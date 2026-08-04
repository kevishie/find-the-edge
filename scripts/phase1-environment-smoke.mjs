import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createPublicKey, verify } from "node:crypto";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { run } from "./phase1-support.mjs";

const REQUIRED = [
  "AWS_ACCOUNT_ID",
  "AWS_REGION",
  "FTE_PHASE1_API_BASE",
  "FTE_LIVE_ODDS_FUNCTION_NAME",
  "FTE_WEB_ORIGIN",
  "FTE_PHASE1_STACK_ID",
  "FTE_WEB_ASSETS_BUCKET_NAME",
  "FTE_PHASE1_BROWSER_BASE_URL",
  "FTE_EVENT_CURSOR_SECRET_ARN",
];
const AUTHORIZED_ACCOUNT = "228246988391";
const AUTHORIZED_REGION = "us-east-1";
const RELEASE_REFRESH_LEAGUES = new Set([
  "mlb",
  "mls",
  "epl",
  "liga-mx",
  "uefa-champions-league",
]);

export const liveOddsInvocationArguments = (
  functionName,
  region,
  responseFile,
) => [
  "lambda",
  "invoke",
  "--function-name",
  functionName,
  "--region",
  region,
  "--payload",
  '{"forceRefresh":true}',
  "--cli-binary-format",
  "raw-in-base64-out",
  "--output",
  "json",
  responseFile,
];

function decodeJwtPart(value) {
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error();
    return JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    throw new Error("Wrong-scope token is invalid");
  }
}

export async function validateWrongScopeToken(
  token,
  environment,
  fetchJwks = fetch,
) {
  if (typeof token !== "string" || token.length === 0 || token.length > 8192)
    throw new Error("Wrong-scope token is invalid");
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Wrong-scope token is invalid");
  const header = decodeJwtPart(parts[0]);
  const payload = decodeJwtPart(parts[1]);
  const scopes =
    typeof payload?.scope === "string" ? payload.scope.split(" ") : [];
  if (
    !payload ||
    typeof payload !== "object" ||
    payload.iss !== environment.FTE_JWT_ISSUER ||
    payload.aud !== environment.FTE_JWT_AUDIENCE ||
    payload.token_use !== "id" ||
    typeof payload.exp !== "number" ||
    payload.exp <= Date.now() / 1000 + 30 ||
    scopes.includes("events/events:read")
  )
    throw new Error("Wrong-scope token is invalid");
  if (header?.alg !== "RS256" || typeof header?.kid !== "string")
    throw new Error("Wrong-scope token is invalid");
  try {
    const response = await fetchJwks(
      `${environment.FTE_JWT_ISSUER}/.well-known/jwks.json`,
      { signal: AbortSignal.timeout(5_000), cache: "no-store" },
    );
    if (!response.ok) throw new Error();
    const text = await response.text();
    if (text.length > 65_536) throw new Error();
    const jwks = JSON.parse(text);
    const key = jwks.keys?.find(
      (candidate) =>
        candidate.kid === header.kid &&
        candidate.alg === "RS256" &&
        candidate.kty === "RSA" &&
        candidate.use === "sig" &&
        typeof candidate.n === "string" &&
        candidate.n.length <= 2048 &&
        typeof candidate.e === "string" &&
        candidate.e.length <= 16,
    );
    if (
      !key ||
      !verify(
        "RSA-SHA256",
        Buffer.from(`${parts[0]}.${parts[1]}`),
        createPublicKey({ key, format: "jwk" }),
        Buffer.from(parts[2], "base64url"),
      )
    )
      throw new Error();
  } catch {
    throw new Error("Wrong-scope token is invalid");
  }
}

