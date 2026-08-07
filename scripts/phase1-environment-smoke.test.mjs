import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";
import {
  assertHostedIndexHeaders,
  assertLiveGame,
  assertLiveIngestionSummary,
  assertLiveIngestionResourceBinding,
  assertWrongOriginDenied,
  boundedLiveIngestionDiagnostic,
  boundedLiveIngestionInvocationFailure,
  isSafeLiveIngestionResult,
  isTransientLiveIngestionSummary,
  liveIngestionRecoveryAction,
  liveOddsInvocationArguments,
  phase1EnvironmentSmoke,
  stackResourceListingArguments,
  validateEnvironment,
  validateWrongScopeToken,
} from "./phase1-environment-smoke.mjs";

test("bounds Lambda invocation failures to safe machine codes", () => {
  assert.equal(
    boundedLiveIngestionInvocationFailure({
      errorMessage: "event-reconciliation-cleanup-storage-access-denied",
      stackTrace: ["secret internal path"],
    }),
    "event-reconciliation-cleanup-storage-access-denied",
  );
  assert.equal(
    boundedLiveIngestionInvocationFailure({ errorMessage: "Secret: abc_123" }),
    "failure-redacted",
  );
  assert.equal(boundedLiveIngestionInvocationFailure(null), "failure-redacted");
});

test("live ingestion diagnostics expose only bounded league outcomes", () => {
  assert.equal(
    boundedLiveIngestionDiagnostic([
      { leagueKey: "mlb", status: "skipped", reason: "cadence-not-due" },
      { leagueKey: "secret-league", status: "failed", reason: "raw payload!" },
    ]),
    "mlb:skipped:cadence-not-due,league-invalid:failed:none",
  );
  assert.equal(boundedLiveIngestionDiagnostic({}), "summary-shape-invalid");
  assert.equal(
    isSafeLiveIngestionResult({
      leagueKey: "epl",
      status: "failed",
      reason: "schedule-provider-error-near-canonical-projection-stale",
      pages: 0,
      quotaCost: 0,
    }),
    true,
  );
});

test("environment smoke is a clear non-mutating skip unless explicitly enabled", async () => {
  assert.deepEqual(await phase1EnvironmentSmoke({}), {
    skipped: true,
    reason: "set FTE_PHASE1_SMOKE=1 with the documented environment to opt in",
  });
});

test("explicit smoke fails before AWS mutation when prerequisites are absent", async () => {
  await assert.rejects(
    phase1EnvironmentSmoke({ FTE_PHASE1_SMOKE: "1" }),
    /missing required environment/,
  );
});

const jwt = (payload) =>
  `header.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`;
const validEnvironment = {
  AWS_ACCOUNT_ID: "228246988391",
  AWS_REGION: "us-east-1",
  FTE_PHASE1_API_BASE: "https://api.example.com/dev",
  FTE_LIVE_ODDS_FUNCTION_NAME: "fte-dev-live-odds",
  FTE_WEB_ORIGIN: "https://app.example.com",
  FTE_PHASE1_STACK_ID:
    "arn:aws:cloudformation:us-east-1:228246988391:stack/FindTheEdge-dev-Foundation/12345678-1234-1234-1234-123456789012",
  FTE_WEB_ASSETS_BUCKET_NAME: "fte-assets-example",
  FTE_PHASE1_BROWSER_BASE_URL: "https://app.example.com",
  FTE_PHASE1_ACCESS_TOKEN: "opaque-token",
  FTE_PHASE1_WRONG_SCOPE_TOKEN: jwt({
    iss: "https://issuer.example.com",
    aud: "find-the-edge-dev",
    token_use: "id",
    exp: Math.floor(Date.now() / 1000) + 300,
  }),
  FTE_PHASE1_USERNAME: "operator@example.com",
  FTE_PHASE1_PASSWORD: "not-a-real-password",
  FTE_JWT_ISSUER: "https://issuer.example.com",
  FTE_JWT_AUDIENCE: "find-the-edge-dev",
  FTE_COGNITO_DOMAIN: "https://domain.auth.us-east-1.amazoncognito.com",
  FTE_EVENT_CURSOR_SECRET_ARN:
    "arn:aws:secretsmanager:us-east-1:228246988391:secret:fte-cursor",
};

