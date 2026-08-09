import assert from "node:assert/strict";
import test from "node:test";
import {
  RESET_ENABLED_LEAGUES,
  RESET_MAX_MANIFEST_KEYS,
  assertPointInTimeRecovery,
  backupName,
  buildFeedManifest,
  classifyFeedKey,
  createBackup,
  deleteFeedBatches,
  executeReset,
  forcedIngestionDiagnostics,
  quiesceTarget,
  requirePitr,
  resourceState,
  safeErrorCode,
  scanAllKeys,
  scanFeedManifest,
  setResourceState,
  validateAwsIdentity,
  validateForcedIngestion,
  validatePublicFeed,
  validateResetEnvironment,
  validateResetTarget,
  verifyPublicFeed,
  waitForBackup,
} from "./phase1-reset-feed.mjs";

const hash = "a".repeat(64);
const otherHash = "b".repeat(64);
const key = (pk, sk = "CURRENT") => ({ pk, sk });
const fixturePk =
  'FIXTURE_ODDS#["event-1",1,"baseball","moneyline","away","draftkings"]';
const snapshotSk = `SNAPSHOT#2026-08-05T19:30:00.000Z#${hash}`;

test("classifier uses exact key shapes and preserves immutable odds evidence", () => {
  const deleted = [
    key("EVENT#event-1"),
    key("EVENT#event-1", `PROVIDER_REVISION#${hash}`),
    key("EVENT#event-1", "HISTORY#2026-08-05T19:30:00.000Z"),
    key("EVENT_DETAIL#event-1"),
    key(
      "EVENTS#SPORT#baseball#LEAGUE#mlb#STATUS#scheduled#DAY#2026-08-05",
      "2026-08-05T23:05:00.000Z#event-1#0000000000000001",
    ),
    key("EVENT_PROJECTIONS", "READINESS"),
    key("IDENTITY#legacy"),
    key("IDENTITY#legacy", "EVENT#event-1"),
    key("IDENTITY_OWNER#owner"),
    key("MAPPING#mapping"),
    key("EVENT_RECONCILIATION#scope"),
    key("UNRESOLVED#event", `OBSERVATION_ID#${hash}`),
    key("UNRESOLVED#event", `OBSERVATION#${hash}`),
    key("BOOTSTRAP_MARKER#mlb", hash),
    key(`BOOTSTRAP_RESPONSE#${hash}`, "CHUNK#0001"),
    key("CHECKPOINT#mlb"),
    key("CURSOR_MARKER#mlb", hash),
    key("PROVIDER_EVENT_FENCE#mlb", hash),
    key("PROVIDER_PAGE#mlb", hash),
    key("RUN#ingestion-run:one"),
    key("OUTBOX_PENDING#mlb", `0000000000000001#0000000000000002#${hash}`),
    key("OUTBOX_DELIVERED#mlb", hash),
    key("ODDS_CONTROL#ATTEMPT#attempt-1"),
    key("ODDS_CONTROL#PAGE#run-1#page-1"),
    key("ODDS_CONTROL#HEALTH#sharpapi%3Amlb"),
    key("ODDS_CONTROL#CHECKPOINT#mlb"),
    key("ODDS_CONTROL#CONTINUATION#mlb"),
    key(`ODDS_CONTROL#GAP#${hash}`),
    key("ODDS_CONTROL#MAINTENANCE#feed-reset"),
    key(fixturePk),
    key(fixturePk, "AVAILABILITY"),
    key(`FIXTURE_ODDS_GROUP#${hash}`, "AVAILABILITY"),
    key(
      "BETTING_SPLIT#event-1",
      "CURRENT#sharpapi#V1#moneyline#away#none#draftkings",
    ),
    key(
      "BETTING_SPLIT#event-1",
      `HISTORY#2026-08-05T19:30:00.000Z#split:${hash}`,
    ),
    key(
      "BETTING_SPLIT_GAP#sharpapi#provider-event-1",
      `2026-08-05T19:30:00.000Z#${hash}`,
    ),
  ];
  for (const candidate of deleted)
    assert.equal(
      classifyFeedKey(candidate).disposition,
      "delete",
      `${candidate.pk}/${candidate.sk}`,
    );

  const preserved = [
    key(fixturePk, snapshotSk),
    key(
      'FIXTURE_ODDS#["event?one",1,"baseball","moneyline","away","book&one"]',
      snapshotSk,
    ),
    key("ODDS_SNAPSHOTS_BY_ID", hash),
    key("ODDS_HISTORY#event-1", snapshotSk),
    key("RESULT#one"),
    key(`RESULT_EXACT#one`, "result:one"),
    key("RESULT_CHECKPOINT#baseball#mlb"),
    key("RESULT_RUN#baseball#mlb", "2026-08-05T19:30:00.000Z#result-run:one"),
    key("UNRESOLVED_RESULT#sharpapi", "ITEM#result:one"),
    key(`EVALUATION#${hash}`, "RECORD"),
    key("EVALUATION_ATTEMPT#attempt-1", "RECORD"),
    key(`EVALUATION_TERMINAL#${hash}`, "CLAIM"),
    key("PAPER_BETS_BY_DAY#2026-08-05", `paper-bet:${hash}`),
    key("PAPER_BETS_BY_EVENT#event-1", `paper-bet:${hash}`),
    key("PAPER_GRADE#paper-bet:one"),
    key("PAPER_PICK_GENERATION#generation-1", "EVENT#event-1"),
    key("PAPER_PICK_RUN#paper-pick-run:one", "ITEM#pick-1"),
    key("PERFORMANCE_COHORT#cohort-1", "DEFINITION"),
    key(`PERFORMANCE_COHORT_CUTOFF#${hash}`, "2026-08-05T19:30:00.000Z"),
    key("PERFORMANCE_COHORTS", "cohort-1"),
    key("PERFORMANCE_REPORT#one", "RECORD"),
    key("PERFORMANCE_REPORTS", "2026-08-05T19:30:00.000Z#00000001#report-1"),
    key("STRATEGY#one", "ARTIFACT#v1"),
    key("STRATEGY_ACTIVE#one", "2026-08-05T19:30:00.000Z#activation-1"),
    key("STRATEGY_ACTIVE_HEAD#one", "HEAD"),
    key("STRATEGY_APPROVAL#one", hash),
    key("STRATEGY_EVIDENCE#one", hash),
    key("STRATEGY_ACTIVATION", "activation-request-1"),
    key("STRATEGY_DECISION", "decision-request-1"),
    key("EXPERIMENT#one", "RECORD"),
    key("EXPERIMENT_AUDIT#one", "2026-08-05T19:30:00.000Z#decision-1"),
    key("EXPERIMENTS", "2026-08-05T19:30:00.000Z#experiment-1"),
    key("RETROSPECTIVE#one"),
    key("RETROSPECTIVE_VERSION#one", "RECORD"),
    key("RETROSPECTIVE_REPORT#one", "report-1"),
    key("RETROSPECTIVE_AUDIT#one", "2026-08-05T19:30:00.000Z#decision-1"),
    key("RETROSPECTIVE_REPLAY#one", "replay-1"),
    key("RETROSPECTIVES", "8640000000000000#retrospective-1"),
    key("WALK_FORWARD_REQUEST#one", "RECORD"),
    key("EXPERIMENT_WINDOW#one", "RECORD"),
    key("STRATEGY_PERFORMANCE_EVIDENCE#one", "RECORD"),
    key("STRATEGY_GATE_POLICY#one", "RECORD"),
  ];
  for (const candidate of preserved)
    assert.equal(
      classifyFeedKey(candidate).disposition,
      "preserve",
      `${candidate.pk}/${candidate.sk}`,
    );

  for (const candidate of [
    key("EVENT#event-1", "FUTURE"),
    key(fixturePk, `SNAPSHOT#bad#${hash}`),
    key("RESULT#one", "FUTURE"),
    key("BETTING_SPLIT#event-1", "FUTURE"),
    key("FUTURE_UNKNOWN#one"),
    key("ODDS_CONTROL#FUTURE#one"),
    key(
      'FIXTURE_ODDS#[ "event-1",1,"baseball","moneyline","away","draftkings"]',
    ),
  ])
    assert.equal(classifyFeedKey(candidate).disposition, "unexpected");
});

