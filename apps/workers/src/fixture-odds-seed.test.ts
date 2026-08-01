import { normalizeFixtureOddsObservation } from "@find-the-edge/domain";
import { createEventHandler } from "@find-the-edge/api";
import {
  EventCursorCodec,
  MemoryEventIngestionStore,
  MemoryEventRepository,
  MemoryGamesRepository,
} from "@find-the-edge/database";
import { mvpFixtureOdds } from "@find-the-edge/providers";
import { describe, expect, it } from "vitest";
import {
  FixtureOddsSeedError,
  seedFixtureOdds,
  type FixtureOddsPersister,
} from "./fixture-odds-seed";
import { assertFixtureSeedEnvironment } from "./fixture-odds-seed-lambda";

class MemoryOdds implements FixtureOddsPersister {
  readonly snapshots = new Map<
    string,
    ReturnType<typeof normalizeFixtureOddsObservation>
  >();
  readonly inputs: Parameters<FixtureOddsPersister["persist"]>[0][] = [];
  failOnceAt: number | undefined;
  async persist(input: Parameters<FixtureOddsPersister["persist"]>[0]) {
    await Promise.resolve();
    this.inputs.push(input);
    if (this.failOnceAt === this.inputs.length) {
      this.failOnceAt = undefined;
      throw new Error("injected");
    }
    const value = normalizeFixtureOddsObservation(input.observation);
    const existing = this.snapshots.has(value.snapshotId);
    this.snapshots.set(value.snapshotId, value);
    return {
      snapshot: existing ? ("existing" as const) : ("created" as const),
      current: existing ? ("retained" as const) : ("advanced" as const),
      value,
    };
  }
  async batchGet(
    keys: readonly { readonly pk: string; readonly sk: "CURRENT" }[],
  ) {
    await Promise.resolve();
    return keys.flatMap((key) => {
      const value = [...this.snapshots.values()].find(
        (snapshot) => snapshot.partitionKey === key.pk,
      );
      return value ? [{ pk: key.pk, sk: key.sk, value }] : [];
    });
  }
}

