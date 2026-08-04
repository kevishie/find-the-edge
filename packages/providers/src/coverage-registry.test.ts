import { describe, expect, it, vi } from "vitest";

import {
  defaultFeedCoveragePolicies,
  feedCoverageCatalogVersion,
} from "@find-the-edge/config";
import type { FeedCoverageRegistration, SportKey } from "@find-the-edge/domain";

import {
  CoverageRegistryValidationError,
  FeedCoverageRegistry,
  defaultFeedCoverageRegistry,
  fixtureDevelopmentProvider,
} from "./coverage-registry";
import { supportsRequest, type ProviderDescriptor } from "./index";

const sport = (value: string) => value as SportKey;

function inactiveLeague(
  state: "planned" | "disabled",
): FeedCoverageRegistration[] {
  return (["schedule", "odds", "results"] as const).map((capability) => ({
    sportKey: sport("test"),
    leagueKey: "test",
    leagueName: "Test League",
    capability,
    allowlistState: state,
    active: false,
    supportedMarketKeys: [],
    unsupportedReason:
      state === "planned" ? "league-planned" : "league-disabled",
  })) as unknown as FeedCoverageRegistration[];
}

function activeLeague(): FeedCoverageRegistration[] {
  return (["schedule", "odds", "results"] as const).map((capability) => ({
    sportKey: sport("test"),
    leagueKey: "test",
    leagueName: "Test League",
    capability,
    allowlistState: "enabled",
    active: true,
    providerId: "test-provider",
    maturity: "development",
    cadence: { mode: "interval", seconds: 60 },
    quotaEstimate: { requestsPerRun: 1, requestsPerDay: 10 },
    supportedMarketKeys:
      capability === "odds" ? (["market-a"] as [string]) : [],
  })) as FeedCoverageRegistration[];
}

const descriptor: ProviderDescriptor = {
  id: "test-provider",
  displayName: "Test Provider",
  capabilities: ["schedule", "odds", "results"],
  coverage: {
    leagues: [
      {
        sportKey: sport("test"),
        leagueKey: "test",
        capabilities: ["schedule", "odds", "results"],
        marketKeys: ["market-a"],
      },
    ],
  },
  expectedFreshnessSeconds: 60,
  qualityTier: "development",
};