test("manifest is stable, capped, duplicate-safe, and proves preserved keys", () => {
  const rows = [
    key("RESULT#keep"),
    key(fixturePk, snapshotSk),
    key("EVENT#two"),
    key("EVENT#one"),
  ];
  const first = buildFeedManifest(rows);
  const reordered = buildFeedManifest([...rows].reverse());
  assert.equal(first.deleteCount, 2);
  assert.equal(first.preserveCount, 2);
  assert.equal(first.digest, reordered.digest);
  assert.equal(first.preserveDigest, reordered.preserveDigest);
  assert.deepEqual(
    first.deleteKeys.map(({ pk }) => pk),
    ["EVENT#one", "EVENT#two"],
  );
  assert.throws(
    () => buildFeedManifest([key("EVENT#one"), key("EVENT#one")]),
    /duplicate/,
  );
  assert.throws(() => buildFeedManifest([key("UNKNOWN#one")]), /unclassified/);
  const oversized = Array.from({ length: RESET_MAX_MANIFEST_KEYS + 1 }, () =>
    key("EVENT#one"),
  );
  assert.throws(() => buildFeedManifest(oversized), /key-limit/);
});

test("environment and identity require the exact dev target and apply confirmation", () => {
  const base = { AWS_ACCOUNT_ID: "228246988391", AWS_REGION: "us-east-1" };
  assert.deepEqual(validateResetEnvironment(base), { mode: "dry-run" });
  assert.deepEqual(
    validateResetEnvironment({
      ...base,
      FTE_PHASE1_RESET_MODE: "apply",
      FTE_PHASE1_RESET_APPLY: "RESET",
      GITHUB_ACTIONS: "true",
      GITHUB_REPOSITORY: "kevishie/find-the-edge",
      GITHUB_REF: "refs/heads/main",
      GITHUB_EVENT_NAME: "workflow_dispatch",
      GITHUB_WORKFLOW_REF:
        "kevishie/find-the-edge/.github/workflows/reset-phase1-feed.yml@refs/heads/main",
      GITHUB_JOB: "reset",
      GITHUB_RUN_ID: "123",
    }),
    { mode: "apply" },
  );
  assert.throws(
    () => validateResetEnvironment({ ...base, AWS_REGION: "us-west-2" }),
    /target/,
  );
  assert.throws(
    () => validateResetEnvironment({ ...base, FTE_PHASE1_RESET_MODE: "apply" }),
    /confirmation/,
  );
  assert.throws(
    () =>
      validateResetEnvironment({
        ...base,
        FTE_PHASE1_RESET_MODE: "apply",
        FTE_PHASE1_RESET_APPLY: "RESET",
      }),
    /workflow-required/,
  );
  assert.doesNotThrow(() =>
    validateAwsIdentity({
      Account: base.AWS_ACCOUNT_ID,
      Arn: "arn:aws:iam::228246988391:role/test",
      UserId: "test",
    }),
  );
});

