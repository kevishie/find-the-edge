import { describe, expect, it } from "vitest";

import { resolveEnvironment } from "./environments";

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
});
