import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  SCOUTING_WORKFLOW_INTENT,
  assessEventMetadata,
  createArbitrageFinding,
  createQueuedScoutingRecords,
  createScoutingReportCompletionPointer,
  createScoutingReportHead,
  createScoutingReportVersion,
  createScoutingReportVersionEnvelope,
  fixtureOddsGroupAvailabilityIdentity,
  normalizeFixtureOddsObservation,
  validateScoutingAttempt,
  validateScoutingJob,
  type GameOddsCellDto,
  type GameOddsComparisonDto,
  type ScoutingReportInlinePayload,
  type ScoutingReportProvenance,
} from "@find-the-edge/domain";
import { impliedProbability } from "@find-the-edge/odds";
import {
  EventStorageError,
  EventCursorCodec,
  MemoryArbitrageBoardRepository,
  MemoryClvRepository,
  MemoryCohortRepository,
  MemoryOddsHistoryRepository,
  MemoryScoutingReportRepository,
  MemoryWatchlistRepository,
  RankedOpportunityUnavailableError,
  type GamesRepository,
  type EventRepository,
  type OddsHistoryRepository,
  type RankedOpportunityRepository,
  type ScoutingReportRepository,
  type WatchlistRepository,
} from "@find-the-edge/database";
import {
  clearHandlerCaches,
  createEventHandler,
  eventIdCandidates,
  publishedSplitScopes,
} from "./handler";

// Response and split caches live at module scope so warm Lambda invocations
// share them; tests must not share them with each other.
beforeEach(clearHandlerCaches);
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

it("publishes the provider consensus instead of its underlying book history", () => {
  const values = [
    { id: "consensus", scope: "consensus" },
    { id: "dk", scope: "draftkings" },
    { id: "circa", scope: "circa" },
  ];
  expect(publishedSplitScopes(values).map(({ id }) => id)).toEqual([
    "consensus",
  ]);
  expect(publishedSplitScopes(values.slice(1))).toEqual(values.slice(1));
});

it("keeps books the consensus does not aggregate", () => {
  const values = [
    { id: "consensus", scope: "consensus" },
    { id: "dk", scope: "draftkings" },
    { id: "circa", scope: "Circa" },
    { id: "mgm", scope: "betmgm" },
  ];
  expect(publishedSplitScopes(values).map(({ id }) => id)).toEqual([
    "consensus",
    "mgm",
  ]);
});

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

it("serves the arbitrage board and fails closed on bad queries", async () => {
  const observedAt = new Date(Date.now() - 120_000).toISOString();
  const retrievedAt = new Date(Date.now() - 119_000).toISOString();
  const arbQuote = (
    sportsbookId: string,
    selectionKey: string,
    odds: number,
  ) => {
    const normalized = normalizeFixtureOddsObservation({
      canonicalEventId: "event-1",
      canonicalEventVersion: 1,
      sportKey: "mlb",
      marketKey: "moneyline",
      selectionKey,
      sportsbookId,
      americanOdds: odds,
      observedAt,
      retrievedAt,
    });
    return {
      ...normalized,
      point: null,
      selectionAvailability: {
        identity: normalized.partitionKey,
        evidenceId: `availability-${sportsbookId}-${selectionKey}`,
        state: "active" as const,
        observedAt: retrievedAt,
      },
      groupAvailability: {
        identity: fixtureOddsGroupAvailabilityIdentity(normalized),
        evidenceId: `group-availability-${sportsbookId}`,
        state: "active" as const,
        observedAt: retrievedAt,
      },
    };
  };
  const scannedAt = new Date(Date.now() - 60_000).toISOString();
  const finding = createArbitrageFinding({
    canonicalEventId: "event-1",
    canonicalEventVersion: 1,
    sportKey: "mlb",
    leagueKey: "mlb",
    marketKey: "moneyline",
    startsAt: new Date(Date.now() + 3_600_000).toISOString(),
    evaluatedAt: scannedAt,
    legs: [
      {
        selectionKey: "team-a",
        point: null,
        best: arbQuote("novig", "team-a", 125),
        competing: [],
      },
      {
        selectionKey: "team-b",
        point: null,
        best: arbQuote("prophetx", "team-b", -115),
        competing: [],
      },
    ],
    excludedBooks: [],
    policy: {
      id: "find-the-edge-arbitrage",
      version: "1.0.0",
      lowHoldThreshold: 1.01,
      maximumPriceAgeMinutes: 15,
    },
  });
  const board = new MemoryArbitrageBoardRepository();
  await board.putBoard("mlb", [finding], scannedAt);
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
    undefined,
    undefined,
    undefined,
    board,
  );
  const ok = await handler({
    route: "arbitrage-list",
    sportKey: "mlb",
    method: "GET",
  });
  expect(ok.statusCode).toBe(200);
  const page = JSON.parse(ok.body) as {
    schemaVersion: string;
    items: { classification: string }[];
    totalCount: number;
  };
  expect(page.schemaVersion).toBe("arbitrage-page-v1");
  expect(page.totalCount).toBe(1);
  expect(page.items.map(({ classification }) => classification)).toEqual([
    "arbitrage",
  ]);
  const filtered = await handler({
    route: "arbitrage-list",
    sportKey: "mlb",
    method: "GET",
    query: { classification: "low-hold" },
  });
  expect(
    (JSON.parse(filtered.body) as { items: unknown[] }).items,
  ).toHaveLength(0);
  for (const bad of [
    { sportKey: "MLB!" },
    { sportKey: "mlb", query: { bogus: "1" } },
    { sportKey: "mlb", query: { limit: "0" } },
    { sportKey: "mlb", query: { classification: "sure-thing" } },
  ])
    expect(
      await handler({ route: "arbitrage-list", method: "GET", ...bad }),
    ).toMatchObject({ statusCode: 400 });
});

