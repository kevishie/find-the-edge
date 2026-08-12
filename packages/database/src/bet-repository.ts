import {
  PutCommand,
  QueryCommand,
  type DynamoDBDocumentClient,
} from "@aws-sdk/lib-dynamodb";
import {
  canTransitionTo,
  createBet,
  normalizeBet,
  type Bet,
  type BetStatus,
} from "@find-the-edge/domain";

/**
 * A settlement that was recorded, kept forever. Correcting a mis-entered
 * result is normal, so the current status alone would lose the fact that it
 * ever said something else — and a performance aggregate that moved because
 * of a correction should be explainable.
 */
export interface BetAuditEntry {
  readonly betId: string;
  readonly at: string;
  readonly from: BetStatus;
  readonly to: BetStatus;
  readonly returnedCents: number | null;
}

export interface BetSettlementInput {
  readonly status: BetStatus;
  readonly settledAt: string;
  /** Required for `cashed-out`, refused otherwise — the domain enforces it. */
  readonly returnedCents?: number | null;
}

export interface BetRepository {
  /** First writer wins; a retried create returns the stored bet unchanged. */
  create(bet: Bet): Promise<Bet>;
  get(accountId: string, betId: string): Promise<Bet | null>;
  /** The account's own partition, newest placement first. */
  list(accountId: string, limit?: number): Promise<readonly Bet[]>;
  /**
   * Settle or correct. Optimistic on `version`, so two tabs settling the
   * same bet cannot silently overwrite one another.
   */
  settle(
    accountId: string,
    betId: string,
    settlement: BetSettlementInput,
    now: string,
  ): Promise<Bet>;
  audit(accountId: string, betId: string): Promise<readonly BetAuditEntry[]>;
}

/**
 * Key schema (single table, primary key only — no Scan, no GSI):
 * `BET#<accountId>` / `BET#<placedAt>#<betId>` for the bets themselves and
 * `BET#<accountId>` / `AUDIT#<betId>#<at>` for settlement history. The
 * partition is the account, so a list is one Query that cannot reach another
 * account's rows, and the sort key orders by placement without an index.
 */
export const betPartition = (accountId: string): string => `BET#${accountId}`;

export const betSortKey = (bet: { placedAt: string; betId: string }): string =>
  `BET#${bet.placedAt}#${bet.betId}`;

export const betAuditSortKey = (betId: string, at: string): string =>
  `AUDIT#${betId}#${at}`;

const isConditionalCheckFailure = (error: unknown): boolean =>
  error instanceof Error && error.name === "ConditionalCheckFailedException";

export class DynamoBetRepository implements BetRepository {
  constructor(
    private readonly client: DynamoDBDocumentClient,
    private readonly tableName: string,
  ) {}

  async create(bet: Bet): Promise<Bet> {
    const record = normalizeBet(bet);
    const item = {
      pk: betPartition(record.accountId),
      sk: betSortKey(record),
      value: record,
    };
    try {
      await this.client.send(
        new PutCommand({
          TableName: this.tableName,
          Item: item,
          ConditionExpression: "attribute_not_exists(pk)",
        }),
      );
      return record;
    } catch (error) {
      if (!isConditionalCheckFailure(error)) throw error;
      // A retried create returns what the first one stored rather than
      // pretending to have written again.
      const stored = await this.get(record.accountId, record.betId);
      if (!stored) throw error;
      return stored;
    }
  }

  async get(accountId: string, betId: string): Promise<Bet | null> {
    // The sort key embeds placedAt, which a caller holding only an id does
    // not know, so this reads the partition and picks the row out. Bounded by
    // the same limit the list uses.
    const bets = await this.list(accountId);
    return bets.find((bet) => bet.betId === betId) ?? null;
  }