export function validateEnvironment(environment) {
  const missing = REQUIRED.filter((name) => !environment[name]);
  if (missing.length > 0)
    throw new Error(`missing required environment: ${missing.join(", ")}`);
  if (
    environment.AWS_ACCOUNT_ID !== AUTHORIZED_ACCOUNT ||
    environment.AWS_REGION !== AUTHORIZED_REGION
  )
    throw new Error("Smoke is restricted to the authorized account and region");
  if (
    !environment.FTE_PHASE1_STACK_ID.startsWith(
      `arn:aws:cloudformation:${AUTHORIZED_REGION}:${AUTHORIZED_ACCOUNT}:stack/FindTheEdge-dev-Foundation/`,
    )
  )
    throw new Error("FTE_PHASE1_STACK_ID must identify the intended stack");
  if (!/^[A-Za-z0-9-_]{1,64}$/.test(environment.FTE_LIVE_ODDS_FUNCTION_NAME))
    throw new Error("FTE_LIVE_ODDS_FUNCTION_NAME is invalid");
  if (
    !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(
      environment.FTE_WEB_ASSETS_BUCKET_NAME,
    )
  )
    throw new Error("FTE_WEB_ASSETS_BUCKET_NAME is invalid");
  let api;
  let origin;
  let browser;
  try {
    api = new URL(environment.FTE_PHASE1_API_BASE);
    origin = new URL(environment.FTE_WEB_ORIGIN);
    browser = new URL(environment.FTE_PHASE1_BROWSER_BASE_URL);
  } catch {
    throw new Error("API, browser, and web origin must be valid URLs");
  }
  if (
    api.protocol !== "https:" ||
    api.username ||
    api.password ||
    api.search ||
    api.hash
  )
    throw new Error("FTE_PHASE1_API_BASE must be safe HTTPS");
  if (
    origin.protocol !== "https:" ||
    origin.origin !== environment.FTE_WEB_ORIGIN
  )
    throw new Error("FTE_WEB_ORIGIN must be an exact HTTPS origin");
  if (
    browser.protocol !== "https:" ||
    browser.origin !== environment.FTE_WEB_ORIGIN ||
    browser.href !== `${environment.FTE_WEB_ORIGIN}/`
  )
    throw new Error("Browser base must exactly match FTE_WEB_ORIGIN");
  const arn = environment.FTE_EVENT_CURSOR_SECRET_ARN;
  if (
    !new RegExp(
      `^arn:(aws|aws-us-gov|aws-cn):secretsmanager:${environment.AWS_REGION}:${environment.AWS_ACCOUNT_ID}:secret:[A-Za-z0-9/_+=.@-]+$`,
    ).test(arn)
  )
    throw new Error(
      "Cursor secret ARN must match the configured account and region",
    );
}

export function assertLiveIngestionResourceBinding(resources, environment) {
  if (
    !resources.some(
      (resource) =>
        resource.StackId === environment.FTE_PHASE1_STACK_ID &&
        resource.StackName === "FindTheEdge-dev-Foundation" &&
        resource.ResourceType === "AWS::Lambda::Function" &&
        resource.PhysicalResourceId === environment.FTE_LIVE_ODDS_FUNCTION_NAME,
    )
  )
    throw new Error("Live ingestion is not the intended stack Lambda");
}