it("serves the CLV board and rejects query parameters", async () => {
  const clvResult = {
    schemaVersion: "clv-result-v1" as const,
    logicalOpportunityId: `opportunity:${"c".repeat(64)}`,
    canonicalEventId: "event-1",
    sportKey: "mlb",
    leagueKey: "mlb",
    marketKey: "moneyline",
    selectionKey: "participant:away",
    point: null,
    entryAmericanOdds: 135,
    entryFairProbability: 0.46,
    evaluatedAt: "2026-08-10T20:00:00.000Z",
    closingFairProbability: 0.4416,
    closingSource: "display-book" as const,
    clvPercent: (0.4416 * 2.35 - 1) * 100,
    closingCapturedAt: "2026-08-10T23:20:00.000Z",
  };
  const clv = new MemoryClvRepository();
  await clv.appendResults("mlb", [clvResult], "2026-08-10T23:20:00.000Z");
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
    undefined,
    undefined,
    undefined,
    undefined,
    clv,
  );
  const ok = await handler({
    route: "clv-list",
    sportKey: "mlb",
    method: "GET",
  });
  expect(ok.statusCode).toBe(200);
  const page = JSON.parse(ok.body) as {
    schemaVersion: string;
    items: { clvPercent: number }[];
  };
  expect(page.schemaVersion).toBe("clv-page-v1");
  expect(page.items).toHaveLength(1);
  expect(page.items[0]?.clvPercent).toBeCloseTo(3.78, 1);
  expect(
    await handler({
      route: "clv-list",
      sportKey: "mlb",
      method: "GET",
      query: { leaked: "1" },
    }),
  ).toMatchObject({ statusCode: 400 });
});

it("redacts unexpected scouting failures from structured logs", async () => {
  const logs: Readonly<Record<string, unknown>>[] = [];
  const handler = createEventHandler(
    repository,
    undefined,
    (entry) => logs.push(entry),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    () => Promise.reject(new Error("table-name-and-internal-key")),
  );
  const result = await handler({
    route: "scout-status",
    method: "GET",
    subject: "owner",
    scopes: ["events/scouting:read"],
    jobId: `scout-job:${"a".repeat(64)}`,
  });
  expect(result.statusCode).toBe(500);
  expect(logs).toContainEqual({
    event: "event-api-internal-failure",
    route: "scout-status",
    errorName: "ScoutingInternalError",
    errorMessage: "scouting-operation-failed",
  });
  expect(logs.at(-1)).toMatchObject({
    Route: "scout-status",
    Status: 500,
    ScoutingFailure: 1,
  });
  expect(JSON.stringify(logs)).not.toContain("table-name-and-internal-key");
});

