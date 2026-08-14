import { describe, expect, it, vi } from "vitest";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import {
  createWatchlistEntry,
  type WatchlistEntry,
  type WatchlistEntryInput,
} from "@find-the-edge/domain";
import {
  DynamoWatchlistRepository,
  MemoryWatchlistRepository,
  watchlistItemKey,
  type WatchlistRepository,
} from "./watchlist-repository";

const PERCENT_EVENT_ID = "event:mlb%3Amlb:game-1";

const entry = (overrides: Partial<WatchlistEntryInput> = {}): WatchlistEntry =>
  createWatchlistEntry({
    requesterId: "user-1",
    canonicalEventId: PERCENT_EVENT_ID,
    canonicalEventVersion: 3,
    sportKey: "mlb",
    leagueKey: "mlb",
    startsAt: "2026-08-11T23:05:00.000Z",
    addedAt: "2026-08-10T12:00:00.000Z",
    ...overrides,
  });

interface CommandLike {
  readonly constructor: { readonly name: string };
  readonly input: Record<string, unknown>;
}

/**
 * Minimal single-table double: exact-key Put/Get/Delete plus a partition
 * Query, which is the entire surface the repository is allowed to use.
 */
class FakeWatchlistTableClient {
  private readonly items = new Map<string, Record<string, unknown>>();

  private static id(pk: string, sk: string): string {
    return `${pk}\0${sk}`;
  }

  putRaw(pk: string, sk: string, item: Record<string, unknown>): void {
    this.items.set(FakeWatchlistTableClient.id(pk, sk), structuredClone(item));
  }

  async send(raw: unknown): Promise<Record<string, unknown>> {
    await Promise.resolve();
    const command = raw as CommandLike;
    const input = command.input;
    const key = input["Key"] as { pk: string; sk: string } | undefined;
    if (command.constructor.name === "GetCommand") {
      const item = key
        ? this.items.get(FakeWatchlistTableClient.id(key.pk, key.sk))
        : undefined;
      return item === undefined ? {} : { Item: structuredClone(item) };
    }
    if (command.constructor.name === "DeleteCommand") {
      if (key) this.items.delete(FakeWatchlistTableClient.id(key.pk, key.sk));
      return {};
    }
    if (command.constructor.name === "PutCommand") {
      const item = input["Item"] as { pk: string; sk: string };
      const id = FakeWatchlistTableClient.id(item.pk, item.sk);
      if (
        input["ConditionExpression"] === "attribute_not_exists(pk)" &&
        this.items.has(id)
      )
        throw Object.assign(new Error("condition"), {
          name: "ConditionalCheckFailedException",
        });
      this.items.set(id, structuredClone(item));
      return {};
    }
    if (command.constructor.name === "QueryCommand") {
      const values = input["ExpressionAttributeValues"] as Record<
        string,
        string
      >;
      const pk = values[":pk"];
      const matches = [...this.items.entries()]
        .filter(([id]) => id.startsWith(`${pk}\0`))
        .map(([, item]) => structuredClone(item));
      return { Items: matches };
    }
    throw new Error(`unsupported-command:${command.constructor.name}`);
  }
}

const harnesses: readonly [
  string,
  () => {
    readonly repo: WatchlistRepository;
    readonly corrupt: (requesterId: string, eventId: string) => void;
  },
][] = [
  [
    "memory",
    () => {
      const repo = new MemoryWatchlistRepository();
      return {
        repo,
        corrupt: (requesterId, eventId) => {
          const key = watchlistItemKey(requesterId, eventId);
          repo.partitions.set(
            key.pk,
            new Map([
              [
                key.sk,
                {
                  schemaVersion: "watchlist-entry-v0",
                } as unknown as WatchlistEntry,
              ],
            ]),
          );
        },
      };
    },
  ],
  [
    "dynamo",
    () => {
      const client = new FakeWatchlistTableClient();
      const repo = new DynamoWatchlistRepository(
        client as unknown as DynamoDBDocumentClient,
        "table",
      );
      return {
        repo,
        corrupt: (requesterId, eventId) => {
          const key = watchlistItemKey(requesterId, eventId);
          client.putRaw(key.pk, key.sk, {
            ...key,
            value: { schemaVersion: "watchlist-entry-v0" },
          });
        },
      };
    },
  ],
];

