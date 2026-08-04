import { describe, expect, it, vi } from "vitest";
import type {
  CanonicalEvent,
  IsoTimestamp,
  SportKey,
} from "@find-the-edge/domain";
import type { DynamoItem } from "./dynamodb-event-ingestion";
import { DynamoEventRepository } from "./dynamodb-event-repository";
import { EventCursorCodec } from "./event-repository";
import {
  isCanonicalEntityId,
  projectionItems,
  validateProjection,
} from "./event-read-projection";

const instant = (value: string) => value as IsoTimestamp;
const event = (id = "game-1"): CanonicalEvent => ({
  id: id as CanonicalEvent["id"],
  sportKey: "mlb" as SportKey,
  leagueKey: "mlb",
  leagueId: "mlb" as CanonicalEvent["leagueId"],
  participantIds: ["away", "home"] as CanonicalEvent["participantIds"],
  participantLabels: ["Away", "Home"],
  startsAt: instant("2026-08-01T00:00:00.000Z"),
  phase: "scheduled",
  evidence: [],
  status: "scheduled",
  revisions: {},
  updatedAt: instant("2026-07-31T20:00:00.000Z"),
  candidateIdentity: "away-home",
  version: 1,
});
const current = { id: "current", secret: Buffer.alloc(32, 7) };
const unusedQuery = () => Promise.resolve({ items: [] as DynamoItem[] });
const unusedGet = () => Promise.resolve([] as (DynamoItem | null)[]);