it("emits bounded scouting lifecycle metrics", async () => {
  const logs: Readonly<Record<string, unknown>>[] = [];
  const handler = createEventHandler(
    repository,
    undefined,
    (entry) => logs.push(entry),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    () =>
      Promise.resolve({
        statusCode: 202,
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
  );
  expect(
    await handler({
      route: "scout-create",
      method: "POST",
      subject: "owner",
      scopes: ["events/scouting:write"],
    }),
  ).toMatchObject({ statusCode: 202 });
  expect(logs.at(-1)).toMatchObject({
    Route: "scout-create",
    Status: 202,
    ScoutingJobCreated: 1,
  });
  expect(typeof logs.at(-1)?.ScoutingLatency).toBe("number");
  expect(logs.at(-1)).not.toHaveProperty("_aws");
});

describe("scouting report read routes", () => {
  const reportRequester = "user-123";
  const foreignRequester = "user-456";
  const reportEventId = "baseball:mlb:event-123";
  const readScopes = ["events/scouting:read"];
  const reportPayload = {
    candidate: {
      marketKey: "moneyline",
      outcomeStructure: "two-way",
      selection: { kind: "participant", participantId: "yankees" },
    },
    versions: {
      contractVersion: "analysis-contract-v1",
      promptBundleId: "bundle-mlb",
      promptBundleVersion: "1.0.0",
      promptSections: {
        shared: { id: "shared-core", version: "1" },
        sport: { id: "mlb-module", version: "2" },
        strategy: { id: "core-strategy", version: "3" },
        analysis: { id: "analysis-core", version: "1" },
      },
      inputSchemaId: "scouting-input",
      inputSchemaVersion: "1",
      outputSchemaId: "scouting-report",
      outputSchemaVersion: "1",
      modelId: "model-x",
      modelVersion: "2026-01",
    },
    probability: { estimate: 0.55, low: 0.5, high: 0.6, uncertainty: 0.05 },
    status: "complete",
    abstentionCodes: [],
    summary: "Yankees hold a pricing edge.",
    assertions: [
      {
        text: "Yankees hold a pricing edge.",
        classification: "inference",
        citationIds: ["obs-1"],
      },
    ],
  } satisfies ScoutingReportInlinePayload;
  const reportProvenance = {
    citedSourceObservations: [
      {
        observationId: "obs-1",
        category: "lineup",
        status: "verified",
        observedAt: "2026-08-10T12:01:00.000Z",
      },
    ],
    providerObservations: [
      {
        providerId: "sharpapi",
        observationId: "obs-1",
        observedAt: "2026-08-10T12:01:00.000Z",
      },
    ],
    evidenceReferences: [
      {
        sourceId: "sharpapi",
        observedAt: "2026-08-10T12:01:00.000Z",
        retrievedAt: "2026-08-10T12:01:00.000Z",
        verification: "verified",
      },
    ],
    calculationVersions: [{ id: "no-vig-fair-line", version: "1" }],
    referenceHashes: ["ab".repeat(32)],
    oddsSnapshotIds: ["snap-1"],
    inputHash: "cd".repeat(32),
    inputSchema: { id: "scouting-input", version: "1" },
    promptBundle: { id: "bundle-mlb", version: "1.0.0" },
    model: { id: "model-x", version: "2026-01" },
    sportModule: { id: "mlb-module", version: "2" },
    strategy: { id: "core-strategy", version: "3" },
    reportSchema: { id: "scouting-report", version: "1" },
  } satisfies ScoutingReportProvenance;

  const seedScoutReport = async () => {
    const repo = new MemoryScoutingReportRepository();
    const records = createQueuedScoutingRecords(
      {
        schemaVersion: 1,
        requesterId: reportRequester,
        idempotencyKey: "request-1",
        eventId: reportEventId,
        eventVersion: 7,
        workflowIntent: SCOUTING_WORKFLOW_INTENT,
      },
      "2026-08-10T12:00:00.000Z",
    );
    const job = validateScoutingJob({
      ...records.job,
      status: "in_progress",
      stateVersion: records.job.stateVersion + 1,
      updatedAt: "2026-08-10T12:01:00.000Z",
    });
    const attempt = validateScoutingAttempt({
      ...records.attempt,
      status: "in_progress",
      stateVersion: records.attempt.stateVersion + 1,
      updatedAt: "2026-08-10T12:01:00.000Z",
      startedAt: "2026-08-10T12:01:00.000Z",
    });
    repo.seedJob(job);
    repo.seedAttempt(attempt);
    repo.setActiveLock(job.semanticDigest, job.jobId, attempt.attemptId);
    const version = createScoutingReportVersion({
      requesterId: reportRequester,
      eventId: reportEventId,
      eventVersion: 7,
      jobId: job.jobId,
      attemptId: job.currentAttemptId,
      versionNumber: 1,
      payload: reportPayload,
      provenance: reportProvenance,
      generatedAt: "2026-08-10T12:02:00.000Z",
      predecessor: null,
    });
    await repo.completeWithReport({
      material: {
        version,
        head: createScoutingReportHead(version),
        completionPointer: createScoutingReportCompletionPointer(version),
        envelope: createScoutingReportVersionEnvelope(version),
      },
      completedAt: "2026-08-10T12:03:00.000Z",
    });
    return {
      repo,
      version,
      jobId: job.jobId,
      reportId: version.reportId,
    };
  };

  const reportHandler = (
    repo: ScoutingReportRepository,
    log?: (entry: Readonly<Record<string, unknown>>) => void,
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
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      repo,
    );

  it("serves the job-bound report with history depth and no internal identities", async () => {
    const { repo, jobId, reportId } = await seedScoutReport();
    const logs: Readonly<Record<string, unknown>>[] = [];
    const handler = reportHandler(repo, (entry) => logs.push(entry));
    const result = await handler({
      route: "scout-report-by-job",
      method: "GET",
      subject: reportRequester,
      scopes: readScopes,
      jobId,
    });
    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual([
      "changeSummary",
      "eventId",
      "eventVersion",
      "generatedAt",
      "jobId",
      "latestVersionNumber",
      "payload",
      "provenance",
      "reportId",
      "schemaVersion",
      "validationOutcome",
      "versionNumber",
    ]);
    expect(body).toMatchObject({
      schemaVersion: "scout-report-v1",
      reportId,
      versionNumber: 1,
      latestVersionNumber: 1,
      jobId,
      eventId: reportEventId,
      eventVersion: 7,
      generatedAt: "2026-08-10T12:02:00.000Z",
      validationOutcome: "complete",
      changeSummary: { kind: "initial", changedFields: [] },
    });
    expect(body["payload"]).toEqual(reportPayload);
    expect(body["provenance"]).toEqual(reportProvenance);
    expect(result.body).not.toContain("draftHash");
    expect(result.body).not.toContain("persistenceFingerprint");
    expect(result.body).not.toContain("attemptId");
    expect(result.body).not.toContain("predecessor");
    // Report reads are not job lifecycle events: no duplicate metric.
    expect(logs.at(-1)).toMatchObject({
      Route: "scout-report-by-job",
      Status: 200,
    });
    expect(JSON.stringify(logs.at(-1))).not.toContain("ScoutingDuplicate");
    expect(JSON.stringify(logs)).not.toContain(reportRequester);
  });

  it("lists version metadata without payloads plus head info", async () => {
    const { repo, jobId, reportId } = await seedScoutReport();
    const handler = reportHandler(repo);
    const result = await handler({
      route: "scout-report-versions",
      method: "GET",
      subject: reportRequester,
      scopes: readScopes,
      reportId,
    });
    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body) as {
      items: Record<string, unknown>[];
    } & Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual([
      "eventId",
      "items",
      "latestVersionNumber",
      "reportId",
      "schemaVersion",
      "updatedAt",
    ]);
    expect(body).toMatchObject({
      schemaVersion: "scout-report-versions-v1",
      reportId,
      eventId: reportEventId,
      latestVersionNumber: 1,
      updatedAt: "2026-08-10T12:02:00.000Z",
    });
    expect(body.items).toHaveLength(1);
    expect(Object.keys(body.items[0] ?? {}).sort()).toEqual([
      "changeSummary",
      "generatedAt",
      "jobId",
      "validationOutcome",
      "versionNumber",
    ]);
    expect(body.items[0]).toEqual({
      versionNumber: 1,
      generatedAt: "2026-08-10T12:02:00.000Z",
      validationOutcome: "complete",
      changeSummary: { kind: "initial", changedFields: [] },
      jobId,
    });
    expect(result.body).not.toContain('"payload"');
    expect(result.body).not.toContain('"provenance"');
  });

  it("serves a full single version and treats unknown numbers as neutral missing", async () => {
    const { repo, reportId } = await seedScoutReport();
    const handler = reportHandler(repo);
    const result = await handler({
      route: "scout-report-version",
      method: "GET",
      subject: reportRequester,
      scopes: readScopes,
      reportId,
      versionNumber: "1",
    });
    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toMatchObject({
      schemaVersion: "scout-report-v1",
      reportId,
      versionNumber: 1,
      latestVersionNumber: 1,
    });
    for (const versionNumber of ["2", "9999999999999999"])
      expect(
        await handler({
          route: "scout-report-version",
          method: "GET",
          subject: reportRequester,
          scopes: readScopes,
          reportId,
          versionNumber,
        }),
      ).toMatchObject({
        statusCode: 404,
        body: JSON.stringify({ error: "not-found" }),
      });
  });

  it("gives foreign requesters the same neutral missing as absent reports", async () => {
    const { repo, jobId, reportId } = await seedScoutReport();
    const handler = reportHandler(repo);
    const requests = [
      { route: "scout-report-by-job" as const, jobId },
      { route: "scout-report-versions" as const, reportId },
      { route: "scout-report-version" as const, reportId, versionNumber: "1" },
    ];
    for (const request of requests) {
      expect(
        await handler({
          ...request,
          method: "GET",
          subject: foreignRequester,
          scopes: readScopes,
        }),
      ).toMatchObject({
        statusCode: 404,
        body: JSON.stringify({ error: "not-found" }),
      });
    }
  });

  it("requires authentication and the scouting read scope", async () => {
    const { repo, jobId, reportId } = await seedScoutReport();
    const handler = reportHandler(repo);
    const requests = [
      { route: "scout-report-by-job" as const, jobId },
      { route: "scout-report-versions" as const, reportId },
      { route: "scout-report-version" as const, reportId, versionNumber: "1" },
    ];
    for (const request of requests) {
      expect(
        await handler({ ...request, method: "GET", scopes: readScopes }),
      ).toMatchObject({ statusCode: 401 });
      expect(
        await handler({
          ...request,
          method: "GET",
          subject: reportRequester,
          scopes: ["events/scouting:write"],
        }),
      ).toMatchObject({ statusCode: 403 });
    }
  });

  it("rejects malformed identifiers and leaked query parameters", async () => {
    const { repo, jobId, reportId } = await seedScoutReport();
    const handler = reportHandler(repo);
    const authorized = {
      method: "GET" as const,
      subject: reportRequester,
      scopes: readScopes,
    };
    for (const badJobId of [undefined, "scout-job:short", reportId])
      expect(
        await handler({
          ...authorized,
          route: "scout-report-by-job",
          ...(badJobId ? { jobId: badJobId } : {}),
        }),
      ).toMatchObject({ statusCode: 400 });
    for (const badReportId of [undefined, "scout-report:short", jobId])
      expect(
        await handler({
          ...authorized,
          route: "scout-report-versions",
          ...(badReportId ? { reportId: badReportId } : {}),
        }),
      ).toMatchObject({ statusCode: 400 });
    for (const versionNumber of [
      undefined,
      "0",
      "01",
      "1.5",
      "-1",
      "abc",
      "10000000000000000",
    ])
      expect(
        await handler({
          ...authorized,
          route: "scout-report-version",
          reportId,
          ...(versionNumber ? { versionNumber } : {}),
        }),
      ).toMatchObject({ statusCode: 400 });
    for (const request of [
      { route: "scout-report-by-job" as const, jobId },
      { route: "scout-report-versions" as const, reportId },
      { route: "scout-report-version" as const, reportId, versionNumber: "1" },
    ])
      expect(
        await handler({ ...request, ...authorized, query: { leaked: "1" } }),
      ).toMatchObject({ statusCode: 400 });
  });

  it("fails closed on corrupt stored rows without leaking storage details", async () => {
    const { repo, jobId, reportId, version } = await seedScoutReport();
    const tampered = JSON.parse(JSON.stringify(version)) as {
      payload: { summary: string };
    };
    tampered.payload.summary = `${tampered.payload.summary} tampered`;
    repo.unsafeSeedVersionRow(reportId, 1, tampered);
    const logs: Readonly<Record<string, unknown>>[] = [];
    const handler = reportHandler(repo, (entry) => logs.push(entry));
    for (const request of [
      { route: "scout-report-by-job" as const, jobId },
      { route: "scout-report-versions" as const, reportId },
      { route: "scout-report-version" as const, reportId, versionNumber: "1" },
    ])
      expect(
        await handler({
          ...request,
          method: "GET",
          subject: reportRequester,
          scopes: readScopes,
        }),
      ).toMatchObject({
        statusCode: 500,
        body: JSON.stringify({ error: "internal-error" }),
      });
    expect(logs).toContainEqual({
      event: "event-api-internal-failure",
      route: "scout-report-version",
      errorName: "ScoutingInternalError",
      errorMessage: "scouting-operation-failed",
    });
    expect(JSON.stringify(logs)).not.toContain("tampered");
  });
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
    expect(serialized).not.toContain('"_aws"');
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
  it("serves a materialized board without running the projection", async () => {
    const games = {
      list: vi.fn(() => Promise.reject(new Error("unexpected-live-build"))),
    };
    const storedBody = JSON.stringify({ items: [], stored: true });
    const loadStoredBoard = vi.fn(() =>
      Promise.resolve({
        schemaVersion: 1 as const,
        generatedAt: new Date().toISOString(),
        body: storedBody,
        counts: { stale: 0, partial: 0, unavailable: 0 },
      }),
    );
    const handler = createEventHandler(
      repository,
      games,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      loadStoredBoard,
    );
    const result = await handler({
      route: "splits",
      query: {
        sport: "mlb",
        status: "scheduled",
        day: "2026-08-08",
        limit: "50",
      },
    });
    expect(result.statusCode).toBe(200);
    expect(result.body).toBe(storedBody);
    expect(games.list).not.toHaveBeenCalled();
    expect(loadStoredBoard).toHaveBeenCalledWith({
      route: "splits",
      sportKey: "mlb",
      leagueKey: "",
      status: "scheduled",
      day: "2026-08-08",
      limit: 50,
    });
  });

  it("falls back to the live projection when no stored board is fresh", async () => {
    const games = {
      list: vi.fn(() =>
        Promise.resolve({
          items: [],
          nextCursor: null,
          projectionState: "ready" as const,
          evaluationState: "complete" as const,
          hasMoreUnknown: false,
          snapshotAt: null,
          freshness: null,
          unavailableReason: null,
        }),
      ),
    };
    const handler = createEventHandler(
      repository,
      games,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      () => Promise.resolve(null),
    );
    const result = await handler({
      route: "games",
      query: { sport: "mlb", status: "scheduled", day: "2026-08-08" },
    });
    expect(result.statusCode).toBe(200);
    expect(games.list).toHaveBeenCalledTimes(1);
  });

  it("serves repeated board requests from the response cache", async () => {
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
    const handler = createEventHandler(repository, games);
    const query = { sport: "mlb", status: "scheduled", day: "2026-08-02" };
    const first = await handler({ route: "games", query });
    const second = await handler({ route: "games", query });
    expect(first.statusCode).toBe(200);
    expect(second.body).toBe(first.body);
    expect(reads).toBe(1);
    // A different day is a different board, never a cache hit.
    await handler({
      route: "games",
      query: { ...query, day: "2026-08-03" },
    });
    expect(reads).toBe(2);
  });

  it.each(["games", "splits"] as const)(
    "expires cached %s responses exactly at kickoff",
    async (route) => {
      vi.useFakeTimers();
      const kickoff = Date.parse("2026-08-08T12:00:00.000Z");
      vi.setSystemTime(kickoff - 1);
      try {
        const list = vi.fn(() => {
          const pregame = list.mock.calls.length === 1;
          return Promise.resolve({
            items: [
              {
                id: "event:mlb:one",
                version: 1,
                sportKey: "mlb",
                leagueKey: "mlb",
                status: "scheduled",
                startsAt: new Date(kickoff).toISOString(),
                participants: [
                  { id: "away", label: "Away" },
                  { id: "home", label: "Home" },
                ],
                freshness: new Date(kickoff - 60_000).toISOString(),
                odds: pregame
                  ? {
                      state: "available" as const,
                      source: "pregame-snapshot" as const,
                      selections: [],
                    }
                  : { state: "unavailable" as const },
                metadata: {
                  freshness: { state: "current", evidenceAt: null },
                  availability: "unavailable",
                  evaluatedAt: new Date(kickoff - 1).toISOString(),
                },
              },
            ],
            nextCursor: null,
            projectionState: "ready" as const,
            evaluationState: "complete" as const,
            hasMoreUnknown: false,
            snapshotAt: new Date(kickoff - 60_000).toISOString(),
            freshness: null,
            unavailableReason: null,
          });
        });
        const handler = createEventHandler(
          repository,
          { list } as unknown as GamesRepository,
          undefined,
          route === "splits"
            ? ({ listCurrent: () => Promise.resolve([]) } as never)
            : undefined,
        );
        const query = {
          sport: "mlb",
          status: "scheduled",
          day: "2026-08-08",
        };

        const before = await handler({ route, query });
        await handler({ route, query });
        expect(list).toHaveBeenCalledTimes(1);
        const oddsState = (body: string) =>
          (
            JSON.parse(body) as {
              readonly items: readonly {
                readonly odds: { readonly state: string };
              }[];
            }
          ).items[0]?.odds.state;
        expect(oddsState(before.body)).toBe("available");

        vi.setSystemTime(kickoff);
        const after = await handler({ route, query });
        expect(list).toHaveBeenCalledTimes(2);
        expect(oddsState(after.body)).toBe("unavailable");
      } finally {
        clearHandlerCaches();
        vi.useRealTimers();
      }
    },
  );

  it.each(["games", "splits"] as const)(
    "keeps canonical-closing %s responses cached after kickoff",
    async (route) => {
      vi.useFakeTimers();
      const now = Date.parse("2026-08-08T12:05:00.000Z");
      vi.setSystemTime(now);
      try {
        const list = vi.fn(() =>
          Promise.resolve({
            items: [
              {
                id: "event:mlb:closed",
                startsAt: "2026-08-08T12:00:00.000Z",
                odds: {
                  state: "available" as const,
                  source: "canonical-closing" as const,
                  selections: [],
                },
                metadata: {
                  freshness: { state: "current", evidenceAt: null },
                  availability: "available",
                  evaluatedAt: new Date(now).toISOString(),
                },
              },
            ],
            nextCursor: null,
            projectionState: "ready" as const,
            evaluationState: "complete" as const,
            hasMoreUnknown: false,
            snapshotAt: new Date(now).toISOString(),
            freshness: null,
            unavailableReason: null,
          }),
        );
        const handler = createEventHandler(
          repository,
          { list } as unknown as GamesRepository,
          undefined,
          route === "splits"
            ? ({ listCurrent: () => Promise.resolve([]) } as never)
            : undefined,
        );
        const query = {
          sport: "mlb",
          status: "scheduled",
          day: "2026-08-08",
        };

        await handler({ route, query });
        vi.setSystemTime(now + 14_999);
        await handler({ route, query });
        expect(list).toHaveBeenCalledTimes(1);
      } finally {
        clearHandlerCaches();
        vi.useRealTimers();
      }
    },
  );
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
    // The merged all view is a games-only contract.
    expect(
      (
        await createEventHandler(
          repository,
          games,
        )({
          route: "games",
          query: { sport: "mlb", status: "all", day: "2026-08-01" },
        })
      ).statusCode,
    ).toBe(200);
    expect(reads).toBe(7);
    for (const [route, sport, status] of [
      ["games", "nfl", "completed"],
      ["games", "mlb", "invalid"],
      ["splits", "mlb", "all"],
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
    expect(reads).toBe(7);
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
    expect(reads).toBe(7);
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
    expect(serialized).not.toContain('"_aws"');
    expect(serialized).toContain('"Caught5xx":1');
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

describe("event id decode-variant resolution", () => {
  const rawId = "event:mlb%3Amlb:mlb_angels_marlins_2026-08-08_b2";
  const overDecoded = "event:mlb:mlb:mlb_angels_marlins_2026-08-08_b2";
  const wireSegment = encodeURIComponent(rawId);

  it("derives candidates for both possible rawPath decode depths", () => {
    // rawPath handed over still encoded.
    expect(
      eventIdCandidates(
        `/events/${wireSegment}`,
        "GET /events/{eventId}",
        overDecoded,
      ),
    ).toEqual([wireSegment, rawId, overDecoded]);
    // rawPath handed over once-decoded.
    expect(
      eventIdCandidates(
        `/events/${rawId}`,
        "GET /events/{eventId}",
        overDecoded,
      ),
    ).toEqual([rawId, overDecoded]);
    // Odds-history route template also carries the id.
    expect(
      eventIdCandidates(
        `/games/${rawId}/odds-history`,
        "GET /games/{eventId}/odds-history",
        overDecoded,
      ),
    ).toEqual([rawId, overDecoded]);
    // The hosted gateway decodes rawPath as much as the parameters, so the
    // canonical grammar reconstructs the interior %3A joins.
    expect(
      eventIdCandidates(
        `/events/${overDecoded}`,
        "GET /events/{eventId}",
        overDecoded,
      ),
    ).toEqual([overDecoded, rawId]);
    // Misaligned paths still recover the id from the grammar.
    expect(
      eventIdCandidates("/events", "GET /events/{eventId}", overDecoded),
    ).toEqual([rawId, overDecoded]);
    expect(eventIdCandidates(undefined, undefined, overDecoded)).toEqual([
      rawId,
      overDecoded,
    ]);
    // Ids without destroyed joins gain no fabricated variants.
    expect(eventIdCandidates(undefined, undefined, "event:one")).toEqual([
      "event:one",
    ]);
  });

  it("serves the detail whose decode variant the store recognizes", async () => {
    const known = new Set([rawId]);
    const detailFor = (id: string) =>
      Promise.resolve(
        known.has(id)
          ? {
              projectionState: "ready" as const,
              item: withOddsComparison({
                id,
                version: 1,
                sportKey: "mlb",
                leagueKey: "mlb",
                status: "scheduled",
                startsAt: "2026-08-08T20:10:00.000Z",
                eastern: {
                  timeZone: "America/New_York",
                  calendarDay: "2026-08-08",
                  display: "Aug 8, 2026, 4:10 PM",
                },
                participants: [
                  { id: "away", label: "Away" },
                  { id: "home", label: "Home" },
                ],
                competition: { key: "mlb" },
                metadata: {
                  availability: "complete",
                  lifecycle: { state: "scheduled" },
                  freshness: { state: "current" },
                },
                odds: { state: "unavailable" },
              } as never),
              unavailableReason: null,
            }
          : {
              projectionState: "ready" as const,
              item: null,
              unavailableReason: null,
            },
      );
    const handler = createEventHandler(
      repository,
      gamesWithDetail(detailFor),
      () => undefined,
    );
    // The over-decoded id alone stays a 404.
    const miss = await handler({ route: "detail", eventId: overDecoded });
    expect(miss.statusCode).toBe(404);
    // With decode variants present, the true id resolves.
    const hit = await handler({
      route: "detail",
      eventId: overDecoded,
      eventIdAlternatives: [wireSegment, rawId, overDecoded],
    });
    expect(hit.statusCode).toBe(200);
    expect(JSON.parse(hit.body)).toMatchObject({ item: { id: rawId } });
  });

  it("resolves odds-history through the same decode variants", async () => {
    const events: EventRepository = {
      ...repository,
      detail: (eventId) =>
        Promise.resolve({
          projectionState: "ready",
          item:
            eventId === rawId
              ? ({
                  id: eventId,
                  version: 3,
                  sportKey: "mlb",
                  participants: [
                    { id: "away", label: "Away" },
                    { id: "home", label: "Home" },
                  ],
                } as never)
              : null,
          unavailableReason: null,
        }),
    };
    const history = new MemoryOddsHistoryRepository(
      [],
      new EventCursorCodec({
        current: { id: "test", secret: new Uint8Array(32).fill(3) },
      }),
      { draftkings: "DraftKings" },
      impliedProbability,
    );
    const list = vi.spyOn(history, "list");
    const result = await createEventHandler(
      events,
      () => undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      history,
    )({
      route: "odds-history",
      eventId: overDecoded,
      eventIdAlternatives: [wireSegment, rawId, overDecoded],
      query: {
        from: "2026-08-08T00:00:00.000Z",
        to: "2026-08-09T00:00:00.000Z",
      },
    });
    expect(result.statusCode).toBe(200);
    expect(list).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: rawId, canonicalEventVersion: 3 }),
    );
  });
});

describe("watchlist", () => {
  const subject = "watchlist-user-1";
  const otherSubject = "watchlist-user-2";
  const storedEventId = "event:mlb%3Amlb:game-1";
  // The gateway decodes path parameters twice, so the canonical id above
  // reaches the handler with its %3A already destroyed.
  const overDecodedEventId = "event:mlb:mlb:game-1";
  const eventItem = (id: string) => ({
    id,
    version: 4,
    sportKey: "mlb",
    leagueKey: "mlb",
    competition: { key: "mlb", state: "provisional" as const },
    participants: [
      { id: "away", label: "Away" },
      { id: "home", label: "Home" },
    ],
    startsAt: "2026-08-11T23:05:00.000Z",
    eastern: {
      timeZone: "America/New_York" as const,
      calendarDay: "2026-08-11",
      display: "Aug 11",
    },
    status: "scheduled" as const,
    freshness: null,
    metadata: assessEventMetadata(
      "scheduled",
      null,
      "2026-08-10T12:00:00.000Z",
    ),
  });

  const eventsWith = (known: readonly string[]): EventRepository => ({
    list: (filter, limit, cursor) => repository.list(filter, limit, cursor),
    detail: async (eventId) => {
      await Promise.resolve();
      return {
        projectionState: "ready" as const,
        item: known.includes(eventId) ? eventItem(eventId) : null,
        unavailableReason: null,
      };
    },
  });

  const watchlistHandler = (
    watchlist: WatchlistRepository,
    known: readonly string[] = [storedEventId],
    log?: (entry: Readonly<Record<string, unknown>>) => void,
  ) =>
    createEventHandler(
      eventsWith(known),
      undefined,
      log,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      watchlist,
    );

  const addRequest = (eventId: string, requester = subject) => ({
    route: "watchlist-add" as const,
    method: "POST" as const,
    contentType: "application/json",
    subject: requester,
    body: JSON.stringify({ eventId }),
  });

  it("requires an authenticated subject on every watchlist route", async () => {
    const handler = watchlistHandler(new MemoryWatchlistRepository());
    for (const request of [
      { route: "watchlist-list" as const, method: "GET" as const },
      {
        route: "watchlist-add" as const,
        method: "POST" as const,
        contentType: "application/json",
        body: JSON.stringify({ eventId: storedEventId }),
      },
      {
        route: "watchlist-remove" as const,
        method: "DELETE" as const,
        eventId: storedEventId,
      },
    ]) {
      const result = await handler(request);
      expect(result.statusCode).toBe(401);
      expect(JSON.parse(result.body)).toEqual({ error: "unauthorized" });
    }
  });

  it("adds, lists, and removes an event for the token subject", async () => {
    const watchlist = new MemoryWatchlistRepository();
    const handler = watchlistHandler(watchlist);
    const created = await handler(addRequest(storedEventId));
    expect(created.statusCode).toBe(201);
    expect(JSON.parse(created.body)).toMatchObject({
      schemaVersion: "watchlist-entry-v1",
      eventId: storedEventId,
      eventVersion: 4,
      sportKey: "mlb",
      leagueKey: "mlb",
      startsAt: "2026-08-11T23:05:00.000Z",
    });
    expect(Object.keys(JSON.parse(created.body) as object).sort()).toEqual([
      "addedAt",
      "eventId",
      "eventVersion",
      "leagueKey",
      "schemaVersion",
      "sportKey",
      "startsAt",
    ]);
    const listed = await handler({
      route: "watchlist-list",
      method: "GET",
      subject,
    });
    expect(listed.statusCode).toBe(200);
    expect(JSON.parse(listed.body)).toMatchObject({
      schemaVersion: "watchlist-page-v1",
      items: [{ eventId: storedEventId }],
    });
    const removed = await handler({
      route: "watchlist-remove",
      method: "DELETE",
      subject,
      eventId: storedEventId,
      eventIdAlternatives: [storedEventId],
    });
    expect(removed.statusCode).toBe(204);
    expect(removed.body).toBe("");
    expect(
      JSON.parse(
        (await handler({ route: "watchlist-list", method: "GET", subject }))
          .body,
      ),
    ).toMatchObject({ items: [] });
  });

  it("treats a repeated add as an existing entry and keeps the first addedAt", async () => {
    const watchlist = new MemoryWatchlistRepository();
    const handler = watchlistHandler(watchlist);
    const first = JSON.parse(
      (await handler(addRequest(storedEventId))).body,
    ) as { addedAt: string };
    const repeat = await handler(addRequest(storedEventId));
    expect(repeat.statusCode).toBe(200);
    expect(JSON.parse(repeat.body)).toMatchObject({ addedAt: first.addedAt });
    expect(
      JSON.parse(
        (await handler({ route: "watchlist-list", method: "GET", subject }))
          .body,
      ),
    ).toMatchObject({ items: [{ addedAt: first.addedAt }] });
  });

  it("removes idempotently, including an event that was never watched", async () => {
    const handler = watchlistHandler(new MemoryWatchlistRepository());
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = await handler({
        route: "watchlist-remove",
        method: "DELETE",
        subject,
        eventId: storedEventId,
        eventIdAlternatives: [storedEventId],
      });
      expect(result.statusCode).toBe(204);
    }
  });

  it("round-trips a percent-encoded canonical id through add, list, and delete", async () => {
    const watchlist = new MemoryWatchlistRepository();
    const handler = watchlistHandler(watchlist);
    // The client echoes back the id the gateway handed it, already decoded.
    const created = await handler(addRequest(overDecodedEventId));
    expect(created.statusCode).toBe(201);
    expect(JSON.parse(created.body)).toMatchObject({ eventId: storedEventId });
    expect(
      JSON.parse(
        (await handler({ route: "watchlist-list", method: "GET", subject }))
          .body,
      ),
    ).toMatchObject({ items: [{ eventId: storedEventId }] });
    const removed = await handler({
      route: "watchlist-remove",
      method: "DELETE",
      subject,
      eventId: overDecodedEventId,
      eventIdAlternatives: eventIdCandidates(
        "/watchlist/event:mlb:mlb:game-1",
        "DELETE /watchlist/{eventId}",
        overDecodedEventId,
      ),
    });
    expect(removed.statusCode).toBe(204);
    expect(await watchlist.list(subject)).toEqual([]);
  });

  it("answers a missing or deleted event with a neutral not-found", async () => {
    const handler = watchlistHandler(new MemoryWatchlistRepository(), []);
    const result = await handler(addRequest(storedEventId));
    expect(result.statusCode).toBe(404);
    expect(JSON.parse(result.body)).toEqual({ error: "not-found" });
  });

  it("never exposes or mutates another subject's watchlist", async () => {
    const watchlist = new MemoryWatchlistRepository();
    const handler = watchlistHandler(watchlist);
    await handler(addRequest(storedEventId, otherSubject));
    expect(
      JSON.parse(
        (await handler({ route: "watchlist-list", method: "GET", subject }))
          .body,
      ),
    ).toMatchObject({ items: [] });
    const removed = await handler({
      route: "watchlist-remove",
      method: "DELETE",
      subject,
      eventId: storedEventId,
      eventIdAlternatives: [storedEventId],
    });
    expect(removed.statusCode).toBe(204);
    expect(await watchlist.list(otherSubject)).toHaveLength(1);
  });

  it("rejects unexpected query parameters, methods, and body shapes", async () => {
    const handler = watchlistHandler(new MemoryWatchlistRepository());
    const invalid = [
      {
        route: "watchlist-list" as const,
        method: "GET" as const,
        subject,
        query: { limit: "5" },
      },
      { route: "watchlist-list" as const, method: "POST" as const, subject },
      {
        route: "watchlist-remove" as const,
        method: "DELETE" as const,
        subject,
        eventId: "EVENT:MLB",
        eventIdAlternatives: ["EVENT:MLB"],
      },
      { ...addRequest(storedEventId), method: "GET" as const },
      { ...addRequest(storedEventId), contentType: "text/plain" },
      {
        route: "watchlist-add" as const,
        method: "POST" as const,
        contentType: "application/json",
        subject,
        body: "{",
      },
      {
        route: "watchlist-add" as const,
        method: "POST" as const,
        contentType: "application/json",
        subject,
        body: JSON.stringify({
          eventId: storedEventId,
          requesterId: otherSubject,
        }),
      },
      {
        route: "watchlist-add" as const,
        method: "POST" as const,
        contentType: "application/json",
        subject,
        body: JSON.stringify({ eventId: 7 }),
      },
    ];
    for (const request of invalid) {
      const result = await handler(request);
      expect(result.statusCode).toBe(400);
      expect(JSON.parse(result.body)).toEqual({ error: "invalid-request" });
      expect(result.body).not.toContain(otherSubject);
    }
  });

  it("logs mutations with the event, a hashed requester, and the request id", async () => {
    const logs: Readonly<Record<string, unknown>>[] = [];
    const handler = watchlistHandler(
      new MemoryWatchlistRepository(),
      [storedEventId],
      (entry) => logs.push(entry),
    );
    await handler({ ...addRequest(storedEventId), requestId: "request-1" });
    await handler({
      route: "watchlist-remove",
      method: "DELETE",
      subject,
      eventId: storedEventId,
      eventIdAlternatives: [storedEventId],
      requestId: "request-2",
    });
    const mutations = logs.filter(
      (entry) => entry["event"] === "watchlist-mutation",
    );
    expect(mutations).toHaveLength(2);
    expect(mutations[0]).toMatchObject({
      action: "add",
      outcome: "created",
      eventId: storedEventId,
      requestId: "request-1",
    });
    expect(mutations[1]).toMatchObject({
      action: "remove",
      outcome: "removed",
      eventId: storedEventId,
      requestId: "request-2",
    });
    expect(typeof mutations[0]?.["requesterDigest"]).toBe("string");
    expect(mutations[0]?.["requesterDigest"]).toBe(
      mutations[1]?.["requesterDigest"],
    );
    expect(JSON.stringify(logs)).not.toContain(subject);
  });
});
