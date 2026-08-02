import assert from "node:assert/strict";
import test from "node:test";
import {
  phase1EnvironmentSmoke,
  validateEnvironment,
} from "./phase1-environment-smoke.mjs";

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

const validEnvironment = {
  AWS_ACCOUNT_ID: "123456789012",
  AWS_REGION: "us-east-1",
  FTE_PHASE1_API_BASE: "https://api.example.com/dev",
  FTE_FIXTURE_SEED_FUNCTION_NAME: "fte-dev-seed",
  FTE_WEB_ORIGIN: "https://app.example.com",
  FTE_PHASE1_BROWSER_BASE_URL: "https://app.example.com",
  FTE_PHASE1_ACCESS_TOKEN: "opaque-token",
  FTE_JWT_ISSUER: "https://issuer.example.com",
  FTE_JWT_AUDIENCE: "find-the-edge-dev",
  FTE_EVENT_CURSOR_SECRET_ARN:
    "arn:aws:secretsmanager:us-east-1:123456789012:secret:fte-cursor",
};

test("rejects unsafe full-smoke inputs before any AWS command", () => {
  assert.doesNotThrow(() => validateEnvironment(validEnvironment));
  for (const change of [
    { FTE_PHASE1_API_BASE: "https://user:pass@api.example.com/dev" },
    { FTE_PHASE1_API_BASE: "https://api.example.com/dev?token=x" },
    { FTE_PHASE1_BROWSER_BASE_URL: "https://other.example.com" },
    { AWS_REGION: "not-a-region" },
    { FTE_FIXTURE_SEED_FUNCTION_NAME: "bad/function" },
    { FTE_EVENT_CURSOR_SECRET_ARN: "secret-value" },
  ])
    assert.throws(() =>
      validateEnvironment({ ...validEnvironment, ...change }),
    );
});
