import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createPublicKey, verify } from "node:crypto";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { run } from "./phase1-support.mjs";

const REQUIRED = [
  "AWS_ACCOUNT_ID",
  "AWS_REGION",
  "FTE_PHASE1_API_BASE",
  "FTE_FIXTURE_SEED_FUNCTION_NAME",
  "FTE_WEB_ORIGIN",
  "FTE_PHASE1_STACK_ID",
  "FTE_WEB_ASSETS_BUCKET_NAME",
  "FTE_PHASE1_ACCESS_TOKEN",
  "FTE_PHASE1_BROWSER_BASE_URL",
  "FTE_JWT_ISSUER",
  "FTE_JWT_AUDIENCE",
  "FTE_COGNITO_DOMAIN",
  "FTE_EVENT_CURSOR_SECRET_ARN",
  "FTE_PHASE1_USERNAME",
  "FTE_PHASE1_PASSWORD",
  "FTE_PHASE1_WRONG_SCOPE_TOKEN",
];
const AUTHORIZED_ACCOUNT = "228246988391";
const AUTHORIZED_REGION = "us-east-1";

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
  if (!/^[A-Za-z0-9-_]{1,64}$/.test(environment.FTE_FIXTURE_SEED_FUNCTION_NAME))
    throw new Error("FTE_FIXTURE_SEED_FUNCTION_NAME is invalid");
  if (
    !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(
      environment.FTE_WEB_ASSETS_BUCKET_NAME,
    )
  )
    throw new Error("FTE_WEB_ASSETS_BUCKET_NAME is invalid");
  let api;
  let origin;
  let browser;
  let issuer;
  try {
    api = new URL(environment.FTE_PHASE1_API_BASE);
    origin = new URL(environment.FTE_WEB_ORIGIN);
    browser = new URL(environment.FTE_PHASE1_BROWSER_BASE_URL);
    issuer = new URL(environment.FTE_JWT_ISSUER);
    new URL(environment.FTE_COGNITO_DOMAIN);
  } catch {
    throw new Error(
      "API, browser, web origin, and JWT issuer must be valid URLs",
    );
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
  if (issuer.protocol !== "https:" || issuer.username || issuer.password)
    throw new Error("FTE_JWT_ISSUER must be safe HTTPS");
  if (/\s/.test(environment.FTE_JWT_AUDIENCE))
    throw new Error("FTE_JWT_AUDIENCE must be nonblank without whitespace");
  const arn = environment.FTE_EVENT_CURSOR_SECRET_ARN;
  if (
    !new RegExp(
      `^arn:(aws|aws-us-gov|aws-cn):secretsmanager:${environment.AWS_REGION}:${environment.AWS_ACCOUNT_ID}:secret:[A-Za-z0-9/_+=.@-]+$`,
    ).test(arn)
  )
    throw new Error(
      "Cursor secret ARN must match the configured account and region",
    );
  if (
    environment.FTE_PHASE1_ACCESS_TOKEN.trim().length === 0 ||
    environment.FTE_PHASE1_ACCESS_TOKEN.length > 8192
  )
    throw new Error("Access token is empty or oversized");
}

export function assertSeedResourceBinding(resources, environment) {
  if (
    !resources.some(
      (resource) =>
        resource.StackId === environment.FTE_PHASE1_STACK_ID &&
        resource.StackName === "FindTheEdge-dev-Foundation" &&
        resource.ResourceType === "AWS::Lambda::Function" &&
        resource.PhysicalResourceId ===
          environment.FTE_FIXTURE_SEED_FUNCTION_NAME,
    )
  )
    throw new Error("Fixture seed is not the intended stack Lambda");
}

