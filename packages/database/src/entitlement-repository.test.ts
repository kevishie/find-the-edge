import { describe, expect, it } from "vitest";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import {
  applyStripeEvent,
  createEntitlement,
  deriveAccountId,
  normalizeStripeEvent,
  type Entitlement,
} from "@find-the-edge/domain";
import {
  DynamoEntitlementRepository,
  entitlementKey,
  MemoryEntitlementRepository,
  stripeCustomerKey,
  type EntitlementRepository,
} from "./entitlement-repository";

const ACCOUNT_ID = deriveAccountId(
  "+15557654321",
  "account-pepper-value-0123456789ab",
);
const OTHER_ACCOUNT_ID = deriveAccountId(
  "+15550009999",
  "account-pepper-value-0123456789ab",
);
const CUSTOMER = "cus_TestCustomer001";
const SUBSCRIPTION = "sub_TestSubscription1";
const NOW = "2026-08-10T12:00:00.000Z";
const NOW_SECONDS = Math.floor(Date.parse(NOW) / 1_000);
const DAY_SECONDS = 86_400;

const subscriptionEvent = (input: {
  readonly id: string;
  readonly created: number;
  readonly status: string;
  readonly periodEnd: number;
}) =>
  normalizeStripeEvent({
    id: input.id,
    type: "customer.subscription.updated",
    created: input.created,
    data: {
      object: {
        id: SUBSCRIPTION,
        customer: CUSTOMER,
        status: input.status,
        current_period_end: input.periodEnd,
      },
    },
  });

const applied = (
  current: Entitlement | null,
  input: Parameters<typeof subscriptionEvent>[0],
): Entitlement =>
  applyStripeEvent(current, subscriptionEvent(input), NOW, ACCOUNT_ID).next;

interface CommandLike {
  readonly constructor: { readonly name: string };
  readonly input: Record<string, unknown>;
}

const conditionalFailure = () =>
  Object.assign(new Error("condition"), {
    name: "ConditionalCheckFailedException",
  });

/**
 * Single-table double that understands exactly the expressions the
 * repository is allowed to issue. Anything else throws, so a change to the
 * repository's storage vocabulary cannot slip past these tests.
 */
class FakeEntitlementTableClient {
  readonly items = new Map<string, Record<string, unknown>>();

  private static id(pk: string, sk: string): string {
    return `${pk}\0${sk}`;
  }

  raw(pk: string, sk: string): Record<string, unknown> | undefined {
    return this.items.get(FakeEntitlementTableClient.id(pk, sk));
  }

  async send(raw: unknown): Promise<Record<string, unknown>> {
    await Promise.resolve();
    const command = raw as CommandLike;
    const input = command.input;
    const values = (input["ExpressionAttributeValues"] ?? {}) as Record<
      string,
      unknown
    >;
    if (command.constructor.name === "GetCommand") {
      const key = input["Key"] as { pk: string; sk: string };
      const item = this.items.get(
        FakeEntitlementTableClient.id(key.pk, key.sk),
      );
      return item === undefined ? {} : { Item: structuredClone(item) };
    }
    if (command.constructor.name === "PutCommand") {
      const item = input["Item"] as {
        pk: string;
        sk: string;
        lastEventCreated?: number;
      };
      const id = FakeEntitlementTableClient.id(item.pk, item.sk);
      const existing = this.items.get(id);
      const condition = input["ConditionExpression"];
      if (condition === "attribute_not_exists(pk)" && existing)
        throw conditionalFailure();
      if (
        condition ===
          "attribute_not_exists(pk) OR lastEventCreated <= :fence" &&
        existing &&
        Number(existing["lastEventCreated"]) > Number(values[":fence"])
      )
        throw conditionalFailure();
      this.items.set(id, structuredClone(item));
      return {};
    }
    if (command.constructor.name !== "UpdateCommand")
      throw new Error(`unexpected-command:${command.constructor.name}`);
    const key = input["Key"] as { pk: string; sk: string };
    const id = FakeEntitlementTableClient.id(key.pk, key.sk);
    const existing = this.items.get(id);
    if (!existing) throw conditionalFailure();
    if (
      input["UpdateExpression"] !==
      "SET #value.stripeCustomerId = :customerId, #value.updatedAt = :now"
    )
      throw new Error("unexpected-update-expression");
    const value = existing["value"] as Record<string, unknown>;
    const next = {
      ...existing,
      value: {
        ...value,
        stripeCustomerId: values[":customerId"],
        updatedAt: values[":now"],
      },
    };
    this.items.set(id, structuredClone(next));
    return { Attributes: structuredClone(next) };
  }
}

