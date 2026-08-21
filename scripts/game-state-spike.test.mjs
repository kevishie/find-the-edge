import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  GAME_STATE_MAX_EVIDENCE_BYTES,
  GAME_STATE_ROUTES,
  buildSchemaHash,
  buildStateHash,
  diffLifecycle,
  fetchGameStateRoute,
  normalizeGameStatePayload,
  normalizeIdentityManifest,
  mapGameStateIdentity,
  loadTruthProtocol,
  parseCliArgs,
  parseSharpApiSecret,
  reconcileRouteObservations,
  runGameStateSpike,
  safeSpikeError,
  validateRequestBudget,
  summarizeCoverage,
} from "./game-state-spike.mjs";

const NOW = new Date("2026-08-14T18:00:00.000Z");

test("full-slate evidence and offline analysis share a bounded usable size", () => {
  assert.equal(GAME_STATE_MAX_EVIDENCE_BYTES, 500_000_000);
  assert.ok(GAME_STATE_MAX_EVIDENCE_BYTES > 128_000_000);
});

const state = (overrides = {}) => ({
  away_score: 2,
  home_score: 1,
  game_clock: "07:14",
  in_play: true,
  is_live: true,
  book_count: 12,
  consensus_at: "2026-08-14T17:59:50.000Z",
  primary_book: "book-one",
  status: "in_progress",
  ...overrides,
});

const sampleTruthProtocol = (manifestInputHash = "f".repeat(64)) => {
  const header = {
    schemaVersion: "game-state-spike-truth-v1",
    kind: "header",
    frozenAt: "2026-08-14T12:00:00.000Z",
    manifestInputHash,
    source: {
      kind: "official-scoreboard",
      referenceHash: "d".repeat(64),
    },
    comparisonToleranceSeconds: 60,
  };
  return {
    manifestInputHash,
    truthProtocol: {
      headerHash: createHash("sha256")
        .update(`${JSON.stringify(header)}\n`, "utf8")
        .digest("hex"),
      header,
    },
  };
};

test("truth protocol input requires the exact canonical header line bytes", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "fte-truth-header-"));
  const inputHash = "f".repeat(64);
  const { truthProtocol } = sampleTruthProtocol(inputHash);
  const validPath = path.join(directory, "valid.jsonl");
  const invalidPath = path.join(directory, "invalid.jsonl");
  const line = JSON.stringify(truthProtocol.header);
  await writeFile(validPath, `${line}\n`);
  await writeFile(invalidPath, `${line}\r\n`);
  assert.equal(
    (await loadTruthProtocol(validPath, inputHash)).headerHash,
    truthProtocol.headerHash,
  );
  await assert.rejects(
    loadTruthProtocol(invalidPath, inputHash),
    /configuration/,
  );
});

test("sample rejects a truth protocol that predates its frozen manifest", async () => {
  let accessed = false;
  await assert.rejects(
    runGameStateSpike(
      {
        stage: "staging",
        mode: "sample",
        output: path.join(tmpdir(), "backdated-protocol.json"),
        region: "us-east-1",
        intervalSeconds: 300,
        durationMinutes: 1,
        postFinalMinutes: 0,
        rateReserve: 4,
        maxRequests: 4,
        plannedRequests: 4,
        ticks: 1,
      },
      {
        assertAwsIdentity: async () => {
          accessed = true;
        },
        ...sampleTruthProtocol(),
        identityManifest: normalizeIdentityManifest({
          schemaVersion: "game-state-spike-manifest-v1",
          frozenAt: "2026-08-14T12:00:00.001Z",
          identitySource: {
            kind: "official-scoreboard",
            referenceHash: "d".repeat(64),
          },
          events: [
            {
              canonicalEventId: "event:one",
              sport: "baseball",
              providerEventId: "provider-event-1",
              scheduledStart: "2026-08-14T17:00:00.000Z",
            },
          ],
        }),
      },
    ),
    /configuration/,
  );
  assert.equal(accessed, false);
});

const aggregateFixture = () => ({
  baseball: {
    "provider-event-1": state(),
  },
  football: {
    "provider-event-2": state({
      away_score: 7,
      home_score: 10,
      game_clock: "Q2 03:10",
    }),
  },
  soccer: {
    "provider-event-3": state({ game_clock: "63:10" }),
  },
  esports: {
    "pollution-event": state(),
  },
});

const scopedFixture = (sport) => {
  const payload = aggregateFixture();
  return payload[sport];
};

const response = (body, init = {}) =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status: init.status ?? 200,
    headers: {
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });

test("route contract is closed to aggregate plus every served sport", () => {
  assert.deepEqual(
    GAME_STATE_ROUTES.map(({ id, path: routePath, sport }) => ({
      id,
      path: routePath,
      sport,
    })),
    [
      { id: "aggregate", path: "/gamestate", sport: null },
      { id: "baseball", path: "/gamestate/baseball", sport: "baseball" },
      { id: "football", path: "/gamestate/football", sport: "football" },
      { id: "soccer", path: "/gamestate/soccer", sport: "soccer" },
    ],
  );
  assert.equal(Object.isFrozen(GAME_STATE_ROUTES), true);
  assert.equal(
    GAME_STATE_ROUTES.every(({ sourceSportKeys }) =>
      Object.isFrozen(sourceSportKeys),
    ),
    true,
  );
});

test("game-state routes cover the existing SharpAPI served league registry", async () => {
  const providerSource = await readFile(
    path.resolve("packages/providers/src/sharp-api.ts"),
    "utf8",
  );
  const registryBlock = providerSource.match(
    /export const sharpApiLeagues:[\s\S]+?^\];/m,
  )?.[0];
  assert.ok(registryBlock);
  const leagueKeys = [...registryBlock.matchAll(/leagueKey: "([a-z-]+)"/g)]
    .map((match) => match[1])
    .sort();
  const routedKeys = GAME_STATE_ROUTES.flatMap(
    ({ sourceSportKeys }) => sourceSportKeys,
  ).sort();
  assert.deepEqual(routedKeys, leagueKeys);
});