const targetInput = () => {
  const stack = {
    StackName: "FindTheEdge-staging-Foundation",
    StackId:
      "arn:aws:cloudformation:us-east-1:228246988391:stack/FindTheEdge-staging-Foundation/id",
    StackStatus: "UPDATE_COMPLETE",
  };
  const resources = [
    ["EventIngestionTableABC", "AWS::DynamoDB::Table", "table"],
    ["LiveOddsIngestionABC", "AWS::Lambda::Function", "live"],
    [
      "LiveOddsControlPlaneQueueABC",
      "AWS::SQS::Queue",
      "https://sqs.us-east-1.amazonaws.com/228246988391/queue",
    ],
    ["LiveOddsSchedulerABC", "AWS::Events::Rule", "rule"],
    [
      "LiveOddsIngestionSqsEventSourceABC",
      "AWS::Lambda::EventSourceMapping",
      "mapping",
    ],
    ["FixtureOddsProjectionABC", "AWS::Lambda::Function", "projection"],
    [
      "FixtureOddsProjectionDynamoDBEventSourceABC",
      "AWS::Lambda::EventSourceMapping",
      "projection-mapping",
    ],
    ["UpcomingEventsWorkerABC", "AWS::Lambda::Function", "upcoming"],
    [
      "UpcomingEventsWorkerSqsEventSourceABC",
      "AWS::Lambda::EventSourceMapping",
      "upcoming-mapping",
    ],
    [
      "UpcomingEventsQueueABC",
      "AWS::SQS::Queue",
      "https://sqs.us-east-1.amazonaws.com/228246988391/upcoming",
    ],
    ["UpcomingEventsProducerABC", "AWS::Lambda::Function", "producer"],
    ["UpcomingEventsSchedulerReadyABC", "AWS::Events::Rule", "upcoming-rule"],
    ["EventsHttpApiABC", "AWS::ApiGatewayV2::Api", "example"],
    ["EventApiStageABC", "AWS::ApiGatewayV2::Stage", "staging"],
  ].map(([LogicalResourceId, ResourceType, PhysicalResourceId]) => ({
    LogicalResourceId,
    ResourceType,
    PhysicalResourceId,
  }));
  return {
    stack,
    resources,
    outputs: {
      LiveOddsIngestionFunctionName: "live",
      FixtureOddsProjectionFunctionName: "projection",
      EventsApiEndpoint:
        "https://example.execute-api.us-east-1.amazonaws.com/staging",
    },
    lambdaConfigurations: [
      {
        FunctionName: "live",
        Timeout: 600,
        Environment: {
          Variables: {
            FTE_EVENT_TABLE: "table",
            FTE_LIVE_ODDS_QUEUE_URL:
              "https://sqs.us-east-1.amazonaws.com/228246988391/queue",
            FTE_SHARP_API_ENABLED: "true",
            FTE_SHARP_API_SECRET_ID: "find-the-edge/staging/sharpapi",
          },
        },
      },
      {
        FunctionName: "projection",
        Timeout: 30,
        Environment: { Variables: { FTE_EVENT_TABLE: "table" } },
      },
      {
        FunctionName: "upcoming",
        Timeout: 60,
        Environment: {
          Variables: {
            FTE_EVENT_TABLE: "table",
            FTE_UPCOMING_QUEUE_URL:
              "https://sqs.us-east-1.amazonaws.com/228246988391/upcoming",
          },
        },
      },
      {
        FunctionName: "producer",
        Timeout: 30,
        Environment: {
          Variables: {
            FTE_UPCOMING_QUEUE_URL:
              "https://sqs.us-east-1.amazonaws.com/228246988391/upcoming",
          },
        },
      },
    ],
  };
};

test("target validator rejects unstable stacks, wrong bindings, and invalid API endpoints", () => {
  const input = targetInput();
  assert.deepEqual(validateResetTarget(input), {
    stackId: input.stack.StackId,
    tableName: "table",
    writers: {
      live: { functionName: "live", timeoutSeconds: 600 },
      projection: { functionName: "projection", timeoutSeconds: 30 },
      upcoming: { functionName: "upcoming", timeoutSeconds: 60 },
      producer: { functionName: "producer", timeoutSeconds: 30 },
    },
    queues: {
      live: input.resources[2].PhysicalResourceId,
      upcoming: input.resources[9].PhysicalResourceId,
    },
    rules: { live: "rule", upcoming: "upcoming-rule" },
    mappings: {
      live: "mapping",
      projection: "projection-mapping",
      upcoming: "upcoming-mapping",
    },
    apiBase: input.outputs.EventsApiEndpoint,
  });
  assert.throws(
    () =>
      validateResetTarget({
        ...input,
        stack: { ...input.stack, StackStatus: "UPDATE_IN_PROGRESS" },
      }),
    /stack/,
  );
  assert.throws(
    () =>
      validateResetTarget({
        ...input,
        outputs: { ...input.outputs, EventsApiEndpoint: "http://localhost" },
      }),
    /binding/,
  );
  assert.throws(
    () =>
      validateResetTarget({
        ...input,
        lambdaConfigurations: input.lambdaConfigurations.map((configuration) =>
          configuration.FunctionName === "live"
            ? {
                ...configuration,
                Environment: {
                  Variables: {
                    ...configuration.Environment.Variables,
                    FTE_EVENT_TABLE: "other",
                  },
                },
              }
            : configuration,
        ),
      }),
    /binding/,
  );
  assert.throws(
    () =>
      validateResetTarget({
        ...input,
        resources: [
          ...input.resources,
          {
            LogicalResourceId: "FixtureOddsSeedABC",
            ResourceType: "AWS::Lambda::Function",
            PhysicalResourceId: "seed",
          },
        ],
      }),
    /fixture-seed-present/,
  );
});

