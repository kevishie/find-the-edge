import {
  GetCommand,
  PutCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
} from "@aws-sdk/lib-dynamodb";
import {
  createEntitlement,
  isStripeCustomerId,
  normalizeEntitlement,
  type Entitlement,
} from "@find-the-edge/domain";

export interface EntitlementRepository {
  get(accountId: string): Promise<Entitlement | null>;
  /**
   * Webhooks arrive keyed by Stripe customer, not by account, so the pointer
   * row is the only way back to an account id without a Scan or a GSI.
   */
  findAccountByStripeCustomer(customerId: string): Promise<string | null>;
  /**
   * First writer wins, and the winner is returned. A retried checkout that
   * created a second Stripe customer therefore cannot steal the pointer from
   * the customer already bound to the account.
   */
  linkStripeCustomer(accountId: string, customerId: string): Promise<string>;
  /** Records the customer on the entitlement without touching the replay
   * fence, so a webhook racing a checkout is never rolled back by it. */
  attachStripeCustomer(
    accountId: string,
    customerId: string,
    now: string,
  ): Promise<Entitlement>;
  /**
   * Fenced on `lastEventCreated`: returns false when a newer event has
   * already been persisted, which is how two webhook deliveries racing each
   * other resolve to the newer one whatever order they reach storage in.
   */
  save(next: Entitlement): Promise<boolean>;
}

/**
 * Key schema (single table, primary key only — no Scan, no GSI):
 *
 *   `ENTITLEMENT#<accountId>`      / `RECORD`    the durable entitlement
 *   `STRIPE_CUSTOMER#<customerId>` / `ACCOUNT`   pointer back to the account
 *
 * The entitlement item also carries a top-level `lastEventCreated` number
 * that mirrors the one inside `value`. The fence has to be a plain numeric
 * attribute for the conditional write to compare it: a nested null would be
 * stored as a NULL attribute, and `NULL <= :number` is false, which would
 * refuse the very first event for every account.
 */
export const entitlementKey = (accountId: string) => ({
  pk: `ENTITLEMENT#${assertAccountId(accountId)}`,
  sk: "RECORD",
});

export const stripeCustomerKey = (customerId: string) => ({
  pk: `STRIPE_CUSTOMER#${assertCustomerId(customerId)}`,
  sk: "ACCOUNT",
});

function assertAccountId(value: unknown): string {
  if (typeof value !== "string" || !/^account:[a-f0-9]{64}$/.test(value))
    throw new Error("entitlement-account-id-invalid");
  return value;
}

function assertCustomerId(value: unknown): string {
  if (!isStripeCustomerId(value))
    throw new Error("entitlement-customer-id-invalid");
  return value;
}

const isConditionalCheckFailure = (error: unknown): boolean =>
  error instanceof Error && error.name === "ConditionalCheckFailedException";

/** Zero stands in for "no event applied yet", so the fence is always a
 * number and the comparison never has to special-case an absent one. */
const fenceOf = (entitlement: Entitlement): number =>
  entitlement.lastEventCreated ?? 0;

const entitlementItem = (entitlement: Entitlement) => ({
  ...entitlementKey(entitlement.accountId),
  value: normalizeEntitlement(entitlement),
  lastEventCreated: fenceOf(entitlement),
});

export class DynamoEntitlementRepository implements EntitlementRepository {
  constructor(
    private readonly client: DynamoDBDocumentClient,
    private readonly tableName: string,
  ) {}