export function assertLiveIngestionSummary(summary) {
  if (Array.isArray(summary)) {
    const expectedLeagues = RELEASE_REFRESH_LEAGUES;
    const isOwnershipOverlap = (result) =>
      result?.status === "failed" &&
      result?.reason === "schedule-provider-recovering";
    const ownershipOverlapLeagues = summary.map((result) => result?.leagueKey);
    if (
      summary.length === expectedLeagues.size &&
      new Set(ownershipOverlapLeagues).size === expectedLeagues.size &&
      ownershipOverlapLeagues.every((leagueKey) =>
        expectedLeagues.has(leagueKey),
      ) &&
      summary.every(isOwnershipOverlap)
    )
      return;
    const safeResult = (result) =>
      result &&
      typeof result === "object" &&
      RELEASE_REFRESH_LEAGUES.has(result.leagueKey) &&
      ["completed", "skipped", "failed"].includes(result.status) &&
      (result.reason === undefined ||
        [
          "provider-error",
          "provider-unavailable",
          "rate-limited",
          "not-entitled",
          "coverage-missing",
          "provider-request-ambiguous",
          "provider-response-unsealed",
          "quota-reserve",
          "provider-cooldown",
          "provider-recovering",
          "schedule-dependency-failed",
          "mapping-quarantine",
          "pagination-invalid",
          "transition-conflict",
          "internal-failure",
          "cadence-not-due",
        ].includes(result.reason) ||
        /^schedule-(provider-error|provider-unavailable|rate-limited|unauthorized|not-entitled|invalid-response|coverage-missing|provider-request-ambiguous|provider-response-unsealed|quota-reserve|provider-cooldown|provider-recovering|schedule-dependency-failed|mapping-quarantine|pagination-invalid|transition-conflict|internal-failure)$/.test(
          result.reason,
        )) &&
      (isOwnershipOverlap(result) ||
        (Number.isSafeInteger(result.pages) && result.pages >= 0)) &&
      (isOwnershipOverlap(result) ||
        (Number.isSafeInteger(result.quotaCost) && result.quotaCost >= 0));
    const leagues = summary.map((result) => result?.leagueKey);
    if (
      summary.length !== expectedLeagues.size ||
      new Set(leagues).size !== leagues.length ||
      summary.some(
        (result) =>
          !safeResult(result) ||
          !expectedLeagues.has(result.leagueKey) ||
          (!["completed", "skipped"].includes(result.status) &&
            !isOwnershipOverlap(result)),
      ) ||
      leagues.some((leagueKey) => !expectedLeagues.has(leagueKey))
    )
      throw new Error(
        `live ingestion returned an invalid control-plane summary: ${
          summary
            .filter(safeResult)
            .map(
              (result) =>
                `${result.leagueKey}=${result.status}${result.reason ? `:${result.reason}` : ""}`,
            )
            .sort()
            .join(",") ||
          `invalid-shape:${summary.length}:${summary
            .slice(0, 4)
            .map((result) =>
              result && typeof result === "object"
                ? Object.entries(result)
                    .map(([key, value]) => `${key}:${typeof value}`)
                    .sort()
                    .join("|")
                : typeof result,
            )
            .join(",")}`
        }`,
      );
    return;
  }
  if (
    !summary ||
    typeof summary !== "object" ||
    summary.leagues !== 2 ||
    !Number.isSafeInteger(summary.events) ||
    summary.events < 0 ||
    !Number.isSafeInteger(summary.observations) ||
    summary.observations < 0 ||
    !Number.isSafeInteger(summary.skippedLeagues) ||
    summary.skippedLeagues < 0 ||
    summary.skippedLeagues > 2
  )
    throw new Error("live ingestion returned an invalid legacy summary");
}

export function boundedLiveIngestionDiagnostic(summary) {
  if (!Array.isArray(summary)) return "summary-shape-invalid";
  return summary
    .slice(0, 10)
    .map((result) => {
      if (!result || typeof result !== "object") return "result-invalid";
      const league = RELEASE_REFRESH_LEAGUES.has(result.leagueKey)
        ? result.leagueKey
        : "league-invalid";
      const status = ["completed", "skipped", "failed"].includes(result.status)
        ? result.status
        : "status-invalid";
      const reason =
        typeof result.reason === "string" &&
        /^[a-z0-9-]{1,80}$/.test(result.reason)
          ? result.reason
          : "none";
      return `${league}:${status}:${reason}`;
    })
    .join(",");
}

export function isTransientLiveIngestionSummary(summary) {
  if (
    !Array.isArray(summary) ||
    summary.length !== RELEASE_REFRESH_LEAGUES.size
  )
    return false;
  const leagues = new Set(RELEASE_REFRESH_LEAGUES);
  let recovering = false;
  return (
    summary.every((result) => {
      if (
        !result ||
        typeof result !== "object" ||
        Array.isArray(result) ||
        ![
          "leagueKey,pages,providerId,quotaCost,status",
          "leagueKey,pages,quotaCost,reason,status",
          "leagueKey,pages,providerId,quotaCost,reason,status",
        ].includes(Object.keys(result).sort().join(",")) ||
        (result.providerId !== undefined && result.providerId !== "sharpapi") ||
        !leagues.delete(result.leagueKey) ||
        !Number.isSafeInteger(result.pages) ||
        result.pages < 0 ||
        !Number.isSafeInteger(result.quotaCost) ||
        result.quotaCost < 0
      )
        return false;
      if (result.status === "completed") return result.reason === undefined;
      const isRecovering =
        ["failed", "skipped"].includes(result.status) &&
        ["provider-recovering", "schedule-provider-recovering"].includes(
          result.reason,
        );
      recovering ||= isRecovering;
      return isRecovering;
    }) && recovering
  );
}