test("PITR and backup availability are mandatory and bounded", async () => {
  assert.doesNotThrow(() =>
    assertPointInTimeRecovery({
      ContinuousBackupsStatus: "ENABLED",
      PointInTimeRecoveryDescription: { PointInTimeRecoveryStatus: "ENABLED" },
    }),
  );
  assert.throws(
    () => assertPointInTimeRecovery({ ContinuousBackupsStatus: "ENABLED" }),
    /pitr/,
  );
  assert.match(
    backupName(new Date("2026-08-05T14:00:00.000Z")),
    /^find-the-edge-dev-feed-reset-20260805T140000000Z$/,
  );
  const states = ["CREATING", "AVAILABLE"];
  await waitForBackup(async () => states.shift(), {
    attempts: 2,
    delay: async () => {},
  });
  await assert.rejects(
    waitForBackup(async () => "CREATING", {
      attempts: 2,
      delay: async () => {},
    }),
    /timeout/,
  );
});

test("batch deletion pages, retries, and rejects injected or duplicate keys", async () => {
  const sizes = [];
  let first = true;
  const keys = Array.from({ length: 51 }, (_, index) => key(`EVENT#${index}`));
  const deleted = await deleteFeedBatches(
    keys,
    async (pending) => {
      sizes.push(pending.length);
      if (first) {
        first = false;
        return pending.slice(0, 2);
      }
      return [];
    },
    { delay: async () => {} },
  );
  assert.equal(deleted, 51);
  assert.deepEqual(sizes, [25, 2, 25, 1]);
  await assert.rejects(
    deleteFeedBatches([key("EVENT#one")], async () => [key("EVENT#injected")], {
      delay: async () => {},
    }),
    /response-key-invalid/,
  );
  await assert.rejects(
    deleteFeedBatches(
      [key("EVENT#one")],
      async (pending) => [pending[0], pending[0]],
      { delay: async () => {} },
    ),
    /response|response-key-invalid/,
  );
});

test("key scan follows cursors, rejects cycles, and enforces its memory cap", async () => {
  const pages = new Map([
    [undefined, { keys: [key("EVENT#one")], cursor: { pk: { S: "one" } } }],
    [JSON.stringify({ pk: { S: "one" } }), { keys: [key("RESULT#keep")] }],
  ]);
  assert.equal(
    (
      await scanAllKeys(
        async (cursor) =>
          pages.get(JSON.stringify(cursor)) ?? pages.get(cursor),
      )
    ).length,
    2,
  );
  await assert.rejects(
    scanAllKeys(async () => ({ keys: [], cursor: { pk: { S: "same" } } })),
    /cycle/,
  );
  await assert.rejects(
    scanAllKeys(async () => ({ keys: [key("EVENT#one"), key("EVENT#two")] }), {
      maxKeys: 1,
    }),
    /key-limit/,
  );
});

test("streaming manifest is deterministic and retains only deletable keys", async () => {
  const rows = [
    key("RESULT#keep-two"),
    key("EVENT#two"),
    key(fixturePk, snapshotSk),
    key("EVENT#one"),
  ];
  const scan = async (ordered) =>
    scanFeedManifest(async (cursor) => {
      const offset = cursor ?? 0;
      const keys = ordered.slice(offset, offset + 2);
      return {
        keys,
        ...(offset + 2 < ordered.length ? { cursor: offset + 2 } : {}),
      };
    });
  const first = await scan(rows);
  const reordered = await scan([...rows].reverse());
  assert.equal(first.manifestVersion, 2);
  assert.equal(first.scanned, 4);
  assert.equal(first.deleteCount, 2);
  assert.equal(first.preserveCount, 2);
  assert.equal(first.digest, reordered.digest);
  assert.equal(first.preserveDigest, reordered.preserveDigest);
  assert.deepEqual(first.deleteKeys, [key("EVENT#one"), key("EVENT#two")]);
  assert.equal("preservedKeys" in first, false);
});

test("streaming manifest scans beyond the legacy total-key cap with bounded retention", async () => {
  const pageSize = 1_000;
  const pageCount = Math.floor(RESET_MAX_MANIFEST_KEYS / pageSize) + 1;
  const manifest = await scanFeedManifest(
    async (cursor) => {
      const page = cursor ?? 0;
      const keys = Array.from({ length: pageSize }, (_, index) =>
        key(`RESULT#keep-${page}-${index}`),
      );
      if (page === 0) keys[0] = key("EVENT#delete-me");
      return {
        keys,
        ...(page + 1 < pageCount ? { cursor: page + 1 } : {}),
      };
    },
    { maxPageKeys: pageSize },
  );
  assert.ok(manifest.scanned > RESET_MAX_MANIFEST_KEYS);
  assert.equal(manifest.deleteCount, 1);
  assert.equal(manifest.preserveCount, manifest.scanned - 1);
  assert.deepEqual(manifest.deleteKeys, [key("EVENT#delete-me")]);
});

