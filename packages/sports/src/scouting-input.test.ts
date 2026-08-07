import type { SportKey } from "@find-the-edge/domain";
import { describe, expect, it } from "vitest";

import { mlbModule } from "./mlb/definition";
import {
  nbaModule,
  ncaafModule,
  nflModule,
  tennisModule,
} from "./planned/definitions";
import { sportRegistry } from "./registry";
import {
  defineSportScoutingInputContract,
  scoutingCapabilityInstances,
  type SportScoutingFactValidationContext,
  type SportScoutingInputContract,
} from "./shared/scouting-input";
import { soccerModule } from "./soccer/definition";
import {
  soccerScoutingInputContract,
  type SoccerLineupState,
} from "./soccer/scouting-input";

function schema(capabilityKey: string, factKey: string, variant?: string) {
  const capability = soccerScoutingInputContract.capabilities.find(
    (candidate) => candidate.key === capabilityKey,
  );
  expect(capability).toBeDefined();
  const fact = capability?.facts.find(
    (candidate) => candidate.key === factKey && candidate.variant === variant,
  );
  expect(fact).toBeDefined();
  return fact!;
}

function soccerContext(
  input: Partial<SportScoutingFactValidationContext> = {},
): SportScoutingFactValidationContext {
  return {
    sportKey: "soccer" as SportKey,
    leagueKey: "mls",
    participantIds: ["home", "away"],
    capabilityFacts: [],
    ...input,
  };
}

function lineupMembers(participantId: string, first = 1): string[] {
  return Array.from(
    { length: 11 },
    (_, index) => `${participantId}.player-${first + index}`,
  );
}

function rawContract(): SportScoutingInputContract {
  return {
    schemaId: "scout-input/runtime-validation",
    schemaVersion: "1",
    sportKey: "runtime-validation" as SportKey,
    participantCardinality: { minimum: 2, maximum: 2 },
    capabilities: [
      {
        key: "context",
        required: true,
        scope: "event",
        availability: "evidence",
        facts: [
          {
            key: "value",
            required: true,
            cardinality: "one",
            subjectScope: "event",
            maximumAgeMilliseconds: 1_000,
            validateValue: (value) => ({
              valid: typeof value === "string",
              value,
              errors: typeof value === "string" ? [] : ["string-required"],
            }),
          },
        ],
      },
    ],
  };
}