test("CLI accepts one pnpm delimiter and validates a complete preflight before access", () => {
  const parsed = parseCliArgs([
    "--",
    "--stage",
    "staging",
    "--mode",
    "preflight",
    "--output",
    "/tmp/derived.json",
    "--max-requests",
    "4",
    "--region",
    "us-east-1",
  ]);
  assert.equal(parsed.stage, "staging");
  assert.equal(parsed.mode, "preflight");
  assert.equal(parsed.region, "us-east-1");
  assert.equal(parsed.plannedRequests, 4);
  assert.equal(parsed.intervalSeconds, 300);
  assert.equal(parsed.durationMinutes, 0);
});

test("CLI rejects unknown, duplicate, missing, unsafe, and arbitrary values", () => {
  const base = [
    "--stage",
    "prod",
    "--mode",
    "preflight",
    "--output",
    "/tmp/derived.json",
    "--max-requests",
    "4",
  ];
  assert.throws(() => parseCliArgs(["--", "--", ...base]), /invalid-argument/);
  assert.throws(
    () => parseCliArgs([...base, "--stage", "staging"]),
    /invalid-argument:--stage/,
  );
  assert.throws(
    () => parseCliArgs([...base, "--sport", "hockey"]),
    /invalid-argument/,
  );
  assert.throws(
    () => parseCliArgs([...base, "--api-key", "secret"]),
    /invalid-argument/,
  );
  assert.throws(
    () => parseCliArgs(base.slice(0, -1)),
    /invalid-argument:--max-requests/,
  );
  assert.throws(() => parseCliArgs(base.with(1, "dev")), /invalid-stage/);
  assert.throws(
    () => parseCliArgs(base.with(base.indexOf("/tmp/derived.json"), "-")),
    /invalid-output/,
  );
  assert.throws(
    () => parseCliArgs([...base, "--region", "us-west-2"]),
    /invalid-region/,
  );
  assert.throws(
    () =>
      parseCliArgs([
        ...base.with(3, "sample").with(base.length - 1, "8"),
        "--duration-minutes",
        "5",
        "--post-final-minutes",
        "0",
      ]),
    /missing-argument:--manifest/,
  );
  assert.throws(
    () =>
      parseCliArgs([
        ...base.with(3, "sample").with(base.length - 1, "8"),
        "--duration-minutes",
        "5",
        "--post-final-minutes",
        "0",
        "--manifest",
        "/tmp/manifest.json",
      ]),
    /missing-argument:--truth-sidecar/,
  );
  assert.throws(
    () => parseCliArgs([...base, "--fixture", "/tmp/fixture.json"]),
    /invalid-fixture-mode/,
  );
  assert.throws(
    () =>
      parseCliArgs([...base.with(1, "staging"), "--post-final-minutes", "1"]),
    /invalid-post-final-minutes/,
  );
});

test("sample budgets are derived before dispatch and bounded", () => {
  assert.deepEqual(
    validateRequestBudget({
      mode: "sample",
      intervalSeconds: 300,
      durationMinutes: 10,
      maxRequests: 12,
    }),
    { ticks: 3, plannedRequests: 12 },
  );
  assert.throws(
    () =>
      validateRequestBudget({
        mode: "sample",
        intervalSeconds: 300,
        durationMinutes: 10,
        maxRequests: 11,
      }),
    /request-budget-too-small/,
  );
  assert.throws(
    () =>
      validateRequestBudget({
        mode: "sample",
        intervalSeconds: 1,
        durationMinutes: 1_000,
        maxRequests: 5_000,
      }),
    /invalid-interval|request-budget-exceeds-limit/,
  );
  assert.deepEqual(
    validateRequestBudget({
      mode: "preflight",
      intervalSeconds: 300,
      durationMinutes: 0,
      maxRequests: 4,
    }),
    { ticks: 1, plannedRequests: 4 },
  );
  assert.deepEqual(
    validateRequestBudget({
      mode: "sample",
      intervalSeconds: 300,
      durationMinutes: 1_440,
      postFinalMinutes: 360,
      maxRequests: 1_444,
    }),
    { ticks: 361, plannedRequests: 1_444 },
  );
});

test("secret parser accepts only a bounded plain key or exact apiKey object", () => {
  assert.equal(parseSharpApiSecret("plain-key"), "plain-key");
  assert.equal(parseSharpApiSecret('{"apiKey":"json-key"}'), "json-key");
  for (const value of [
    undefined,
    "",
    " padded ",
    "{}",
    '{"apiKey":" key"}',
    '{"apiKey":"key","extra":true}',
    JSON.stringify({ apiKey: "x".repeat(513) }),
  ])
    assert.throws(() => parseSharpApiSecret(value), /provider-api-secret/);
});

test("safe errors expose only fixed bounded reason codes", () => {
  assert.deepEqual(safeSpikeError(new Error("api-key=secret https://bad")), {
    code: "unknown",
  });
  assert.deepEqual(safeSpikeError({ code: "not-entitled", detail: "secret" }), {
    code: "not-entitled",
  });
  assert.deepEqual(
    safeSpikeError({ code: "x".repeat(200), stage: "raw-body" }),
    { code: "unknown" },
  );
});