describe.each(harnesses)("watchlist repository (%s)", (_name, build) => {
  it("adds once and treats a repeat as an existing entry without moving addedAt", async () => {
    const { repo } = build();
    const first = await repo.add(entry());
    expect(first.outcome).toBe("created");
    const second = await repo.add(
      entry({ addedAt: "2026-08-10T18:00:00.000Z" }),
    );
    expect(second).toEqual({ outcome: "exists", entry: first.entry });
    expect(second.entry.addedAt).toBe("2026-08-10T12:00:00.000Z");
    expect(await repo.list("user-1")).toEqual([first.entry]);
  });

  it("removes idempotently, including an entry that was never added", async () => {
    const { repo } = build();
    await repo.remove("user-1", PERCENT_EVENT_ID);
    await repo.add(entry());
    await repo.remove("user-1", PERCENT_EVENT_ID);
    await repo.remove("user-1", PERCENT_EVENT_ID);
    expect(await repo.list("user-1")).toEqual([]);
    const readded = await repo.add(
      entry({ addedAt: "2026-08-10T18:00:00.000Z" }),
    );
    expect(readded.outcome).toBe("created");
    expect(readded.entry.addedAt).toBe("2026-08-10T18:00:00.000Z");
  });

  it("orders the list by kickoff then canonical event id", async () => {
    const { repo } = build();
    const late = entry({
      canonicalEventId: "event:mlb%3Amlb:z",
      startsAt: "2026-08-12T23:05:00.000Z",
    });
    const earlyB = entry({ canonicalEventId: "event:mlb%3Amlb:b" });
    const earlyA = entry({ canonicalEventId: "event:mlb%3Amlb:a" });
    for (const value of [late, earlyB, earlyA]) await repo.add(value);
    expect(
      (await repo.list("user-1")).map(
        ({ canonicalEventId }) => canonicalEventId,
      ),
    ).toEqual(["event:mlb%3Amlb:a", "event:mlb%3Amlb:b", "event:mlb%3Amlb:z"]);
  });

  it("isolates one requester's watchlist from another's", async () => {
    const { repo } = build();
    await repo.add(entry());
    await repo.add(
      entry({
        requesterId: "user-2",
        canonicalEventId: "event:mlb%3Amlb:other",
      }),
    );
    expect(
      (await repo.list("user-1")).map(
        ({ canonicalEventId }) => canonicalEventId,
      ),
    ).toEqual([PERCENT_EVENT_ID]);
    expect(
      (await repo.list("user-2")).map(
        ({ canonicalEventId }) => canonicalEventId,
      ),
    ).toEqual(["event:mlb%3Amlb:other"]);
    // A remove aimed at another partition can never touch the first user.
    await repo.remove("user-2", PERCENT_EVENT_ID);
    expect(await repo.list("user-1")).toHaveLength(1);
  });

  it("round-trips a percent-encoded canonical id through add, list, and remove", async () => {
    const { repo } = build();
    const stored = await repo.add(entry());
    expect(stored.entry.canonicalEventId).toBe(PERCENT_EVENT_ID);
    // The decoded form is a different id and must not resolve to this entry.
    await repo.remove("user-1", "event:mlb:mlb:game-1");
    expect(await repo.list("user-1")).toHaveLength(1);
    await repo.remove("user-1", PERCENT_EVENT_ID);
    expect(await repo.list("user-1")).toEqual([]);
  });

  it("rejects a corrupt stored row instead of serving it", async () => {
    const { repo, corrupt } = build();
    corrupt("user-1", PERCENT_EVENT_ID);
    await expect(repo.list("user-1")).rejects.toThrow(
      "stored-watchlist-entry-invalid",
    );
    await expect(repo.add(entry())).rejects.toThrow(
      "stored-watchlist-entry-invalid",
    );
  });

  it("refuses identities the canonical grammar rejects", async () => {
    const { repo } = build();
    await expect(repo.list("bad requester")).rejects.toThrow(
      "watchlist-requester-invalid",
    );
    await expect(repo.remove("user-1", "EVENT:MLB")).rejects.toThrow(
      "watchlist-event-id-invalid",
    );
  });
});