test("streaming manifest fails closed on an unsafe key or oversized delete set", async () => {
  await assert.rejects(
    scanFeedManifest(async () => ({ keys: [key("UNKNOWN#one")] })),
    /unclassified/,
  );
  await assert.rejects(
    scanFeedManifest(
      async () => ({ keys: [key("EVENT#one"), key("EVENT#two")] }),
      { maxDeleteKeys: 1 },
    ),
    /delete-key-limit/,
  );
});

test("reset accepts a streaming plan and never mutates before it is complete", async () => {
  const calls = [];
  const streamed = await scanFeedManifest(async () => ({
    keys: [key("EVENT#one"), key("RESULT#keep")],
  }));
  const result = await executeReset("dry-run", {
    scan: async () => (calls.push("scan"), streamed),
    report: async () => calls.push("report"),
    quiesce: async () => calls.push("quiesce"),
  });
  assert.equal(result.manifest.manifestVersion, 2);
  assert.deepEqual(calls, ["scan", "report"]);

  calls.length = 0;
  await assert.rejects(
    executeReset("apply", {
      scan: async () =>
        scanFeedManifest(async () => ({ keys: [key("UNKNOWN#one")] })),
      report: async () => calls.push("report"),
      quiesce: async () => calls.push("quiesce"),
    }),
    /unclassified/,
  );
  assert.deepEqual(calls, []);
});

const ingestionSummary = () =>
  RESET_ENABLED_LEAGUES.map((leagueKey) => ({
    leagueKey,
    providerId: "sharpapi",
    status: "completed",
    pages: 1,
    quotaCost: 1,
  }));

test("forced ingestion requires every enabled SharpAPI league", () => {
  assert.deepEqual(validateForcedIngestion(ingestionSummary()), {
    leagues: RESET_ENABLED_LEAGUES.length,
    completed: RESET_ENABLED_LEAGUES.length,
    pages: Object.fromEntries(
      RESET_ENABLED_LEAGUES.map((league) => [league, 1]),
    ),
  });
  assert.throws(
    () =>
      validateForcedIngestion(
        ingestionSummary().map((result, index) =>
          index === 0 ? { ...result, status: "failed" } : result,
        ),
      ),
    /enabled-league-ingestion-incomplete/,
  );
  assert.throws(
    () => validateForcedIngestion(ingestionSummary().slice(1)),
    /league-set-invalid/,
  );
  assert.throws(
    () =>
      validateForcedIngestion([
        ...ingestionSummary().slice(0, -1),
        { ...ingestionSummary()[0] },
      ]),
    /duplicate/,
  );
  assert.throws(
    () =>
      validateForcedIngestion([
        ...ingestionSummary(),
        {
          leagueKey: "new-league",
          providerId: "sharpapi",
          status: "failed",
          pages: 0,
          quotaCost: 0,
        },
      ]),
    /league-set-invalid/,
  );
});

test("forced ingestion diagnostics expose only bounded league outcomes", () => {
  assert.deepEqual(
    forcedIngestionDiagnostics([
      {
        leagueKey: "mlb",
        providerId: "sharpapi",
        status: "skipped",
        reason: "schedule-provider-recovering",
        pages: 0,
        quotaCost: 1,
        licensedPayload: "must-not-appear",
      },
      {
        leagueKey: "secret-league",
        providerId: "secret-provider",
        status: "unexpected",
        failureReason: "contains spaces and secret detail",
        pages: -1,
        quotaCost: 1.5,
      },
    ]),
    {
      shape: "array",
      results: [
        {
          leagueKey: "mlb",
          providerId: "sharpapi",
          status: "skipped",
          reason: "schedule-provider-recovering",
          pages: 0,
          quotaCost: 1,
        },
        {
          leagueKey: "invalid",
          providerId: "invalid",
          status: "invalid",
          reason: "none",
          pages: null,
          quotaCost: null,
        },
      ],
    },
  );
  assert.deepEqual(forcedIngestionDiagnostics({ secret: "value" }), {
    shape: "invalid",
  });
});

const now = new Date("2026-08-05T20:00:00.000Z");
const publicGame = {
  id: "event-1",
  sportKey: "mlb",
  leagueKey: "mlb",
  status: "scheduled",
  startsAt: "2026-08-05T23:05:00.000Z",
  eastern: { calendarDay: "2026-08-05" },
  participants: [{ label: "Away" }, { label: "Home" }],
  odds: {
    state: "available",
    selections: [
      {
        sportsbookId: "draftkings",
        americanOdds: -110,
        observedAt: "2026-08-05T19:30:00.000Z",
        retrievedAt: "2026-08-05T19:31:00.000Z",
      },
    ],
  },
};
const publicSplitGame = {
  ...publicGame,
  splits: [
    {
      canonicalEventId: "event-1",
      providerId: "sharpapi",
      betPercent: 55,
      providerTimestamp: "2026-08-05T18:00:00.000Z",
      retrievedAt: "2026-08-05T18:01:00.000Z",
    },
  ],
};