test("provider request uses exact auth/header/timeout boundary and returns bounded metadata", async () => {
  let captured;
  const instants = [new Date("2026-08-14T17:59:59.900Z"), NOW];
  const result = await fetchGameStateRoute({
    route: GAME_STATE_ROUTES[0],
    apiKey: "secret-key",
    now: () => instants.shift(),
    fetcher: async (url, init) => {
      captured = { url, init };
      return response(aggregateFixture(), {
        headers: {
          "x-ratelimit-limit": "60",
          "x-ratelimit-remaining": "55",
          "x-ratelimit-reset": "1786730460",
        },
      });
    },
  });
  assert.equal(captured.url, "https://api.sharpapi.io/api/v1/gamestate");
  assert.deepEqual(captured.init.headers, {
    accept: "application/json",
    "X-API-Key": "secret-key",
  });
  assert.equal(captured.init.method, "GET");
  assert.ok(captured.init.signal instanceof AbortSignal);
  assert.equal(result.retrievedAt, NOW.toISOString());
  assert.equal(result.requestStartedAt, "2026-08-14T17:59:59.900Z");
  assert.equal(result.latencyMs, 100);
  assert.equal(result.metadata.rateWindow.limit, 60);
  assert.equal(result.metadata.rateWindow.remaining, 55);
  assert.ok(result.byteLength > 0);
  assert.deepEqual(result.payload, aggregateFixture());
});

test("provider request unwraps the live data envelope and normalizes numeric timestamps", async () => {
  const result = await fetchGameStateRoute({
    route: GAME_STATE_ROUTES[0],
    apiKey: "secret-key",
    now: () => NOW,
    fetcher: async () =>
      response({
        data: {
          baseball: {
            live: state({
              consensus_at: Date.parse("2026-08-14T17:59:50.000Z") / 1_000,
            }),
          },
        },
        updated_at: NOW.toISOString(),
      }),
  });
  assert.deepEqual(Object.keys(result.payload), ["baseball"]);
  assert.equal(result.providerEnvelopeUpdatedAt, NOW.toISOString());
  const normalized = normalizeGameStatePayload({
    route: GAME_STATE_ROUTES[0],
    payload: result.payload,
    retrievedAt: NOW.toISOString(),
    byteLength: result.byteLength,
    hashKey: "test-only-key",
  });
  assert.equal(
    normalized.observations[0].consensusAt,
    "2026-08-14T17:59:50.000Z",
  );
});

test("malformed rate metadata is ignored instead of crashing normalization", async () => {
  const result = await fetchGameStateRoute({
    route: GAME_STATE_ROUTES[0],
    apiKey: "secret-key",
    now: () => NOW,
    fetcher: async () =>
      response(aggregateFixture(), {
        headers: {
          "x-ratelimit-limit": "999999999999999999999999",
          "x-ratelimit-reset": "999999999999999999999999",
        },
      }),
  });
  assert.deepEqual(result.metadata.rateWindow, {});
});

test("rate reset metadata accepts relative seconds, epoch milliseconds, and HTTP dates", async () => {
  for (const [rawReset, expected] of [
    ["60", "2026-08-14T18:01:00.000Z"],
    [String(NOW.getTime() + 120_000), "2026-08-14T18:02:00.000Z"],
    ["Fri, 14 Aug 2026 18:03:00 GMT", "2026-08-14T18:03:00.000Z"],
  ]) {
    const result = await fetchGameStateRoute({
      route: GAME_STATE_ROUTES[0],
      apiKey: "secret-key",
      now: () => NOW,
      fetcher: async () =>
        response(aggregateFixture(), {
          headers: { "x-ratelimit-reset": rawReset },
        }),
    });
    assert.equal(result.metadata.rateWindow.resetsAt, expected);
  }
});

test("provider failures are bounded, terminal, and never retried", async () => {
  for (const [status, code] of [
    [401, "unauthorized"],
    [403, "not-entitled"],
    [429, "rate-limited"],
    [500, "provider-unavailable"],
    [404, "provider-rejected"],
  ]) {
    let calls = 0;
    await assert.rejects(
      fetchGameStateRoute({
        route: GAME_STATE_ROUTES[0],
        apiKey: "secret-key",
        fetcher: async () => {
          calls += 1;
          return response("<html>secret response</html>", { status });
        },
      }),
      (error) => safeSpikeError(error).code === code,
    );
    assert.equal(calls, 1);
  }
  await assert.rejects(
    fetchGameStateRoute({
      route: GAME_STATE_ROUTES[0],
      apiKey: "secret-key",
      fetcher: async () => {
        throw new Error("socket exposed secret");
      },
    }),
    (error) => safeSpikeError(error).code === "provider-request-ambiguous",
  );
});

test("rate-limited failures retain only bounded authoritative header metadata", async () => {
  await assert.rejects(
    fetchGameStateRoute({
      route: GAME_STATE_ROUTES[0],
      apiKey: "secret-key",
      now: () => NOW,
      fetcher: async () =>
        response("limited", {
          status: 429,
          headers: {
            "x-ratelimit-limit": "60",
            "x-ratelimit-remaining": "0",
            "x-ratelimit-reset": "60",
            "retry-after": "30",
          },
        }),
    }),
    (error) => {
      assert.deepEqual(safeSpikeError(error), {
        code: "rate-limited",
        rateMetadata: {
          rateWindow: {
            limit: 60,
            remaining: 0,
            resetsAt: "2026-08-14T18:01:00.000Z",
          },
          retryAt: "2026-08-14T18:00:30.000Z",
        },
      });
      return true;
    },
  );
});

test("provider response rejects malformed and oversized material without returning a body", async () => {
  await assert.rejects(
    fetchGameStateRoute({
      route: GAME_STATE_ROUTES[0],
      apiKey: "secret-key",
      fetcher: async () => response("not-json"),
    }),
    (error) => safeSpikeError(error).code === "invalid-response",
  );
  await assert.rejects(
    fetchGameStateRoute({
      route: GAME_STATE_ROUTES[0],
      apiKey: "secret-key",
      maxResponseBytes: 20,
      fetcher: async () => response(aggregateFixture()),
    }),
    (error) => safeSpikeError(error).code === "invalid-response",
  );
});

