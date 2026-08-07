import type { SportKey } from "@find-the-edge/domain";
import {
  defineSportScoutingInputContract,
  soccerModule,
} from "@find-the-edge/sports";
import { describe, expect, it } from "vitest";

import {
  ScoutingInputValidationError,
  validateScoutingInput,
  type ScoutingInputSourceAuthorization,
} from "./scouting-input";

const sportKey = "test-sport" as SportKey;
const contract = defineSportScoutingInputContract({
  schemaId: "scout-input/test-sport",
  schemaVersion: "1",
  sportKey,
  participantCardinality: { minimum: 2, maximum: 2 },
  capabilities: [
    {
      key: "fixture-note",
      required: true,
      scope: "event",
      availability: "evidence",
      facts: [
        {
          key: "note",
          required: true,
          cardinality: "one",
          subjectScope: "event",
          maximumAgeMilliseconds: 1_000,
          validateValue: (value) =>
            typeof value === "string" && value.startsWith("valid-")
              ? { valid: true, value, errors: [] }
              : { valid: false, errors: ["invalid note"] },
        },
        {
          key: "basis-note",
          required: false,
          cardinality: "one",
          subjectScope: "event",
          maximumAgeMilliseconds: 1_000,
          validateValue: (value) =>
            typeof value === "string" && value.startsWith("valid-")
              ? { valid: true, value, errors: [] }
              : { valid: false, errors: ["invalid basis note"] },
        },
      ],
    },
  ],
});
const module = {
  ...soccerModule,
  key: sportKey,
  metadata: { ...soccerModule.metadata, supportedLeagues: ["test-league"] },
  scoutingInputContract: contract,
};
const event = {
  canonicalEventId: "event-1",
  canonicalEventVersion: "v1",
  sportKey,
  leagueKey: "test-league",
  startsAt: "2026-08-07T21:00:00.000Z",
  participantIds: ["participant-a", "participant-b"],
};
const providerSource: ScoutingInputSourceAuthorization = {
  id: "approved-provider-source",
  providerId: "provider-1",
  maturity: "production",
  productionEligible: true,
  sourceKind: "provider",
  sportKey,
  competitionKeys: ["test-league"],
  capabilities: ["fixture-note"],
  evidenceReferencePrefixes: ["s3://retained/provider-1/"],
};

function observation(overrides: Record<string, unknown> = {}) {
  return {
    id: "observation-1",
    capabilityKey: "fixture-note",
    providerId: "provider-1",
    providerTimestamp: "2026-08-07T20:00:00.000Z",
    collectedAt: "2026-08-07T20:00:00.100Z",
    evidenceReference: {
      kind: "retained-reference",
      reference: `s3://retained/provider-1/${"a".repeat(64)}`,
      contentHash: "a".repeat(64),
    },
    revision: { providerRevision: "revision-1", providerOrdinal: 1 },
    ...overrides,
  };
}

function fact(overrides: Record<string, unknown> = {}) {
  return Object.fromEntries(
    Object.entries({
      id: "fact-1",
      capabilityKey: "fixture-note",
      schemaKey: "note",
      state: "verified",
      value: "valid-note",
      observationIds: ["observation-1"],
      observedAt: "2026-08-07T20:00:00.100Z",
      confidence: 1,
      ...overrides,
    }).filter(([, value]) => value !== undefined),
  );
}

function envelope(overrides: Record<string, unknown> = {}) {
  return {
    schemaId: "find-the-edge.scouting-input",
    schemaVersion: "1.0.0",
    moduleSchema: { id: contract.schemaId, version: contract.schemaVersion },
    event,
    coverage: [
      {
        capabilityKey: "fixture-note",
        status: "available",
        observationIds: ["observation-1"],
      },
    ],
    observations: [observation()],
    facts: [fact()],
    ...overrides,
  };
}

function validate(input: unknown, evaluatedAt = "2026-08-07T20:00:01.000Z") {
  return validateScoutingInput(input, {
    canonicalEvent: event,
    evaluatedAt,
    environment: "production",
    module,
    sourceAuthorization: providerSource,
  });
}

