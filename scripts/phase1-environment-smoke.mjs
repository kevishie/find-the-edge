import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { run } from "./phase1-support.mjs";

const REQUIRED = [
  "AWS_ACCOUNT_ID",
  "AWS_REGION",
  "FTE_PHASE1_API_BASE",
  "FTE_FIXTURE_SEED_FUNCTION_NAME",
  "FTE_WEB_ORIGIN",
  "FTE_PHASE1_ACCESS_TOKEN",
  "FTE_PHASE1_BROWSER_BASE_URL",
  "FTE_JWT_ISSUER",
  "FTE_JWT_AUDIENCE",
  "FTE_EVENT_CURSOR_SECRET_ARN",
];

export function validateEnvironment(environment) {
  const missing = REQUIRED.filter((name) => !environment[name]);
  if (missing.length > 0)
    throw new Error(`missing required environment: ${missing.join(", ")}`);
  if (!/^\d{12}$/.test(environment.AWS_ACCOUNT_ID))
    throw new Error("AWS_ACCOUNT_ID must contain 12 digits");
  if (!/^[a-z]{2}(?:-gov)?-[a-z]+-\d$/.test(environment.AWS_REGION))
    throw new Error("AWS_REGION is invalid");
  if (!/^[A-Za-z0-9-_]{1,64}$/.test(environment.FTE_FIXTURE_SEED_FUNCTION_NAME))
    throw new Error("FTE_FIXTURE_SEED_FUNCTION_NAME is invalid");
  let api;
  let origin;
  let browser;
  let issuer;
  try {
    api = new URL(environment.FTE_PHASE1_API_BASE);
    origin = new URL(environment.FTE_WEB_ORIGIN);
    browser = new URL(environment.FTE_PHASE1_BROWSER_BASE_URL);
    issuer = new URL(environment.FTE_JWT_ISSUER);
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

export async function phase1EnvironmentSmoke(environment = process.env) {
  if (environment.FTE_PHASE1_SMOKE !== "1")
    return {
      skipped: true,
      reason:
        "set FTE_PHASE1_SMOKE=1 with the documented environment to opt in",
    };
  validateEnvironment(environment);
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
    for (let invocation = 1; invocation <= 2; invocation += 1) {
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
    if (
      wrongOrigin.headers.get("access-control-allow-origin") ===
      "https://wrong-origin.invalid"
    )
      throw new Error("API allowed an unconfigured CORS origin");
    if (environment.FTE_PHASE1_WRONG_SCOPE_TOKEN) {
      const denied = await request(
        `${apiBase}/games?sport=mlb&day=2026-08-01`,
        {
          headers: {
            authorization: `Bearer ${environment.FTE_PHASE1_WRONG_SCOPE_TOKEN}`,
          },
        },
      );
      if (![401, 403].includes(denied.status))
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