test("normalization emits derived bounded observations and classifies catalogue pollution", () => {
  const normalized = normalizeGameStatePayload({
    route: GAME_STATE_ROUTES[0],
    payload: aggregateFixture(),
    retrievedAt: NOW.toISOString(),
    byteLength: 2_000,
    hashKey: "test-only-key",
  });
  assert.equal(normalized.routeId, "aggregate");
  assert.equal(normalized.rowCount, 4);
  assert.equal(normalized.observations.length, 4);
  assert.deepEqual(normalized.countsBySport, {
    baseball: 1,
    football: 1,
    soccer: 1,
    "off-roster": 1,
  });
  const baseball = normalized.observations.find(
    (item) => item.sport === "baseball",
  );
  assert.match(baseball.eventHash, /^[a-f0-9]{64}$/);
  assert.equal(baseball.providerEventId, undefined);
  assert.equal(baseball.primaryBook, undefined);
  assert.equal(baseball.bookCount, 12);
  assert.equal(baseball.phase, "live");
  assert.equal(baseball.lagMs, 10_000);
  assert.ok(normalized.schemaHash.match(/^[a-f0-9]{64}$/));
  assert.equal(normalized.fieldPresence.away_score, 4);
  assert.deepEqual(normalized.fieldTypes.away_score, ["integer"]);
  assert.equal(normalized.unknownFieldCount, 0);
  assert.equal(JSON.stringify(normalized).includes("provider-event-1"), false);
  assert.equal(JSON.stringify(normalized).includes("book-one"), false);
});

test("sport routes accept direct event maps and reject wrong/invalid roots", () => {
  const normalized = normalizeGameStatePayload({
    route: GAME_STATE_ROUTES[1],
    payload: scopedFixture("baseball"),
    retrievedAt: NOW.toISOString(),
    byteLength: 1_000,
    hashKey: "test-only-key",
  });
  assert.equal(normalized.rowCount, 1);
  assert.equal(normalized.observations[0].sport, "baseball");
  assert.throws(
    () =>
      normalizeGameStatePayload({
        route: GAME_STATE_ROUTES[1],
        payload: [],
        retrievedAt: NOW.toISOString(),
        byteLength: 2,
        hashKey: "test-only-key",
      }),
    /invalid-response/,
  );
  assert.throws(
    () =>
      normalizeGameStatePayload({
        route: GAME_STATE_ROUTES[0],
        payload: { data: { baseball: { "provider-event-1": state() } } },
        retrievedAt: NOW.toISOString(),
        byteLength: 2,
        hashKey: "test-only-key",
      }),
    /invalid-response/,
  );
});

test("different off-roster catalogues cannot collide on the same provider event id", () => {
  const normalized = normalizeGameStatePayload({
    route: GAME_STATE_ROUTES[0],
    payload: {
      esports: { duplicate: state() },
      college_baseball: { duplicate: state() },
    },
    retrievedAt: NOW.toISOString(),
    byteLength: 1_000,
    hashKey: "test-only-key",
  });
  assert.equal(normalized.observations.length, 2);
  assert.notEqual(
    normalized.observations[0].eventHash,
    normalized.observations[1].eventHash,
  );
});

test("schema and state hashes are canonical, stable, and change only with relevant state", () => {
  const left = state();
  const reordered = Object.fromEntries(Object.entries(left).reverse());
  assert.equal(buildSchemaHash(left), buildSchemaHash(reordered));
  assert.equal(buildStateHash(left), buildStateHash(reordered));
  assert.notEqual(
    buildStateHash(left),
    buildStateHash({ ...left, home_score: 2 }),
  );
  assert.equal(
    buildSchemaHash(left),
    buildSchemaHash({ ...left, home_score: 2 }),
  );
});

test("semantic revisions ignore provider metadata churn and retain phase conflicts", () => {
  const first = normalizeGameStatePayload({
    route: GAME_STATE_ROUTES[1],
    payload: {
      game: state({
        status: "halftime",
        in_play: true,
        is_live: true,
        period: "HALFTIME",
        possession: "away-team-label",
      }),
    },
    retrievedAt: NOW.toISOString(),
    byteLength: 1_000,
    hashKey: "test-only-key",
  });
  const second = normalizeGameStatePayload({
    route: GAME_STATE_ROUTES[1],
    payload: {
      game: state({
        status: "halftime",
        in_play: true,
        is_live: true,
        period: "HALFTIME",
        possession: "away-team-label",
        book_count: 20,
        consensus_at: "2026-08-14T18:00:00.000Z",
      }),
    },
    retrievedAt: NOW.toISOString(),
    byteLength: 1_000,
    hashKey: "test-only-key",
  });
  const left = first.observations[0];
  const right = second.observations[0];
  assert.equal(left.phase, "break");
  assert.deepEqual(left.signalConflicts, ["status-live-conflict"]);
  assert.equal(left.period, "HALFTIME");
  assert.equal(left.possession.kind, "opaque-value");
  assert.equal(JSON.stringify(left).includes("away-team-label"), false);
  assert.equal(left.stateHash, right.stateHash);
  assert.notEqual(left.observationHash, right.observationHash);
  assert.deepEqual(diffLifecycle(left, right).kinds, []);

  const terminalOnly = normalizeGameStatePayload({
    route: GAME_STATE_ROUTES[1],
    payload: {
      game: {
        game_clock: "FINAL",
        in_play: false,
        is_live: false,
      },
    },
    retrievedAt: NOW.toISOString(),
    byteLength: 100,
    hashKey: "test-only-key",
  }).observations[0];
  assert.equal(terminalOnly.terminalSignal, "FINAL");
  assert.equal(terminalOnly.phase, "unknown");
});