describe("event repository", () => {
  it("separates canonical stored IDs from strict external filter slugs", async () => {
    const semantic =
      "event:mlb%3Amlb:%5B%22mlb%22%2C%5B%22boston%20red%20sox%22%2C%22new%20york%20yankees%22%5D%5D";
    expect(isCanonicalEntityId(semantic)).toBe(true);
    for (const invalid of [
      "event::mlb",
      "event:%3a",
      "event:%61",
      "event:%",
      "event:%00",
      "event:%C2%80",
      "event:__proto__",
      `event:${"a".repeat(507)}`,
    ])
      expect(isCanonicalEntityId(invalid), invalid).toBe(false);

    const projected = projectionItems(event(semantic));
    expect(
      validateProjection(projected.sport, "sport", event().updatedAt),
    ).toMatchObject({ eventId: semantic });
    const bad = {
      ...projected.sport,
      value: { ...projected.sport.value, eventId: "event:%3a" },
    };
    expect(() => validateProjection(bad, "sport", event().updatedAt)).toThrow(
      "invalid-projection",
    );

    const repository = new DynamoEventRepository(
      { queryPage: unusedQuery, transactGet: unusedGet },
      new EventCursorCodec({ current }),
      () => Promise.resolve(true),
    );
    await expect(
      repository.list(
        { sportKey: "mlb:mls", status: "scheduled", day: "2026-08-01" },
        1,
      ),
    ).rejects.toThrow("invalid-event-filter");
    await expect(
      repository.list(
        { sportKey: "mlb%3Amls", status: "scheduled", day: "2026-08-01" },
        1,
      ),
    ).rejects.toThrow("invalid-event-filter");
  });

  it("returns a DTO only when one transaction proves exact active cross-family material", async () => {
    const projected = projectionItems(event());
    const transactGet = vi.fn((keys: readonly { pk: string; sk: string }[]) =>
      Promise.resolve(
        keys.map(
          (key) =>
            [projected.pointer, projected.sport, projected.league].find(
              (item) => item.pk === key.pk && item.sk === key.sk,
            ) ?? null,
        ),
      ),
    );
    const repository = new DynamoEventRepository(
      { queryPage: unusedQuery, transactGet },
      new EventCursorCodec({ current }),
      () => Promise.resolve(true),
      () => new Date("2026-07-31T20:01:00.000Z"),
    );
    await expect(repository.detail("game-1")).resolves.toMatchObject({
      projectionState: "ready",
      item: {
        id: "game-1",
        participants: [
          { id: "away", label: "Away" },
          { id: "home", label: "Home" },
        ],
      },
    });
    const corruptLeague = {
      ...projected.league,
      value: {
        ...projected.league.value,
        participantLabels: ["Wrong", "Home"],
      },
    };
    transactGet.mockImplementation((keys) =>
      Promise.resolve(
        keys.map(
          (key) =>
            [projected.pointer, projected.sport, corruptLeague].find(
              (item) => item.pk === key.pk && item.sk === key.sk,
            ) ?? null,
        ),
      ),
    );
    await expect(repository.detail("game-1")).rejects.toThrow(
      "detail-material-mismatch",
    );
    const duplicateParticipants = {
      ...projected.sport,
      value: {
        ...projected.sport.value,
        participantIds: [
          projected.sport.value.participantIds[0]!,
          projected.sport.value.participantIds[0]!,
        ],
      },
    };
    transactGet.mockImplementation((keys) =>
      Promise.resolve(
        keys.map(
          (key) =>
            [projected.pointer, duplicateParticipants, projected.league].find(
              (item) => item.pk === key.pk && item.sk === key.sk,
            ) ?? null,
        ),
      ),
    );
    await expect(repository.detail("game-1")).rejects.toThrow(
      "invalid-projection",
    );
  });

  it("probes the physical successor so an exact terminal page has no phantom cursor", async () => {
    const projected = projectionItems(event());
    const queryPage = vi.fn((_pk: string, startSk: string | undefined) =>
      Promise.resolve(
        startSk
          ? { items: [] as DynamoItem[] }
          : { items: [projected.sport], lastEvaluatedSk: projected.sport.sk },
      ),
    );
    const repository = new DynamoEventRepository(
      { queryPage, transactGet: unusedGet },
      new EventCursorCodec({ current }),
      () => Promise.resolve(true),
      () => new Date("2026-07-31T20:01:00.000Z"),
    );
    const page = await repository.list(
      { sportKey: "mlb", status: "scheduled", day: "2026-07-31" },
      1,
    );
    expect(page.nextCursor).toBeNull();
    expect(queryPage).toHaveBeenCalledTimes(2);
  });

  it("accepts an unexpired previous-key token during acceptance even when token expiry is later", () => {
    const now = new Date("2026-07-31T20:00:00.000Z");
    const previous = { id: "old", secret: Buffer.alloc(32, 8) };
    const oldCodec = new EventCursorCodec({ current: previous });
    const token = oldCodec.encode("pk", "sk", now.toISOString(), now);
    const rotating = new EventCursorCodec({
      current,
      previous: {
        ...previous,
        acceptUntil: new Date(now.valueOf() + 60_000).toISOString(),
      },
    });
    expect(
      rotating.decode(token, "pk", new Date(now.valueOf() + 30_000)).lastSk,
    ).toBe("sk");
    expect(() =>
      rotating.decode(token, "pk", new Date(now.valueOf() + 60_001)),
    ).toThrow("invalid-cursor");
  });

  it("uses the original cursor snapshot for metadata assessment on every page", async () => {
    const rows = [
      projectionItems(event("game-1")).sport,
      projectionItems(event("game-2")).sport,
    ].sort((left, right) => left.sk.localeCompare(right.sk));
    let clock = new Date("2026-07-31T21:59:00.000Z");
    const repository = new DynamoEventRepository(
      {
        queryPage: (_pk, startSk, limit) => {
          const remaining = rows.filter((row) => !startSk || row.sk > startSk);
          const items = remaining.slice(0, limit);
          return Promise.resolve({
            items,
            ...(remaining.length > items.length && items.length
              ? { lastEvaluatedSk: items.at(-1)!.sk }
              : {}),
          });
        },
        transactGet: unusedGet,
      },
      new EventCursorCodec({ current }),
      () => Promise.resolve(true),
      () => clock,
    );
    const filter = {
      sportKey: "mlb",
      status: "scheduled" as const,
      day: "2026-07-31",
    };
    const first = await repository.list(filter, 1);
    expect(first.items[0]?.metadata.freshness.state).toBe("current");
    clock = new Date("2026-07-31T22:10:00.000Z");
    const second = await repository.list(filter, 1, first.nextCursor!);
    expect(second.items[0]?.metadata.evaluatedAt).toBe(first.snapshotAt);
    expect(second.items[0]?.metadata.freshness.state).toBe("current");
  });

  it("explains an uninitialized projection without manufacturing metadata", async () => {
    const repository = new DynamoEventRepository(
      { queryPage: unusedQuery, transactGet: unusedGet },
      new EventCursorCodec({ current }),
      () => Promise.resolve(false),
    );
    await expect(
      repository.list(
        { sportKey: "mlb", status: "scheduled", day: "2026-08-01" },
        20,
      ),
    ).resolves.toMatchObject({
      items: [],
      projectionState: "uninitialized",
      unavailableReason: "projection-uninitialized",
      snapshotAt: null,
    });
  });
});