describe("fixture odds seed", () => {
  it("converges on rerun without duplicate snapshots", async () => {
    const store = new MemoryEventIngestionStore();
    const odds = new MemoryOdds();
    const first = await seedFixtureOdds(store, odds);
    const second = await seedFixtureOdds(store, odds);
    expect(first).toMatchObject({
      events: 3,
      observations: 7,
      snapshotsCreated: 7,
    });
    expect(second).toMatchObject({ snapshotsExisting: 7, currentRetained: 7 });
    expect(odds.snapshots.size).toBe(7);
  });

  it("reads unchanged MLB and MLS semantic IDs through the joined games repository", async () => {
    const store = new MemoryEventIngestionStore();
    const odds = new MemoryOdds();
    await seedFixtureOdds(store, odds);
    const events = new MemoryEventRepository(
      store,
      new EventCursorCodec({
        current: { id: "test", secret: Buffer.alloc(32, 7) },
      }),
      () => new Date("2026-08-01T12:31:00.000Z"),
    );
    const games = new MemoryGamesRepository(events, odds);

    const mlbFirstDay = await games.list(
      {
        sportKey: "mlb",
        leagueKey: "mlb",
        status: "scheduled",
        day: "2026-08-01",
      },
      50,
    );
    const mlbSecondDay = await games.list(
      {
        sportKey: "mlb",
        leagueKey: "mlb",
        status: "scheduled",
        day: "2026-08-02",
      },
      50,
    );
    const mls = await games.list(
      {
        sportKey: "soccer",
        leagueKey: "mls",
        status: "scheduled",
        day: "2026-08-01",
      },
      50,
    );
    expect(mlbFirstDay.items).toHaveLength(1);
    expect(mlbSecondDay.items).toHaveLength(1);
    expect(mls.items).toHaveLength(1);
    const allGames = [
      ...mlbFirstDay.items,
      ...mlbSecondDay.items,
      ...mls.items,
    ];
    expect(
      allGames.map((game) => ({
        id: game.id,
        version: game.version,
        participants: game.participants.map(({ id, label }) => ({ id, label })),
        odds: game.odds,
      })),
    ).toEqual([
      {
        id: "event:mlb%3Amlb:2026-regular-boston-new-york-001",
        version: 1,
        participants: [
          { id: "participant:mlb%3Amlb:boston", label: "Boston" },
          { id: "participant:mlb%3Amlb:new%20york", label: "New York" },
        ],
        odds: {
          state: "available",
          selections: [
            {
              marketKey: "moneyline",
              selectionKey: "away",
              selectionLabel: "Boston",
              sportsbookId: "fixture-book",
              sportsbookLabel: "Fixture Book",
              americanOdds: 120,
              observedAt: "2026-08-01T12:00:00.000Z",
              retrievedAt: "2026-08-01T12:00:00.000Z",
            },
          ],
        },
      },
      {
        id: "event:mlb%3Amlb:2026-regular-chicago-detroit-001",
        version: 1,
        participants: [
          { id: "participant:mlb%3Amlb:chicago", label: "Chicago" },
          { id: "participant:mlb%3Amlb:detroit", label: "Detroit" },
        ],
        odds: {
          state: "available",
          selections: [
            {
              marketKey: "moneyline",
              selectionKey: "away",
              selectionLabel: "Chicago",
              sportsbookId: "fixture-book",
              sportsbookLabel: "Fixture Book",
              americanOdds: -105,
              observedAt: "2026-08-01T12:01:00.000Z",
              retrievedAt: "2026-08-01T12:01:00.000Z",
            },
          ],
        },
      },
      {
        id: "event:soccer%3Amls:2026-regular-miami-atlanta-001",
        version: 1,
        participants: [
          { id: "participant:soccer%3Amls:miami", label: "Miami" },
          { id: "participant:soccer%3Amls:atlanta", label: "Atlanta" },
        ],
        odds: {
          state: "available",
          selections: [
            {
              marketKey: "three_way_moneyline",
              selectionKey: "away",
              selectionLabel: "Miami",
              sportsbookId: "fixture-book",
              sportsbookLabel: "Fixture Book",
              americanOdds: 145,
              observedAt: "2026-08-01T12:02:00.000Z",
              retrievedAt: "2026-08-01T12:02:00.000Z",
            },
          ],
        },
      },
    ]);

    const authenticated = createEventHandler(events, games, () => undefined);
    const mlbResponse = await authenticated({
      route: "games",
      subject: "fixture-user",
      scopes: ["events:read"],
      query: {
        sport: "mlb",
        league: "mlb",
        status: "scheduled",
        day: "2026-08-01",
        limit: "50",
      },
    });
    const mlsResponse = await authenticated({
      route: "games",
      subject: "fixture-user",
      scopes: ["events:read"],
      query: {
        sport: "soccer",
        league: "mls",
        status: "scheduled",
        day: "2026-08-01",
        limit: "50",
      },
    });
    expect(mlbResponse.statusCode).toBe(200);
    expect(mlsResponse.statusCode).toBe(200);
    expect(JSON.parse(mlbResponse.body)).toMatchObject({
      items: [mlbFirstDay.items[0]],
    });
    expect(JSON.parse(mlsResponse.body)).toMatchObject({
      items: [mls.items[0]],
    });
  });

  it("binds a rerun to the current canonical version", async () => {
    const store = new MemoryEventIngestionStore();
    const odds = new MemoryOdds();
    await seedFixtureOdds(store, odds);
    const mapping = await store.resolveExactCanonicalBinding({
      providerId: "fixture-development",
      providerEventId: "mlb-1",
      sportKey: "mlb" as never,
      leagueKey: "mlb",
    });
    expect(mapping).not.toBeNull();
    store.events.set(mapping!.id, {
      ...mapping!,
      version: mapping!.version + 1,
    });
    await seedFixtureOdds(store, odds);
    const latest = odds.inputs
      .filter((input) => input.providerEventId === "mlb-1")
      .slice(-2);
    expect(
      latest.map((input) => input.observation.canonicalEventVersion),
    ).toEqual([2, 2]);
  });

  it("resumes safely after a partially persisted invocation", async () => {
    const store = new MemoryEventIngestionStore();
    const odds = new MemoryOdds();
    odds.failOnceAt = 3;
    await expect(seedFixtureOdds(store, odds)).rejects.toBeInstanceOf(
      FixtureOddsSeedError,
    );
    expect(odds.snapshots.size).toBe(2);
    const result = await seedFixtureOdds(store, odds);
    expect(result).toMatchObject({ observations: 7 });
    expect(odds.snapshots.size).toBe(7);
  });

  it("preflights exact schedule coverage before any write", async () => {
    const store = new MemoryEventIngestionStore();
    const odds = new MemoryOdds();
    await expect(
      seedFixtureOdds(store, odds, { fixtures: mvpFixtureOdds.slice(1) }),
    ).rejects.toThrow("schedule and odds fixture coverage differ: mlb");
    expect(store.events.size).toBe(0);
    expect(odds.inputs).toHaveLength(0);
  });

  it("rejects duplicate scoped provider events before any write", async () => {
    const store = new MemoryEventIngestionStore();
    const odds = new MemoryOdds();
    await expect(
      seedFixtureOdds(store, odds, {
        fixtures: [mvpFixtureOdds[0]!, mvpFixtureOdds[0]!],
      }),
    ).rejects.toThrow("duplicate scoped odds provider event");
    expect(store.events.size).toBe(0);
    expect(odds.inputs).toHaveLength(0);
  });

  it("preserves typed market context and cause for persistence failures", async () => {
    const store = new MemoryEventIngestionStore();
    const odds = new MemoryOdds();
    odds.failOnceAt = 1;
    const error = await seedFixtureOdds(store, odds).catch(
      (value: unknown) => value,
    );
    expect(error).toBeInstanceOf(FixtureOddsSeedError);
    if (!(error instanceof FixtureOddsSeedError)) throw error;
    expect(error).toMatchObject({
      providerEventId: "mlb-1",
      marketKey: "moneyline",
      selectionKey: "away",
    });
    expect(error.cause).toBeInstanceOf(Error);
    expect((error.cause as Error).message).toBe("injected");
    expect(error.message).toContain("mlb-1/moneyline/away");
    expect(error.message).not.toContain("injected");
  });

  it("fails closed when an exact mapping is unavailable", async () => {
    class MissingBindingStore extends MemoryEventIngestionStore {
      override async resolveExactCanonicalBinding() {
        await Promise.resolve();
        return null;
      }
    }
    await expect(
      seedFixtureOdds(new MissingBindingStore(), new MemoryOdds()),
    ).rejects.toThrow("exact canonical binding unavailable: mlb-1");
  });
});