test("constituent in-play maps expose disagreement counts without book labels", () => {
  const normalized = normalizeGameStatePayload({
    route: GAME_STATE_ROUTES[1],
    payload: {
      game: state({
        in_play: {
          "private-book-one": true,
          "private-book-two": false,
          "private-book-three": null,
        },
      }),
    },
    retrievedAt: NOW.toISOString(),
    byteLength: 1_000,
    hashKey: "test-only-key",
  });
  assert.deepEqual(normalized.disagreementCounts, { observed: 1 });
  assert.deepEqual(normalized.observations[0].inPlayEvidence, {
    kind: "constituent-map",
    constituentCount: 3,
    trueCount: 1,
    falseCount: 1,
    nullCount: 1,
    invalidCount: 0,
    disagreement: "observed",
  });
  assert.equal(JSON.stringify(normalized).includes("private-book"), false);
});

test("schema hashes ignore catalogue order, row count, and object insertion order", () => {
  const one = normalizeGameStatePayload({
    route: GAME_STATE_ROUTES[1],
    payload: { one: state() },
    retrievedAt: NOW.toISOString(),
    byteLength: 1_000,
    hashKey: "test-only-key",
  });
  const reversed = Object.fromEntries(Object.entries(state()).reverse());
  const many = normalizeGameStatePayload({
    route: GAME_STATE_ROUTES[1],
    payload: { two: reversed, one: state() },
    retrievedAt: NOW.toISOString(),
    byteLength: 1_000,
    hashKey: "test-only-key",
  });
  assert.equal(one.schemaHash, many.schemaHash);
});

test("aggregate and scoped routes reconcile missing, extra, and mismatched state", () => {
  const aggregate = normalizeGameStatePayload({
    route: GAME_STATE_ROUTES[0],
    payload: aggregateFixture(),
    retrievedAt: NOW.toISOString(),
    byteLength: 2_000,
    hashKey: "test-only-key",
  });
  const scoped = normalizeGameStatePayload({
    route: GAME_STATE_ROUTES[1],
    payload: {
      ...scopedFixture("baseball"),
      "extra-event": state({ home_score: 9 }),
    },
    retrievedAt: NOW.toISOString(),
    byteLength: 1_000,
    hashKey: "test-only-key",
  });
  const changed = structuredClone(scoped);
  changed.observations[0].stateHash = "f".repeat(64);
  const result = reconcileRouteObservations(aggregate, changed);
  assert.equal(result.sport, "baseball");
  assert.equal(result.aggregateCount, 1);
  assert.equal(result.scopedCount, 2);
  assert.equal(result.missingFromScoped, 0);
  assert.equal(result.extraInScoped, 1);
  assert.equal(result.stateMismatches, 1);
});

test("frozen identity manifests bind exact provider ids without minting or guessing", () => {
  const manifest = normalizeIdentityManifest({
    schemaVersion: "game-state-spike-manifest-v1",
    frozenAt: "2026-08-14T12:00:00.000Z",
    identitySource: {
      kind: "official-scoreboard",
      referenceHash: "b".repeat(64),
    },
    events: [
      {
        canonicalEventId: "event:mlb:one",
        sport: "baseball",
        providerEventId: "provider-event-1",
        scheduledStart: "2026-08-14T17:00:00.000Z",
      },
      {
        canonicalEventId: "event:mlb:two",
        sport: "baseball",
        providerEventId: "provider-event-2",
        scheduledStart: "2026-08-14T20:00:00.000Z",
      },
    ],
  });
  assert.equal(manifest.events.length, 2);
  assert.deepEqual(
    mapGameStateIdentity(manifest, "baseball", "provider-event-1"),
    {
      kind: "exact-provider-id",
      canonicalEventId: "event:mlb:one",
    },
  );
  assert.deepEqual(mapGameStateIdentity(manifest, "baseball", "unknown"), {
    kind: "unmapped",
  });
  assert.throws(
    () =>
      normalizeIdentityManifest({
        ...manifest,
        events: [...manifest.events, manifest.events[0]],
      }),
    /invalid-manifest/,
  );
  assert.throws(
    () =>
      normalizeIdentityManifest({
        ...manifest,
        comparisonToleranceSeconds: 60,
      }),
    /invalid-manifest/,
  );
  assert.throws(
    () =>
      normalizeIdentityManifest({
        ...manifest,
        identitySource: {
          ...manifest.identitySource,
          truthCheckpoints: [],
        },
      }),
    /invalid-manifest/,
  );
  assert.throws(
    () =>
      normalizeIdentityManifest({
        ...manifest,
        events: [{ ...manifest.events[0], truthCheckpoints: [] }],
      }),
    /invalid-manifest/,
  );
});

test("identity mapping exposes ambiguity, exact aliases, and contradictory evidence", () => {
  const shared = {
    sport: "baseball",
    providerEventId: "duplicate-provider-id",
    scheduledStart: "2026-08-14T17:00:00.000Z",
  };
  const ambiguous = normalizeIdentityManifest({
    schemaVersion: "game-state-spike-manifest-v1",
    frozenAt: "2026-08-14T12:00:00.000Z",
    identitySource: {
      kind: "official-scoreboard",
      referenceHash: "b".repeat(64),
    },
    events: [
      { ...shared, canonicalEventId: "event:one" },
      { ...shared, canonicalEventId: "event:two" },
    ],
  });
  assert.deepEqual(
    mapGameStateIdentity(ambiguous, "baseball", "duplicate-provider-id"),
    { kind: "ambiguous" },
  );

  const aliases = normalizeIdentityManifest({
    schemaVersion: "game-state-spike-manifest-v1",
    frozenAt: "2026-08-14T12:00:00.000Z",
    identitySource: {
      kind: "official-scoreboard",
      referenceHash: "c".repeat(64),
    },
    events: [
      {
        ...shared,
        canonicalEventId: "event:one",
        providerEventId: "schedule-id",
        providerEventUuid: "stable-uuid",
      },
    ],
  });
  assert.deepEqual(
    mapGameStateIdentity(aliases, "baseball", "game-state-id", {
      providerEventUuid: "stable-uuid",
    }),
    { kind: "exact-provider-uuid", canonicalEventId: "event:one" },
  );
  assert.deepEqual(
    mapGameStateIdentity(aliases, "baseball", "schedule-id", {
      providerEventUuid: "wrong-uuid",
    }),
    {
      kind: "identity-mismatch",
      reasons: ["provider-uuid-mismatch"],
    },
  );
});