export function liveIngestionRecoveryAction({
  summary,
  invocation,
  recoveryAttempts,
  now,
  recoveryDeadline,
  recoveryDelayMs,
}) {
  if (!isTransientLiveIngestionSummary(summary)) return "complete";
  return invocation === recoveryAttempts ||
    now + recoveryDelayMs > recoveryDeadline
    ? "exhausted"
    : "retry";
}

export function assertLiveGame(game, sport) {
  if (
    !game ||
    !game.id ||
    !Array.isArray(game.participants) ||
    game.participants.length !== 2
  )
    throw new Error("live game identity is invalid");
  if (game.id.includes("fixture") || game.odds?.state !== "available")
    throw new Error("live game contains fixture or unavailable odds");
  const selections = game.odds.selections;
  if (!Array.isArray(selections)) throw new Error("live game odds are invalid");
  const expected =
    sport === "mlb" ? ["away", "home"] : ["away", "draw", "home"];
  const market = "moneyline";
  const groups = new Map();
  for (const selection of selections) {
    const group = groups.get(selection.marketKey) ?? [];
    group.push(selection);
    groups.set(selection.marketKey, group);
  }
  const moneyline = groups.get(market) ?? [];
  const spread = groups.get("spread") ?? [];
  const total = groups.get("total") ?? [];
  const first = selections[0];
  if (
    !first ||
    selections.some(
      (selection) =>
        selection.sportsbookId !== first.sportsbookId ||
        selection.observedAt !== first.observedAt ||
        selection.retrievedAt !== first.retrievedAt,
    ) ||
    moneyline.length !== expected.length ||
    moneyline.some(
      (selection, index) =>
        selection.selectionKey !== expected[index] ||
        !["draftkings", "fanduel", "betmgm", "williamhill_us"].includes(
          selection.sportsbookId,
        ) ||
        !Number.isInteger(selection.americanOdds) ||
        selection.americanOdds === 0 ||
        !Number.isFinite(Date.parse(selection.observedAt)) ||
        !Number.isFinite(Date.parse(selection.retrievedAt)),
    ) ||
    (spread.length !== 0 &&
      (spread.length !== 2 ||
        spread.some(
          (selection, index) =>
            selection.selectionKey !== ["away", "home"][index] ||
            !Number.isFinite(selection.point),
        ))) ||
    (spread.length === 2 && spread[0].point !== -spread[1].point) ||
    (total.length !== 0 &&
      (total.length !== 2 ||
        total.some(
          (selection, index) =>
            selection.selectionKey !== ["over", "under"][index] ||
            !Number.isFinite(selection.point),
        ))) ||
    (total.length === 2 &&
      (total[0].point !== total[1].point || total[0].point < 0))
  )
    throw new Error("live game odds are incomplete or invalid");
  return spread.length === 2 && total.length === 2;
}

const easternDays = (count = 8) => {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return Array.from({ length: count }, (_, index) =>
    formatter.format(new Date(Date.now() + index * 86_400_000)),
  );
};

async function request(url, options, timeoutMs = 10_000) {
  const response = await fetch(url, {
    ...options,
    signal: AbortSignal.timeout(timeoutMs),
  });
  return response;
}

export function assertWrongOriginDenied(headers) {
  if (headers.get("access-control-allow-origin") !== null)
    throw new Error("API allowed an unconfigured CORS origin");
}

export function assertHostedIndexHeaders(headers, environment) {
  const expectedCsp = `default-src 'self'; base-uri 'none'; connect-src 'self' ${environment.FTE_PHASE1_API_BASE.replace(/\/dev\/?$/, "")}; form-action 'none'; frame-ancestors 'none'; img-src 'self'; object-src 'none'; script-src 'self'; style-src 'self'`;
  const exactHeaders = {
    "content-security-policy": expectedCsp,
    "strict-transport-security": "max-age=31536000; includeSubDomains; preload",
    "x-frame-options": "DENY",
    "x-content-type-options": "nosniff",
    "referrer-policy": "strict-origin-when-cross-origin",
    "permissions-policy": "camera=(), microphone=(), geolocation=()",
    "cache-control": "no-store",
  };
  for (const [name, value] of Object.entries(exactHeaders))
    if (headers.get(name) !== value)
      throw new Error(`Hosted index has invalid ${name}`);
}