describe("fixture odds seed environment", () => {
  it("accepts only explicitly enabled dev", () => {
    expect(
      assertFixtureSeedEnvironment({
        FTE_AWS_STAGE: "dev",
        FTE_FIXTURE_ODDS_SEED_ENABLED: "true",
        FTE_EVENT_TABLE: "events",
      }),
    ).toBe("events");
    expect(() =>
      assertFixtureSeedEnvironment({
        FTE_AWS_STAGE: "prod",
        FTE_FIXTURE_ODDS_SEED_ENABLED: "true",
        FTE_EVENT_TABLE: "events",
      }),
    ).toThrow("restricted to the dev stage");
    expect(() =>
      assertFixtureSeedEnvironment({
        FTE_AWS_STAGE: "dev",
        FTE_EVENT_TABLE: "events",
      }),
    ).toThrow("disabled");
    expect(
      assertFixtureSeedEnvironment({
        FTE_AWS_STAGE: "dev",
        FTE_FIXTURE_ODDS_SEED_ENABLED: "true",
        FTE_EVENT_TABLE: "  events  ",
      }),
    ).toBe("events");
    expect(() =>
      assertFixtureSeedEnvironment({
        FTE_AWS_STAGE: "dev",
        FTE_FIXTURE_ODDS_SEED_ENABLED: "true",
        FTE_EVENT_TABLE: "   ",
      }),
    ).toThrow("required and nonblank");
  });
});