test("coverage summaries retain the frozen denominator and explicit mapping outcomes", () => {
  const manifest = normalizeIdentityManifest({
    schemaVersion: "game-state-spike-manifest-v1",
    frozenAt: "2026-08-14T12:00:00.000Z",
    identitySource: {
      kind: "official-scoreboard",
      referenceHash: "b".repeat(64),
    },
    events: [
      {
        canonicalEventId: "event:mlb:one",
        sport: "baseball",
        providerEventId: "provider-event-1",
        scheduledStart: "2026-08-14T17:00:00.000Z",
      },
      {
        canonicalEventId: "event:mlb:two",
        sport: "baseball",
        providerEventId: "provider-event-2",
        scheduledStart: "2026-08-14T20:00:00.000Z",
      },
    ],
  });
  const normalized = normalizeGameStatePayload({
    route: GAME_STATE_ROUTES[0],
    payload: aggregateFixture(),
    retrievedAt: NOW.toISOString(),
    byteLength: 2_000,
    hashKey: "test-only-key",
    identityManifest: manifest,
  });
  assert.deepEqual(normalized.mappingCounts, {
    "exact-provider-id": 1,
    unmapped: 3,
  });
  assert.deepEqual(summarizeCoverage(manifest, normalized, "baseball"), {
    sport: "baseball",
    denominator: 2,
    observedMapped: 1,
    observedUnmapped: 0,
    duplicateMappedRows: 0,
    missingCanonical: 1,
    phases: { live: 1 },
  });
});

test("lifecycle diff records first final, revision, regression, and disappearance categorically", () => {
  const live = {
    eventHash: "a".repeat(64),
    stateHash: "1".repeat(64),
    phase: "live",
    consensusAt: "2026-08-14T17:59:50.000Z",
  };
  const final = {
    ...live,
    stateHash: "2".repeat(64),
    phase: "final",
    consensusAt: "2026-08-14T18:10:00.000Z",
  };
  const revised = {
    ...final,
    stateHash: "3".repeat(64),
    consensusAt: "2026-08-14T18:20:00.000Z",
  };
  assert.deepEqual(diffLifecycle(undefined, live).kinds, ["first-seen"]);
  assert.deepEqual(diffLifecycle(live, final).kinds, [
    "changed",
    "first-final",
  ]);
  assert.deepEqual(diffLifecycle(final, revised).kinds, [
    "changed",
    "final-revised",
  ]);
  assert.deepEqual(diffLifecycle(revised, live).kinds, [
    "changed",
    "phase-regressed",
    "provider-time-regressed",
  ]);
  assert.deepEqual(diffLifecycle(revised, undefined).kinds, ["disappeared"]);
  const periodBreak = { ...live, phase: "break", stateHash: "4".repeat(64) };
  assert.deepEqual(diffLifecycle(live, periodBreak).kinds, [
    "changed",
    "period-break",
  ]);
  assert.deepEqual(diffLifecycle(periodBreak, live).kinds, [
    "changed",
    "resumed",
  ]);
  const terminal = {
    ...live,
    phase: "unknown",
    terminalSignal: "FINAL",
    stateHash: "5".repeat(64),
  };
  assert.equal(
    diffLifecycle(live, terminal).kinds.includes("terminal-clock-first-seen"),
    true,
  );
});

test("complete preflight resolves the secret once, fetches every route once, and writes derived evidence once", async () => {
  const calls = [];
  const writes = [];
  let secretReads = 0;
  const result = await runGameStateSpike(
    {
      stage: "staging",
      mode: "preflight",
      output: path.join(tmpdir(), "derived.json"),
      region: "us-east-1",
      intervalSeconds: 300,
      durationMinutes: 0,
      postFinalMinutes: 0,
      rateReserve: 4,
      maxRequests: 4,
      plannedRequests: 4,
      ticks: 1,
    },
    {
      now: () => NOW,
      hashKey: "test-only-key",
      assertAwsIdentity: async () => {},
      secretResolver: async (secretId) => {
        secretReads += 1;
        assert.equal(secretId, "find-the-edge/staging/sharpapi");
        return '{"apiKey":"secret-key"}';
      },
      fetcher: async (url) => {
        calls.push(url);
        const route = GAME_STATE_ROUTES.find((entry) =>
          url.endsWith(entry.path),
        );
        return response(
          route.id === "aggregate"
            ? aggregateFixture()
            : scopedFixture(route.sport),
        );
      },
      writer: async (output, evidence) => writes.push({ output, evidence }),
      sleep: async () => assert.fail("preflight must not sleep"),
      sourceKind: "test",
    },
  );
  assert.equal(secretReads, 1);
  assert.equal(calls.length, 4);
  assert.equal(writes.length, 1);
  assert.equal(result.attemptCount, 4);
  assert.equal(result.samples.length, 4);
  assert.equal(result.reconciliation.length, 3);
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes("secret-key"), false);
  assert.equal(serialized.includes("provider-event-1"), false);
  assert.equal(serialized.includes("book-one"), false);
});

