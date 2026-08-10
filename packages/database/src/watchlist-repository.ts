import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  type DynamoDBDocumentClient,
} from "@aws-sdk/lib-dynamodb";
import {
  assertWatchlistEventId,
  assertWatchlistRequesterId,
  compareWatchlistEntries,
  normalizeWatchlistEntry,
  type WatchlistEntry,
} from "@find-the-edge/domain";

/**
 * Outcome of an add: "created" is the first write, "exists" means the event
 * was already watched and the stored entry — including its original
 * `addedAt` — stands. Callers map these to 201 and 200.
 */
export interface WatchlistAddResult {
  readonly outcome: "created" | "exists";
  readonly entry: WatchlistEntry;
}

export interface WatchlistRepository {
  /** Idempotent: a second add of the same event never moves `addedAt`. */
  add(entry: WatchlistEntry): Promise<WatchlistAddResult>;
  /** Idempotent: removing an entry that is not there succeeds. */
  remove(requesterId: string, canonicalEventId: string): Promise<void>;
  /** The requester's own partition only, ordered by kickoff then event id. */
  list(requesterId: string): Promise<readonly WatchlistEntry[]>;
}

/**
 * Key schema (single table, primary key only — no Scan, no GSI):
 * `WATCHLIST#<requesterId>` / `<canonicalEventId>`. The partition is the user,
 * so a list is one Query that can never reach another user's rows and
 * add/remove are exact single-item writes.
 */
export const watchlistPartition = (requesterId: string): string =>
  `WATCHLIST#${assertWatchlistRequesterId(requesterId)}`;

export const watchlistItemKey = (
  requesterId: string,
  canonicalEventId: string,
) => ({
  pk: watchlistPartition(requesterId),
  sk: assertWatchlistEventId(canonicalEventId),
});

/** A stored row that survives re-derivation; a corrupt row throws. */
const storedEntry = (value: unknown): WatchlistEntry =>
  normalizeWatchlistEntry(value as WatchlistEntry);

const isConditionalCheckFailure = (error: unknown): boolean =>
  error instanceof Error && error.name === "ConditionalCheckFailedException";

export class DynamoWatchlistRepository implements WatchlistRepository {
  constructor(
    private readonly client: DynamoDBDocumentClient,
    private readonly tableName: string,
  ) {}

  async add(entry: WatchlistEntry): Promise<WatchlistAddResult> {
    const validated = normalizeWatchlistEntry(entry);
    const key = watchlistItemKey(
      validated.requesterId,
      validated.canonicalEventId,
    );
    // Two passes at most: the conditional put loses only to an existing row,
    // and the only way the follow-up read finds nothing is a concurrent
    // remove, which makes a fresh add correct again.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await this.client.send(
          new PutCommand({
            TableName: this.tableName,
            Item: { ...key, value: validated },
            ConditionExpression: "attribute_not_exists(pk)",
          }),
        );
        return { outcome: "created", entry: validated };
      } catch (error) {
        if (!isConditionalCheckFailure(error)) throw error;
      }
      const existing = await this.client.send(
        new GetCommand({
          TableName: this.tableName,
          Key: key,
          ConsistentRead: true,
        }),
      );
      if (existing.Item !== undefined)
        return {
          outcome: "exists",
          entry: storedEntry(existing.Item["value"]),
        };
    }
    throw new Error("watchlist-add-unresolved");
  }

  async remove(requesterId: string, canonicalEventId: string): Promise<void> {
    await this.client.send(
      new DeleteCommand({
        TableName: this.tableName,
        Key: watchlistItemKey(requesterId, canonicalEventId),
      }),
    );
  }

  async list(requesterId: string): Promise<readonly WatchlistEntry[]> {
    const pk = watchlistPartition(requesterId);
    const entries: WatchlistEntry[] = [];
    let cursor: Record<string, unknown> | undefined;
    do {
      const page = await this.client.send(
        new QueryCommand({
          TableName: this.tableName,
          KeyConditionExpression: "pk = :pk",
          ExpressionAttributeValues: { ":pk": pk },
          ConsistentRead: true,
          ...(cursor ? { ExclusiveStartKey: cursor } : {}),
        }),
      );
      for (const item of page.Items ?? [])
        entries.push(storedEntry(item["value"]));
      cursor = page.LastEvaluatedKey;
    } while (cursor);
    return Object.freeze(entries.sort(compareWatchlistEntries));
  }
}

export class MemoryWatchlistRepository implements WatchlistRepository {
  /** Partition-per-requester, mirroring the stored key schema exactly. */
  readonly partitions = new Map<string, Map<string, WatchlistEntry>>();

  private partition(requesterId: string): Map<string, WatchlistEntry> {
    const pk = watchlistPartition(requesterId);
    const existing = this.partitions.get(pk);
    if (existing) return existing;
    const created = new Map<string, WatchlistEntry>();
    this.partitions.set(pk, created);
    return created;
  }

  async add(entry: WatchlistEntry): Promise<WatchlistAddResult> {
    await Promise.resolve();
    const validated = normalizeWatchlistEntry(entry);
    const partition = this.partition(validated.requesterId);
    const sk = assertWatchlistEventId(validated.canonicalEventId);
    const existing = partition.get(sk);
    if (existing) return { outcome: "exists", entry: storedEntry(existing) };
    partition.set(sk, validated);
    return { outcome: "created", entry: validated };
  }

  async remove(requesterId: string, canonicalEventId: string): Promise<void> {
    await Promise.resolve();
    this.partition(requesterId).delete(
      assertWatchlistEventId(canonicalEventId),
    );
  }

  async list(requesterId: string): Promise<readonly WatchlistEntry[]> {
    await Promise.resolve();
    return Object.freeze(
      [...this.partition(requesterId).values()]
        .map((entry) => storedEntry(entry))
        .sort(compareWatchlistEntries),
    );
  }
}