test("public verification requires unique matchups, fresh valid odds, and fresh splits", async () => {
  assert.deepEqual(
    validatePublicFeed([publicGame], [publicSplitGame], "2026-08-05", now),
    {
      day: "2026-08-05",
      games: 1,
      oddsGames: 1,
      oddsSelections: 1,
      splitObservations: 1,
    },
  );
  assert.throws(
    () =>
      validatePublicFeed(
        [
          publicGame,
          {
            ...publicGame,
            id: "event-2",
            startsAt: "2026-08-05T23:06:00.000Z",
            participants: [...publicGame.participants].reverse(),
          },
        ],
        [publicSplitGame],
        "2026-08-05",
        now,
      ),
    /duplicate-matchup/,
  );
  assert.throws(
    () =>
      validatePublicFeed(
        [
          {
            ...publicGame,
            odds: {
              state: "available",
              selections: [
                {
                  ...publicGame.odds.selections[0],
                  americanOdds: -99,
                },
              ],
            },
          },
        ],
        [publicSplitGame],
        "2026-08-05",
        now,
      ),
    /odds-unavailable/,
  );
  assert.throws(
    () =>
      validatePublicFeed(
        [publicGame],
        [
          {
            ...publicSplitGame,
            splits: [{ ...publicSplitGame.splits[0], betPercent: 101 }],
          },
        ],
        "2026-08-05",
        now,
      ),
    /splits-unavailable/,
  );
  const secondGame = {
    ...publicGame,
    id: "event-2",
    startsAt: "2026-08-05T21:05:00.000Z",
    participants: [{ label: "Other Away" }, { label: "Other Home" }],
    odds: { state: "unavailable" },
  };
  assert.throws(
    () =>
      validatePublicFeed(
        [publicGame, secondGame],
        [
          { ...publicGame, splits: [] },
          {
            ...secondGame,
            splits: [
              {
                ...publicSplitGame.splits[0],
                canonicalEventId: "event-2",
              },
            ],
          },
        ],
        "2026-08-05",
        now,
      ),
    /complete-game-unavailable/,
  );

  let request = 0;
  const fetcher = async (url) => {
    request += 1;
    if (request <= 2) return new Response("unavailable", { status: 503 });
    return new Response(
      JSON.stringify({
        items: url.includes("/splits?") ? [publicSplitGame] : [publicGame],
        projectionState: "ready",
        evaluationState: "complete",
        nextCursor: null,
      }),
      { status: 200 },
    );
  };
  await assert.doesNotReject(
    verifyPublicFeed({
      apiBase: "https://example.execute-api.us-east-1.amazonaws.com/staging",
      day: "2026-08-05",
      fetcher,
      now: () => now,
      attempts: 2,
      delay: async () => {},
    }),
  );
});

test("dry run is read-only; apply proves preservation and always restores", async () => {
  const calls = [];
  const preserved = key(fixturePk, snapshotSk);
  const initial = [key("EVENT#one"), preserved];
  const operations = {
    scan: async () => initial,
    report: async () => calls.push("report"),
    quiesce: async () => (
      calls.push("quiesce"),
      {
        schedulerEnabled: true,
        mappingEnabled: true,
        reservedConcurrency: null,
      }
    ),
    requirePitr: async () => calls.push("pitr"),
    backup: async () => (calls.push("backup"), { arn: "backup" }),
    delete: async () => calls.push("delete"),
    ingest: async () => (calls.push("ingest"), { ok: true }),
    verify: async () => (calls.push("verify"), { games: 1 }),
    restore: async () => calls.push("restore"),
  };
  await executeReset("dry-run", operations);
  assert.deepEqual(calls, ["report"]);

  calls.length = 0;
  let scan = 0;
  await executeReset("apply", {
    ...operations,
    scan: async () => {
      scan += 1;
      if (scan <= 2) return initial;
      if (scan === 3) return [preserved];
      return [preserved, key("EVENT#new")];
    },
  });
  assert.deepEqual(calls, [
    "report",
    "quiesce",
    "pitr",
    "backup",
    "delete",
    "ingest",
    "verify",
    "restore",
  ]);

  calls.length = 0;
  scan = 0;
  await assert.rejects(
    executeReset("apply", {
      ...operations,
      scan: async () => (++scan <= 2 ? initial : [preserved]),
      ingest: async () => {
        calls.push("ingest");
        throw new Error("reset-provider-failed");
      },
    }),
    /provider-failed/,
  );
  assert.equal(calls.at(-1), "restore");

  await assert.rejects(
    executeReset("apply", {
      ...operations,
      scan: async () => {
        throw new Error("raw SDK detail");
      },
    }),
    /pre-mutation-failed/,
  );
  assert.equal(
    safeErrorCode(new Error("secret raw detail")),
    "reset-operation-failed",
  );
  await assert.rejects(executeReset("typo", operations), /mode-invalid/);
});

const writerTarget = {
  tableName: "table",
  writers: {
    live: { functionName: "live", timeoutSeconds: 7 },
    projection: { functionName: "projection", timeoutSeconds: 3 },
    upcoming: { functionName: "upcoming", timeoutSeconds: 5 },
    producer: { functionName: "producer", timeoutSeconds: 2 },
  },
  queues: {
    live: "https://sqs.us-east-1.amazonaws.com/228246988391/live",
    upcoming: "https://sqs.us-east-1.amazonaws.com/228246988391/upcoming",
  },
  rules: { live: "live-rule", upcoming: "upcoming-rule" },
  mappings: {
    live: "live-mapping",
    projection: "projection-mapping",
    upcoming: "upcoming-mapping",
  },
};