test("required route failure writes no final artifact and consumes one attempt only", async () => {
  let writes = 0;
  let calls = 0;
  await assert.rejects(
    runGameStateSpike(
      {
        stage: "prod",
        mode: "preflight",
        output: path.join(tmpdir(), "derived.json"),
        region: "us-east-1",
        intervalSeconds: 300,
        durationMinutes: 0,
        postFinalMinutes: 0,
        rateReserve: 4,
        maxRequests: 4,
        plannedRequests: 4,
        ticks: 1,
      },
      {
        now: () => NOW,
        hashKey: "test-only-key",
        assertAwsIdentity: async () => {},
        secretResolver: async () => "secret-key",
        fetcher: async () => {
          calls += 1;
          return response("denied", { status: 403 });
        },
        writer: async () => {
          writes += 1;
        },
        sourceKind: "test",
      },
    ),
    (error) => safeSpikeError(error).code === "not-entitled",
  );
  assert.equal(calls, 1);
  assert.equal(writes, 0);
});

test("live collection refuses missing rate evidence and preserves its reserve", async () => {
  const options = {
    stage: "staging",
    mode: "preflight",
    output: path.join(tmpdir(), "derived-rate.json"),
    region: "us-east-1",
    intervalSeconds: 300,
    durationMinutes: 0,
    postFinalMinutes: 0,
    rateReserve: 4,
    maxRequests: 4,
    plannedRequests: 4,
    ticks: 1,
  };
  let writes = 0;
  await assert.rejects(
    runGameStateSpike(options, {
      now: () => NOW,
      hashKey: "test-only-key",
      assertAwsIdentity: async () => {},
      secretResolver: async () => "secret-key",
      fetcher: async () => response(aggregateFixture()),
      writer: async () => {
        writes += 1;
      },
    }),
    (error) => safeSpikeError(error).code === "invalid-response",
  );
  assert.equal(writes, 0);

  let calls = 0;
  await assert.rejects(
    runGameStateSpike(options, {
      now: () => NOW,
      hashKey: "test-only-key",
      assertAwsIdentity: async () => {},
      secretResolver: async () => "secret-key",
      fetcher: async () => {
        calls += 1;
        return response(aggregateFixture(), {
          headers: {
            "x-ratelimit-limit": "60",
            "x-ratelimit-remaining": "4",
            "x-ratelimit-reset": "60",
          },
        });
      },
      writer: async () => {
        writes += 1;
      },
    }),
    (error) => safeSpikeError(error).code === "rate-limited",
  );
  assert.equal(calls, 1);
  assert.equal(writes, 0);
});

test("multi-tick sampling preserves categorical lifecycle changes and fixed cadence", async () => {
  let calls = 0;
  const sleeps = [];
  const result = await runGameStateSpike(
    {
      stage: "staging",
      mode: "sample",
      output: path.join(tmpdir(), "derived-sample.json"),
      region: "us-east-1",
      intervalSeconds: 300,
      durationMinutes: 5,
      postFinalMinutes: 0,
      rateReserve: 4,
      maxRequests: 8,
      plannedRequests: 8,
      ticks: 2,
    },
    {
      now: () => NOW,
      hashKey: "test-only-key",
      assertAwsIdentity: async () => {},
      secretResolver: async () => "secret-key",
      sleep: async (milliseconds) => sleeps.push(milliseconds),
      monotonicNow: () => 0,
      writer: async () => {},
      sourceKind: "test",
      ...sampleTruthProtocol(),
      identityManifest: normalizeIdentityManifest({
        schemaVersion: "game-state-spike-manifest-v1",
        frozenAt: "2026-08-14T12:00:00.000Z",
        identitySource: {
          kind: "official-scoreboard",
          referenceHash: "b".repeat(64),
        },
        events: [
          {
            canonicalEventId: "event:mlb:one",
            sport: "baseball",
            providerEventId: "provider-event-1",
            scheduledStart: "2026-08-14T17:00:00.000Z",
          },
        ],
      }),
      fetcher: async (url) => {
        const tick = Math.floor(calls / 4);
        calls += 1;
        const route = GAME_STATE_ROUTES.find((entry) =>
          url.endsWith(entry.path),
        );
        const finalState = state({
          status: "final",
          in_play: false,
          is_live: false,
          game_clock: "FINAL",
          consensus_at: "2026-08-14T18:00:00.000Z",
        });
        const aggregate = aggregateFixture();
        if (tick === 1) aggregate.baseball["provider-event-1"] = finalState;
        return response(
          route.id === "aggregate"
            ? aggregate
            : tick === 1 && route.sport === "baseball"
              ? { "provider-event-1": finalState }
              : scopedFixture(route.sport),
        );
      },
    },
  );
  assert.deepEqual(sleeps, [300_000]);
  assert.equal(result.attemptCount, 8);
  assert.equal(result.manifest.inputHash, "f".repeat(64));
  assert.equal(
    result.truthProtocol.headerHash,
    sampleTruthProtocol().truthProtocol.headerHash,
  );
  assert.equal(
    result.transitions.some(({ kinds }) => kinds.includes("first-final")),
    true,
  );
});