const repositories = (): readonly [
  string,
  () => { readonly repository: EntitlementRepository },
][] => [
  [
    "memory",
    () => ({ repository: new MemoryEntitlementRepository() }),
  ],
  [
    "dynamo",
    () => {
      const client = new FakeEntitlementTableClient();
      return {
        repository: new DynamoEntitlementRepository(
          client as unknown as DynamoDBDocumentClient,
          "fte-table",
        ),
      };
    },
  ],
];

describe("entitlement key layout", () => {
  it("partitions by account and by Stripe customer", () => {
    expect(entitlementKey(ACCOUNT_ID)).toEqual({
      pk: `ENTITLEMENT#${ACCOUNT_ID}`,
      sk: "RECORD",
    });
    expect(stripeCustomerKey(CUSTOMER)).toEqual({
      pk: `STRIPE_CUSTOMER#${CUSTOMER}`,
      sk: "ACCOUNT",
    });
  });

  it("refuses ids that are not what they claim to be", () => {
    expect(() => entitlementKey("account:short")).toThrow(
      "entitlement-account-id-invalid",
    );
    expect(() => stripeCustomerKey("sub_WrongPrefix01")).toThrow(
      "entitlement-customer-id-invalid",
    );
  });
});

for (const [name, build] of repositories())
  describe(`entitlement repository (${name})`, () => {
    it("returns null for an account with no record and no pointer", async () => {
      const { repository } = build();
      expect(await repository.get(ACCOUNT_ID)).toBeNull();
      expect(await repository.findAccountByStripeCustomer(CUSTOMER)).toBeNull();
    });

    it("round-trips a saved record", async () => {
      const { repository } = build();
      const record = applied(null, {
        id: "evt_first0000000001",
        created: NOW_SECONDS,
        status: "active",
        periodEnd: NOW_SECONDS + 30 * DAY_SECONDS,
      });
      expect(await repository.save(record)).toBe(true);
      expect(await repository.get(ACCOUNT_ID)).toEqual(record);
    });

    it("resolves a webhook's customer back to its account", async () => {
      const { repository } = build();
      expect(await repository.linkStripeCustomer(ACCOUNT_ID, CUSTOMER)).toBe(
        ACCOUNT_ID,
      );
      expect(await repository.findAccountByStripeCustomer(CUSTOMER)).toBe(
        ACCOUNT_ID,
      );
    });

    it("keeps the first account bound to a customer when a second claims it", async () => {
      const { repository } = build();
      await repository.linkStripeCustomer(ACCOUNT_ID, CUSTOMER);
      expect(
        await repository.linkStripeCustomer(OTHER_ACCOUNT_ID, CUSTOMER),
      ).toBe(ACCOUNT_ID);
      expect(await repository.findAccountByStripeCustomer(CUSTOMER)).toBe(
        ACCOUNT_ID,
      );
    });

    it("attaches a customer to a fresh account and then to an existing record", async () => {
      const { repository } = build();
      const created = await repository.attachStripeCustomer(
        ACCOUNT_ID,
        CUSTOMER,
        NOW,
      );
      expect(created.stripeCustomerId).toBe(CUSTOMER);
      expect(created.state).toBe("none");

      const active = applied(created, {
        id: "evt_active0000001",
        created: NOW_SECONDS + 10,
        status: "active",
        periodEnd: NOW_SECONDS + 30 * DAY_SECONDS,
      });
      expect(await repository.save(active)).toBe(true);

      // A later checkout must not reset the state or the fence the webhook
      // path already wrote.
      const reattached = await repository.attachStripeCustomer(
        ACCOUNT_ID,
        CUSTOMER,
        "2026-08-11T00:00:00.000Z",
      );
      expect(reattached.state).toBe("active");
      expect(reattached.lastEventId).toBe("evt_active0000001");
      expect(reattached.updatedAt).toBe("2026-08-11T00:00:00.000Z");
      expect((await repository.get(ACCOUNT_ID))?.state).toBe("active");
    });

    it("refuses a stale write when a newer event already landed", async () => {
      const { repository } = build();
      const older = applied(null, {
        id: "evt_older000000001",
        created: NOW_SECONDS,
        status: "active",
        periodEnd: NOW_SECONDS + 30 * DAY_SECONDS,
      });
      const newer = applied(null, {
        id: "evt_newer000000001",
        created: NOW_SECONDS + 500,
        status: "canceled",
        periodEnd: NOW_SECONDS + 30 * DAY_SECONDS,
      });
      expect(await repository.save(newer)).toBe(true);
      expect(await repository.save(older)).toBe(false);
      const stored = await repository.get(ACCOUNT_ID);
      expect(stored?.lastEventId).toBe("evt_newer000000001");
      expect(stored?.state).toBe("canceled");
    });

    it("lets two events from the same second both land", async () => {
      const { repository } = build();
      const first = applied(null, {
        id: "evt_samesecond0001",
        created: NOW_SECONDS,
        status: "trialing",
        periodEnd: NOW_SECONDS + 7 * DAY_SECONDS,
      });
      expect(await repository.save(first)).toBe(true);
      const second = applied(first, {
        id: "evt_samesecond0002",
        created: NOW_SECONDS,
        status: "active",
        periodEnd: NOW_SECONDS + 30 * DAY_SECONDS,
      });
      expect(await repository.save(second)).toBe(true);
      expect((await repository.get(ACCOUNT_ID))?.state).toBe("active");
    });

    it("resolves a concurrent apply race to the newer event", async () => {
      const { repository } = build();
      // Both deliveries read the same empty record, both apply, and both
      // write. Whatever order they reach storage in, the cancellation is
      // what survives — an interleaved older write cannot resurrect access.
      const cancel = applied(null, {
        id: "evt_racecancel0001",
        created: NOW_SECONDS + 900,
        status: "canceled",
        periodEnd: NOW_SECONDS + 30 * DAY_SECONDS,
      });
      const update = applied(null, {
        id: "evt_raceupdate0001",
        created: NOW_SECONDS + 300,
        status: "active",
        periodEnd: NOW_SECONDS + 30 * DAY_SECONDS,
      });
      const results = await Promise.all([
        repository.save(cancel),
        repository.save(update),
      ]);
      expect(results).toContain(true);
      const stored = await repository.get(ACCOUNT_ID);
      expect(stored?.lastEventId).toBe("evt_racecancel0001");
      expect(stored?.state).toBe("canceled");
      expect(stored?.accessUntil).toBeNull();

      // And in the opposite arrival order.
      const other = build();
      const reversed = await Promise.all([
        other.repository.save(update),
        other.repository.save(cancel),
      ]);
      expect(reversed).toEqual([true, true]);
      expect((await other.repository.get(ACCOUNT_ID))?.state).toBe("canceled");
    });

    it("refuses to store a record that is not a valid entitlement", async () => {
      const { repository } = build();
      const record = createEntitlement({
        accountId: ACCOUNT_ID,
        updatedAt: NOW,
      });
      await expect(
        repository.save({ ...record, state: "comped" } as unknown as Entitlement),
      ).rejects.toThrow("stored-entitlement-invalid");
    });
  });