test("rejects unsafe full-smoke inputs before any AWS command", () => {
  assert.doesNotThrow(() => validateEnvironment(validEnvironment));
  for (const change of [
    { FTE_PHASE1_API_BASE: "https://user:pass@api.example.com/dev" },
    { FTE_PHASE1_API_BASE: "https://api.example.com/dev?token=x" },
    { FTE_PHASE1_BROWSER_BASE_URL: "https://other.example.com" },
    { FTE_COGNITO_DOMAIN: "http://domain.example.com" },
    { FTE_COGNITO_DOMAIN: "https://user:pass@domain.example.com" },
    { FTE_COGNITO_DOMAIN: "https://domain.example.com/path" },
    { FTE_COGNITO_DOMAIN: "https://domain.example.com/" },
    { FTE_COGNITO_DOMAIN: "https://domain.example.com?client=secret" },
    { FTE_COGNITO_DOMAIN: "not-a-url" },
    { AWS_REGION: "not-a-region" },
    { AWS_ACCOUNT_ID: "123456789012" },
    { AWS_REGION: "us-west-2" },
    { FTE_LIVE_ODDS_FUNCTION_NAME: "bad/function" },
    { FTE_WEB_ASSETS_BUCKET_NAME: "bad/bucket" },
    { FTE_EVENT_CURSOR_SECRET_ARN: "secret-value" },
  ])
    assert.throws(() =>
      validateEnvironment({ ...validEnvironment, ...change }),
    );
});

test("wrong-scope JWT signature and claims are validated before use", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  const header = Buffer.from(
    JSON.stringify({ alg: "RS256", kid: "key-1" }),
  ).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      iss: validEnvironment.FTE_JWT_ISSUER,
      aud: validEnvironment.FTE_JWT_AUDIENCE,
      token_use: "id",
      exp: Math.floor(Date.now() / 1000) + 300,
    }),
  ).toString("base64url");
  const signature = sign(
    "RSA-SHA256",
    Buffer.from(`${header}.${payload}`),
    privateKey,
  ).toString("base64url");
  const validToken = `${header}.${payload}.${signature}`;
  const jwks = JSON.stringify({
    keys: [
      {
        ...publicKey.export({ format: "jwk" }),
        kid: "key-1",
        alg: "RS256",
        use: "sig",
      },
    ],
  });
  const fetchJwks = async () => ({ ok: true, text: async () => jwks });
  await assert.doesNotReject(() =>
    validateWrongScopeToken(validToken, validEnvironment, fetchJwks),
  );
  const forged = `${header}.${payload}.${Buffer.from("forged").toString("base64url")}`;
  await assert.rejects(() =>
    validateWrongScopeToken(forged, validEnvironment, fetchJwks),
  );
  for (const token of [
    "opaque",
    "a.!!!!.b",
    jwt({
      iss: "https://wrong.example.com",
      aud: "find-the-edge-dev",
      token_use: "id",
      exp: Math.floor(Date.now() / 1000) + 300,
    }),
    jwt({
      iss: "https://issuer.example.com",
      aud: "find-the-edge-dev",
      token_use: "access",
      exp: Math.floor(Date.now() / 1000) + 300,
    }),
    jwt({
      iss: "https://issuer.example.com",
      aud: "find-the-edge-dev",
      token_use: "id",
      exp: 1,
    }),
    jwt({
      iss: "https://issuer.example.com",
      aud: "find-the-edge-dev",
      token_use: "id",
      exp: Math.floor(Date.now() / 1000) + 300,
      scope: "events/events:read",
    }),
  ])
    await assert.rejects(
      () => validateWrongScopeToken(token, validEnvironment, fetchJwks),
      /Wrong-scope token is invalid/,
    );
});