const writerHarness = (options = {}) => {
  const queueArns = {
    live: "arn:aws:sqs:us-east-1:228246988391:live",
    upcoming: "arn:aws:sqs:us-east-1:228246988391:upcoming",
  };
  const state = {
    rules: { live: "ENABLED", upcoming: "DISABLED" },
    mappings: {
      live: "Enabled",
      projection: "Enabled",
      upcoming: "Enabled",
    },
    concurrency: { live: 2, projection: null, upcoming: null, producer: null },
    purges: { live: 0, upcoming: 0 },
  };
  const calls = [];
  const aws = (arguments_) => {
    const operation = `${arguments_[0]} ${arguments_[1]}`;
    calls.push(operation);
    if (options.fail?.(operation, state)) throw new Error("injected failure");
    const valueAfter = (flag) => arguments_[arguments_.indexOf(flag) + 1];
    if (operation === "events describe-rule") {
      const name = valueAfter("--name").startsWith("live")
        ? "live"
        : "upcoming";
      return { State: state.rules[name] };
    }
    if (operation === "events list-targets-by-rule") {
      const name = valueAfter("--rule").startsWith("live")
        ? "live"
        : "upcoming";
      return {
        Targets: [
          {
            Id: `${name}-target`,
            Arn:
              name === "live"
                ? options.wrongTarget
                  ? `${queueArns.live}-wrong`
                  : queueArns.live
                : "arn:aws:lambda:us-east-1:228246988391:function:producer",
          },
        ],
      };
    }
    if (operation === "lambda get-event-source-mapping") {
      const name = valueAfter("--uuid").replace("-mapping", "");
      return {
        State: state.mappings[name],
        FunctionArn: `arn:aws:lambda:us-east-1:228246988391:function:${name}`,
        EventSourceArn:
          name === "projection"
            ? "arn:aws:dynamodb:us-east-1:228246988391:table/table/stream/2026-08-05T00:00:00.000"
            : queueArns[name],
      };
    }
    if (operation === "sqs get-queue-attributes") {
      const name = valueAfter("--queue-url").endsWith("/live")
        ? "live"
        : "upcoming";
      return {
        Attributes: {
          QueueArn: queueArns[name],
          ApproximateNumberOfMessages: "0",
          ApproximateNumberOfMessagesNotVisible: "0",
          ...(options.missingQueueAttribute
            ? {}
            : { ApproximateNumberOfMessagesDelayed: "0" }),
        },
      };
    }
    if (operation === "lambda get-function-concurrency") {
      const name = valueAfter("--function-name");
      return state.concurrency[name] === null
        ? {}
        : { ReservedConcurrentExecutions: state.concurrency[name] };
    }
    if (operation === "lambda put-function-concurrency") {
      const name = valueAfter("--function-name");
      state.concurrency[name] = Number(
        arguments_[arguments_.indexOf("--reserved-concurrent-executions") + 1],
      );
      return {};
    }
    if (operation === "lambda delete-function-concurrency") {
      state.concurrency[valueAfter("--function-name")] = null;
      return {};
    }
    if (operation === "lambda update-event-source-mapping") {
      const name = valueAfter("--uuid").replace("-mapping", "");
      state.mappings[name] = arguments_.includes("--enabled")
        ? "Enabled"
        : "Disabled";
      return {};
    }
    if (operation === "events enable-rule") {
      const name = valueAfter("--name").startsWith("live")
        ? "live"
        : "upcoming";
      state.rules[name] = "ENABLED";
      return {};
    }
    if (operation === "events disable-rule") {
      const name = valueAfter("--name").startsWith("live")
        ? "live"
        : "upcoming";
      state.rules[name] = "DISABLED";
      return {};
    }
    if (operation === "sqs purge-queue") {
      const name = valueAfter("--queue-url").endsWith("/live")
        ? "live"
        : "upcoming";
      state.purges[name] += 1;
      return {};
    }
    throw new Error(`unexpected ${operation}`);
  };
  return { aws, calls, state };
};

test("writer adapter binds all feed writers, fences them, and restores exact state", async () => {
  const harness = writerHarness();
  let stateChecks = 0;
  assert.deepEqual(
    resourceState(writerTarget, {}, harness.aws, () => {
      stateChecks += 1;
    }),
    {
      rules: { live: true, upcoming: false },
      mappings: { live: true, projection: true, upcoming: true },
      concurrency: {
        live: 2,
        projection: null,
        upcoming: null,
        producer: null,
      },
    },
  );
  assert.equal(stateChecks, 14, "checks the deadline between binding reads");
  const delays = [];
  const prior = await quiesceTarget(
    writerTarget,
    {},
    {
      aws: harness.aws,
      delay: async (milliseconds) => delays.push(milliseconds),
    },
  );
  assert.deepEqual(prior, {
    rules: { live: true, upcoming: false },
    mappings: { live: true, projection: true, upcoming: true },
    concurrency: { live: 2, projection: null, upcoming: null, producer: null },
  });
  assert.deepEqual(harness.state.rules, {
    live: "DISABLED",
    upcoming: "DISABLED",
  });
  assert.deepEqual(harness.state.mappings, {
    live: "Disabled",
    projection: "Disabled",
    upcoming: "Disabled",
  });
  assert.deepEqual(harness.state.concurrency, {
    live: 0,
    projection: 0,
    upcoming: 0,
    producer: 0,
  });
  assert.deepEqual(harness.state.purges, { live: 1, upcoming: 1 });
  assert.equal(
    delays.reduce((total, milliseconds) => total + milliseconds, 0),
    135_000,
    "waits for the deployed Lambda timeout, both purge windows, and stable queues",
  );
  assert.ok(
    delays.every((milliseconds) => milliseconds <= 2_000),
    "long waits are split into deadline-aware chunks",
  );
  await setResourceState(writerTarget, {}, prior, {
    aws: harness.aws,
    delay: async () => {},
  });
  assert.deepEqual(harness.state.rules, {
    live: "ENABLED",
    upcoming: "DISABLED",
  });
  assert.deepEqual(harness.state.mappings, {
    live: "Enabled",
    projection: "Enabled",
    upcoming: "Enabled",
  });
  assert.deepEqual(harness.state.concurrency, {
    live: 2,
    projection: null,
    upcoming: null,
    producer: null,
  });

  assert.throws(
    () =>
      resourceState(writerTarget, {}, writerHarness({ wrongTarget: true }).aws),
    /source-binding-invalid/,
  );
  await assert.rejects(
    quiesceTarget(
      writerTarget,
      {},
      {
        aws: writerHarness({ missingQueueAttribute: true }).aws,
        delay: async () => {},
      },
    ),
    /queue-attributes-invalid|quiesce-failed/,
  );
});