  async list(accountId: string, limit = 200): Promise<readonly Bet[]> {
    const result = await this.client.send(
      new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
        ExpressionAttributeValues: {
          ":pk": betPartition(accountId),
          ":prefix": "BET#",
        },
        // Newest placement first: a bettor opens this screen to see what is
        // still running, not what they did last spring.
        ScanIndexForward: false,
        Limit: limit,
      }),
    );
    return (result.Items ?? []).map((item) => normalizeBet(item["value"]));
  }

  async settle(
    accountId: string,
    betId: string,
    settlement: BetSettlementInput,
    now: string,
  ): Promise<Bet> {
    const current = await this.get(accountId, betId);
    if (!current) throw new Error("bet-not-found");
    if (!canTransitionTo(current.status, settlement.status))
      throw new Error("bet-transition-invalid");
    // Re-derived through the domain, so an impossible settlement — a return
    // on a win, a cash-out without one — is refused before it is stored.
    const next = createBet({
      ...current,
      status: settlement.status,
      settledAt: settlement.settledAt,
      returnedCents: settlement.returnedCents ?? null,
      updatedAt: now,
      version: current.version + 1,
    });
    try {
      await this.client.send(
        new PutCommand({
          TableName: this.tableName,
          Item: {
            pk: betPartition(accountId),
            sk: betSortKey(next),
            value: next,
          },
          // Two tabs settling the same bet: the second one loses rather than
          // silently overwriting a result the reader has already seen.
          ConditionExpression: "#v.#version = :expected",
          ExpressionAttributeNames: { "#v": "value", "#version": "version" },
          ExpressionAttributeValues: { ":expected": current.version },
        }),
      );
    } catch (error) {
      if (isConditionalCheckFailure(error))
        throw new Error("bet-settlement-conflict");
      throw error;
    }
    // The audit row is written after the settlement it records. A crash
    // between the two loses a history entry, never the money — the opposite
    // order could claim a settlement that never landed.
    await this.client.send(
      new PutCommand({
        TableName: this.tableName,
        Item: {
          pk: betPartition(accountId),
          sk: betAuditSortKey(betId, now),
          value: {
            betId,
            at: now,
            from: current.status,
            to: next.status,
            returnedCents: next.returnedCents,
          } satisfies BetAuditEntry,
        },
      }),
    );
    return next;
  }

  async audit(
    accountId: string,
    betId: string,
  ): Promise<readonly BetAuditEntry[]> {
    const result = await this.client.send(
      new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
        ExpressionAttributeValues: {
          ":pk": betPartition(accountId),
          ":prefix": `AUDIT#${betId}#`,
        },
      }),
    );
    return (result.Items ?? []).map((item) => item["value"] as BetAuditEntry);
  }
}

/** In-memory twin, used by handler tests and local runs. */
export class MemoryBetRepository implements BetRepository {
  readonly bets = new Map<string, Bet>();
  readonly entries: BetAuditEntry[] = [];

  private key(accountId: string, betId: string) {
    return `${accountId}|${betId}`;
  }

  create(bet: Bet): Promise<Bet> {
    const record = normalizeBet(bet);
    const key = this.key(record.accountId, record.betId);
    const existing = this.bets.get(key);
    if (existing) return Promise.resolve(existing);
    this.bets.set(key, record);
    return Promise.resolve(record);
  }

  get(accountId: string, betId: string): Promise<Bet | null> {
    return Promise.resolve(this.bets.get(this.key(accountId, betId)) ?? null);
  }

  list(accountId: string, limit = 200): Promise<readonly Bet[]> {
    return Promise.resolve(
      [...this.bets.values()]
        .filter((bet) => bet.accountId === accountId)
        .sort((left, right) =>
          left.placedAt === right.placedAt
            ? right.betId.localeCompare(left.betId)
            : right.placedAt.localeCompare(left.placedAt),
        )
        .slice(0, limit),
    );
  }

  async settle(
    accountId: string,
    betId: string,
    settlement: BetSettlementInput,
    now: string,
  ): Promise<Bet> {
    const current = await this.get(accountId, betId);
    if (!current) throw new Error("bet-not-found");
    if (!canTransitionTo(current.status, settlement.status))
      throw new Error("bet-transition-invalid");
    const next = createBet({
      ...current,
      status: settlement.status,
      settledAt: settlement.settledAt,
      returnedCents: settlement.returnedCents ?? null,
      updatedAt: now,
      version: current.version + 1,
    });
    this.bets.set(this.key(accountId, betId), next);
    this.entries.push({
      betId,
      at: now,
      from: current.status,
      to: next.status,
      returnedCents: next.returnedCents,
    });
    return next;
  }

  audit(accountId: string, betId: string): Promise<readonly BetAuditEntry[]> {
    void accountId;
    return Promise.resolve(this.entries.filter((e) => e.betId === betId));
  }
}