describe("scouting input consumer contract", () => {
  it("derives eligibility from trusted authorization and rejects caller assertions", () => {
    expect(validate(envelope()).source.productionEligible).toBe(true);
    expect(() => validate({ ...envelope(), mode: "provider" })).toThrow(
      "unknown or missing fields",
    );
    expect(() => validate({ ...envelope(), productionEligible: true })).toThrow(
      "unknown or missing fields",
    );
    expect(() =>
      validateScoutingInput(envelope(), {
        canonicalEvent: event,
        evaluatedAt: "2026-08-07T20:00:01.000Z",
        environment: "production",
        module,
        sourceAuthorization: {
          ...providerSource,
          maturity: "development",
          productionEligible: false,
        },
      }),
    ).toThrow("production requires an eligible provider");
  });

  it("requires immutable retained references and canonical event identity", () => {
    expect(() =>
      validate(
        envelope({
          observations: [
            observation({
              evidenceReference: {
                kind: "retained-reference",
                reference: "s3://retained/mutable.json",
              },
            }),
          ],
        }),
      ),
    ).toThrow("retained references require immutable content hashes");
    expect(() =>
      validateScoutingInput(envelope(), {
        canonicalEvent: { ...event, canonicalEventVersion: "v2" },
        evaluatedAt: "2026-08-07T20:00:01.000Z",
        environment: "production",
        module,
        sourceAuthorization: providerSource,
      }),
    ).toThrow("event does not match trusted canonical event");
  });

  it("authorizes every content-addressed evidence locator against its source", () => {
    const hash = "a".repeat(64);
    expect(
      validateScoutingInput(
        envelope({
          observations: [
            observation({
              evidenceReference: {
                kind: "retained-reference",
                reference: `sha256://${hash}`,
                contentHash: hash,
              },
            }),
          ],
        }),
        {
          canonicalEvent: event,
          evaluatedAt: "2026-08-07T20:00:01.000Z",
          environment: "production",
          module,
          sourceAuthorization: {
            ...providerSource,
            evidenceReferencePrefixes: ["sha256://"],
          },
        },
      ).observations[0]?.evidenceReference.reference,
    ).toBe(`sha256://${hash}`);
    expect(() =>
      validate(
        envelope({
          observations: [
            observation({
              evidenceReference: {
                kind: "retained-reference",
                reference: `s3://another-source/${hash}`,
                contentHash: hash,
              },
            }),
          ],
        }),
      ),
    ).toThrow("observation reference is not authorized for its source");
    expect(() =>
      validate(
        envelope({
          observations: [
            observation({
              evidenceReference: {
                kind: "retained-reference",
                reference: `s3://retained/provider-1/${hash}/mutable.json`,
                contentHash: hash,
              },
            }),
          ],
        }),
      ),
    ).toThrow("retained reference key must end with its content hash");

    expect(() =>
      validateScoutingInput(
        envelope({
          observations: [
            observation({
              evidenceReference: {
                kind: "synthetic-fixture",
                reference: "synthetic://",
              },
              revision: { collectorSequence: 1 },
            }),
          ],
        }),
        {
          canonicalEvent: event,
          evaluatedAt: "2026-08-07T20:00:01.000Z",
          environment: "test",
          module,
          sourceAuthorization: {
            ...providerSource,
            maturity: "development",
            productionEligible: false,
            sourceKind: "synthetic-fixture",
            evidenceReferencePrefixes: ["synthetic://trusted/"],
          },
        },
      ),
    ).toThrow("synthetic references must use synthetic:// and no content hash");
  });

  it("requires exactly one coverage record and required fact per manifest instance", () => {
    expect(() => validate(envelope({ coverage: [] }))).toThrow(
      "coverage must be a nonempty bounded array",
    );
    expect(() =>
      validate(envelope({ facts: [fact({ schemaKey: "unknown" })] })),
    ).toThrow("fact schema is not declared by the module");
    expect(() =>
      validate(envelope({ facts: [fact({ value: "malformed" })] })),
    ).toThrow("violates sport schema");
  });

  it("uses the oldest authoritative origin with exact millisecond boundaries", () => {
    const exactlyCurrent = validate(envelope(), "2026-08-07T20:00:01.000Z");
    expect(exactlyCurrent.facts[0]?.freshness).toEqual({
      status: "current",
      originAt: "2026-08-07T20:00:00.000Z",
      ageMilliseconds: 1_000,
    });
    expect(() => validate(envelope(), "2026-08-07T20:00:01.001Z")).toThrow(
      "verified fact must be fresh",
    );
    const stale = validate(
      envelope({ facts: [fact({ state: "stale", confidence: 0.8 })] }),
      "2026-08-07T20:00:01.001Z",
    );
    expect(stale.facts[0]?.freshness.ageMilliseconds).toBe(1_001);
    expect(() =>
      validate(
        envelope({
          observations: [
            observation({
              providerTimestamp: "2026-08-07T20:00:01.001Z",
            }),
          ],
        }),
      ),
    ).toThrow("provider timestamp must not follow collection or evaluation");
  });

  it("preserves unavailable-fact provenance", () => {
    const normalized = validate(
      envelope({
        coverage: [
          {
            capabilityKey: "fixture-note",
            status: "unavailable",
            unavailableReason: "provider-outage",
            observationIds: ["observation-1"],
          },
        ],
        facts: [
          fact({
            state: "unavailable",
            value: undefined,
            observedAt: undefined,
            unavailableReason: "provider-outage",
            confidence: 0,
          }),
        ],
      }),
    );
    expect(normalized.facts[0]?.freshness).toEqual({ status: "unavailable" });
    expect(normalized.facts[0]?.provenance[0]?.id).toBe("observation-1");
  });

  it("accepts retroactive corrections ordered by revision instead of timestamp", () => {
    const normalized = validate(
      envelope({
        coverage: [
          {
            capabilityKey: "fixture-note",
            status: "available",
            observationIds: ["observation-1", "observation-2"],
          },
        ],
        observations: [
          observation(),
          observation({
            id: "observation-2",
            providerTimestamp: "2026-08-07T19:59:59.900Z",
            evidenceReference: {
              kind: "retained-reference",
              reference: `s3://retained/provider-1/${"b".repeat(64)}`,
              contentHash: "b".repeat(64),
            },
            revision: { providerRevision: "revision-2", providerOrdinal: 2 },
            supersedesObservationId: "observation-1",
          }),
        ],
        facts: [
          fact({
            observationIds: ["observation-2"],
            observedAt: "2026-08-07T20:00:00.100Z",
          }),
        ],
      }),
      "2026-08-07T20:00:00.900Z",
    );
    expect(normalized.observations).toHaveLength(2);
    expect(normalized.facts[0]?.freshness.originAt).toBe(
      "2026-08-07T19:59:59.900Z",
    );
    expect(normalized.facts[0]?.provenance.map((item) => item.id)).toEqual([
      "observation-2",
    ]);
    expect(() =>
      validate(
        envelope({
          coverage: [
            {
              capabilityKey: "fixture-note",
              status: "available",
              observationIds: ["observation-1", "observation-2"],
            },
          ],
          observations: [
            observation(),
            observation({
              id: "observation-2",
              evidenceReference: {
                kind: "retained-reference",
                reference: `s3://retained/provider-1/${"b".repeat(64)}`,
                contentHash: "b".repeat(64),
              },
              revision: { providerRevision: "revision-2", providerOrdinal: 2 },
              supersedesObservationId: "observation-1",
            }),
          ],
          facts: [fact({ observationIds: ["observation-1"] })],
        }),
      ),
    ).toThrow("resolved fact must cite the latest usable stream evidence");
  });

  it("quarantines same-revision contradictions and permits only conflict evidence", () => {
    const normalized = validate(
      envelope({
        coverage: [
          {
            capabilityKey: "fixture-note",
            status: "partial",
            observationIds: ["observation-1", "observation-2"],
          },
        ],
        observations: [
          observation(),
          observation({
            id: "observation-2",
            evidenceReference: {
              kind: "retained-reference",
              reference: `s3://retained/provider-1/${"b".repeat(64)}`,
              contentHash: "b".repeat(64),
            },
          }),
        ],
        facts: [
          fact({
            state: "conflicting",
            value: undefined,
            observedAt: undefined,
            confidence: 0,
            observationIds: ["observation-1", "observation-2"],
            conflict: {
              alternatives: [
                { value: "valid-a", observationIds: ["observation-1"] },
                { value: "valid-b", observationIds: ["observation-2"] },
              ],
            },
          }),
        ],
      }),
    );
    expect(normalized.observations.every((item) => item.quarantined)).toBe(
      true,
    );
    expect(normalized.facts[0]?.state).toBe("conflicting");
  });

  it("produces a deterministic immutable hash", () => {
    const left = validate(envelope());
    const right = validate(
      envelope({
        observations: [observation()],
        facts: [fact()],
      }),
    );
    expect(left.inputHash).toBe(right.inputHash);
    expect(Object.isFrozen(left)).toBe(true);
    expect(Object.isFrozen(left.facts[0]?.provenance[0])).toBe(true);
  });

  it("reads array indexes as data descriptors and rejects every extra key", () => {
    let accessorInvoked = false;
    const accessorCoverage: unknown[] = [];
    Object.defineProperty(accessorCoverage, "0", {
      enumerable: true,
      get: () => {
        accessorInvoked = true;
        return envelope().coverage[0];
      },
    });
    accessorCoverage.length = 1;
    expect(() => validate(envelope({ coverage: accessorCoverage }))).toThrow(
      "payload must be bounded plain JSON",
    );
    expect(accessorInvoked).toBe(false);

    const overriddenMap = [...envelope().facts];
    Object.defineProperty(overriddenMap, "map", {
      enumerable: true,
      value: () => {
        throw new Error("must-not-run");
      },
    });
    expect(() => validate(envelope({ facts: overriddenMap }))).toThrow(
      "payload must be bounded plain JSON",
    );

    const noncanonicalIndex = [...envelope().observations];
    Object.defineProperty(noncanonicalIndex, "01", {
      enumerable: true,
      value: observation(),
    });
    expect(() =>
      validate(envelope({ observations: noncanonicalIndex })),
    ).toThrow("payload must be bounded plain JSON");
  });

  it("rejects unknown runtime environments and mismatched sha256 references", () => {
    expect(() =>
      validateScoutingInput(envelope(), {
        canonicalEvent: event,
        evaluatedAt: "2026-08-07T20:00:01.000Z",
        environment: "preview" as never,
        module,
        sourceAuthorization: providerSource,
      }),
    ).toThrow("runtime environment is invalid");
    expect(() =>
      validate(
        envelope({
          observations: [
            observation({
              evidenceReference: {
                kind: "retained-reference",
                reference: `sha256://${"b".repeat(64)}`,
                contentHash: "a".repeat(64),
              },
            }),
          ],
        }),
      ),
    ).toThrow("sha256 retained reference must match its content hash");
  });

  it("preserves opaque provider revisions while ordering by numeric ordinals", () => {
    const corrected = validate(
      envelope({
        coverage: [
          {
            capabilityKey: "fixture-note",
            status: "available",
            observationIds: ["observation-1", "observation-2"],
          },
        ],
        observations: [
          observation({
            revision: {
              providerRevision: 'W/"etag/+== one"',
              providerOrdinal: 1,
            },
          }),
          observation({
            id: "observation-2",
            evidenceReference: {
              kind: "retained-reference",
              reference: `s3://retained/provider-1/${"b".repeat(64)}`,
              contentHash: "b".repeat(64),
            },
            revision: {
              providerRevision: "a-opaque",
              providerOrdinal: 2,
            },
            supersedesObservationId: "observation-1",
          }),
        ],
        facts: [fact({ observationIds: ["observation-2"] })],
      }),
    );
    expect(corrected.observations.map((item) => item.id)).toEqual([
      "observation-1",
      "observation-2",
    ]);
    expect(corrected.observations[0]?.revision.providerRevision).toBe(
      'W/"etag/+== one"',
    );
    expect(() =>
      validate(
        envelope({
          observations: [
            observation({ revision: { providerToken: "opaque" } }),
          ],
        }),
      ),
    ).toThrow("payload must be bounded plain JSON");
    expect(() =>
      validate(
        envelope({
          observations: [
            observation({
              revision: { providerRevision: "missing-ordinal" },
            }),
          ],
        }),
      ),
    ).toThrow("provider revision and ordinal must be paired");
  });

  it("pairs provider entity identity fields and preserves opaque entity ids", () => {
    const opaqueEntityId = ' external/entity +/== "v1" ';
    const normalized = validate(
      envelope({
        observations: [
          observation({
            providerEntityType: "fixture-note",
            providerEntityId: opaqueEntityId,
          }),
        ],
      }),
    );
    expect(normalized.observations[0]?.providerEntityId).toBe(opaqueEntityId);
    expect(() =>
      validate(
        envelope({
          observations: [observation({ providerEntityType: "fixture-note" })],
        }),
      ),
    ).toThrow("provider entity type and id must be paired");
    expect(() =>
      validate(
        envelope({
          observations: [observation({ providerEntityId: opaqueEntityId })],
        }),
      ),
    ).toThrow("provider entity type and id must be paired");
    expect(() =>
      validate(
        envelope({
          observations: [
            observation({
              providerEntityType: "not canonical",
              providerEntityId: opaqueEntityId,
            }),
          ],
        }),
      ),
    ).toThrow("providerEntityType is not canonical");
  });

  it("rejects a provider revision mapped to different ordinals in one stream", () => {
    expect(() =>
      validate(
        envelope({
          coverage: [
            {
              capabilityKey: "fixture-note",
              status: "available",
              observationIds: ["observation-1", "observation-2"],
            },
          ],
          observations: [
            observation(),
            observation({
              id: "observation-2",
              evidenceReference: {
                kind: "retained-reference",
                reference: `s3://retained/provider-1/${"b".repeat(64)}`,
                contentHash: "b".repeat(64),
              },
              revision: {
                providerRevision: "revision-1",
                providerOrdinal: 2,
              },
            }),
          ],
          facts: [fact({ observationIds: ["observation-1", "observation-2"] })],
        }),
      ),
    ).toThrow("provider revision cannot map to multiple ordinals");
  });

  it("requires provider timestamp before collection before evaluation", () => {
    expect(() =>
      validate(
        envelope({
          observations: [
            observation({
              providerTimestamp: "2026-08-07T20:00:00.200Z",
              collectedAt: "2026-08-07T20:00:00.100Z",
            }),
          ],
        }),
      ),
    ).toThrow("provider timestamp must not follow collection or evaluation");
  });

  it("requires inferred basis facts to be resolved", () => {
    expect(() =>
      validate(
        envelope({
          facts: [
            fact({
              state: "inferred",
              basisFactIds: ["basis-1"],
              confidence: 0.8,
            }),
            fact({
              id: "basis-1",
              schemaKey: "basis-note",
              state: "unavailable",
              value: undefined,
              observedAt: undefined,
              unavailableReason: "missing",
              confidence: 0,
            }),
          ],
        }),
      ),
    ).toThrow("inferred basis must be resolved");
  });

  it("retains stale freshness independently for inferred and conflicting facts", () => {
    const staleTimestamp = "2026-08-07T19:59:58.000Z";
    const inferred = validate(
      envelope({
        observations: [
          observation({
            providerTimestamp: staleTimestamp,
            collectedAt: staleTimestamp,
          }),
        ],
        facts: [
          fact({
            state: "inferred",
            basisFactIds: ["basis-1"],
            confidence: 0.8,
            observedAt: staleTimestamp,
          }),
          fact({
            id: "basis-1",
            schemaKey: "basis-note",
            state: "stale",
            confidence: 0.8,
            observedAt: staleTimestamp,
          }),
        ],
      }),
    );
    expect(inferred.facts.find((item) => item.id === "fact-1")).toMatchObject({
      state: "inferred",
      freshness: { status: "stale" },
    });

    const conflicting = validate(
      envelope({
        coverage: [
          {
            capabilityKey: "fixture-note",
            status: "partial",
            observationIds: ["observation-1", "observation-2"],
          },
        ],
        observations: [
          observation({
            providerTimestamp: staleTimestamp,
            collectedAt: staleTimestamp,
          }),
          observation({
            id: "observation-2",
            providerEntityType: "fixture",
            providerEntityId: "event-1-secondary-feed",
            providerTimestamp: staleTimestamp,
            collectedAt: staleTimestamp,
            revision: { providerRevision: "revision-2", providerOrdinal: 2 },
            evidenceReference: {
              kind: "retained-reference",
              reference: `s3://retained/provider-1/${"b".repeat(64)}`,
              contentHash: "b".repeat(64),
            },
          }),
        ],
        facts: [
          fact({
            state: "conflicting",
            value: undefined,
            observedAt: undefined,
            confidence: 0,
            observationIds: ["observation-1", "observation-2"],
            conflict: {
              alternatives: [
                { value: "valid-b", observationIds: ["observation-2"] },
                { value: "valid-a", observationIds: ["observation-1"] },
              ],
            },
          }),
        ],
      }),
    );
    expect(conflicting.facts[0]).toMatchObject({
      state: "conflicting",
      freshness: { status: "stale" },
    });
  });

  it("requires every conflict alternative value to be unique", () => {
    expect(() =>
      validate(
        envelope({
          coverage: [
            {
              capabilityKey: "fixture-note",
              status: "partial",
              observationIds: [
                "observation-1",
                "observation-2",
                "observation-3",
              ],
            },
          ],
          observations: [
            observation(),
            ...[2, 3].map((ordinal) =>
              observation({
                id: `observation-${ordinal}`,
                revision: {
                  providerRevision: `revision-${ordinal}`,
                  providerOrdinal: ordinal,
                },
                evidenceReference: {
                  kind: "retained-reference",
                  reference: `s3://retained/provider-1/${String.fromCharCode(96 + ordinal).repeat(64)}`,
                  contentHash: String.fromCharCode(96 + ordinal).repeat(64),
                },
              }),
            ),
          ],
          facts: [
            fact({
              state: "conflicting",
              value: undefined,
              observedAt: undefined,
              confidence: 0,
              observationIds: [
                "observation-1",
                "observation-2",
                "observation-3",
              ],
              conflict: {
                alternatives: [
                  { value: "valid-a", observationIds: ["observation-1"] },
                  { value: "valid-b", observationIds: ["observation-2"] },
                  { value: "valid-a", observationIds: ["observation-3"] },
                ],
              },
            }),
          ],
        }),
      ),
    ).toThrow("conflict alternatives must all differ");
  });

  it("includes present optional facts when deriving coverage state", () => {
    const unavailableOptional = fact({
      id: "optional-fact",
      schemaKey: "basis-note",
      state: "unavailable",
      value: undefined,
      observedAt: undefined,
      unavailableReason: "not-provided",
      confidence: 0,
    });
    expect(() =>
      validate(envelope({ facts: [fact(), unavailableOptional] })),
    ).toThrow("available coverage requires all present facts to be resolved");
    expect(
      validate(
        envelope({
          coverage: [
            {
              capabilityKey: "fixture-note",
              status: "partial",
              observationIds: ["observation-1"],
            },
          ],
          facts: [fact(), unavailableOptional],
        }),
      ).coverage[0]?.status,
    ).toBe("partial");

    expect(() =>
      validate(
        envelope({
          coverage: [
            {
              capabilityKey: "fixture-note",
              status: "unavailable",
              unavailableReason: "not-provided",
              observationIds: ["observation-1"],
            },
          ],
          facts: [
            fact({
              state: "unavailable",
              value: undefined,
              observedAt: undefined,
              unavailableReason: "not-provided",
              confidence: 0,
            }),
            fact({ id: "optional-fact", schemaKey: "basis-note" }),
          ],
        }),
      ),
    ).toThrow(
      "unavailable coverage requires all present facts to be unavailable",
    );
  });

  it("canonicalizes set-like references without locale-dependent sorting", () => {
    const makeTwoObservationEnvelope = (reverse: boolean, conflict = false) => {
      const observations = [
        observation(),
        observation({
          id: "observation-2",
          providerEntityType: "fixture",
          providerEntityId: "event-1-secondary-feed",
          revision: { providerRevision: "revision-2", providerOrdinal: 2 },
          evidenceReference: {
            kind: "retained-reference",
            reference: `s3://retained/provider-1/${"b".repeat(64)}`,
            contentHash: "b".repeat(64),
          },
        }),
      ];
      const ids = reverse
        ? ["observation-2", "observation-1"]
        : ["observation-1", "observation-2"];
      return envelope({
        coverage: [
          {
            capabilityKey: "fixture-note",
            status: conflict ? "partial" : "available",
            observationIds: ids,
          },
        ],
        observations: reverse ? observations.reverse() : observations,
        facts: [
          conflict
            ? fact({
                state: "conflicting",
                value: undefined,
                observedAt: undefined,
                confidence: 0,
                observationIds: ids,
                conflict: {
                  alternatives: reverse
                    ? [
                        {
                          value: "valid-b",
                          observationIds: ["observation-2"],
                        },
                        {
                          value: "valid-a",
                          observationIds: ["observation-1"],
                        },
                      ]
                    : [
                        {
                          value: "valid-a",
                          observationIds: ["observation-1"],
                        },
                        {
                          value: "valid-b",
                          observationIds: ["observation-2"],
                        },
                      ],
                },
              })
            : fact({ observationIds: ids }),
        ],
      });
    };
    const localeCompareDescriptor = Object.getOwnPropertyDescriptor(
      String.prototype,
      "localeCompare",
    )!;
    let orderedHash = "";
    let reversedHash = "";
    let orderedConflictHash = "";
    let reversedConflictHash = "";
    String.prototype.localeCompare = () => {
      throw new Error("locale sorting forbidden");
    };
    try {
      orderedHash = validate(makeTwoObservationEnvelope(false)).inputHash;
      reversedHash = validate(makeTwoObservationEnvelope(true)).inputHash;
      orderedConflictHash = validate(
        makeTwoObservationEnvelope(false, true),
      ).inputHash;
      reversedConflictHash = validate(
        makeTwoObservationEnvelope(true, true),
      ).inputHash;
    } finally {
      Object.defineProperty(
        String.prototype,
        "localeCompare",
        localeCompareDescriptor,
      );
    }
    expect(orderedHash).toBe(reversedHash);
    expect(orderedConflictHash).toBe(reversedConflictHash);
  });

  it("translates throwing sport validators and rejects secret-like content", () => {
    const throwingContract = defineSportScoutingInputContract({
      ...contract,
      schemaId: "scout-input/throwing-test",
      capabilities: [
        {
          ...contract.capabilities[0]!,
          facts: [
            {
              ...contract.capabilities[0]!.facts[0]!,
              validateValue: () => {
                throw new Error("provider detail");
              },
            },
          ],
        },
      ],
    });
    expect(() =>
      validateScoutingInput(
        envelope({
          moduleSchema: {
            id: throwingContract.schemaId,
            version: throwingContract.schemaVersion,
          },
        }),
        {
          canonicalEvent: event,
          evaluatedAt: "2026-08-07T20:00:01.000Z",
          environment: "production",
          module: { ...module, scoutingInputContract: throwingContract },
          sourceAuthorization: providerSource,
        },
      ),
    ).toThrow("sport fact validator failed safely");
    expect(() =>
      validate(
        envelope({ facts: [fact({ value: "valid-note api_key=abc" })] }),
      ),
    ).toThrow("payload must be bounded plain JSON");
  });

  it("requires every observation to be covered and replays identical IDs idempotently", () => {
    expect(() =>
      validate(
        envelope({
          observations: [
            observation(),
            observation({
              id: "observation-2",
              revision: { providerRevision: "revision-2", providerOrdinal: 2 },
              evidenceReference: {
                kind: "retained-reference",
                reference: `s3://retained/provider-1/${"b".repeat(64)}`,
                contentHash: "b".repeat(64),
              },
            }),
          ],
        }),
      ),
    ).toThrow("every observation must appear in coverage");
    const replayed = validate(
      envelope({ observations: [observation(), observation()] }),
    );
    expect(replayed.observations).toHaveLength(1);
  });

  it("associates participant entity facts and rejects duplicates or cross-coverage", () => {
    const entityContract = defineSportScoutingInputContract({
      schemaId: "scout-input/entity-test",
      schemaVersion: "1",
      sportKey,
      participantCardinality: { minimum: 2, maximum: 2 },
      capabilities: [
        {
          key: "participant-entities",
          required: true,
          scope: "participant",
          availability: "evidence",
          facts: [
            {
              key: "entity-rating",
              required: true,
              cardinality: "many",
              subjectScope: "entity",
              maximumAgeMilliseconds: 1_000,
              validateSubject: ({ subjectId, capabilitySubjectId }) =>
                subjectId.startsWith(`${capabilitySubjectId}.entity-`),
              validateValue: (value) =>
                typeof value === "number"
                  ? { valid: true, value, errors: [] }
                  : { valid: false, errors: ["invalid rating"] },
            },
          ],
        },
      ],
    });
    const entityModule = {
      ...module,
      scoutingInputContract: entityContract,
    };
    const observations = event.participantIds.map((subjectId, index) => ({
      id: `entity-observation-${index}`,
      capabilityKey: "participant-entities",
      subjectId,
      providerId: "provider-1",
      providerTimestamp: "2026-08-07T20:00:00.000Z",
      collectedAt: "2026-08-07T20:00:00.100Z",
      evidenceReference: {
        kind: "retained-reference",
        reference: `s3://retained/provider-1/${String(index + 1).repeat(64)}`,
        contentHash: String(index + 1).repeat(64),
      },
      revision: { collectorSequence: index + 1 },
    }));
    const entityFacts = event.participantIds.map((participantId, index) => ({
      id: `entity-fact-${index}`,
      capabilityKey: "participant-entities",
      schemaKey: "entity-rating",
      subjectId: `${participantId}.entity-1`,
      state: "verified",
      value: 90 + index,
      observationIds: [`entity-observation-${index}`],
      observedAt: "2026-08-07T20:00:00.100Z",
      confidence: 1,
    }));
    const entityEnvelope = {
      schemaId: "find-the-edge.scouting-input",
      schemaVersion: "1.0.0",
      moduleSchema: { id: entityContract.schemaId, version: "1" },
      event,
      coverage: event.participantIds.map((subjectId, index) => ({
        capabilityKey: "participant-entities",
        subjectId,
        status: "available",
        observationIds: [`entity-observation-${index}`],
      })),
      observations,
      facts: entityFacts,
    };
    const entityOptions = {
      canonicalEvent: event,
      evaluatedAt: "2026-08-07T20:00:01.000Z",
      environment: "production" as const,
      module: entityModule,
      sourceAuthorization: {
        ...providerSource,
        capabilities: ["participant-entities"],
      },
    };
    expect(
      validateScoutingInput(entityEnvelope, entityOptions).facts,
    ).toHaveLength(2);
    expect(() =>
      validateScoutingInput(
        {
          ...entityEnvelope,
          facts: [
            ...entityFacts,
            { ...entityFacts[0]!, id: "entity-fact-duplicate" },
          ],
        },
        entityOptions,
      ),
    ).toThrow("entity fact cannot repeat within an instance");
    expect(() =>
      validateScoutingInput(
        {
          ...entityEnvelope,
          facts: [
            { ...entityFacts[0]!, observationIds: ["entity-observation-1"] },
            entityFacts[1],
          ],
        },
        entityOptions,
      ),
    ).toThrow("fact observation must belong to its instance coverage");
    const throwingSubjectContract = defineSportScoutingInputContract({
      ...entityContract,
      schemaId: "scout-input/entity-throwing-test",
      capabilities: [
        {
          ...entityContract.capabilities[0]!,
          facts: [
            {
              ...entityContract.capabilities[0]!.facts[0]!,
              validateSubject: () => {
                throw new Error("subject detail");
              },
            },
          ],
        },
      ],
    });
    expect(() =>
      validateScoutingInput(
        {
          ...entityEnvelope,
          moduleSchema: {
            id: throwingSubjectContract.schemaId,
            version: throwingSubjectContract.schemaVersion,
          },
        },
        {
          ...entityOptions,
          module: {
            ...entityModule,
            scoutingInputContract: throwingSubjectContract,
          },
        },
      ),
    ).toThrow("sport subject validator failed safely");
  });

  it("fails safely for proxy and accessor payloads", () => {
    const proxy = new Proxy(
      {},
      {
        ownKeys: () => {
          throw new Error("secret");
        },
      },
    );
    expect(() => validate(proxy)).toThrow(
      new ScoutingInputValidationError(
        "INVALID_INPUT",
        "payload must be bounded plain JSON",
      ),
    );
    const accessor = Object.defineProperty({}, "schemaId", {
      enumerable: true,
      get: () => {
        throw new Error("secret");
      },
    });
    expect(() => validate(accessor)).toThrow(
      "payload must be bounded plain JSON",
    );
  });

  it("treats identical provider re-polls as usable evidence", () => {
    const replay = observation({
      id: "observation-repoll",
      collectedAt: "2026-08-07T20:00:00.200Z",
    });
    const normalized = validate(
      envelope({
        coverage: [
          {
            capabilityKey: "fixture-note",
            status: "available",
            observationIds: ["observation-1", "observation-repoll"],
          },
        ],
        observations: [observation(), replay],
        facts: [
          fact({ observationIds: ["observation-1", "observation-repoll"] }),
        ],
      }),
    );
    expect(normalized.observations.every((item) => !item.quarantined)).toBe(
      true,
    );
  });

  it("requires resolved facts to use a higher unlinked provider revision", () => {
    expect(() =>
      validate(
        envelope({
          coverage: [
            {
              capabilityKey: "fixture-note",
              status: "available",
              observationIds: ["observation-1", "observation-2"],
            },
          ],
          observations: [
            observation(),
            observation({
              id: "observation-2",
              revision: { providerRevision: "revision-2", providerOrdinal: 2 },
              evidenceReference: {
                kind: "retained-reference",
                reference: `s3://retained/provider-1/${"b".repeat(64)}`,
                contentHash: "b".repeat(64),
              },
            }),
          ],
        }),
      ),
    ).toThrow("resolved fact must cite the latest usable stream evidence");
  });

  it("allows an explicit correction to adopt provider revision ordering", () => {
    const normalized = validate(
      envelope({
        coverage: [
          {
            capabilityKey: "fixture-note",
            status: "available",
            observationIds: ["observation-1", "observation-2"],
          },
        ],
        observations: [
          observation({ revision: { collectorSequence: 1 } }),
          observation({
            id: "observation-2",
            revision: { providerRevision: "revision-2", providerOrdinal: 1 },
            supersedesObservationId: "observation-1",
            evidenceReference: {
              kind: "retained-reference",
              reference: `s3://retained/provider-1/${"b".repeat(64)}`,
              contentHash: "b".repeat(64),
            },
          }),
        ],
        facts: [fact({ observationIds: ["observation-2"] })],
      }),
    );
    expect(normalized.facts[0]?.provenance[0]?.id).toBe("observation-2");
  });

  it("rejects a conflict fabricated from duplicate immutable evidence", () => {
    expect(() =>
      validate(
        envelope({
          coverage: [
            {
              capabilityKey: "fixture-note",
              status: "partial",
              observationIds: ["observation-1", "observation-repoll"],
            },
          ],
          observations: [
            observation(),
            observation({
              id: "observation-repoll",
              collectedAt: "2026-08-07T20:00:00.200Z",
            }),
          ],
          facts: [
            fact({
              state: "conflicting",
              value: undefined,
              observedAt: undefined,
              confidence: 0,
              observationIds: ["observation-1", "observation-repoll"],
              conflict: {
                alternatives: [
                  { value: "valid-a", observationIds: ["observation-1"] },
                  {
                    value: "valid-b",
                    observationIds: ["observation-repoll"],
                  },
                ],
              },
            }),
          ],
        }),
      ),
    ).toThrow(
      "duplicate evidence cannot support separate conflict alternatives",
    );
  });

  it("rejects conflict values that collapse after sport normalization", () => {
    const normalizingContract = defineSportScoutingInputContract({
      ...contract,
      schemaId: "scout-input/normalizing-test-sport",
      capabilities: [
        {
          ...contract.capabilities[0]!,
          facts: contract.capabilities[0]!.facts.map((schema) => ({
            ...schema,
            validateValue: (value: unknown) =>
              typeof value === "string" && value.startsWith("valid-")
                ? { valid: true, value: value.toLowerCase(), errors: [] }
                : { valid: false, errors: ["invalid note"] },
          })),
        },
      ],
    });
    const normalizingModule = {
      ...module,
      scoutingInputContract: normalizingContract,
    };
    expect(() =>
      validateScoutingInput(
        envelope({
          moduleSchema: {
            id: normalizingContract.schemaId,
            version: normalizingContract.schemaVersion,
          },
          coverage: [
            {
              capabilityKey: "fixture-note",
              status: "partial",
              observationIds: ["observation-1", "observation-2"],
            },
          ],
          observations: [
            observation(),
            observation({
              id: "observation-2",
              providerEntityType: "fixture",
              providerEntityId: "event-1-secondary-feed",
              evidenceReference: {
                kind: "retained-reference",
                reference: `s3://retained/provider-1/${"b".repeat(64)}`,
                contentHash: "b".repeat(64),
              },
            }),
          ],
          facts: [
            fact({
              state: "conflicting",
              value: undefined,
              observedAt: undefined,
              confidence: 0,
              observationIds: ["observation-1", "observation-2"],
              conflict: {
                alternatives: [
                  { value: "valid-A", observationIds: ["observation-1"] },
                  { value: "valid-a", observationIds: ["observation-2"] },
                ],
              },
            }),
          ],
        }),
        {
          canonicalEvent: event,
          evaluatedAt: "2026-08-07T20:00:01.000Z",
          environment: "production",
          module: normalizingModule,
          sourceAuthorization: providerSource,
        },
      ),
    ).toThrow("conflict alternatives must all differ");
  });

  it.each([false, true])(
    "rejects conflict evidence when a newer revision exists (linked=%s)",
    (linked) => {
      expect(() =>
        validate(
          envelope({
            coverage: [
              {
                capabilityKey: "fixture-note",
                status: "partial",
                observationIds: ["observation-1", "observation-2"],
              },
            ],
            observations: [
              observation(),
              observation({
                id: "observation-2",
                revision: {
                  providerRevision: "revision-2",
                  providerOrdinal: 2,
                },
                ...(linked ? { supersedesObservationId: "observation-1" } : {}),
                evidenceReference: {
                  kind: "retained-reference",
                  reference: `s3://retained/provider-1/${"b".repeat(64)}`,
                  contentHash: "b".repeat(64),
                },
              }),
            ],
            facts: [
              fact({
                state: "conflicting",
                value: undefined,
                observedAt: undefined,
                confidence: 0,
                observationIds: ["observation-1", "observation-2"],
                conflict: {
                  alternatives: [
                    { value: "valid-a", observationIds: ["observation-1"] },
                    { value: "valid-b", observationIds: ["observation-2"] },
                  ],
                },
              }),
            ],
          }),
        ),
      ).toThrow("conflict must cite terminal stream evidence");
    },
  );

  it("keeps unavailable coverage and fact reasons consistent", () => {
    expect(() =>
      validate(
        envelope({
          coverage: [
            {
              capabilityKey: "fixture-note",
              status: "unavailable",
              unavailableReason: "license-denied",
              observationIds: ["observation-1"],
            },
          ],
          facts: [
            fact({
              state: "unavailable",
              value: undefined,
              observedAt: undefined,
              unavailableReason: "provider-outage",
              confidence: 0,
            }),
          ],
        }),
      ),
    ).toThrow("unavailable coverage and facts must share one reason");
  });

  it("wraps unexpected trusted-option failures in the stable input error", () => {
    const unsafeModule = new Proxy(module, {
      get: () => {
        throw new Error("secret trusted option detail");
      },
    });
    expect(() =>
      validateScoutingInput(envelope(), {
        canonicalEvent: event,
        evaluatedAt: "2026-08-07T20:00:01.000Z",
        environment: "production",
        module: unsafeModule,
        sourceAuthorization: providerSource,
      }),
    ).toThrow(
      new ScoutingInputValidationError(
        "INVALID_INPUT",
        "normalization failed safely",
      ),
    );
  });
});
