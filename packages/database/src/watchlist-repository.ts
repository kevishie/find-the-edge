import {
  BatchGetCommand,
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
  /** Resolve at most four decode candidates through authoritative exact keys. */
  findFirst(
    requesterId: string,
    canonicalEventIds: readonly string[],
  ): Promise<WatchlistEntry | null>;
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

const lookupKeys = (
  requesterId: string,
  canonicalEventIds: readonly string[],
) => {
  if (canonicalEventIds.length < 1 || canonicalEventIds.length > 4)
    throw new Error("watchlist-candidates-invalid");
  const pk = watchlistPartition(requesterId);
  const keys = [...new Set(canonicalEventIds)].map((canonicalEventId) => ({
    pk,
    sk: assertWatchlistEventId(canonicalEventId),
  }));
  return { keys };
};

const storedEntryForKey = (
  item: Record<string, unknown>,
  key: { readonly pk: string; readonly sk: string },
): WatchlistEntry => {
  const entry = storedEntry(item["value"]);
  if (
    item["pk"] !== key.pk ||
    item["sk"] !== key.sk ||
    watchlistPartition(entry.requesterId) !== key.pk ||
    entry.canonicalEventId !== key.sk
  )
    throw new Error("stored-watchlist-entry-invalid");
  return entry;
};

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
          // A failed conditional add must distinguish an existing row from a
          // concurrent remove before it retries the mutation.
          ConsistentRead: true,
        }),
      );
      if (existing.Item !== undefined)
        return {
          outcome: "exists",
          entry: storedEntryForKey(existing.Item, key),
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

  async findFirst(
    requesterId: string,
    canonicalEventIds: readonly string[],
  ): Promise<WatchlistEntry | null> {
    const { keys } = lookupKeys(requesterId, canonicalEventIds);
    const result = await this.client.send(
      new BatchGetCommand({
        RequestItems: {
          [this.tableName]: {
            Keys: keys,
            // DELETE resolution must not miss an authoritative watched row.
            ConsistentRead: true,
          },
        },
      }),
    );
    if ((result.UnprocessedKeys?.[this.tableName]?.Keys?.length ?? 0) > 0)
      throw new Error("watchlist-read-partial");
    const rows = new Map(
      (result.Responses?.[this.tableName] ?? []).map((item) => [
        `${String(item["pk"])}\0${String(item["sk"])}`,
        item,
      ]),
    );
    for (const key of keys) {
      const item = rows.get(`${key.pk}\0${key.sk}`);
      if (item) return storedEntryForKey(item, key);
    }
    return null;
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
          // A stale list can only lag this requester's UI; mutations remain
          // conditionally authoritative and no other partition is queried.
          ConsistentRead: false,
          ...(cursor ? { ExclusiveStartKey: cursor } : {}),
        }),
      );
      const items = (page.Items ?? []) as unknown as readonly Record<
        string,
        unknown
      >[];
      for (const item of items) {
        const sk = item["sk"];
        if (typeof sk !== "string")
          throw new Error("stored-watchlist-entry-invalid");
        entries.push(storedEntryForKey(item, { pk, sk }));
      }
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

  async findFirst(
    requesterId: string,
    canonicalEventIds: readonly string[],
  ): Promise<WatchlistEntry | null> {
    await Promise.resolve();
    const { keys } = lookupKeys(requesterId, canonicalEventIds);
    const partition = this.partition(requesterId);
    for (const key of keys) {
      const value = partition.get(key.sk);
      if (!value) continue;
      const entry = storedEntry(value);
      if (
        entry.requesterId !== requesterId ||
        entry.canonicalEventId !== key.sk
      )
        throw new Error("stored-watchlist-entry-invalid");
      return entry;
    }
    return null;
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