describe("FeedCoverageRegistry", () => {
  it("resolves every default capability and preserves planned reasons", () => {
    for (const league of [
      ["mlb", "mlb"],
      ["soccer", "mls"],
    ] as const) {
      for (const capability of ["schedule", "odds", "results"] as const) {
        expect(
          defaultFeedCoverageRegistry.resolve({
            sportKey: sport(league[0]),
            leagueKey: league[1],
            capability,
          }).supported,
        ).toBe(true);
      }
    }
    for (const league of [
      ["tennis", "atp"],
      ["nfl", "nfl"],
      ["nba", "nba"],
      ["soccer", "international"],
    ] as const) {
      for (const capability of ["schedule", "odds", "results"] as const) {
        expect(
          defaultFeedCoverageRegistry.resolve({
            sportKey: sport(league[0]),
            leagueKey: league[1],
            capability,
          }),
        ).toMatchObject({ supported: false, reason: "league-planned" });
      }
    }
  });

  it("declares canonical spread coverage for MLB and MLS", () => {
    for (const [sportKey, leagueKey] of [
      ["mlb", "mlb"],
      ["soccer", "mls"],
    ] as const) {
      expect(
        defaultFeedCoverageRegistry.resolve({
          sportKey: sport(sportKey),
          leagueKey,
          capability: "odds",
          marketKeys: ["spread"],
        }),
      ).toMatchObject({ supported: true });
    }
    const legacy = defaultFeedCoverageRegistry.resolve({
      sportKey: sport("mlb"),
      leagueKey: "mlb",
      capability: "odds",
      marketKeys: ["run_line"],
    });
    expect(legacy.supported).toBe(true);
    if (!legacy.supported)
      throw new Error("expected canonical legacy coverage");
    expect(legacy.supportedMarketKeys).toContain("spread");
    expect(legacy.supportedMarketKeys).not.toContain("run_line");
    const legacySoccer = defaultFeedCoverageRegistry.resolve({
      sportKey: sport("soccer"),
      leagueKey: "mls",
      capability: "odds",
      marketKeys: ["three_way_moneyline"],
    });
    expect(legacySoccer.supported).toBe(true);
    if (!legacySoccer.supported)
      throw new Error("expected canonical legacy soccer coverage");
    expect(legacySoccer.supportedMarketKeys).toContain("moneyline");
    expect(legacySoccer.supportedMarketKeys).not.toContain(
      "three_way_moneyline",
    );
  });

  it("supports synthetic enabled and disabled leagues with complete policy sets", () => {
    const enabled = new FeedCoverageRegistry("v", activeLeague(), [descriptor]);
    expect(
      enabled.resolve({
        sportKey: sport("test"),
        leagueKey: "test",
        capability: "odds",
        marketKeys: ["market-a"],
      }).supported,
    ).toBe(true);
    const disabled = new FeedCoverageRegistry(
      "v",
      inactiveLeague("disabled"),
      [],
    );
    expect(
      disabled.resolve({
        sportKey: sport("test"),
        leagueKey: "test",
        capability: "results",
      }),
    ).toMatchObject({ supported: false, reason: "league-disabled" });
  });

  it.each(["planned", "disabled"] as const)(
    "allows partial %s league policies and resolves omissions explicitly",
    (state) => {
      const registry = new FeedCoverageRegistry(
        "v",
        inactiveLeague(state).slice(1),
        [],
      );
      expect(
        registry.resolve({
          sportKey: sport("test"),
          leagueKey: "test",
          capability: "schedule",
        }),
      ).toMatchObject({
        supported: false,
        reason: "capability-unavailable",
        allowlistState: state,
      });
      expect(
        registry.resolve({
          sportKey: sport("test"),
          leagueKey: "test",
          capability: "odds",
        }),
      ).toMatchObject({
        supported: false,
        reason: state === "planned" ? "league-planned" : "league-disabled",
      });
    },
  );

  it("allows partial enabled coverage but rejects explicitly inactive enabled policies", () => {
    const partial = new FeedCoverageRegistry("v", activeLeague().slice(1), [
      descriptor,
    ]);
    expect(
      partial.resolve({
        sportKey: sport("test"),
        leagueKey: "test",
        capability: "schedule",
      }),
    ).toMatchObject({
      supported: false,
      reason: "capability-unavailable",
      allowlistState: "enabled",
    });
    expect(
      partial.resolve({
        sportKey: sport("test"),
        leagueKey: "test",
        capability: "odds",
      }).supported,
    ).toBe(true);
    const policies = activeLeague() as unknown as Record<string, unknown>[];
    policies[0] = {
      ...policies[0],
      active: false,
      supportedMarketKeys: [],
      providerId: undefined,
      maturity: undefined,
      cadence: undefined,
      quotaEstimate: undefined,
      unsupportedReason: "capability-unavailable",
    };
    expect(
      () =>
        new FeedCoverageRegistry(
          "v",
          policies as unknown as FeedCoverageRegistration[],
          [descriptor],
        ),
    ).toThrow("explicitly enabled policy must be active");
  });

  it("models markets per exact sport and league pair", () => {
    const multi: ProviderDescriptor = {
      ...descriptor,
      coverage: {
        leagues: [
          descriptor.coverage.leagues[0]!,
          {
            sportKey: sport("test"),
            leagueKey: "other",
            capabilities: ["odds"],
            marketKeys: ["market-b"],
          },
        ],
      },
    };
    expect(
      supportsRequest(multi, "odds", {
        sportKey: sport("test"),
        leagueKey: "test",
        marketKeys: ["market-a"],
      }),
    ).toBe(true);
    expect(
      supportsRequest(multi, "odds", {
        sportKey: sport("test"),
        leagueKey: "test",
        marketKeys: ["market-b"],
      }),
    ).toBe(false);
    const crossed = activeLeague().map((policy) =>
      policy.capability === "odds"
        ? { ...policy, supportedMarketKeys: ["market-b"] as [string] }
        : policy,
    );
    expect(
      () =>
        new FeedCoverageRegistry(
          "v",
          crossed as unknown as FeedCoverageRegistration[],
          [multi],
        ),
    ).toThrow("Provider pair does not cover market market-b");
  });

  it("scopes capabilities per pair and checks every matching pair when league is omitted", () => {
    const pairs: ProviderDescriptor["coverage"]["leagues"] = [
      {
        sportKey: sport("test"),
        leagueKey: "odds-only",
        capabilities: ["odds"],
        marketKeys: ["market-a"],
      },
      {
        sportKey: sport("test"),
        leagueKey: "schedule-only",
        capabilities: ["schedule"],
        marketKeys: [],
      },
    ];
    const provider: ProviderDescriptor = {
      ...descriptor,
      capabilities: ["odds", "schedule"],
      coverage: { leagues: pairs },
    };
    const reversed: ProviderDescriptor = {
      ...provider,
      coverage: { leagues: [...pairs].reverse() },
    };
    for (const candidate of [provider, reversed]) {
      expect(
        supportsRequest(candidate, "schedule", { sportKey: sport("test") }),
      ).toBe(true);
      expect(
        supportsRequest(candidate, "odds", {
          sportKey: sport("test"),
          marketKeys: ["market-a"],
        }),
      ).toBe(true);
      expect(
        supportsRequest(candidate, "odds", {
          sportKey: sport("test"),
          leagueKey: "schedule-only",
        }),
      ).toBe(false);
    }
    const oddsPolicy = activeLeague().filter(
      (policy) => policy.capability === "odds",
    );
    expect(
      () =>
        new FeedCoverageRegistry("v", oddsPolicy, [
          {
            ...provider,
            capabilities: ["schedule"],
            coverage: {
              leagues: [
                {
                  sportKey: sport("test"),
                  leagueKey: "test",
                  capabilities: ["schedule"],
                  marketKeys: [],
                },
              ],
            },
          },
        ]),
    ).toThrow("Provider pair does not support capability odds");
  });

  it("returns false for malformed legacy requests and non-odds markets", () => {
    for (const request of [
      null,
      [],
      { sportKey: "" },
      { sportKey: " test" },
      { sportKey: "test", leagueKey: "" },
      { sportKey: "test", marketKeys: "market-a" },
      { sportKey: "test", marketKeys: [""] },
      { sportKey: "test", marketKeys: ["market-a", "market-a"] },
    ]) {
      expect(() =>
        supportsRequest(descriptor, "odds", request as never),
      ).not.toThrow();
      expect(supportsRequest(descriptor, "odds", request as never)).toBe(false);
    }
    expect(
      supportsRequest(descriptor, "schedule", {
        sportKey: sport("test"),
        marketKeys: ["market-a"],
      }),
    ).toBe(false);
    expect(
      supportsRequest({ ...descriptor, coverage: null as never }, "odds", {
        sportKey: sport("test"),
      }),
    ).toBe(false);
  });

  it.each([
    [null, "request must be an object"],
    [{ sportKey: "", leagueKey: "x", capability: "odds" }, "sportKey"],
    [{ sportKey: "x", leagueKey: " ", capability: "odds" }, "leagueKey"],
    [{ sportKey: "x", leagueKey: "x", capability: "stats" }, "capability"],
    [
      { sportKey: "x", leagueKey: "x", capability: "odds", marketKeys: "x" },
      "marketKeys must be an array",
    ],
    [
      { sportKey: "x", leagueKey: "x", capability: "odds", marketKeys: [""] },
      "marketKeys[0]",
    ],
    [
      {
        sportKey: "x",
        leagueKey: "x",
        capability: "schedule",
        marketKeys: ["x"],
      },
      "Non-odds requests",
    ],
  ])("rejects malformed runtime request %#", (request, message) => {
    expect(() =>
      defaultFeedCoverageRegistry.resolve(request as never),
    ).toThrowError(CoverageRegistryValidationError);
    expect(() => defaultFeedCoverageRegistry.resolve(request as never)).toThrow(
      message,
    );
  });

  it("creates byte-stable reports independent of input ordering and locale", () => {
    const reversedPolicies = [...defaultFeedCoveragePolicies]
      .reverse()
      .map((policy) => ({
        ...policy,
        supportedMarketKeys: [...policy.supportedMarketKeys].reverse(),
      })) as unknown as FeedCoverageRegistration[];
    const reversedProvider = {
      ...fixtureDevelopmentProvider,
      capabilities: [...fixtureDevelopmentProvider.capabilities].reverse(),
      coverage: {
        leagues: [...fixtureDevelopmentProvider.coverage.leagues]
          .reverse()
          .map((league) => ({
            ...league,
            capabilities: [...league.capabilities].reverse(),
            marketKeys: [...league.marketKeys].reverse(),
          })),
      },
    };
    const localeCompare = vi
      .spyOn(String.prototype, "localeCompare")
      .mockImplementation(() => {
        throw new Error("locale-dependent sorting used");
      });
    try {
      const registry = new FeedCoverageRegistry(
        feedCoverageCatalogVersion,
        reversedPolicies,
        [reversedProvider],
      );
      expect(JSON.stringify(registry.report())).toBe(
        JSON.stringify(defaultFeedCoverageRegistry.report()),
      );
    } finally {
      localeCompare.mockRestore();
    }
  });

  it("isolates caller mutation, freezes outputs, and ignores logger failures", () => {
    const policies = activeLeague();
    const providers = [
      {
        ...descriptor,
        coverage: {
          leagues: descriptor.coverage.leagues.map((x) => ({
            ...x,
            capabilities: [...x.capabilities],
            marketKeys: [...x.marketKeys],
          })),
        },
      },
    ];
    const registry = new FeedCoverageRegistry("v", policies, providers, {
      info: () => {
        throw new Error("telemetry down");
      },
      error: () => undefined,
    });
    (policies[1]!.supportedMarketKeys as unknown as string[])[0] = "changed";
    providers[0]!.coverage.leagues[0]!.marketKeys[0] = "changed";
    providers[0]!.coverage.leagues[0]!.capabilities[0] = "injury";
    const resolution = registry.resolve({
      sportKey: sport("test"),
      leagueKey: "test",
      capability: "odds",
      marketKeys: ["market-a"],
    });
    expect(resolution.supported).toBe(true);
    expect(Object.isFrozen(resolution)).toBe(true);
    expect(Object.isFrozen(registry.report().entries)).toBe(true);
  });

  it("rejects malformed construction data and unusable descriptors", () => {
    expect(
      () =>
        new FeedCoverageRegistry(
          "v",
          [
            { ...inactiveLeague("planned")[0], allowlistState: "future" },
          ] as never,
          [],
        ),
    ).toThrow("allowlistState");
    expect(
      () =>
        new FeedCoverageRegistry("v", activeLeague(), [
          { ...descriptor, coverage: { leagues: [] } },
        ]),
    ).toThrow("nonempty array");
    expect(
      () =>
        new FeedCoverageRegistry("v", activeLeague(), [
          {
            ...descriptor,
            coverage: {
              leagues: [
                {
                  sportKey: sport("test"),
                  leagueKey: "test",
                  capabilities: ["odds"],
                  marketKeys: [],
                },
              ],
            },
          },
        ]),
    ).toThrow("requires market coverage");
    expect(
      () =>
        new FeedCoverageRegistry("v", activeLeague(), [
          {
            ...descriptor,
            capabilities: [...descriptor.capabilities, "injury"],
          },
        ]),
    ).toThrow("must equal the union");
    expect(
      () =>
        new FeedCoverageRegistry("v", activeLeague(), [
          {
            ...descriptor,
            capabilities: ["schedule", "odds"],
          },
        ]),
    ).toThrow("must equal the union");
  });
});
