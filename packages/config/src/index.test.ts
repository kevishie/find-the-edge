import { describe, expect, it } from "vitest";

import {
  ConfigValidationError,
  defaultFeedCoveragePolicies,
  feedCoverageCatalogVersion,
  validateEnvironment,
} from "./index";

describe("validateEnvironment", () => {
  it("supports local fixture mode without secrets", () => {
    expect(validateEnvironment({})).toEqual({
      environment: "development",
      applicationName: "find-the-edge",
      port: 5173,
      fixtureMode: true,
    });
  });

  it("validates explicit provider and AWS profiles", () => {
    expect(
      validateEnvironment({ ODDS_API_KEY: "test-placeholder" }, "provider"),
    ).toMatchObject({
      fixtureMode: false,
      provider: { oddsApiKey: "test-placeholder" },
    });
    expect(
      validateEnvironment(
        { AWS_REGION: "us-east-1", FTE_AWS_STAGE: "test" },
        "aws",
      ),
    ).toMatchObject({
      fixtureMode: false,
      aws: { region: "us-east-1", stage: "test" },
    });
  });

  it("reports missing profile-specific values", () => {
    expect(() => validateEnvironment({}, "provider")).toThrow(
      ConfigValidationError,
    );
    try {
      validateEnvironment({}, "aws");
    } catch (error) {
      expect(error).toMatchObject({
        issues: [
          { variable: "AWS_REGION", code: "missing" },
          { variable: "FTE_AWS_STAGE", code: "missing" },
        ],
      });
    }
  });

  it("reports malformed common values", () => {
    expect(() =>
      validateEnvironment({ NODE_ENV: "preview", FTE_PORT: "70000" }),
    ).toThrow(
      "NODE_ENV must be development, test, or production; FTE_PORT must be an integer from 1 through 65535",
    );
  });
});

describe("default feed coverage catalog", () => {
  it("contains complete, immutable, secret-free league policy sets", () => {
    expect(feedCoverageCatalogVersion).toBe("2026-08-03.v6");
    expect(defaultFeedCoveragePolicies).toHaveLength(18);
    const leagues = new Map<string, Set<string>>();
    for (const policy of defaultFeedCoveragePolicies) {
      const key = `${policy.sportKey}/${policy.leagueKey}`;
      const capabilities = leagues.get(key) ?? new Set<string>();
      capabilities.add(policy.capability);
      leagues.set(key, capabilities);
      expect(Object.isFrozen(policy)).toBe(true);
      expect(JSON.stringify(policy)).not.toMatch(/api.?key|secret|token/i);
    }
    expect([...leagues.values()]).toHaveLength(6);
    for (const capabilities of leagues.values()) {
      expect([...capabilities].sort()).toEqual(["odds", "results", "schedule"]);
    }
    expect(Object.isFrozen(defaultFeedCoveragePolicies)).toBe(true);
  });
});