test("fixed cadence targets absolute deadlines instead of adding sweep latency", async () => {
  let monotonic = 0;
  let calls = 0;
  const sleeps = [];
  const manifest = normalizeIdentityManifest({
    schemaVersion: "game-state-spike-manifest-v1",
    frozenAt: "2026-08-14T12:00:00.000Z",
    identitySource: {
      kind: "official-scoreboard",
      referenceHash: "d".repeat(64),
    },
    events: [
      {
        canonicalEventId: "event:one",
        sport: "baseball",
        providerEventId: "provider-event-1",
        scheduledStart: "2026-08-14T17:00:00.000Z",
      },
    ],
  });
  const result = await runGameStateSpike(
    {
      stage: "staging",
      mode: "sample",
      output: path.join(tmpdir(), "absolute-cadence.json"),
      region: "us-east-1",
      intervalSeconds: 300,
      durationMinutes: 5,
      postFinalMinutes: 0,
      rateReserve: 4,
      maxRequests: 8,
      plannedRequests: 8,
      ticks: 2,
    },
    {
      now: () => NOW,
      monotonicNow: () => monotonic,
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
        monotonic += milliseconds;
      },
      hashKey: "test-only-key",
      assertAwsIdentity: async () => {},
      secretResolver: async () => "secret-key",
      identityManifest: manifest,
      ...sampleTruthProtocol(),
      sourceKind: "test",
      writer: async () => {},
      fetcher: async (url) => {
        calls += 1;
        monotonic += 1_000;
        const route = GAME_STATE_ROUTES.find((entry) =>
          url.endsWith(entry.path),
        );
        return response(
          route.id === "aggregate"
            ? aggregateFixture()
            : scopedFixture(route.sport),
        );
      },
    },
  );
  assert.equal(calls, 8);
  assert.deepEqual(sleeps, [296_000]);
  assert.equal(result.samples[4].scheduledOffsetMs, 300_000);
  assert.equal(result.samples[4].dispatchDriftMs, 0);
});

test("production script has no database, billing, write-service, or API-key argument surface", async () => {
  const source = await readFile(
    path.resolve("scripts/game-state-spike.mjs"),
    "utf8",
  );
  assert.doesNotMatch(source, /DynamoDB|PutItem|UpdateItem|Transact|stripe/i);
  assert.doesNotMatch(source, /@aws-sdk\/client-(?:sts|secrets-manager)/);
  assert.doesNotMatch(
    source,
    /--api-key|process\.env\[["']?[^\]]*(?:KEY|SECRET)/i,
  );
  assert.match(source, /find-the-edge\/\$\{stage\}\/sharpapi/);
});

test("package command accepts the pnpm delimiter and publishes only complete fixture evidence", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "fte-game-state-spike-"));
  const fixturePath = path.join(directory, "fixture.json");
  const outputPath = path.join(directory, "derived.json");
  await writeFile(
    fixturePath,
    JSON.stringify({
      responses: {
        aggregate: aggregateFixture(),
        baseball: scopedFixture("baseball"),
        football: scopedFixture("football"),
        soccer: scopedFixture("soccer"),
      },
    }),
  );
  const result = spawnSync(
    "pnpm",
    [
      "game-state:spike",
      "--",
      "--stage",
      "staging",
      "--mode",
      "preflight",
      "--output",
      outputPath,
      "--max-requests",
      "4",
      "--fixture",
      fixturePath,
    ],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  const evidence = JSON.parse(await readFile(outputPath, "utf8"));
  assert.equal(evidence.attemptCount, 4);
  assert.equal(evidence.source, "synthetic-fixture");
  assert.equal(evidence.stage, "staging");
  assert.equal(evidence.mode, "preflight");
  assert.equal(JSON.stringify(evidence).includes("provider-event-1"), false);
  assert.equal(JSON.stringify(evidence).includes("book-one"), false);
  const second = spawnSync(
    "pnpm",
    [
      "game-state:spike",
      "--",
      "--stage",
      "staging",
      "--mode",
      "preflight",
      "--output",
      outputPath,
      "--max-requests",
      "4",
      "--fixture",
      fixturePath,
    ],
    { encoding: "utf8" },
  );
  assert.notEqual(second.status, 0);
  assert.deepEqual(JSON.parse(await readFile(outputPath, "utf8")), evidence);
  assert.equal(
    (await readdir(directory)).some((name) =>
      /derived\.json\.(?:lock|partial-)/.test(name),
    ),
    false,
  );
});

test("invalid local input publishes only a bounded failure sidecar and releases its reservation", async () => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "fte-game-state-invalid-"),
  );
  const fixturePath = path.join(directory, "invalid.json");
  const outputPath = path.join(directory, "derived.json");
  await writeFile(fixturePath, "not-json");
  const result = spawnSync(
    "pnpm",
    [
      "game-state:spike",
      "--",
      "--stage",
      "staging",
      "--mode",
      "preflight",
      "--output",
      outputPath,
      "--max-requests",
      "4",
      "--fixture",
      fixturePath,
    ],
    { encoding: "utf8" },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /invalid-response attempts=unknown/);
  const names = await readdir(directory);
  assert.equal(names.includes("derived.json"), false);
  assert.equal(
    names.some((name) => /derived\.json\.(?:lock|partial-)/.test(name)),
    false,
  );
  const failure = JSON.parse(
    await readFile(`${outputPath}.failure.json`, "utf8"),
  );
  assert.equal(failure.schemaVersion, "game-state-spike-failure-v1");
  assert.equal(failure.code, "invalid-response");
  assert.equal(failure.source, "synthetic-fixture");
  assert.equal(
    names.some((name) => name.includes(".failure.partial-")),
    false,
  );
});

test("an existing output lock is never removed by a competing invocation", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "fte-game-state-lock-"));
  const fixturePath = path.join(directory, "fixture.json");
  const outputPath = path.join(directory, "derived.json");
  const lockPath = `${outputPath}.lock`;
  await writeFile(
    fixturePath,
    JSON.stringify({
      responses: {
        aggregate: aggregateFixture(),
        baseball: scopedFixture("baseball"),
        football: scopedFixture("football"),
        soccer: scopedFixture("soccer"),
      },
    }),
  );
  await writeFile(lockPath, "active-owner");
  const result = spawnSync(
    "pnpm",
    [
      "game-state:spike",
      "--",
      "--stage",
      "staging",
      "--mode",
      "preflight",
      "--output",
      outputPath,
      "--max-requests",
      "4",
      "--fixture",
      fixturePath,
    ],
    { encoding: "utf8" },
  );
  assert.notEqual(result.status, 0);
  assert.equal(await readFile(lockPath, "utf8"), "active-owner");
  assert.equal((await readdir(directory)).includes("derived.json"), false);
});