  async get(accountId: string): Promise<Entitlement | null> {
    const result = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: entitlementKey(accountId),
        // Product authorization must observe the latest billing entitlement.
        ConsistentRead: true,
      }),
    );
    return result.Item === undefined
      ? null
      : normalizeEntitlement(result.Item["value"]);
  }

  async findAccountByStripeCustomer(
    customerId: string,
  ): Promise<string | null> {
    const result = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: stripeCustomerKey(customerId),
        // Billing ownership requires a unique authoritative customer binding.
        ConsistentRead: true,
      }),
    );
    const accountId: unknown = result.Item?.["accountId"];
    return result.Item === undefined ? null : assertAccountId(accountId);
  }

  async linkStripeCustomer(
    accountId: string,
    customerId: string,
  ): Promise<string> {
    const key = stripeCustomerKey(customerId);
    try {
      await this.client.send(
        new PutCommand({
          TableName: this.tableName,
          Item: { ...key, accountId: assertAccountId(accountId) },
          ConditionExpression: "attribute_not_exists(pk)",
        }),
      );
      return accountId;
    } catch (error) {
      if (!isConditionalCheckFailure(error)) throw error;
    }
    const winner = await this.findAccountByStripeCustomer(customerId);
    return winner ?? accountId;
  }

  async attachStripeCustomer(
    accountId: string,
    customerId: string,
    now: string,
  ): Promise<Entitlement> {
    const created = createEntitlement({
      accountId,
      updatedAt: now,
      stripeCustomerId: customerId,
    });
    try {
      await this.client.send(
        new PutCommand({
          TableName: this.tableName,
          Item: entitlementItem(created),
          ConditionExpression: "attribute_not_exists(pk)",
        }),
      );
      return created;
    } catch (error) {
      if (!isConditionalCheckFailure(error)) throw error;
    }
    // A targeted update: the state, the boundary, and the fence belong to
    // the webhook path and must survive a concurrent checkout.
    const result = await this.client.send(
      new UpdateCommand({
        TableName: this.tableName,
        Key: entitlementKey(accountId),
        UpdateExpression:
          "SET #value.stripeCustomerId = :customerId, #value.updatedAt = :now",
        ConditionExpression: "attribute_exists(pk)",
        ExpressionAttributeNames: { "#value": "value" },
        ExpressionAttributeValues: {
          ":customerId": assertCustomerId(customerId),
          ":now": created.updatedAt,
        },
        ReturnValues: "ALL_NEW",
      }),
    );
    return normalizeEntitlement(result.Attributes?.["value"]);
  }

  async save(next: Entitlement): Promise<boolean> {
    const candidate = normalizeEntitlement(next);
    try {
      await this.client.send(
        new PutCommand({
          TableName: this.tableName,
          Item: entitlementItem(candidate),
          // `<=` rather than `<`: Stripe emits several events per second and
          // they are not contradictory, so equal fences must both land.
          ConditionExpression:
            "attribute_not_exists(pk) OR lastEventCreated <= :fence",
          ExpressionAttributeValues: { ":fence": fenceOf(candidate) },
        }),
      );
      return true;
    } catch (error) {
      if (isConditionalCheckFailure(error)) return false;
      throw error;
    }
  }
}

export class MemoryEntitlementRepository implements EntitlementRepository {
  /** Partitioned exactly like the table, so the tests exercise the same key
   * derivation the hosted repository uses. */
  readonly items = new Map<string, Record<string, unknown>>();

  private static id(key: { pk: string; sk: string }): string {
    return `${key.pk}\0${key.sk}`;
  }

  private read(key: {
    pk: string;
    sk: string;
  }): Record<string, unknown> | null {
    return this.items.get(MemoryEntitlementRepository.id(key)) ?? null;
  }

  private write(
    key: { pk: string; sk: string },
    item: Record<string, unknown>,
  ): void {
    this.items.set(MemoryEntitlementRepository.id(key), structuredClone(item));
  }

  async get(accountId: string): Promise<Entitlement | null> {
    await Promise.resolve();
    const stored = this.read(entitlementKey(accountId));
    return stored ? normalizeEntitlement(stored["value"]) : null;
  }

  async findAccountByStripeCustomer(
    customerId: string,
  ): Promise<string | null> {
    await Promise.resolve();
    const stored = this.read(stripeCustomerKey(customerId));
    return stored ? assertAccountId(stored["accountId"]) : null;
  }

  async linkStripeCustomer(
    accountId: string,
    customerId: string,
  ): Promise<string> {
    await Promise.resolve();
    const key = stripeCustomerKey(customerId);
    const stored = this.read(key);
    if (stored) return assertAccountId(stored["accountId"]);
    this.write(key, { ...key, accountId: assertAccountId(accountId) });
    return accountId;
  }

  async attachStripeCustomer(
    accountId: string,
    customerId: string,
    now: string,
  ): Promise<Entitlement> {
    await Promise.resolve();
    const created = createEntitlement({
      accountId,
      updatedAt: now,
      stripeCustomerId: customerId,
    });
    const key = entitlementKey(accountId);
    const stored = this.read(key);
    const record = stored
      ? createEntitlement({
          ...normalizeEntitlement(stored["value"]),
          stripeCustomerId: assertCustomerId(customerId),
          updatedAt: created.updatedAt,
        })
      : created;
    this.write(key, entitlementItem(record));
    return record;
  }

  async save(next: Entitlement): Promise<boolean> {
    await Promise.resolve();
    const candidate = normalizeEntitlement(next);
    const key = entitlementKey(candidate.accountId);
    const stored = this.read(key);
    const fence = stored?.["lastEventCreated"];
    if (typeof fence === "number" && fence > fenceOf(candidate)) return false;
    this.write(key, entitlementItem(candidate));
    return true;
  }
}