it("keeps the stored key schema exact", () => {
  expect(watchlistItemKey("user-1", PERCENT_EVENT_ID)).toEqual({
    pk: "WATCHLIST#user-1",
    sk: PERCENT_EVENT_ID,
  });
});

it("keeps stale lists observational while exact candidate lookup stays strong", async () => {
  const authoritative = entry();
  const key = watchlistItemKey(
    authoritative.requesterId,
    authoritative.canonicalEventId,
  );
  let queryCount = 0;
  const send = vi.fn(async (command: CommandLike) => {
    await Promise.resolve();
    if (command.constructor.name === "QueryCommand")
      return queryCount++ === 0
        ? { Items: [] }
        : { Items: [{ ...key, value: authoritative }] };
    if (command.constructor.name === "BatchGetCommand") {
      const request = command.input["RequestItems"] as Record<
        string,
        { Keys: { pk: string; sk: string }[] }
      >;
      const [table, options] = Object.entries(request)[0]!;
      return {
        Responses: {
          [table]: options.Keys.some(
            (candidate) => candidate.pk === key.pk && candidate.sk === key.sk,
          )
            ? [{ ...key, value: authoritative }]
            : [],
        },
      };
    }
    throw new Error(`unexpected-command:${command.constructor.name}`);
  });
  const repo = new DynamoWatchlistRepository(
    { send } as unknown as DynamoDBDocumentClient,
    "table",
  );
  await expect(repo.list("user-1")).resolves.toEqual([]);
  await expect(
    repo.findFirst("user-1", [
      "event:mlb%3Amlb:missing",
      authoritative.canonicalEventId,
    ]),
  ).resolves.toEqual(authoritative);
  await expect(
    repo.findFirst("user-2", [authoritative.canonicalEventId]),
  ).resolves.toBeNull();
  await expect(repo.list("user-1")).resolves.toEqual([authoritative]);
  expect(
    (send.mock.calls[0]?.[0] as { input: Record<string, unknown> }).input,
  ).toMatchObject({
    ConsistentRead: false,
    ExpressionAttributeValues: { ":pk": "WATCHLIST#user-1" },
  });
  for (const index of [1, 2]) {
    const input = (send.mock.calls[index]?.[0] as CommandLike).input;
    const request = input["RequestItems"] as Record<
      string,
      { ConsistentRead?: boolean; Keys: { pk: string; sk: string }[] }
    >;
    expect(request["table"]?.ConsistentRead).toBe(true);
    expect(request["table"]?.Keys).toSatisfy((keys: { pk: string }[]) =>
      keys.every(({ pk }) =>
        pk.startsWith(index === 1 ? "WATCHLIST#user-1" : "WATCHLIST#user-2"),
      ),
    );
  }
  expect(
    (send.mock.calls[3]?.[0] as { input: Record<string, unknown> }).input,
  ).toMatchObject({ ConsistentRead: false });
  expect(send.mock.calls.map(([command]) => command.constructor.name)).toEqual([
    "QueryCommand",
    "BatchGetCommand",
    "BatchGetCommand",
    "QueryCommand",
  ]);
});

it("re-adds after a concurrent remove drops the conflicting row", async () => {
  const client = new FakeWatchlistTableClient();
  const repo = new DynamoWatchlistRepository(
    client as unknown as DynamoDBDocumentClient,
    "table",
  );
  const key = watchlistItemKey("user-1", PERCENT_EVENT_ID);
  client.putRaw(key.pk, key.sk, { ...key, value: entry() });
  const send = client.send.bind(client);
  let removed = false;
  const racing = {
    send: async (command: unknown) => {
      try {
        return await send(command);
      } catch (error) {
        // Simulate the remove landing between the failed put and the reread.
        if (!removed) {
          removed = true;
          await send({
            constructor: { name: "DeleteCommand" },
            input: { Key: key },
          });
        }
        throw error;
      }
    },
  };
  const raced = new DynamoWatchlistRepository(
    racing as unknown as DynamoDBDocumentClient,
    "table",
  );
  expect((await raced.add(entry())).outcome).toBe("created");
  expect(await repo.list("user-1")).toHaveLength(1);
});