test("live ingestion binding finds the intended Lambda beyond the first resource page", () => {
  const intended = {
    StackId: validEnvironment.FTE_PHASE1_STACK_ID,
    StackName: "FindTheEdge-dev-Foundation",
    ResourceType: "AWS::Lambda::Function",
    PhysicalResourceId: validEnvironment.FTE_LIVE_ODDS_FUNCTION_NAME,
  };
  const exact = [
    ...Array.from({ length: 100 }, (_, index) => ({
      ...intended,
      PhysicalResourceId: `unrelated-${String(index)}`,
    })),
    intended,
  ];
  assert.doesNotThrow(() =>
    assertLiveIngestionResourceBinding(exact, validEnvironment),
  );
  for (const resource of [
    undefined,
    { ...intended, StackId: `${intended.StackId}-wrong` },
    { ...intended, StackName: "UnrelatedStack" },
    { ...intended, ResourceType: "AWS::Lambda::Version" },
    { ...intended, PhysicalResourceId: "unrelated" },
  ])
    assert.throws(() =>
      assertLiveIngestionResourceBinding(
        resource === undefined ? [] : [resource],
        validEnvironment,
      ),
    );
});

test("stack resource lookup relies on AWS CLI automatic pagination", () => {
  const argumentsList = stackResourceListingArguments(
    validEnvironment.FTE_PHASE1_STACK_ID,
    validEnvironment.AWS_REGION,
  );
  assert.deepEqual(argumentsList, [
    "cloudformation",
    "list-stack-resources",
    "--stack-name",
    validEnvironment.FTE_PHASE1_STACK_ID,
    "--region",
    validEnvironment.AWS_REGION,
    "--output",
    "json",
  ]);
  assert.equal(argumentsList.includes("--no-paginate"), false);
  assert.equal(argumentsList.includes("--max-items"), false);
  assert.equal(argumentsList.includes("--starting-token"), false);
});

test("release refresh payload is attached only to the Lambda invocation", () => {
  assert.deepEqual(
    liveOddsInvocationArguments("fte-dev-live-odds", "us-east-1", "out.json"),
    [
      "lambda",
      "invoke",
      "--function-name",
      "fte-dev-live-odds",
      "--region",
      "us-east-1",
      "--payload",
      '{"forceRefresh":true}',
      "--cli-binary-format",
      "raw-in-base64-out",
      "--output",
      "json",
      "out.json",
    ],
  );
});

test("live ingestion proof accepts production control-plane summaries", () => {
  assert.doesNotThrow(() =>
    assertLiveIngestionSummary([
      {
        leagueKey: "mlb",
        status: "completed",
        providerId: "sharpapi",
        pages: 1,
        quotaCost: 1,
      },
      {
        leagueKey: "mls",
        status: "skipped",
        reason: "cadence-not-due",
        pages: 0,
        quotaCost: 0,
      },
      ...["epl", "liga-mx", "uefa-champions-league"].map((leagueKey) => ({
        leagueKey,
        status: "completed",
        pages: 1,
        quotaCost: 1,
      })),
    ]),
  );
  assert.doesNotThrow(() =>
    assertLiveIngestionSummary({
      leagues: 2,
      events: 1,
      observations: 6,
      skippedLeagues: 1,
    }),
  );
  for (const invalid of [
    [],
    [
      { leagueKey: "mlb", status: "failed", pages: 0, quotaCost: 1 },
      { leagueKey: "mls", status: "completed", pages: 1, quotaCost: 1 },
    ],
    [
      { leagueKey: "mlb", status: "completed", pages: 1, quotaCost: 1 },
      { leagueKey: "mlb", status: "completed", pages: 1, quotaCost: 1 },
    ],
  ])
    assert.throws(() => assertLiveIngestionSummary(invalid));
  assert.throws(
    () =>
      assertLiveIngestionSummary([
        {
          leagueKey: "mlb",
          status: "failed",
          reason: "mapping-quarantine",
          pages: 0,
          quotaCost: 1,
        },
        {
          leagueKey: "mls",
          status: "completed",
          pages: 1,
          quotaCost: 1,
        },
      ]),
    /mlb=failed:mapping-quarantine,mls=completed/,
  );
  assert.throws(
    () =>
      assertLiveIngestionSummary([
        {
          leagueKey: "mlb",
          status: "failed",
          reason: "schedule-provider-unavailable",
          pages: 0,
          quotaCost: 1,
        },
        {
          leagueKey: "mls",
          status: "completed",
          pages: 1,
          quotaCost: 1,
        },
      ]),
    /mlb=failed:schedule-provider-unavailable,mls=completed/,
  );
  assert.throws(
    () =>
      assertLiveIngestionSummary([
        {
          leagueKey: "mlb",
          status: "failed",
          reason: "raw-secret-provider-message",
          pages: 0,
          quotaCost: 1,
        },
        {
          leagueKey: "mls",
          status: "completed",
          pages: 1,
          quotaCost: 1,
        },
      ]),
    /mls=completed/,
  );
});