describe("dynamo entitlement storage shape", () => {
  it("mirrors the fence as a top-level numeric attribute", async () => {
    const client = new FakeEntitlementTableClient();
    const repository = new DynamoEntitlementRepository(
      client as unknown as DynamoDBDocumentClient,
      "fte-table",
    );
    const fresh = createEntitlement({ accountId: ACCOUNT_ID, updatedAt: NOW });
    expect(await repository.save(fresh)).toBe(true);
    // Zero, not null: the conditional write compares numbers, and a nested
    // null would refuse the very first event for every account.
    expect(
      client.raw(`ENTITLEMENT#${ACCOUNT_ID}`, "RECORD")?.["lastEventCreated"],
    ).toBe(0);

    const record = applied(fresh, {
      id: "evt_fence00000001",
      created: NOW_SECONDS + 5,
      status: "active",
      periodEnd: NOW_SECONDS + 30 * DAY_SECONDS,
    });
    expect(await repository.save(record)).toBe(true);
    expect(
      client.raw(`ENTITLEMENT#${ACCOUNT_ID}`, "RECORD")?.["lastEventCreated"],
    ).toBe(NOW_SECONDS + 5);
    expect(client.raw(`STRIPE_CUSTOMER#${CUSTOMER}`, "ACCOUNT")).toBeUndefined();
  });

  it("stores nothing but the account id in the customer pointer", async () => {
    const client = new FakeEntitlementTableClient();
    const repository = new DynamoEntitlementRepository(
      client as unknown as DynamoDBDocumentClient,
      "fte-table",
    );
    await repository.linkStripeCustomer(ACCOUNT_ID, CUSTOMER);
    expect(client.raw(`STRIPE_CUSTOMER#${CUSTOMER}`, "ACCOUNT")).toEqual({
      pk: `STRIPE_CUSTOMER#${CUSTOMER}`,
      sk: "ACCOUNT",
      accountId: ACCOUNT_ID,
    });
  });
});
