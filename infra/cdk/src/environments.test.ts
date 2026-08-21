import { describe, expect, it } from "vitest";

import {
  resolveAdminAccessConfiguration,
  resolveEnvironment,
  resolveProductAccessEnforcement,
  resolveRecurringDataPlaneEnabled,
} from "./environments";

describe("deployment environment contract", () => {
  it.each([
    [
      "staging",
      "main",
      "staging",
      "staging.kevishie.com",
      "api-staging.kevishie.com",
    ],
    ["prod", "production", "production", "kevishie.com", "api.kevishie.com"],
  ])(
    "maps %s to its isolated branch, GitHub environment, and domains",
    (stage, branch, githubEnvironment, webDomainName, apiDomainName) => {
      expect(resolveEnvironment(stage)).toEqual(
        expect.objectContaining({
          stage,
          branch,
          githubEnvironment,
          stackName: `FindTheEdge-${stage}-Foundation`,
          secretPrefix: `find-the-edge/${stage}`,
          webDomainName,
          apiDomainName,
          webOrigin: `https://${webDomainName}`,
          apiOrigin: `https://${apiDomainName}`,
        }),
      );
    },
  );

  it("keeps local credential-free and legacy dev explicitly fenced", () => {
    expect(resolveEnvironment("local").persistent).toBe(false);
    expect(() => resolveEnvironment("dev")).toThrow(/legacy/i);
    expect(resolveEnvironment("dev", { allowLegacyDev: true })).toEqual(
      expect.objectContaining({
        stage: "dev",
        stackName: "FindTheEdge-dev-Foundation",
        secretPrefix: "find-the-edge/dev",
        legacy: true,
      }),
    );
  });

  it.each(["", "production", "qa", "staging-other", "PROD"])(
    "rejects unsupported stage %j",
    (stage) => expect(() => resolveEnvironment(stage)).toThrow(/stage/i),
  );

  it("rejects a release branch that does not own the selected stage", () => {
    expect(resolveEnvironment("staging").branch).toBe("main");
    expect(resolveEnvironment("prod").branch).toBe("production");
    expect(resolveEnvironment("staging").branch).not.toBe(
      resolveEnvironment("prod").branch,
    );
  });

  it("requires an exact product-access setting for persistent stages", () => {
    expect(resolveProductAccessEnforcement("local", undefined)).toBe(false);
    expect(resolveProductAccessEnforcement("staging", "false")).toBe(false);
    expect(resolveProductAccessEnforcement("local", "true")).toBe(true);
    expect(() => resolveProductAccessEnforcement("prod", "true")).toThrow(
      /cutover/i,
    );
    expect(() => resolveProductAccessEnforcement("staging", undefined)).toThrow(
      /required/i,
    );
    for (const value of ["", "1", "TRUE", " false", "false "]) {
      expect(() => resolveProductAccessEnforcement("prod", value)).toThrow(
        /true or false/i,
      );
    }
  });

  it("owns recurring data-plane policy in protected stages without breaking legacy dev", () => {
    expect(resolveRecurringDataPlaneEnabled("staging", undefined)).toBe(false);
    expect(resolveRecurringDataPlaneEnabled("staging", "false")).toBe(false);
    expect(resolveRecurringDataPlaneEnabled("prod", undefined)).toBe(true);
    expect(resolveRecurringDataPlaneEnabled("prod", "true")).toBe(true);
    expect(resolveRecurringDataPlaneEnabled("dev", "true")).toBe(true);
    expect(resolveRecurringDataPlaneEnabled("local", undefined)).toBe(false);
    expect(() => resolveRecurringDataPlaneEnabled("staging", "true")).toThrow(
      /must be false for staging/,
    );
    expect(() => resolveRecurringDataPlaneEnabled("prod", "false")).toThrow(
      /must be true for prod/,
    );
    expect(() => resolveRecurringDataPlaneEnabled("local", "TRUE")).toThrow(
      /true or false/,
    );
  });

  it("keeps admin rollout disabled until owner bootstrap is verified", () => {
    const owner = `account:${"a".repeat(64)}`;
    expect(
      resolveAdminAccessConfiguration({
        enabled: undefined,
        ownerAccountId: undefined,
        bootstrapVerified: undefined,
      }),
    ).toEqual({ enabled: false });
    expect(() =>
      resolveAdminAccessConfiguration({
        enabled: "true",
        ownerAccountId: owner,
        bootstrapVerified: undefined,
      }),
    ).toThrow(/fresh bootstrap or verified migration/i);
    expect(
      resolveAdminAccessConfiguration({
        enabled: "true",
        ownerAccountId: owner,
        bootstrapVerified: "true",
      }),
    ).toEqual({
      enabled: true,
      ownerAccountId: owner,
      bootstrapMode: "verified",
    });
    expect(
      resolveAdminAccessConfiguration({
        enabled: "true",
        ownerAccountId: owner,
        bootstrapVerified: "false",
        freshBootstrap: "true",
      }),
    ).toEqual({
      enabled: true,
      ownerAccountId: owner,
      bootstrapMode: "fresh",
    });
    expect(() =>
      resolveAdminAccessConfiguration({
        enabled: "true",
        ownerAccountId: owner,
        bootstrapVerified: "true",
        freshBootstrap: "true",
      }),
    ).toThrow(/fresh or verified/);
    expect(() =>
      resolveAdminAccessConfiguration({
        enabled: "false",
        ownerAccountId: owner,
        bootstrapVerified: "yes",
      }),
    ).toThrow(/BOOTSTRAP_VERIFIED must be true or false/);
  });
});
