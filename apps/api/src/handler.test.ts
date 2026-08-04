import { describe, expect, it } from "vitest";
import {
  EventStorageError,
  MemoryCohortRepository,
  type GamesRepository,
  type EventRepository,
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
  }),
  detail: async () => {
    await Promise.resolve();
    return { projectionState: "ready", item: null };
  },
};
describe("event API", () => {
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
      repository,
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
            odds: { state: "unavailable" },
          },
        ],
        nextCursor: null,
        projectionState: "ready" as const,
        evaluationState: "complete" as const,
        hasMoreUnknown: false,
        snapshotAt: null,
        freshness: null,
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
  it("rejects unsupported games sports and non-scheduled status before reading", async () => {
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
        };
      },
    };
    const result = await createEventHandler(
      repository,
      games,
    )({
      route: "games",
      subject: "u",
      scopes: ["events/events:read"],
      query: { sport: "nfl", status: "completed", day: "2026-08-01" },
    });
    expect(result.statusCode).toBe(400);
    expect(reads).toBe(0);
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
    expect(reads).toBe(0);
  });
  it("keeps internal listing scoped while serving public detail", async () => {
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
    ).toBe(404);
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
    expect(logs).toHaveLength(1);
    const serialized = JSON.stringify(logs[0]);
    expect(serialized).toContain('"Namespace":"FindTheEdge/EventApi"');
    expect(serialized).toContain('"Dimensions":[["Route"]]');
    expect(serialized).toContain('"Name":"Caught5xx","Unit":"Count"');
    expect(serialized).toContain('"Route":"list"');
  });
});