const expectedGames = [
  {
    sport: "mlb",
    day: "2026-08-01",
    id: "event:mlb%3Amlb:2026-regular-boston-new-york-001",
    selections: [
      [
        "moneyline",
        "away",
        "Boston",
        "fixture-book",
        120,
        "2026-08-01T12:00:00.000Z",
      ],
      [
        "moneyline",
        "home",
        "New York",
        "fixture-book",
        -135,
        "2026-08-01T12:00:00.000Z",
      ],
    ],
  },
  {
    sport: "mlb",
    day: "2026-08-02",
    id: "event:mlb%3Amlb:2026-regular-chicago-detroit-001",
    selections: [
      [
        "moneyline",
        "away",
        "Chicago",
        "fixture-book",
        -105,
        "2026-08-01T12:01:00.000Z",
      ],
      [
        "moneyline",
        "home",
        "Detroit",
        "fixture-book",
        -105,
        "2026-08-01T12:01:00.000Z",
      ],
    ],
  },
  {
    sport: "soccer",
    day: "2026-08-01",
    id: "event:soccer%3Amls:2026-regular-miami-atlanta-001",
    selections: [
      [
        "three_way_moneyline",
        "away",
        "Miami",
        "fixture-book",
        145,
        "2026-08-01T12:02:00.000Z",
      ],
      [
        "three_way_moneyline",
        "draw",
        "Draw",
        "fixture-book",
        220,
        "2026-08-01T12:02:00.000Z",
      ],
      [
        "three_way_moneyline",
        "home",
        "Atlanta",
        "fixture-book",
        175,
        "2026-08-01T12:02:00.000Z",
      ],
    ],
  },
];

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
  const expectedCsp = `default-src 'self'; base-uri 'none'; connect-src 'self' ${environment.FTE_PHASE1_API_BASE.replace(/\/dev\/?$/, "")} ${environment.FTE_COGNITO_DOMAIN}; form-action 'self' ${environment.FTE_COGNITO_DOMAIN}; frame-ancestors 'none'; img-src 'self'; object-src 'none'; script-src 'self'; style-src 'self'`;
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
  await validateWrongScopeToken(
    environment.FTE_PHASE1_WRONG_SCOPE_TOKEN,
    environment,
  );
  const token = environment.FTE_PHASE1_ACCESS_TOKEN;
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
    for (const path of ["/runtime-config.js", "/cognito-token-provider.js"]) {
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
    for (let invocation = 1; invocation <= 2; invocation += 1) {
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
      assertSeedResourceBinding(stackResources ?? [], environment);
      const responseFile = resolve(
        temporary,
        `seed-response-${String(invocation)}.json`,
      );
      const invocationResult = JSON.parse(
        run(
          "aws",
          [
            "lambda",
            "invoke",
            "--function-name",
            environment.FTE_FIXTURE_SEED_FUNCTION_NAME,
            "--region",
            environment.AWS_REGION,
            "--output",
            "json",
            responseFile,
          ],
          { capture: true, env: environment },
        ),
      );
      if (invocationResult.StatusCode !== 200 || invocationResult.FunctionError)
        throw new Error("fixture seed Lambda invocation failed");
      const seed = JSON.parse(await readFile(responseFile, "utf8"));
      if (seed.events !== 3 || seed.observations < 3)
        throw new Error("fixture seed returned an invalid summary");
      if (invocation === 2 && seed.snapshotsExisting !== seed.observations)
        throw new Error(
          "fixture seed did not converge on its second invocation",
        );
    }
    const apiBase = environment.FTE_PHASE1_API_BASE.replace(/\/$/, "");
    const unauthenticated = await request(
      `${apiBase}/games?sport=mlb&day=2026-08-01`,
      { headers: { origin: environment.FTE_WEB_ORIGIN } },
    );
    if (unauthenticated.status !== 401)
      throw new Error(
        `unauthenticated API expected 401, received ${String(unauthenticated.status)}`,
      );
    const invalidAuthentication = await request(
      `${apiBase}/games?sport=mlb&day=2026-08-01`,
      {
        headers: {
          authorization: "Bearer invalid-phase1-proof",
          origin: environment.FTE_WEB_ORIGIN,
        },
      },
    );
    if (invalidAuthentication.status !== 401)
      throw new Error(
        `invalid authentication expected 401, received ${String(invalidAuthentication.status)}`,
      );
    for (const expected of expectedGames) {
      const response = await request(
        `${apiBase}/games?sport=${expected.sport}&day=${expected.day}`,
        {
          headers: {
            authorization: `Bearer ${token}`,
            origin: environment.FTE_WEB_ORIGIN,
          },
        },
      );
      if (!response.ok)
        throw new Error(
          `authenticated ${expected.sport} API returned ${String(response.status)}`,
        );
      if (
        response.headers.get("access-control-allow-origin") !==
        environment.FTE_WEB_ORIGIN
      )
        throw new Error(
          `authenticated ${expected.sport} API did not return exact CORS origin`,
        );
      const body = await response.json();
      const game = body.items?.find((item) => item.id === expected.id);
      const actualSelections = game?.odds?.selections?.map((selection) => [
        selection.marketKey,
        selection.selectionKey,
        selection.selectionLabel,
        selection.sportsbookId,
        selection.americanOdds,
        selection.observedAt,
      ]);
      if (
        !game ||
        game.odds?.state !== "available" ||
        JSON.stringify(actualSelections) !== JSON.stringify(expected.selections)
      )
        throw new Error(
          `authenticated ${expected.sport} API did not contain exact fixture identity and odds`,
        );
    }
    const wrongOrigin = await request(
      `${apiBase}/games?sport=mlb&day=2026-08-01`,
      {
        method: "OPTIONS",
        headers: {
          origin: "https://wrong-origin.invalid",
          "access-control-request-method": "GET",
        },
      },
    );
    assertWrongOriginDenied(wrongOrigin.headers);
    {
      const denied = await request(
        `${apiBase}/games?sport=mlb&day=2026-08-01`,
        {
          headers: {
            authorization: `Bearer ${environment.FTE_PHASE1_WRONG_SCOPE_TOKEN}`,
          },
        },
      );
      if (denied.status !== 403)
        throw new Error("wrong-scope token was not denied");
    }
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