describe("sport-owned scouting input contracts", () => {
  it("publishes a frozen, versioned contract from every registered module", () => {
    for (const module of sportRegistry.list()) {
      const contract = module.scoutingInputContract;

      expect(contract.sportKey).toBe(module.key);
      expect(contract.schemaId).toMatch(/^scout-input\//u);
      expect(contract.schemaVersion).toMatch(/^\d+/u);
      expect(contract.capabilities.length).toBeGreaterThan(0);
      expect(Object.isFrozen(contract)).toBe(true);
      expect(Object.isFrozen(contract.participantCardinality)).toBe(true);
      expect(Object.isFrozen(contract.capabilities)).toBe(true);
      for (const capability of contract.capabilities) {
        expect(Object.isFrozen(capability)).toBe(true);
        expect(Object.isFrozen(capability.facts)).toBe(true);
        for (const fact of capability.facts) {
          expect(Object.isFrozen(fact)).toBe(true);
          expect(typeof fact.validateValue).toBe("function");
        }
      }
    }
  });

  it("keeps the soccer required manifest and semantics in the soccer module", () => {
    expect(soccerModule.scoutingInputContract).toBe(
      soccerScoutingInputContract,
    );
    expect(
      soccerScoutingInputContract.capabilities.map(
        ({ key, required, scope, availability }) => ({
          key,
          required,
          scope,
          availability,
        }),
      ),
    ).toEqual([
      {
        key: "fixture",
        required: true,
        scope: "event",
        availability: "evidence",
      },
      {
        key: "venue",
        required: true,
        scope: "event",
        availability: "evidence",
      },
      {
        key: "team-roster-profile",
        required: true,
        scope: "participant",
        availability: "evidence",
      },
      {
        key: "lineup",
        required: true,
        scope: "participant",
        availability: "evidence",
      },
      {
        key: "injury-suspension",
        required: true,
        scope: "event",
        availability: "evidence",
      },
      {
        key: "statistics",
        required: true,
        scope: "participant",
        availability: "evidence",
      },
    ]);

    const lineupStates: readonly SoccerLineupState[] = [
      "predicted",
      "probable",
      "confirmed",
    ];
    expect(
      soccerScoutingInputContract.capabilities
        .find(({ key }) => key === "lineup")
        ?.facts.map(({ variant }) => variant),
    ).toEqual(lineupStates);
    expect(schema("lineup", "starting-lineup", "probable").required).toBe(
      false,
    );
  });

  it("executes strict soccer value schemas and rejects malformed values", () => {
    expect(
      schema("fixture", "competition-context").validateValue(
        { competitionKey: "mls" },
        soccerContext(),
      ),
    ).toMatchObject({ valid: true });
    expect(
      schema("fixture", "competition-context").validateValue(
        {
          competitionKey: "mls",
          providerFixtureId: "must-not-leak",
        },
        soccerContext(),
      ),
    ).toMatchObject({ valid: false });
    expect(
      schema("fixture", "competition-context").validateValue(
        { competitionKey: "epl" },
        soccerContext(),
      ),
    ).toMatchObject({ valid: false });

    const lineup = schema("lineup", "starting-lineup", "confirmed");
    expect(
      lineup.validateValue(
        { memberIds: lineupMembers("home") },
        soccerContext({ capabilitySubjectId: "home" }),
      ),
    ).toMatchObject({ valid: true });
    expect(
      lineup.validateValue(
        { memberIds: [...lineupMembers("home")].reverse() },
        soccerContext({ capabilitySubjectId: "home" }),
      ).value,
    ).toEqual({ memberIds: [...lineupMembers("home")].sort() });
    expect(
      lineup.validateValue(
        { memberIds: ["home.player-1", "home.player-1"] },
        soccerContext({ capabilitySubjectId: "home" }),
      ),
    ).toMatchObject({ valid: false });
    expect(
      lineup.validateValue(
        { memberIds: ["away.player-1"] },
        soccerContext({ capabilitySubjectId: "home" }),
      ),
    ).toMatchObject({ valid: false });
    expect(
      lineup.validateValue(
        { memberIds: [] },
        soccerContext({ capabilitySubjectId: "home" }),
      ),
    ).toMatchObject({ valid: false });
    expect(
      lineup.validateValue(
        { memberIds: "home.player-1" },
        soccerContext({ capabilitySubjectId: "home" }),
      ),
    ).toMatchObject({ valid: false });

    const roster = schema("team-roster-profile", "active-members");
    expect(
      roster.validateValue(
        { memberIds: ["home.player-1"] },
        soccerContext({ capabilitySubjectId: "home" }),
      ),
    ).toMatchObject({ valid: true });
    expect(
      roster.validateValue(
        { memberIds: [] },
        soccerContext({ capabilitySubjectId: "home" }),
      ),
    ).toMatchObject({ valid: false });
    expect(
      roster.validateValue(
        { memberIds: ["club.reserve.player-1"] },
        soccerContext({
          participantIds: ["club", "club.reserve"],
          capabilitySubjectId: "club",
        }),
      ),
    ).toMatchObject({ valid: false });
    expect(
      roster.validateValue(
        { memberIds: ["club.reserve.player-1"] },
        soccerContext({
          participantIds: ["club", "club.reserve"],
          capabilitySubjectId: "club.reserve",
        }),
      ),
    ).toMatchObject({ valid: true });
    expect(
      roster.validateValue(
        { memberIds: ["away.player-1"] },
        soccerContext({ capabilitySubjectId: "home" }),
      ),
    ).toMatchObject({ valid: false });
    expect(
      roster.validateValue(
        { memberIds: ["home.player-John Doe"] },
        soccerContext({ capabilitySubjectId: "home" }),
      ),
    ).toMatchObject({ valid: false });

    const injury = schema("injury-suspension", "feed-status");
    expect(
      injury.validateValue(
        { covered: true, reportedCount: 0 },
        soccerContext(),
      ),
    ).toMatchObject({ valid: true });
    expect(
      injury.validateValue(
        { covered: false, reportedCount: 0 },
        soccerContext(),
      ),
    ).toMatchObject({ valid: false });
    expect(
      injury.validateValue(
        { covered: true, reportedCount: 1 },
        soccerContext(),
      ),
    ).toMatchObject({ valid: false });
    expect(
      injury.validateValue(
        { covered: true, reportedCount: 1 },
        soccerContext({
          capabilityFacts: [
            {
              schemaKey: "player-availability",
              subjectId: "home.player-1",
              status: "resolved",
            },
            {
              schemaKey: "player-availability",
              subjectId: "away.player-2",
              status: "unavailable",
            },
          ],
        }),
      ),
    ).toMatchObject({ valid: true });

    const playerAvailability = schema(
      "injury-suspension",
      "player-availability",
    );
    expect(
      playerAvailability.validateSubject?.({
        subjectId: "home.player-1",
        participantIds: ["home", "away"],
      }),
    ).toBe(true);
    expect(
      playerAvailability.validateSubject?.({
        subjectId: "outsider.player-1",
        participantIds: ["home", "away"],
      }),
    ).toBe(false);

    const statistics = schema("statistics", "team-form-summary");
    expect(
      statistics.validateValue(
        { matches: 5, points: 11 },
        soccerContext({ capabilitySubjectId: "home" }),
      ),
    ).toMatchObject({ valid: true });
    expect(
      statistics.validateValue(
        { matches: 5, points: Number.NaN },
        soccerContext({ capabilitySubjectId: "home" }),
      ),
    ).toMatchObject({ valid: false });
    expect(
      statistics.validateValue(
        {
          matches: 5,
          points: Number.POSITIVE_INFINITY,
        },
        soccerContext({ capabilitySubjectId: "home" }),
      ),
    ).toMatchObject({ valid: false });
    expect(
      statistics.validateValue(
        { matches: 5, points: 16 },
        soccerContext({ capabilitySubjectId: "home" }),
      ),
    ).toMatchObject({ valid: false });
    expect(
      statistics.validateValue(
        { matches: 5, points: 10.5 },
        soccerContext({ capabilitySubjectId: "home" }),
      ),
    ).toMatchObject({ valid: false });
  });

  it("requires exactly eleven unique participant-bound members for every lineup state", () => {
    for (const variant of ["predicted", "probable", "confirmed"] as const) {
      const lineup = schema("lineup", "starting-lineup", variant);
      expect(
        lineup.validateValue(
          { memberIds: lineupMembers("home") },
          soccerContext({ capabilitySubjectId: "home" }),
        ),
      ).toMatchObject({ valid: true });
      expect(
        lineup.validateValue(
          { memberIds: lineupMembers("home").slice(0, 10) },
          soccerContext({ capabilitySubjectId: "home" }),
        ),
      ).toMatchObject({ valid: false });
    }
  });

  it("rejects malformed contract arrays, booleans, enums, and functions", () => {
    const cases: unknown[] = [
      { ...rawContract(), capabilities: {} },
      {
        ...rawContract(),
        capabilities: [{ ...rawContract().capabilities[0], required: "true" }],
      },
      {
        ...rawContract(),
        capabilities: [{ ...rawContract().capabilities[0], scope: "team" }],
      },
      {
        ...rawContract(),
        capabilities: [
          { ...rawContract().capabilities[0], availability: "possible" },
        ],
      },
      {
        ...rawContract(),
        capabilities: [{ ...rawContract().capabilities[0], facts: {} }],
      },
      {
        ...rawContract(),
        capabilities: [
          {
            ...rawContract().capabilities[0],
            facts: [
              { ...rawContract().capabilities[0]!.facts[0], required: 1 },
            ],
          },
        ],
      },
      {
        ...rawContract(),
        capabilities: [
          {
            ...rawContract().capabilities[0],
            facts: [
              {
                ...rawContract().capabilities[0]!.facts[0],
                cardinality: "some",
              },
            ],
          },
        ],
      },
      {
        ...rawContract(),
        capabilities: [
          {
            ...rawContract().capabilities[0],
            facts: [
              {
                ...rawContract().capabilities[0]!.facts[0],
                subjectScope: "player",
              },
            ],
          },
        ],
      },
      {
        ...rawContract(),
        capabilities: [
          {
            ...rawContract().capabilities[0],
            facts: [
              {
                ...rawContract().capabilities[0]!.facts[0],
                validateValue: true,
              },
            ],
          },
        ],
      },
    ];

    for (const input of cases) {
      expect(() =>
        defineSportScoutingInputContract(input as SportScoutingInputContract),
      ).toThrow();
    }
  });

  it("requires a subject validator for every entity-scoped fact", () => {
    const contract = rawContract();
    const fact = contract.capabilities[0]!.facts[0]!;
    const entityFact = { ...fact, subjectScope: "entity" as const };

    expect(() =>
      defineSportScoutingInputContract({
        ...contract,
        capabilities: [
          {
            ...contract.capabilities[0]!,
            facts: [entityFact],
          },
        ],
      }),
    ).toThrow("scouting-fact-schema-invalid");

    expect(
      defineSportScoutingInputContract({
        ...contract,
        capabilities: [
          {
            ...contract.capabilities[0]!,
            facts: [
              {
                ...entityFact,
                validateSubject: ({ subjectId }) => subjectId.length > 0,
              },
            ],
          },
        ],
      }).capabilities[0]?.facts[0]?.subjectScope,
    ).toBe("entity");
  });

  it("rejects impossible scopes and contracts that exceed the envelope expansion", () => {
    const base = rawContract();
    const baseCapability = base.capabilities[0]!;
    const baseFact = baseCapability.facts[0]!;
    expect(() =>
      defineSportScoutingInputContract({
        ...base,
        capabilities: [
          {
            ...baseCapability,
            scope: "participant",
            facts: [baseFact],
          },
        ],
      }),
    ).toThrow("scouting-fact-scope-invalid");
    expect(() =>
      defineSportScoutingInputContract({
        ...base,
        capabilities: [
          {
            ...baseCapability,
            facts: [{ ...baseFact, subjectScope: "capability-instance" }],
          },
        ],
      }),
    ).toThrow("scouting-fact-scope-invalid");

    expect(() =>
      defineSportScoutingInputContract({
        ...base,
        participantCardinality: { minimum: 1, maximum: 256 },
        capabilities: Array.from({ length: 17 }, (_, index) => ({
          ...baseCapability,
          key: `participant-capability-${index}`,
          scope: "participant" as const,
          facts: [
            { ...baseFact, subjectScope: "capability-instance" as const },
          ],
        })),
      }),
    ).toThrow("scouting-contract-expansion-invalid");

    expect(() =>
      defineSportScoutingInputContract({
        ...base,
        participantCardinality: { minimum: 1, maximum: 256 },
        capabilities: [
          {
            ...baseCapability,
            scope: "participant",
            facts: Array.from({ length: 17 }, (_, index) => ({
              ...baseFact,
              key: `participant-fact-${index}`,
              subjectScope: "capability-instance" as const,
            })),
          },
        ],
      }),
    ).toThrow("scouting-contract-expansion-invalid");
  });

  it("fails safely on cyclic and accessor-bearing contracts without invoking getters", () => {
    const cyclic = rawContract() as SportScoutingInputContract & {
      cycle?: unknown;
    };
    cyclic.cycle = cyclic;
    expect(() => defineSportScoutingInputContract(cyclic)).toThrow(
      "scouting-contract-plain-data-invalid",
    );

    let invoked = false;
    const accessor = rawContract() as unknown as Record<string, unknown>;
    Object.defineProperty(accessor, "capabilities", {
      enumerable: true,
      get: () => {
        invoked = true;
        return [];
      },
    });
    expect(() =>
      defineSportScoutingInputContract(
        accessor as unknown as SportScoutingInputContract,
      ),
    ).toThrow("scouting-contract-plain-data-invalid");
    expect(invoked).toBe(false);
  });

  it("keeps MLB and planned modules honestly unavailable-only", () => {
    for (const module of [
      mlbModule,
      tennisModule,
      nflModule,
      nbaModule,
      ncaafModule,
    ]) {
      expect(module.scoutingInputContract.capabilities).toHaveLength(
        module.requiredDataInputs.length,
      );
      expect(
        module.scoutingInputContract.capabilities.map(({ key }) => key),
      ).toEqual(module.requiredDataInputs);
      for (const capability of module.scoutingInputContract.capabilities) {
        expect(capability).toMatchObject({
          required: true,
          availability: "unavailable-only",
        });
        expect(capability.facts).toHaveLength(1);
        expect(capability.facts[0]).toMatchObject({
          key: "availability",
          required: true,
          cardinality: "one",
        });
        expect(
          capability.facts[0]?.validateValue(
            { available: true },
            soccerContext({ sportKey: module.key }),
          ),
        ).toEqual({
          valid: false,
          errors: ["Capability is not implemented"],
        });
      }
    }
  });

  it("expands generic participant capabilities for arbitrary cardinality", () => {
    const contract = defineSportScoutingInputContract({
      schemaId: "scout-input/test-three-participant",
      schemaVersion: "7",
      sportKey: "test-three-participant" as SportKey,
      participantCardinality: { minimum: 1, maximum: 4 },
      capabilities: [
        {
          key: "event-context",
          required: true,
          scope: "event",
          availability: "evidence",
          facts: [
            {
              key: "event-value",
              required: true,
              cardinality: "one",
              subjectScope: "event",
              maximumAgeMilliseconds: 1_000,
              validateValue: (value) => ({
                valid: typeof value === "boolean",
                value,
                errors:
                  typeof value === "boolean" ? [] : ["Boolean is required"],
              }),
            },
          ],
        },
        {
          key: "participant-context",
          required: true,
          scope: "participant",
          availability: "evidence",
          facts: [
            {
              key: "participant-score",
              required: true,
              cardinality: "one",
              subjectScope: "capability-instance",
              maximumAgeMilliseconds: 1_000,
              validateValue: (value) => ({
                valid: typeof value === "number",
                value,
                errors: typeof value === "number" ? [] : ["Number is required"],
              }),
            },
          ],
        },
      ],
    });

    expect(
      scoutingCapabilityInstances(contract, ["alpha", "beta", "gamma"]),
    ).toEqual([
      { capabilityKey: "event-context" },
      { capabilityKey: "participant-context", subjectId: "alpha" },
      { capabilityKey: "participant-context", subjectId: "beta" },
      { capabilityKey: "participant-context", subjectId: "gamma" },
    ]);
    expect(() =>
      scoutingCapabilityInstances(contract, ["alpha", "alpha"]),
    ).toThrow("scouting-participant-cardinality-invalid");
    expect(() => scoutingCapabilityInstances(contract, [])).toThrow(
      "scouting-participant-cardinality-invalid",
    );
  });

  it("restricts tennis scouting events to singles or doubles", () => {
    expect(() =>
      scoutingCapabilityInstances(tennisModule.scoutingInputContract, [
        "player-a",
        "player-b",
        "player-c",
      ]),
    ).toThrow("scouting-participant-cardinality-invalid");
    expect(
      scoutingCapabilityInstances(tennisModule.scoutingInputContract, [
        "player-a",
        "player-b",
        "player-c",
        "player-d",
      ]),
    ).toHaveLength(tennisModule.requiredDataInputs.length);
  });
});