test("live ingestion proof accepts only the closed reconciliation diagnostic set", () => {
  const reconciliationReasons = [
    "invalid-event-reconciliation-lock",
    "event-reconciliation-lock-timeout",
    "event-reconciliation-ownership-lost",
    "event-reconciliation-acquisition-failed",
    "event-reconciliation-execution-failed",
    "event-reconciliation-renewal-failed",
    "event-reconciliation-cleanup-failed",
    "event-reconciliation-acquisition-storage-validation",
    "event-reconciliation-cleanup-storage-transaction-cancelled",
    "identity-snapshot-unstable",
    "dangling-identity-aggregate",
    "stale-identity-aggregate",
    "mapping-canonical-missing",
    "mapping-canonical-scope-mismatch",
    "event-projection-pointer-missing",
    "event-projection-pointer-corrupt",
    "event-projection-active-missing",
    "event-projection-active-corrupt",
    "bootstrap-stale",
    "identity-register-conflict",
    "identity-snapshot-mismatch",
    "canonical-revision-provider-limit",
  ];
  const result = (reason, leagueKey = "mlb") => ({
    leagueKey,
    status: "failed",
    reason,
    pages: 0,
    quotaCost: 0,
  });
  for (const reason of reconciliationReasons)
    assert.equal(
      isSafeLiveIngestionResult(result(`schedule-provider-error-${reason}`)),
      true,
    );
  for (const reason of [
    "schedule-stored-event-conflict",
    "schedule-conflict-metric-pending",
  ])
    assert.equal(isSafeLiveIngestionResult(result(reason)), true);

  const mixed = [
    { leagueKey: "mlb", status: "completed", pages: 1, quotaCost: 1 },
    result("schedule-provider-error-event-reconciliation-lock-timeout", "mls"),
    result("schedule-stored-event-conflict", "epl"),
    result("schedule-conflict-metric-pending", "liga-mx"),
    {
      leagueKey: "uefa-champions-league",
      status: "skipped",
      reason: "cadence-not-due",
      pages: 0,
      quotaCost: 0,
    },
  ];
  assert.deepEqual(mixed.map(isSafeLiveIngestionResult), [
    true,
    true,
    true,
    true,
    true,
  ]);
  assert.throws(
    () => assertLiveIngestionSummary(mixed),
    /mls=failed:schedule-provider-error-event-reconciliation-lock-timeout/,
  );
  for (const reason of [
    "schedule-provider-error-mapping-canonical-missing-secret",
    "schedule-provider-error-event-reconciliation-lock-timeout-secret",
    "schedule-provider-error-SensitiveProviderException",
    "schedule-stored-event-conflict-secret",
    "schedule-conflict-metric-pending-secret",
  ])
    assert.equal(isSafeLiveIngestionResult(result(reason)), false);

  for (const reason of [
    "mapping-canonical-missing",
    "mapping-canonical-scope-mismatch",
    "mapping-scope-mismatch",
    "sharpapi-odds-mapping-no-candidate",
    "sharpapi-odds-mapping-ambiguous-candidates",
    "sharpapi-odds-mapping-participant-mismatch",
    "sharpapi-odds-mapping-start-mismatch",
  ])
    assert.equal(isSafeLiveIngestionResult(result(reason)), true);
  assert.equal(
    isSafeLiveIngestionResult(result("sharpapi-odds-mapping-secret-detail")),
    false,
  );
  for (const reason of [
    "provider-rejected",
    "unauthorized",
    "invalid-response",
  ])
    assert.equal(isSafeLiveIngestionResult(result(reason)), true);
  assert.equal(
    isSafeLiveIngestionResult({
      leagueKey: "mlb",
      status: "completed",
      reason: "unauthorized",
      pages: 1,
      quotaCost: 1,
    }),
    false,
  );
  assert.equal(
    isSafeLiveIngestionResult({
      leagueKey: "mlb",
      status: "failed",
      pages: 0,
      quotaCost: 0,
    }),
    false,
  );
  assert.equal(
    isSafeLiveIngestionResult(result("schedule-provider-rejected")),
    true,
  );
});