test("deadline interruption restores writer state without consuming cleanup reserve", async () => {
  const harness = writerHarness();
  let interrupted = false;
  await assert.rejects(
    quiesceTarget(
      writerTarget,
      {},
      {
        aws: harness.aws,
        delay: async () => {
          interrupted = true;
        },
        check: () => {
          if (interrupted) throw new Error("reset-operation-deadline");
        },
      },
    ),
    /reset-quiesce-failed/,
  );
  assert.equal(harness.state.rules.live, "ENABLED");
  assert.equal(harness.state.rules.upcoming, "DISABLED");
  assert.equal(harness.state.mappings.live, "Enabled");
  assert.equal(harness.state.mappings.projection, "Enabled");
  assert.equal(harness.state.mappings.upcoming, "Enabled");
  assert.equal(harness.state.concurrency.live, 2);
  assert.equal(harness.state.concurrency.projection, null);
  assert.equal(harness.state.concurrency.upcoming, null);
  assert.equal(harness.state.concurrency.producer, null);
});

test("partial quiesce restores prior state and surfaces combined restore failure", async () => {
  const alreadyDisabled = writerHarness();
  alreadyDisabled.state.concurrency.live = 0;
  await assert.rejects(
    quiesceTarget(
      writerTarget,
      {},
      {
        aws: alreadyDisabled.aws,
        delay: async () => {},
      },
    ),
    /prior-concurrency-zero/,
  );
  assert.deepEqual(alreadyDisabled.state.purges, { live: 0, upcoming: 0 });

  let purgeFailures = 1;
  const recoverable = writerHarness({
    fail: (operation) => operation === "sqs purge-queue" && purgeFailures-- > 0,
  });
  await assert.rejects(
    quiesceTarget(
      writerTarget,
      {},
      {
        aws: recoverable.aws,
        delay: async () => {},
      },
    ),
    /reset-quiesce-failed/,
  );
  assert.equal(recoverable.state.rules.live, "ENABLED");
  assert.equal(recoverable.state.mappings.live, "Enabled");
  assert.equal(recoverable.state.concurrency.live, 2);

  let failedPurge = false;
  const unrecoverable = writerHarness({
    fail: (operation) => {
      if (operation === "sqs purge-queue" && !failedPurge) {
        failedPurge = true;
        return true;
      }
      return failedPurge && operation === "events enable-rule";
    },
  });
  await assert.rejects(
    quiesceTarget(
      writerTarget,
      {},
      {
        aws: unrecoverable.aws,
        delay: async () => {},
      },
    ),
    /reset-quiesce-and-restore-failed/,
  );
});

test("backup adapter binds PITR, target ARN, and availability polling", async () => {
  const target = { tableName: "table" };
  const arn =
    "arn:aws:dynamodb:us-east-1:228246988391:table/table/backup/backup-id";
  const states = ["CREATING", "AVAILABLE"];
  const calls = [];
  const aws = (arguments_) => {
    const operation = `${arguments_[0]} ${arguments_[1]}`;
    calls.push(operation);
    if (operation === "dynamodb describe-continuous-backups")
      return {
        ContinuousBackupsDescription: {
          ContinuousBackupsStatus: "ENABLED",
          PointInTimeRecoveryDescription: {
            PointInTimeRecoveryStatus: "ENABLED",
          },
        },
      };
    if (operation === "dynamodb create-backup")
      return { BackupDetails: { BackupArn: arn } };
    if (operation === "dynamodb describe-backup")
      return {
        BackupDescription: {
          BackupDetails: { BackupStatus: states.shift() },
        },
      };
    throw new Error(`unexpected ${operation}`);
  };
  assert.doesNotThrow(() => requirePitr(target, {}, aws));
  const backup = await createBackup(
    target,
    {},
    {
      aws,
      now: () => new Date("2026-08-05T14:00:00.000Z"),
      attempts: 2,
      delay: async () => {},
    },
  );
  assert.equal(backup.arn, arn);
  assert.deepEqual(calls, [
    "dynamodb describe-continuous-backups",
    "dynamodb create-backup",
    "dynamodb describe-backup",
    "dynamodb describe-backup",
  ]);
});