export async function phase1EnvironmentSmoke(environment = process.env) {
  if (environment.FTE_PHASE1_SMOKE !== "1")
    return {
      skipped: true,
      reason:
        "set FTE_PHASE1_SMOKE=1 with the documented environment to opt in",
    };
  validateEnvironment(environment);
  const identity = JSON.parse(
    run("aws", ["sts", "get-caller-identity", "--output", "json"], {
      capture: true,
      env: environment,
    }),
  );
  if (identity.Account !== environment.AWS_ACCOUNT_ID)
    throw new Error("authenticated AWS account does not match AWS_ACCOUNT_ID");
  const temporary = await mkdtemp(resolve(tmpdir(), "fte-phase1-smoke-"));
  try {
    const webOrigin = environment.FTE_WEB_ORIGIN;
    const httpResponse = await request(webOrigin.replace(/^https:/, "http:"), {
      redirect: "manual",
    });
    if (
      ![301, 302, 307, 308].includes(httpResponse.status) ||
      httpResponse.headers.get("location") !== `${webOrigin}/`
    )
      throw new Error(
        "CloudFront HTTP did not redirect to the exact HTTPS URL",
      );
    const directS3 = await request(
      `https://${environment.FTE_WEB_ASSETS_BUCKET_NAME}.s3.${environment.AWS_REGION}.amazonaws.com/index.html`,
      {},
    );
    if (directS3.status !== 403)
      throw new Error("Anonymous direct S3 object access was not denied");
    const indexResponse = await request(`${webOrigin}/`, {});
    if (!indexResponse.ok) throw new Error("Hosted index was unavailable");
    assertHostedIndexHeaders(indexResponse.headers, environment);
    const indexHtml = await indexResponse.text();
    const assetPath = indexHtml.match(/(?:src|href)="(\/assets\/[^"]+)"/)?.[1];
    if (!assetPath)
      throw new Error("Hosted index did not identify a hashed asset");
    for (const path of ["/runtime-config.js"]) {
      const response = await request(`${webOrigin}${path}`, {});
      if (!response.ok || response.headers.get("cache-control") !== "no-store")
        throw new Error(`Hosted ${path} cache policy is invalid`);
    }
    const assetResponse = await request(`${webOrigin}${assetPath}`, {
      headers: { "accept-encoding": "gzip" },
    });
    if (
      !assetResponse.ok ||
      assetResponse.headers.get("cache-control") !==
        "public, max-age=31536000, immutable" ||
      !["gzip", "br"].includes(assetResponse.headers.get("content-encoding"))
    )
      throw new Error(
        "Hosted hashed asset cache/compression policy is invalid",
      );
    // Production provider health uses a 15-minute cooldown. The deployment
    // proof must be able to outlive that exact window without bypassing it or
    // issuing overlapping paid requests.
    const recoveryAttempts = 31;
    const recoveryDelayMs = 30_000;
    const recoveryDeadline = Date.now() + 17 * 60_000;
    let ingestionDiagnostic = "summary-unavailable";
    for (let invocation = 1; invocation <= recoveryAttempts; invocation += 1) {
      const mutationIdentity = JSON.parse(
        run("aws", ["sts", "get-caller-identity", "--output", "json"], {
          capture: true,
          env: environment,
        }),
      );
      if (
        mutationIdentity.Account !== environment.AWS_ACCOUNT_ID ||
        environment.AWS_REGION !== "us-east-1"
      )
        throw new Error("AWS identity guard rejected the seed mutation");
      const stackResources = JSON.parse(
        run(
          "aws",
          [
            "cloudformation",
            "describe-stack-resources",
            "--stack-name",
            environment.FTE_PHASE1_STACK_ID,
            "--region",
            environment.AWS_REGION,
            "--output",
            "json",
          ],
          { capture: true, env: environment },
        ),
      ).StackResources;
      assertLiveIngestionResourceBinding(stackResources ?? [], environment);
      const responseFile = resolve(
        temporary,
        `seed-response-${String(invocation)}.json`,
      );
      const invocationResult = JSON.parse(
        run(
          "aws",
          liveOddsInvocationArguments(
            environment.FTE_LIVE_ODDS_FUNCTION_NAME,
            environment.AWS_REGION,
            responseFile,
          ),
          { capture: true, env: environment },
        ),
      );
      if (invocationResult.StatusCode !== 200 || invocationResult.FunctionError)
        throw new Error("live ingestion Lambda invocation failed");
      const summary = JSON.parse(await readFile(responseFile, "utf8"));
      ingestionDiagnostic = boundedLiveIngestionDiagnostic(summary);
      try {
        assertLiveIngestionSummary(summary);
        const recoveryAction = liveIngestionRecoveryAction({
          summary,
          invocation,
          recoveryAttempts,
          now: Date.now(),
          recoveryDeadline,
          recoveryDelayMs,
        });
        if (recoveryAction === "complete") break;
        if (recoveryAction === "exhausted")
          throw new Error(
            `live ingestion remained in provider recovery (${ingestionDiagnostic})`,
          );
      } catch (error) {
        if (
          invocation === recoveryAttempts ||
          Date.now() + recoveryDelayMs > recoveryDeadline ||
          !isTransientLiveIngestionSummary(summary)
        )
          throw error;
      }
      await new Promise((resolveDelay) =>
        setTimeout(resolveDelay, recoveryDelayMs),
      );
    }
    const apiBase = environment.FTE_PHASE1_API_BASE.replace(/\/$/, "");
    let liveGames = 0;
    let fullMarketGames = 0;
    for (const sport of ["mlb", "soccer"]) {
      let foundForSport = false;
      for (const day of easternDays()) {
        const response = await request(
          `${apiBase}/games?sport=${sport}&status=scheduled&day=${day}`,
          { headers: { origin: environment.FTE_WEB_ORIGIN } },
        );
        if (!response.ok)
          throw new Error(
            `anonymous ${sport} API returned ${String(response.status)}`,
          );
        if (
          response.headers.get("access-control-allow-origin") !==
          environment.FTE_WEB_ORIGIN
        )
          throw new Error(
            `anonymous ${sport} API did not return exact CORS origin`,
          );
        const body = await response.json();
        for (const game of body.items ?? []) {
          if (game.odds?.state !== "available") continue;
          if (
            game.id?.includes("fixture") ||
            game.odds.selections?.some(
              (selection) => selection.sportsbookId === "fixture-book",
            )
          )
            continue;
          if (assertLiveGame(game, sport)) fullMarketGames += 1;
          foundForSport = true;
          liveGames += 1;
        }
      }
      void foundForSport;
    }
    if (liveGames === 0)
      throw new Error(
        `no provider-backed games were visible (${ingestionDiagnostic})`,
      );
    if (fullMarketGames === 0)
      throw new Error(
        "no provider-backed spread/total/moneyline board was visible",
      );
    const wrongOrigin = await request(
      `${apiBase}/games?sport=mlb&status=scheduled&day=${easternDays(1)[0]}`,
      {
        method: "OPTIONS",
        headers: {
          origin: "https://wrong-origin.invalid",
          "access-control-request-method": "GET",
        },
      },
    );
    assertWrongOriginDenied(wrongOrigin.headers);
    const wrongOriginGet = await request(
      `${apiBase}/games?sport=mlb&status=scheduled&day=${easternDays(1)[0]}`,
      { headers: { origin: "https://wrong-origin.invalid" } },
    );
    assertWrongOriginDenied(wrongOriginGet.headers);
    run(
      "pnpm",
      ["exec", "playwright", "test", "--config", "playwright.phase1.config.ts"],
      { env: environment, timeout: 120_000 },
    );
    return { skipped: false };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  import.meta.url === new URL(process.argv[1], "file:").href
) {
  phase1EnvironmentSmoke()
    .then((result) => {
      process.stdout.write(
        result.skipped
          ? `Phase1 environment smoke skipped: ${result.reason}\n`
          : "Phase1 environment smoke passed.\n",
      );
    })
    .catch((error) => {
      const tokens = [
        process.env.FTE_PHASE1_ACCESS_TOKEN,
        process.env.FTE_PHASE1_WRONG_SCOPE_TOKEN,
      ].filter(Boolean);
      let message = error instanceof Error ? error.message : "unknown error";
      for (const token of tokens)
        message = message.replaceAll(token, "[REDACTED]");
      process.stderr.write(`Phase1 environment smoke failed: ${message}\n`);
      process.exitCode = 1;
    });
}