test("live ingestion retries bounded schedule and provider recovery", () => {
  const recovering = [
    "mlb",
    "mls",
    "epl",
    "liga-mx",
    "uefa-champions-league",
  ].map((leagueKey) => ({
    leagueKey,
    status: "failed",
    reason: "schedule-provider-recovering",
    pages: 0,
    quotaCost: 0,
  }));
  assert.equal(isTransientLiveIngestionSummary(recovering), true);
  assert.doesNotThrow(() => assertLiveIngestionSummary(recovering));
  assert.doesNotThrow(() =>
    assertLiveIngestionSummary(
      recovering.map(
        ({ pages: _pages, quotaCost: _quotaCost, ...result }) => result,
      ),
    ),
  );
  assert.equal(
    isTransientLiveIngestionSummary(
      recovering.map((result) => ({ ...result, providerId: "sharpapi" })),
    ),
    true,
  );
  assert.equal(
    isTransientLiveIngestionSummary([
      recovering[0],
      { ...recovering[1], pages: 2, quotaCost: 3 },
      ...recovering.slice(2),
    ]),
    true,
  );
  const providerRecovering = recovering.map((result, index) =>
    index === 0
      ? {
          leagueKey: result.leagueKey,
          status: "completed",
          providerId: "sharpapi",
          pages: 23,
          quotaCost: 23,
        }
      : {
          ...result,
          status: "skipped",
          reason: "provider-recovering",
          providerId: "sharpapi",
        },
  );
  assert.equal(isTransientLiveIngestionSummary(providerRecovering), true);
  assert.equal(
    isTransientLiveIngestionSummary(
      providerRecovering.map((result) => ({
        ...result,
        ...(result.status === "completed" ? { reason: "cadence-not-due" } : {}),
      })),
    ),
    false,
  );
  for (const malformed of [
    [recovering[0], recovering[0]],
    [recovering[0], { ...recovering[1], pages: -1 }],
    [recovering[0], { ...recovering[1], quotaCost: -1 }],
    [recovering[0], { ...recovering[1], pages: 0.5 }],
    [recovering[0], { ...recovering[1], extra: true }],
    [recovering[0], { ...recovering[1], providerId: "other" }],
  ])
    assert.equal(isTransientLiveIngestionSummary(malformed), false);
  assert.equal(
    isTransientLiveIngestionSummary([
      recovering[0],
      { ...recovering[1], reason: "schedule-provider-unavailable" },
    ]),
    false,
  );
  assert.equal(isTransientLiveIngestionSummary({}), false);
  const recoveryInput = {
    summary: recovering,
    invocation: 1,
    recoveryAttempts: 3,
    now: 1_000,
    recoveryDeadline: 100_000,
    recoveryDelayMs: 30_000,
  };
  assert.equal(liveIngestionRecoveryAction(recoveryInput), "retry");
  assert.equal(
    liveIngestionRecoveryAction({ ...recoveryInput, invocation: 3 }),
    "exhausted",
  );
  assert.equal(
    liveIngestionRecoveryAction({ ...recoveryInput, recoveryDeadline: 30_000 }),
    "exhausted",
  );
  assert.equal(
    liveIngestionRecoveryAction({
      ...recoveryInput,
      summary: recovering.map((result) => ({
        leagueKey: result.leagueKey,
        status: "completed",
        providerId: "sharpapi",
        pages: 1,
        quotaCost: 1,
      })),
    }),
    "complete",
  );
});

