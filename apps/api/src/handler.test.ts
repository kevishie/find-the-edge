import { describe, expect, it, vi } from "vitest";
import {
  assessEventMetadata,
  type GameOddsCellDto,
  type GameOddsComparisonDto,
} from "@find-the-edge/domain";
import { impliedProbability } from "@find-the-edge/odds";
import {
  EventStorageError,
  EventCursorCodec,
  MemoryCohortRepository,
  MemoryOddsHistoryRepository,
  RankedOpportunityUnavailableError,
  type GamesRepository,
  type EventRepository,
  type OddsHistoryRepository,
  type RankedOpportunityRepository,
} from "@find-the-edge/database";
import { createEventHandler } from "./handler";
import { parseCursorSecretRing } from "./secrets";
const repository: EventRepository = {
  list: async () => ({
    ...(await Promise.resolve({})),
    items: [],
    nextCursor: null,
    projectionState: "ready",
    evaluationState: "complete",
    hasMoreUnknown: false,
    snapshotAt: new Date().toISOString(),
    freshness: null,
    unavailableReason: null,
  }),
  detail: async () => {
    await Promise.resolve();
    return { projectionState: "ready", item: null, unavailableReason: null };
  },
};

it("serves the public provider-status contract without query parameters", async () => {
  const providerStatus = vi.fn(() =>
    Promise.resolve({
      schemaVersion: "provider-status-page-v1" as const,
      snapshotAt: "2026-08-07T12:00:00.000Z",
      evaluationState: "complete" as const,
      summary: {
        total: 0,
        healthy: 0,
        partial: 0,
        stale: 0,
        outage: 0,
        unknown: 0,
        impacted: 0,
      },
      items: [],
    }),
  );
  const handler = createEventHandler(
    repository,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    providerStatus,
  );
  const result = await handler({ route: "provider-status", method: "GET" });
  expect(result.statusCode).toBe(200);
  expect(providerStatus).toHaveBeenCalledOnce();
  expect(
    await handler({ route: "provider-status", query: { leaked: "1" } }),
  ).toMatchObject({ statusCode: 400 });
});
const gamesWithDetail = (
  detail: NonNullable<GamesRepository["detail"]>,
): GamesRepository => ({
  list: () => Promise.reject(new Error("unexpected-games-list")),
  detail,
});
const withOddsComparison = <T extends object>(
  item: T,
  cells: Readonly<Record<string, GameOddsCellDto>> = {},
): T & Pick<GameOddsComparisonDto, "oddsComparison"> => ({
  ...item,
  oddsComparison: {
    targetSportsbookId: "hardrock",
    targetQualified: false,
    generatedAt: "2026-08-01T15:00:00.000Z",
    sportsbooks: [{ id: "hardrock", label: "Hard Rock Bet", target: true }],
    markets: Object.keys(cells).length
      ? [
          {
            marketKey: "moneyline",
            selections: [
              {
                selectionKey: "away",
                selectionLabel: "Away",
                cells,
              },
            ],
          },
        ]
      : [],
  },
});
const historyEventRepository: EventRepository = {
  ...repository,
  detail: async (eventId) => {
    await Promise.resolve();
    return {
      projectionState: "ready",
      item:
        eventId === "event:one"
          ? ({
              id: eventId,
              version: 7,
              sportKey: "mlb",
              participants: [
                { id: "away", label: "Away" },
                { id: "home", label: "Home" },
              ],
            } as never)
          : null,
      unavailableReason: null,
    };
  },
};
describe("event API", () => {
  it("logs bounded diagnostics for unexpected failures", async () => {
    const logs: Readonly<Record<string, unknown>>[] = [];
    const broken: EventRepository = {
      ...repository,
      list: () => Promise.reject(new Error("projection-row-invalid")),
    };
    const result = await createEventHandler(broken, (entry) =>
      logs.push(entry),
    )({
      route: "list",
      subject: "u",
      scopes: ["events/events:read"],
      query: {
        sport: "mlb",
        status: "scheduled",
        day: "2026-08-05",
      },
    });

    expect(result.statusCode).toBe(500);
    expect(logs).toContainEqual({
      event: "event-api-internal-failure",
      route: "list",
      errorName: "Error",
      errorMessage: "projection-row-invalid",
    });
  });

  it.each([
    ["scheduled", "2026-08-01T13:00:00.000Z", "complete", "current"],
    ["scheduled", "2026-08-01T10:00:00.000Z", "complete", "stale"],
    ["unknown", "2026-08-01T13:00:00.000Z", "partial", "current"],
    ["postponed", "2026-08-01T13:00:00.000Z", "complete", "current"],
    ["cancelled", "2026-08-01T10:00:00.000Z", "complete", "stale"],
    ["scheduled", null, "unavailable", "unavailable"],
  ] as const)(
    "serializes %s lifecycle with independent %s evidence",
    async (eventStatus, evidenceAt, availability, freshnessState) => {
      const evaluatedAt = "2026-08-01T14:00:00.000Z";
      const item = {
        id: "event:one",
        version: 1,
        sportKey: "mlb",
        leagueKey: "mlb",
        competition: { key: "mlb", state: "provisional" as const },
        participants: [
          { id: "away", label: "Away" },
          { id: "home", label: "Home" },
        ],
        startsAt: "2026-08-01T20:00:00.000Z",
        eastern: {
          timeZone: "America/New_York" as const,
          calendarDay: "2026-08-01",
          display: "Aug 1",
        },
        status: eventStatus,
        freshness: evidenceAt,
        metadata: assessEventMetadata(eventStatus, evidenceAt, evaluatedAt),
      };
      const events: EventRepository = {
        list: (filter, limit, cursor) => repository.list(filter, limit, cursor),
        detail: () =>
          Promise.resolve({
            projectionState: "ready",
            item,
            unavailableReason: null,
          }),
      };
      const result = await createEventHandler(
        events,
        gamesWithDetail(() =>
          Promise.resolve({
            projectionState: "ready",
            item: withOddsComparison(item),
            unavailableReason: null,
          }),
        ),
        () => undefined,
      )({
        route: "detail",
        eventId: item.id,
      });
      expect(result.statusCode).toBe(200);
      expect(JSON.parse(result.body)).toMatchObject({
        item: {
          status: eventStatus,
          metadata: {
            availability,
            lifecycle: { state: eventStatus },
            freshness: { state: freshnessState },
          },
        },
      });
    },
  );

  it("returns an explicit envelope reason while projections initialize", async () => {
    const logs: Readonly<Record<string, unknown>>[] = [];
    const events: EventRepository = {
      list: (filter, limit, cursor) => repository.list(filter, limit, cursor),
      detail: () =>
        Promise.resolve({
          projectionState: "uninitialized",
          item: null,
          unavailableReason: "projection-uninitialized",
        }),
    };
    const result = await createEventHandler(
      events,
      gamesWithDetail(() =>
        Promise.resolve({
          projectionState: "uninitialized",
          item: null,
          unavailableReason: "projection-uninitialized",
        }),
      ),
      (entry) => logs.push(entry),
    )({
      route: "detail",
      eventId: "event:one",
    });
    expect(JSON.parse(result.body)).toEqual({
      projectionState: "uninitialized",
      item: null,
      unavailableReason: "projection-uninitialized",
    });
    expect(logs.at(-1)).toMatchObject({ UnavailableEventMetadata: 1 });
  });

  it("emits bounded odds-cell degradation while preserving metadata metrics", async () => {
    const logs: Readonly<Record<string, unknown>>[] = [];
    const evaluatedAt = "2026-08-01T15:00:00.000Z";
    const item = withOddsComparison(
      {
        id: "event:telemetry-secret",
        version: 1,
        sportKey: "mlb",
        leagueKey: "mlb",
        competition: { key: "mlb", state: "provisional" as const },
        participants: [
          { id: "away", label: "Away" },
          { id: "home", label: "Home" },
        ],
        startsAt: "2026-08-01T20:00:00.000Z",
        eastern: {
          timeZone: "America/New_York" as const,
          calendarDay: "2026-08-01",
          display: "Aug 1",
        },
        status: "unknown" as const,
        freshness: "2026-08-01T12:00:00.000Z",
        metadata: assessEventMetadata(
          "unknown",
          "2026-08-01T12:00:00.000Z",
          evaluatedAt,
        ),
      },
      {
        hardrock: {
          state: "stale",
          eligible: false,
          reason: "price-stale",
          evidenceAt: "2026-08-01T12:00:00.000Z",
          americanOdds: 120,
          observedAt: "2026-08-01T12:00:00.000Z",
          retrievedAt: "2026-08-01T12:00:01.000Z",
        },
        draftkings: {
          state: "partial",
          eligible: false,
          reason: "market-incomplete",
          evidenceAt: "2026-08-01T12:05:00.000Z",
        },
        fanduel: {
          state: "suspended",
          eligible: false,
          reason: "market-suspended",
          evidenceAt: "2026-08-01T12:06:00.000Z",
        },
        betmgm: {
          state: "unavailable",
          eligible: false,
          reason: "price-unavailable",
          evidenceAt: null,
        },
      },
    );
    const result = await createEventHandler(
      repository,
      gamesWithDetail(() =>
        Promise.resolve({
          projectionState: "ready",
          item,
          unavailableReason: null,
        }),
      ),
      (entry) => logs.push(entry),
    )({ route: "detail", eventId: item.id });

    expect(result.statusCode).toBe(200);
    expect(logs.at(-1)).toMatchObject({
      StaleEventMetadata: 1,
      PartialEventMetadata: 1,
      UnavailableEventMetadata: 0,
      StaleOddsCells: 1,
      PartialOddsCells: 1,
      SuspendedOrUnavailableOddsCells: 2,
    });
    const serialized = JSON.stringify(logs.at(-1));
    expect(serialized).not.toContain(item.id);
    expect(serialized).not.toContain("hardrock");
    expect(serialized).toContain(
      '"Name":"SuspendedOrUnavailableOddsCells","Unit":"Count"',
    );
  });

  it("emits only bounded aggregate metadata counts", async () => {
    const logs: Readonly<Record<string, unknown>>[] = [];
    const evaluatedAt = "2026-08-01T15:00:00.000Z";
    const stale = assessEventMetadata(
      "unknown",
      "2026-08-01T12:00:00.000Z",
      evaluatedAt,
    );
    const events: EventRepository = {
      list: () =>
        Promise.resolve({
          items: [
            {
              id: "event:one",
              version: 1,
              sportKey: "mlb",
              leagueKey: "mlb",
              competition: { key: "mlb", state: "provisional" },
              participants: [
                { id: "away", label: "Away" },
                { id: "home", label: "Home" },
              ],
              startsAt: "2026-08-01T20:00:00.000Z",
              eastern: {
                timeZone: "America/New_York",
                calendarDay: "2026-08-01",
                display: "Aug 1",
              },
              status: "unknown",
              freshness: "2026-08-01T12:00:00.000Z",
              metadata: stale,
            },
          ],
          nextCursor: null,
          projectionState: "ready",
          evaluationState: "complete",
          hasMoreUnknown: false,
          snapshotAt: evaluatedAt,
          freshness: "2026-08-01T12:00:00.000Z",
          unavailableReason: null,
        }),
      detail: () =>
        Promise.resolve({
          projectionState: "ready",
          item: null,
          unavailableReason: null,
        }),
    };
    const result = await createEventHandler(events, undefined, (entry) =>
      logs.push(entry),
    )({
      route: "list",
      subject: "user",
      scopes: ["events/events:read"],
      query: { sport: "mlb", status: "unknown", day: "2026-08-01" },
    });
    expect(result.statusCode).toBe(200);
    expect(logs.at(-1)).toMatchObject({
      StaleEventMetadata: 1,
      PartialEventMetadata: 1,
      UnavailableEventMetadata: 0,
    });
    expect(JSON.stringify(logs.at(-1))).not.toContain("event:one");
  });
  it("serves authenticated immutable performance cohorts", async () => {
    const cohorts = new MemoryCohortRepository();
    await cohorts.putCohort({
      definition: {
        window: {
          from: "2026-07-01T00:00:00.000Z",
          to: "2026-08-01T00:00:00.000Z",
        },
        filters: { wagerMode: "paper" },
        policyVersions: {
          cohort: "cohort-v1",
          performance: "performance-v1",
          oddsBand: "odds-band-v1",
          calibration: "calibration-deciles-v1",
          clv: "clv-same-book-15m-v1",
        },
      },
      cutoff: "2026-08-02T00:00:00.000Z",
      members: [],
    });
    const result = await createEventHandler(
      historyEventRepository,
      undefined,
      undefined,
      undefined,
      cohorts,
    )({
      route: "performance-list",
      subject: "u",
      scopes: ["events/events:read"],
    });
    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body) as {
      readonly items: readonly unknown[];
    };
    expect(body.items).toHaveLength(1);
  });
  it("serves exact performance report and member evidence routes", async () => {
    const cohorts = new MemoryCohortRepository();
    const cohort = await cohorts.putCohort({
      definition: {
        window: {
          from: "2026-07-01T00:00:00.000Z",
          to: "2026-08-01T00:00:00.000Z",
        },
        filters: { wagerMode: "paper" },
        policyVersions: {
          cohort: "cohort-v1",
          performance: "performance-v1",
          oddsBand: "odds-band-v1",
          calibration: "calibration-deciles-v1",
          clv: "clv-same-book-15m-v1",
        },
      },
      cutoff: "2026-08-02T00:00:00.000Z",
      members: [],
    });
    const report = await cohorts.putReport({
      facets: {
        sports: [],
        leagues: [],
        markets: [],
        oddsBands: [],
        strategyVersions: [],
        modelVersions: [],
      },
      cohortId: cohort.cohortId,
      cutoff: cohort.cutoff,
      evidenceDigest: "a".repeat(64),
      revision: 1,
      createdAt: cohort.cutoff,
      metrics: { source: 0 },
    });
    const handler = createEventHandler(
      repository,
      undefined,
      undefined,
      undefined,
      cohorts,
    );
    const detail = await handler({
      route: "performance-detail",
      eventId: report.reportId,
    });
    expect(detail.statusCode).toBe(200);
    expect(JSON.parse(detail.body)).toMatchObject({
      reportId: report.reportId,
    });
    const members = await handler({
      route: "performance-members",
      eventId: cohort.cohortId,
    });
    expect(members.statusCode).toBe(200);
    expect(JSON.parse(members.body)).toMatchObject({
      cohortId: cohort.cohortId,
      items: [],
    });
    expect(
      (
        await handler({
          route: "performance-detail",
          eventId: `performance-report:${"f".repeat(64)}`,
        })
      ).statusCode,
    ).toBe(404);
  });
  it("serves games through the scoped authenticated repository", async () => {
    const canonicalId =
      "event:mlb%3Amlb:%5B%22mlb%22%2C%5B%22boston%20red%20sox%22%2C%22new%20york%20yankees%22%5D%5D";
    const games: GamesRepository = {
      list: async () => ({
        ...(await Promise.resolve({})),
        items: [
          {
            id: canonicalId,
            version: 1,
            sportKey: "mlb",
            leagueKey: "mlb",
            competition: { key: "mlb", state: "provisional" },
            participants: [
              { id: "participant:mlb%3Amlb:boston", label: "Boston" },
              { id: "participant:mlb%3Amlb:new%20york", label: "New York" },
            ],
            startsAt: "2026-08-01T23:05:00.000Z",
            eastern: {
              timeZone: "America/New_York",
              calendarDay: "2026-08-01",
              display: "Aug 1, 2026, 7:05 PM",
            },
            status: "scheduled",
            freshness: "2026-08-01T12:30:00.000Z",
            metadata: assessEventMetadata(
              "scheduled",
              "2026-08-01T12:30:00.000Z",
              "2026-08-01T13:00:00.000Z",
            ),
            odds: { state: "unavailable" },
          },
        ],
        nextCursor: null,
        projectionState: "ready" as const,
        evaluationState: "complete" as const,
        hasMoreUnknown: false,
        snapshotAt: null,
        freshness: null,
        unavailableReason: null,
      }),
    };
    const result = await createEventHandler(
      repository,
      games,
    )({
      route: "games",
      subject: "u",
      scopes: ["events/events:read"],
      query: {
        sport: "mlb",
        status: "scheduled",
        day: "2026-08-01",
        limit: "50",
      },
    });
    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toMatchObject({
      items: [{ id: canonicalId }],
      projectionState: "ready",
    });
  });
  it("serves strict public chart-ready odds history", async () => {
    const reads: unknown[] = [];
    const logs: Readonly<Record<string, unknown>>[] = [];
    const history: OddsHistoryRepository = {
      validateSportsbookIds: () => undefined,
      list: (input) => {
        reads.push(input);
        return Promise.resolve({
          eventId: input.eventId,
          generatedAt: "2026-08-05T13:00:00.000Z",
          markerScope: "page",
          series: [],
          coverage: [],
          nextCursor: null,
        });
      },
    };
    const handler = createEventHandler(
      historyEventRepository,
      undefined,
      (entry) => logs.push(entry),
      undefined,
      undefined,
      undefined,
      undefined,
      history,
    );
    const result = await handler({
      route: "odds-history",
      eventId: "event:one",
      query: {
        from: "2026-08-05T12:00:00.000Z",
        to: "2026-08-05T13:00:00.000Z",
        limit: "100",
        market: "moneyline",
        selection: "participant:away",
        books: "draftkings,fanduel",
      },
    });
    expect(result.statusCode).toBe(200);
    expect(reads).toEqual([
      {
        eventId: "event:one",
        canonicalEventVersion: 7,
        from: "2026-08-05T12:00:00.000Z",
        to: "2026-08-05T13:00:00.000Z",
        limit: 100,
        marketKey: "moneyline",
        selectionKey: "participant:away",
        sportsbookIds: ["draftkings", "fanduel"],
      },
    ]);
    expect(JSON.parse(result.body)).toEqual({
      eventId: "event:one",
      generatedAt: "2026-08-05T13:00:00.000Z",
      markerScope: "page",
      series: [],
      coverage: [],
      nextCursor: null,
    });
    expect(logs.at(-1)).toMatchObject({
      OddsHistorySeries: 0,
      OddsHistorySportsbooks: 0,
      OddsHistoryPoints: 0,
    });
    expect(JSON.stringify(logs.at(-1))).not.toContain("event:one");
  });

  it("rejects malformed odds-history queries before reading storage", async () => {
    let reads = 0;
    const history: OddsHistoryRepository = {
      validateSportsbookIds: () => undefined,
      list: async () => {
        await Promise.resolve();
        reads += 1;
        throw new Error("must-not-read");
      },
    };
    const handler = createEventHandler(
      historyEventRepository,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      history,
    );
    for (const query of [
      {},
      { from: "bad", to: "2026-08-05T13:00:00.000Z" },
      {
        from: "2026-08-05T12:00:00.000Z",
        to: "2026-08-05T13:00:00.000Z",
        limit: "0",
      },
      {
        from: "2026-08-05T12:00:00.000Z",
        to: "2026-08-05T13:00:00.000Z",
        unknown: "x",
      },
      {
        from: "2026-08-05T12:00:00.000Z",
        to: "2026-08-05T13:00:00.000Z",
        cursor: "x".repeat(4097),
      },
      {
        from: "2026-08-05T12:00:00.000Z",
        to: "2026-08-05T13:00:00.000Z",
        market: "bad value",
      },
      {
        from: "2026-08-05T12:00:00.000Z",
        to: "2026-08-05T13:00:00.000Z",
        market: "player-prop",
      },
      {
        from: "2026-08-05T12:00:00.000Z",
        to: "2026-08-05T13:00:00.000Z",
        books: "draftkings,draftkings",
      },
      {
        from: "2026-08-05T12:00:00.000Z",
        to: "2026-08-05T13:00:00.000Z",
        selection: "participant:%away",
      },
      {
        from: "2026-08-05T12:00:00.000Z",
        to: "2026-08-05T13:00:00.000Z",
        books: "DraftKings",
      },
    ]) {
      const result = await handler({
        route: "odds-history",
        eventId: "event:mlb:history",
        query,
      });
      expect(result.statusCode).toBe(400);
    }
    expect(reads).toBe(0);
  });

  it("rejects a malformed odds-history cursor without exposing internals", async () => {
    const history = new MemoryOddsHistoryRepository(
      [],
      new EventCursorCodec({
        current: { id: "test", secret: new Uint8Array(32).fill(3) },
      }),
      { draftkings: "DraftKings" },
      impliedProbability,
      () => new Date("2026-08-05T13:00:00.000Z"),
    );
    const result = await createEventHandler(
      historyEventRepository,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      history,
    )({
      route: "odds-history",
      eventId: "event:one",
      query: {
        from: "2026-08-05T12:00:00.000Z",
        to: "2026-08-05T13:00:00.000Z",
        cursor: "not-valid",
      },
    });
    expect(result.statusCode).toBe(400);
    expect(result.body).toBe('{"error":"invalid-request"}');
  });
  it("rejects an unapproved requested sportsbook", async () => {
    let eventReads = 0;
    const history = new MemoryOddsHistoryRepository(
      [],
      new EventCursorCodec({
        current: { id: "test", secret: new Uint8Array(32).fill(3) },
      }),
      { draftkings: "DraftKings" },
      impliedProbability,
      () => new Date("2026-08-05T13:00:00.000Z"),
    );
    const result = await createEventHandler(
      {
        ...historyEventRepository,
        detail: async (...args) => {
          eventReads += 1;
          return historyEventRepository.detail(...args);
        },
      },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      history,
    )({
      route: "odds-history",
      eventId: "event:one",
      query: {
        from: "2026-08-05T12:00:00.000Z",
        to: "2026-08-05T13:00:00.000Z",
        books: "unknownbook",
      },
    });

    expect(result.statusCode).toBe(400);
    expect(result.body).toBe('{"error":"invalid-request"}');
    expect(eventReads).toBe(0);
  });

  it("accepts a canonical percent-encoded participant selection", async () => {
    const reads: unknown[] = [];
    const history: OddsHistoryRepository = {
      validateSportsbookIds: () => undefined,
      list: async (input) => {
        await Promise.resolve();
        reads.push(input);
        return {
          eventId: input.eventId,
          generatedAt: "2026-08-05T13:00:00.000Z",
          markerScope: "page",
          series: [],
          coverage: [],
          nextCursor: null,
        };
      },
    };
    const result = await createEventHandler(
      {
        ...historyEventRepository,
        detail: async () => {
          await Promise.resolve();
          return {
            projectionState: "ready" as const,
            item: {
              id: "event:one",
              version: 7,
              sportKey: "mlb",
              participants: [
                { id: "club:42", label: "Away" },
                { id: "club:43", label: "Home" },
              ],
            } as never,
            unavailableReason: null,
          };
        },
      },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      history,
    )({
      route: "odds-history",
      eventId: "event:one",
      query: {
        from: "2026-08-05T12:00:00.000Z",
        to: "2026-08-05T13:00:00.000Z",
        market: "moneyline",
        selection: "participant:club%3A42",
      },
    });
    expect(result.statusCode).toBe(200);
    expect(reads).toHaveLength(1);
  });
  it("distinguishes a missing game from an empty history", async () => {
    let reads = 0;
    const history: OddsHistoryRepository = {
      validateSportsbookIds: () => undefined,
      list: async () => {
        await Promise.resolve();
        reads += 1;
        throw new Error("must-not-read");
      },
    };
    const result = await createEventHandler(
      repository,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      history,
    )({
      route: "odds-history",
      eventId: "event:missing",
      query: {
        from: "2026-08-05T12:00:00.000Z",
        to: "2026-08-05T13:00:00.000Z",
      },
    });
    expect(result.statusCode).toBe(404);
    expect(result.body).toBe('{"error":"not-found"}');
    expect(reads).toBe(0);
  });
  it("rejects colon and percent external filters before repository selection", async () => {
    let reads = 0;
    const games = {
      list: async () => {
        await Promise.resolve();
        reads += 1;
        throw new Error("must-not-read");
      },
    };
    for (const query of [
      { sport: "mlb:mls", status: "scheduled", day: "2026-08-01" },
      { sport: "mlb%3Amls", status: "scheduled", day: "2026-08-01" },
      {
        sport: "mlb",
        league: "mlb%3Amls",
        status: "scheduled",
        day: "2026-08-01",
      },
    ]) {
      const result = await createEventHandler(
        repository,
        games,
      )({
        route: "games",
        subject: "u",
        scopes: ["events/events:read"],
        query,
      });
      expect(result.statusCode).toBe(400);
    }
    expect(reads).toBe(0);
  });
  it("accepts every games lifecycle but keeps splits scheduled-only", async () => {
    let reads = 0;
    const games = {
      list: async () => {
        await Promise.resolve();
        reads += 1;
        return {
          items: [],
          nextCursor: null,
          projectionState: "ready" as const,
          evaluationState: "complete" as const,
          hasMoreUnknown: false,
          snapshotAt: null,
          freshness: null,
          unavailableReason: null,
        };
      },
    };
    for (const status of [
      "scheduled",
      "postponed",
      "cancelled",
      "started",
      "completed",
      "unknown",
    ]) {
      const result = await createEventHandler(
        repository,
        games,
      )({
        route: "games",
        query: { sport: "mlb", status, day: "2026-08-01" },
      });
      expect(result.statusCode).toBe(200);
    }
    expect(reads).toBe(6);
    for (const [route, sport, status] of [
      ["games", "nfl", "completed"],
      ["games", "mlb", "invalid"],
      ["splits", "mlb", "completed"],
    ] as const) {
      const result = await createEventHandler(
        repository,
        games,
      )({
        route,
        query: { sport, status, day: "2026-08-01" },
      });
      expect(result.statusCode).toBe(400);
    }
    expect(reads).toBe(6);
    const unknown = await createEventHandler(
      repository,
      games,
    )({
      route: "games",
      subject: "u",
      scopes: ["events/events:read"],
      query: {
        sport: "mlb",
        status: "scheduled",
        day: "2026-08-01",
        extra: "ignored",
      },
    });
    expect(unknown.statusCode).toBe(400);
    expect(reads).toBe(6);
  });
  it("keeps internal listing scoped and fails closed without joined detail", async () => {
    expect(
      (await createEventHandler(repository)({ route: "list" })).statusCode,
    ).toBe(401);
    expect(
      (
        await createEventHandler(repository)({
          route: "list",
          subject: "u",
          scopes: [],
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (await createEventHandler(repository)({ route: "detail" })).statusCode,
    ).toBe(500);
  });
  it("does not fall back to the legacy event-detail envelope", async () => {
    let legacyDetailReads = 0;
    const logs: Readonly<Record<string, unknown>>[] = [];
    const legacy: EventRepository = {
      ...repository,
      detail: async () => {
        await Promise.resolve();
        legacyDetailReads += 1;
        return {
          projectionState: "ready",
          item: null,
          unavailableReason: null,
        };
      },
    };
    const result = await createEventHandler(legacy, (entry) =>
      logs.push(entry),
    )({ route: "detail", eventId: "event:one" });

    expect(result.statusCode).toBe(500);
    expect(result.body).toBe('{"error":"internal-error"}');
    expect(result.body).not.toContain("games-detail-repository-not-configured");
    expect(legacyDetailReads).toBe(0);
    expect(logs[0]).toMatchObject({
      event: "event-api-internal-failure",
      route: "detail",
      errorName: "Error",
      errorMessage: "games-detail-repository-not-configured",
    });
  });
  it("maps only input errors to 400 and redacts storage errors", async () => {
    expect(
      (
        await createEventHandler(repository)({
          route: "list",
          subject: "u",
          scopes: ["events/events:read"],
          query: {
            sport: "mlb",
            status: "scheduled",
            day: "2026-02-30",
            cursor: "",
          },
        })
      ).statusCode,
    ).toBe(400);
    const broken = {
      ...repository,
      list: async () => {
        await Promise.resolve();
        throw new EventStorageError("secret-storage-detail");
      },
    };
    const result = await createEventHandler(broken)({
      route: "list",
      subject: "u",
      scopes: ["events/events:read"],
      query: { sport: "mlb", status: "scheduled", day: "2026-08-01" },
    });
    expect(result.statusCode).toBe(500);
    expect(result.body).not.toContain("secret-storage-detail");
  });
  it("requires an exact all-or-none canonically encoded secret ring", () => {
    const secret = Buffer.alloc(32, 7).toString("base64");
    expect(
      parseCursorSecretRing(
        JSON.stringify({
          currentId: "current",
          currentSecret: secret,
          currentCreatedAt: "2026-07-31T00:00:00.000Z",
        }),
      ).current.secret,
    ).toHaveLength(32);
    expect(() =>
      parseCursorSecretRing(
        JSON.stringify({
          currentId: "current",
          currentSecret: secret,
          currentCreatedAt: "2026-07-31T00:00:00.000Z",
          previousId: "old",
        }),
      ),
    ).toThrow("invalid-cursor-secret-ring");
    expect(() =>
      parseCursorSecretRing(
        JSON.stringify({
          currentId: "current",
          currentSecret: secret.replace(/=$/, ""),
          currentCreatedAt: "2026-07-31T00:00:00.000Z",
        }),
      ),
    ).toThrow("invalid-cursor-secret");
    expect(() =>
      parseCursorSecretRing(
        JSON.stringify({
          currentId: "current",
          currentSecret: secret,
          currentCreatedAt: "not-an-instant",
        }),
      ),
    ).toThrow("invalid-cursor-secret-ring");
    expect(() =>
      parseCursorSecretRing(
        JSON.stringify({
          currentId: "current",
          currentSecret: secret,
          currentCreatedAt: "2026-07-31T00:00:00.000Z",
          previousId: "old",
          previousSecret: Buffer.alloc(32, 8).toString("base64"),
          previousAcceptUntil: "2026-07-31T00:10:00.000Z",
        }),
      ),
    ).toThrow("invalid-cursor-secret-ring");
  });
  it("emits deployable route-dimensional Caught5xx EMF for caught server errors", async () => {
    const logs: Readonly<Record<string, unknown>>[] = [];
    const broken: EventRepository = {
      ...repository,
      list: () => Promise.reject(new EventStorageError("storage-secret")),
    };
    await createEventHandler(broken, (entry) => logs.push(entry))({
      route: "list",
      subject: "u",
      scopes: ["events/events:read"],
      query: { sport: "mlb", status: "scheduled", day: "2026-08-01" },
    });
    expect(logs).toHaveLength(2);
    expect(logs[0]).toMatchObject({
      event: "event-api-internal-failure",
      route: "list",
      errorName: "Error",
    });
    const serialized = JSON.stringify(logs[1]);
    expect(serialized).toContain('"Namespace":"FindTheEdge/EventApi"');
    expect(serialized).toContain('"Dimensions":[["Route"]]');
    expect(serialized).toContain('"Name":"Caught5xx","Unit":"Count"');
    expect(serialized).toContain('"Route":"list"');
  });

  const opportunityHandler = (
    ranked: RankedOpportunityRepository,
    log: (entry: Readonly<Record<string, unknown>>) => void = () => {},
  ) =>
    createEventHandler(
      repository,
      undefined,
      log,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      ranked,
    );

  it("serves ranked opportunities publicly without restoring the removed login wall", async () => {
    const list = vi.fn().mockResolvedValue({
      schemaVersion: "ranked-opportunity-page-v1",
      rankingPolicy: { id: "rank", version: "1.0.0" },
      items: [],
      nextCursor: null,
      snapshotAt: "2026-08-06T12:00:00.000Z",
      evaluationState: "complete",
      hasMoreUnknown: false,
      evaluatedCount: 0,
      filteredCount: 0,
      staleCount: 0,
      joinFailureCount: 0,
    });
    const ranked = {
      list,
      detail: () => Promise.reject(new Error("unexpected-detail")),
      reconcileActive: () => Promise.reject(new Error("unexpected-reconcile")),
    } satisfies RankedOpportunityRepository;
    const result = await opportunityHandler(ranked)({
      route: "opportunity-list",
      sportKey: "mlb",
    });
    expect(result.statusCode).toBe(200);
    expect(list).toHaveBeenCalledWith({ sportKey: "mlb", limit: 20 });
  });

  it("strictly validates and forwards bounded opportunity filters", async () => {
    let received: unknown;
    const ranked: RankedOpportunityRepository = {
      list: (input) => {
        received = input;
        return Promise.resolve({
          schemaVersion: "ranked-opportunity-page-v1",
          rankingPolicy: { id: "rank", version: "1.0.0" },
          items: [],
          nextCursor: null,
          snapshotAt: "2026-08-06T12:00:00.000Z",
          evaluationState: "complete",
          hasMoreUnknown: false,
          evaluatedCount: 4,
          filteredCount: 4,
          staleCount: 0,
          joinFailureCount: 0,
        });
      },
      detail: () => Promise.resolve(null),
      reconcileActive: () => Promise.reject(new Error("unexpected-reconcile")),
    };
    const logs: Readonly<Record<string, unknown>>[] = [];
    const result = await opportunityHandler(ranked, (entry) =>
      logs.push(entry),
    )({
      route: "opportunity-list",
      sportKey: "mlb",
      subject: "user",
      scopes: ["events/events:read"],
      requestId: "request-123",
      query: {
        market: "moneyline",
        target: "hardrock",
        kickoffFrom: "2026-08-06T00:00:00.000Z",
        kickoffTo: "2026-08-31T00:00:00.000Z",
        minEv: "0.025",
        minBooks: "3",
        maxAge: "10",
        limit: "17",
      },
    });
    expect(result.statusCode).toBe(200);
    expect(received).toEqual({
      sportKey: "mlb",
      limit: 17,
      marketKey: "moneyline",
      targetSportsbookId: "hardrock",
      kickoffFrom: "2026-08-06T00:00:00.000Z",
      kickoffTo: "2026-08-31T00:00:00.000Z",
      minimumExpectedValue: 0.025,
      minimumBooks: 3,
      maximumAgeMinutes: 10,
    });
    expect(logs.at(-1)).toMatchObject({
      Route: "opportunity-list",
      RequestId: "request-123",
      OpportunityDiscovered: 4,
      OpportunityFiltered: 4,
    });

    for (const query of [
      { extra: "x" },
      {
        kickoffFrom: "2026-08-01T00:00:00.000Z",
        kickoffTo: "2026-09-02T00:00:00.000Z",
      },
      {
        kickoffFrom: "+010000-01-01T00:00:00.000Z",
        kickoffTo: "9999-12-31T00:00:00.000Z",
      },
      { maxAge: "16" },
      { minBooks: "0" },
    ])
      expect(
        (
          await opportunityHandler(ranked)({
            route: "opportunity-list",
            sportKey: "mlb",
            subject: "user",
            scopes: ["events/events:read"],
            query,
          })
        ).statusCode,
      ).toBe(400);
  });

  it("returns honest detail absence and temporary join unavailability", async () => {
    const missing: RankedOpportunityRepository = {
      list: () =>
        Promise.reject(
          new RankedOpportunityUnavailableError("event-projection-unavailable"),
        ),
      detail: () => Promise.resolve(null),
      reconcileActive: () => Promise.reject(new Error("unexpected-reconcile")),
    };
    const base = {
      sportKey: "mlb",
    };
    expect(
      (
        await opportunityHandler(missing)({
          ...base,
          route: "opportunity-detail",
          opportunityId: `opportunity:${"a".repeat(64)}`,
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await opportunityHandler(missing)({
          ...base,
          route: "opportunity-list",
        })
      ).statusCode,
    ).toBe(503);
  });
});