test("live game proof accepts complete real sportsbook markets and rejects fixtures", () => {
  const game = {
    id: "event:mlb:provider-event",
    participants: [{ label: "Away" }, { label: "Home" }],
    odds: {
      state: "available",
      selections: ["away", "home"].map((selectionKey) => ({
        marketKey: "moneyline",
        selectionKey,
        sportsbookId: "draftkings",
        americanOdds: selectionKey === "away" ? 120 : -135,
        observedAt: "2026-08-02T12:00:00.000Z",
        retrievedAt: "2026-08-02T12:00:01.000Z",
      })),
    },
  };
  assert.doesNotThrow(() => assertLiveGame(game, "mlb"));
  const soccer = {
    ...game,
    id: "event:soccer:provider-event",
    odds: {
      ...game.odds,
      selections: ["away", "draw", "home"].map((selectionKey) => ({
        ...game.odds.selections[0],
        marketKey: "moneyline",
        selectionKey,
      })),
    },
  };
  assert.doesNotThrow(() => assertLiveGame(soccer, "soccer"));
  assert.throws(() =>
    assertLiveGame(
      {
        ...soccer,
        odds: {
          ...soccer.odds,
          selections: soccer.odds.selections.map((selection) => ({
            ...selection,
            marketKey: "three_way_moneyline",
          })),
        },
      },
      "soccer",
    ),
  );
  assert.throws(() => assertLiveGame({ ...game, id: "fixture-game" }, "mlb"));
  assert.throws(() =>
    assertLiveGame(
      {
        ...game,
        odds: {
          ...game.odds,
          selections: [
            ...game.odds.selections,
            {
              ...game.odds.selections[0],
              marketKey: "spread",
              point: 1.5,
              sportsbookId: "fanduel",
            },
            {
              ...game.odds.selections[1],
              marketKey: "spread",
              point: -1.5,
              sportsbookId: "fanduel",
            },
          ],
        },
      },
      "mlb",
    ),
  );
});

test("wrong-origin and hosting header proofs reject every weakening", () => {
  assert.doesNotThrow(() => assertWrongOriginDenied(new Headers()));
  for (const value of ["*", "https://wrong-origin.invalid", "null"])
    assert.throws(() =>
      assertWrongOriginDenied(
        new Headers({ "access-control-allow-origin": value }),
      ),
    );
  const headers = new Headers({
    "content-security-policy":
      "default-src 'self'; base-uri 'none'; connect-src 'self' https://api.example.com https://domain.auth.us-east-1.amazoncognito.com; form-action 'none'; frame-ancestors 'none'; img-src 'self'; object-src 'none'; script-src 'self'; style-src 'self'",
    "strict-transport-security": "max-age=31536000; includeSubDomains; preload",
    "x-frame-options": "DENY",
    "x-content-type-options": "nosniff",
    "referrer-policy": "strict-origin-when-cross-origin",
    "permissions-policy": "camera=(), microphone=(), geolocation=()",
    "cache-control": "no-store",
  });
  assert.doesNotThrow(() =>
    assertHostedIndexHeaders(headers, validEnvironment),
  );
  for (const name of headers.keys()) {
    const weakened = new Headers(headers);
    weakened.delete(name);
    assert.throws(() => assertHostedIndexHeaders(weakened, validEnvironment));
  }
  for (const csp of [
    "default-src 'self'; base-uri 'none'; connect-src 'self' https://api.example.com; form-action 'none'; frame-ancestors 'none'; img-src 'self'; object-src 'none'; script-src 'self'; style-src 'self'",
    "default-src 'self'; base-uri 'none'; connect-src 'self' https://api.example.com https://domain.auth.us-east-1.amazoncognito.com https://unexpected.example.com; form-action 'none'; frame-ancestors 'none'; img-src 'self'; object-src 'none'; script-src 'self'; style-src 'self'",
    "default-src 'self'; base-uri 'none'; connect-src 'self' https://api.example.com http://domain.auth.us-east-1.amazoncognito.com; form-action 'none'; frame-ancestors 'none'; img-src 'self'; object-src 'none'; script-src 'self'; style-src 'self'",
  ]) {
    const weakened = new Headers(headers);
    weakened.set("content-security-policy", csp);
    assert.throws(() => assertHostedIndexHeaders(weakened, validEnvironment));
  }
});
