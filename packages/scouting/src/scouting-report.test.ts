import {
  calculationInputHash,
  canonicalCalculationJson,
  normalizeFixtureOddsObservation,
  sha256Hex,
  type SportKey,
} from "@find-the-edge/domain";
import {
  createReportCalculationReference,
  calculateFairValue,
  qualifyEvaluation,
} from "@find-the-edge/odds";
import { soccerFindTheEdgeStrategy, soccerModule } from "@find-the-edge/sports";
import { describe, expect, it } from "vitest";

import { buildReportPromptRequest } from "./report-prompt";
import {
  createDisabledReportModelAdapter,
  createFakeReportModelAdapter,
  ReportModelProviderError,
} from "./report-model-port";
import {
  generateValidatedScoutingReport,
  ScoutingReportValidationError,
} from "./scouting-report";
import type { NormalizedScoutingInput } from "./scouting-input";

const hash = "a".repeat(64);
const normalizedInput = {
  schemaId: "find-the-edge.scouting-input",
  schemaVersion: "1.0.0",
  moduleSchema: { id: "scout-input/soccer", version: "1" },
  manifestHash: "b".repeat(64),
  event: {
    canonicalEventId: "event-1",
    canonicalEventVersion: "1",
    sportKey: "soccer" as SportKey,
    leagueKey: "mls",
    startsAt: "2026-08-08T00:00:00.000Z",
    participantIds: ["club-a", "club-b"],
  },
  coverage: [],
  observations: [],
  facts: [
    {
      id: "fact-fixture",
      capabilityKey: "fixture",
      schemaKey: "competition-context",
      state: "verified",
      value: { competitionKey: "mls" },
      observationIds: ["observation-1"],
      confidence: 1,
      freshness: {
        status: "current",
        originAt: "2026-08-07T20:00:00.000Z",
        ageMilliseconds: 0,
      },
      provenance: [],
    },
  ],
  evaluatedAt: "2026-08-07T20:00:00.000Z",
  source: {
    id: "test-source",
    providerId: "test-provider",
    maturity: "development",
    productionEligible: false,
    sourceKind: "synthetic-fixture",
    sportKey: "soccer" as SportKey,
    competitionKeys: ["mls"],
    capabilities: ["fixture"],
    evidenceReferencePrefixes: ["synthetic://test/"],
  },
  inputHash: hash,
} as unknown as NormalizedScoutingInput;

const qualificationInput = {
  targetSportsbookId: "hardrock",
  offeredAmerican: 120,
  offeredAgeMinutes: 2,
  candidateIndex: 0,
  modelProbability: { estimate: 0.5, low: 0.5, high: 0.5, uncertainty: 0 },
  books: [
    { sportsbookId: "circa", ageMinutes: 2, americanOdds: [110, -120] },
    { sportsbookId: "pinnacle", ageMinutes: 3, americanOdds: [105, -115] },
  ],
  outcomeCount: 2,
  policy: {
    comparisonWeights: { circa: 1.25, pinnacle: 1 },
    minimumComparisonBooks: 2,
    maximumPriceAgeMinutes: 15,
    outlierThreshold: 0.12,
    disagreementWarningThreshold: 0.05,
    disagreementBlockThreshold: 0.1,
    maximumUncertainty: 0.1,
    minimumEdge: 0.5,
    minimumExpectedValue: 0.5,
  },
} as const;
const qualification = qualifyEvaluation(qualificationInput);

const snapshot = normalizeFixtureOddsObservation({
  canonicalEventId: "event-1",
  canonicalEventVersion: 1,
  sportKey: "soccer",
  marketKey: "moneyline",
  selectionKey: "club-a",
  sportsbookId: "hardrock",
  americanOdds: 120,
  observedAt: "2026-08-07T20:00:00.000Z",
  retrievedAt: "2026-08-07T20:00:01.000Z",
});

const circaSnapshot = normalizeFixtureOddsObservation({
  canonicalEventId: "event-1",
  canonicalEventVersion: 1,
  sportKey: "soccer",
  marketKey: "moneyline",
  selectionKey: "club-a",
  sportsbookId: "circa",
  americanOdds: 110,
  observedAt: "2026-08-07T19:59:58.000Z",
  retrievedAt: "2026-08-07T20:00:00.000Z",
});

const pinnacleSnapshot = normalizeFixtureOddsObservation({
  canonicalEventId: "event-1",
  canonicalEventVersion: 1,
  sportKey: "soccer",
  marketKey: "moneyline",
  selectionKey: "club-a",
  sportsbookId: "pinnacle",
  americanOdds: 105,
  observedAt: "2026-08-07T19:59:57.000Z",
  retrievedAt: "2026-08-07T20:00:00.000Z",
});

const qualificationSnapshots = [snapshot, circaSnapshot, pinnacleSnapshot];

const unavailableSectionModule = {
  ...soccerModule,
  scoutingReportContract: {
    schemaId: soccerModule.scoutingReportContract.schemaId,
    schemaVersion: soccerModule.scoutingReportContract.schemaVersion,
    sportKey: soccerModule.key,
    sections: [
      {
        key: "match-snapshot",
        title: "Match Snapshot",
        availability: "unavailable-only",
        content: "narrative",
        allowedFactCategories: [],
        allowedCalculationKinds: [],
      },
    ],
  },
} as const;

const calculation = createReportCalculationReference({
  id: "qualification-club-a",
  kind: "qualification",
  canonicalEventId: "event-1",
  canonicalEventVersion: "1",
  sportKey: "soccer",
  marketKey: "moneyline",
  selectionKey: "club-a",
  snapshots: qualificationSnapshots,
  calculationInput: qualificationInput,
  result: qualification,
});

const expectedPromptBundle = {
  id: "soccer-report",
  version: "1",
  trustedInstructions: [
    "Use citations only.",
    "Never calculate betting values.",
  ],
} as const;

function request(references = [calculation]) {
  return buildReportPromptRequest({
    schema: {
      id: soccerModule.scoutingReportContract.schemaId,
      version: soccerModule.scoutingReportContract.schemaVersion,
    },
    sportKey: "soccer",
    moduleVersion: soccerModule.metadata.version,
    strategy: soccerFindTheEdgeStrategy,
    promptBundle: expectedPromptBundle,
    scoutingInput: normalizedInput,
    calculationReferences: references,
  });
}

const expectedModel = {
  providerId: "deterministic-fake",
  modelId: "report-model-fake",
  modelVersion: "1",
  deploymentId: "local-test",
};

describe("structured scouting report generation", () => {
  it("fills omitted sections, binds trusted facts, and injects deterministic PASS", async () => {
    const telemetry: unknown[] = [];
    const report = await generateValidatedScoutingReport({
      provider: createFakeReportModelAdapter({
        output: {
          schemaId: "scout-report/soccer",
          schemaVersion: "1",
          sections: [
            {
              key: "match-snapshot",
              classification: "summary",
              narrative: "The competition context is established.",
              factCitations: ["fact-fixture"],
            },
          ],
        },
      }),
      module: soccerModule,
      strategy: soccerFindTheEdgeStrategy,
      scoutingInput: normalizedInput,
      modelRequest: request(),
      expectedPromptBundle,
      expectedModel,
      calculationReferences: [calculation],
      telemetry: (event) => telemetry.push(event),
    });
    expect(report.sections).toHaveLength(14);
    expect(report.sections[0]).toMatchObject({
      state: "available",
      title: "Match Snapshot",
    });
    expect(report.sections[1]).toMatchObject({
      state: "unavailable",
      unavailableReason: "model-section-omitted",
    });
    expect(report.disposition.state).toBe("pass");
    expect(report.sections[12]?.calculations).toEqual([]);
    expect(report.sections.at(-1)?.calculations).toEqual([calculation]);
    expect(report.draftHash).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.isFrozen(report.sections[0]?.facts[0])).toBe(true);
    expect(Object.isFrozen(report.model)).toBe(true);
    expect(Object.isFrozen(report.model.usage)).toBe(true);
    expect(telemetry.map((event) => (event as { type: string }).type)).toEqual([
      "scouting-report.started",
      "scouting-report.succeeded",
    ]);
    expect(JSON.stringify(telemetry)).not.toContain("competition context");
  });

  it.each([
    [
      {
        schemaId: "scout-report/soccer",
        schemaVersion: "1",
        sections: [
          {
            key: "match-snapshot",
            narrative: "Odds are +120.",
            factCitations: ["fact-fixture"],
          },
        ],
      },
      "FORGED_AUTHORITY",
    ],
    [
      {
        schemaId: "scout-report/soccer",
        schemaVersion: "1",
        sections: [
          {
            key: "match-snapshot",
            narrative: "The competition context is established.",
            factIds: ["fact-fixture"],
          },
        ],
      },
      "INVALID_DRAFT",
    ],
    [
      {
        schemaId: "scout-report/soccer",
        schemaVersion: "1",
        sections: [
          {
            key: "match-snapshot",
            narrative: "Bearer abc123",
            factCitations: ["fact-fixture"],
          },
        ],
      },
      "UNSAFE_CONTENT",
    ],
    [
      {
        schemaId: "scout-report/soccer",
        schemaVersion: "1",
        sections: [{ key: "venue-weather" }, { key: "match-snapshot" }],
      },
      "INVALID_DRAFT",
    ],
    [
      {
        schemaId: "scout-report/soccer",
        schemaVersion: "1",
        sections: [
          {
            key: "match-snapshot",
            narrative: "Unsupported.",
            factCitations: ["missing"],
          },
        ],
      },
      "UNSUPPORTED_CITATION",
    ],
    [
      {
        schemaId: "scout-report/soccer",
        schemaVersion: "1",
        sections: [
          {
            key: "final-plays",
            narrative: "Take the play.",
            calculationCitations: ["qualification-club-a"],
          },
        ],
      },
      "FORGED_AUTHORITY",
    ],
  ])("rejects hostile output atomically", async (output, code) => {
    await expect(
      generateValidatedScoutingReport({
        provider: createFakeReportModelAdapter({ output }),
        module: soccerModule,
        strategy: soccerFindTheEdgeStrategy,
        scoutingInput: normalizedInput,
        modelRequest: request(),
        expectedPromptBundle,
        expectedModel,
        calculationReferences: [calculation],
      }),
    ).rejects.toMatchObject({
      code: code as ScoutingReportValidationError["code"],
    } satisfies Partial<ScoutingReportValidationError>);
  });

  it.each([
    "Decimal odds 2.50 favor the home club.",
    "Probability 0.62 supports the side.",
    "Expected value 0.12 is attractive.",
    "Recommendation PASS.",
    "Bet club A.",
    "The club carries a 62% chance.",
    "The price is +150.",
    "This is a lock.",
    "Guaranteed winner.",
    "Back club A.",
    "Wager on club A.",
    "You should bet club A.",
    "We should back club A.",
    "I recommend club A.",
    "I favor club A.",
    "My pick is club A.",
    "Club A is the best bet.",
    "Club A is the strongest play.",
    "Club A is the top wager.",
    "Club A is the preferred pick.",
    "Club A is worth backing.",
    "The play is club A.",
    "Club A is a value bet.",
    "Club A is the side to back.",
    "Consider betting on club A.",
    "Consider backing club A.",
    "Consider wagering on club A.",
    "I like club A here.",
    "Club A should be backed.",
    "Club A gets the nod.",
    "The рlay is club A.",
    "The pl\u200Bay is club A.",
    "Ｔｈｅ ｐｌａｙ ｉｓ club A.",
    "The recommended side is club A.",
    "Lean toward club A.",
  ])("rejects model-authored betting authority: %s", async (text) => {
    await expect(
      generateValidatedScoutingReport({
        provider: createFakeReportModelAdapter({
          output: {
            schemaId: "scout-report/soccer",
            schemaVersion: "1",
            sections: [
              {
                key: "match-snapshot",
                narrative: text,
                factCitations: ["fact-fixture"],
              },
            ],
          },
        }),
        module: soccerModule,
        strategy: soccerFindTheEdgeStrategy,
        scoutingInput: normalizedInput,
        modelRequest: request(),
        expectedPromptBundle,
        expectedModel,
        calculationReferences: [calculation],
      }),
    ).rejects.toMatchObject({ code: "FORGED_AUTHORITY" });
  });

  it.each([
    "Supporters like the verified lineup information here.",
    "The market should be monitored as evidence changes.",
    "The midfielder played here last season.",
    "São Paulo form is documented by the cited source.",
    "Динамо Kyiv form is documented by the cited source.",
  ])("accepts benign evidence narrative: %s", async (text) => {
    const report = await generateValidatedScoutingReport({
      provider: createFakeReportModelAdapter({
        output: {
          schemaId: "scout-report/soccer",
          schemaVersion: "1",
          sections: [
            {
              key: "match-snapshot",
              narrative: text,
              factCitations: ["fact-fixture"],
            },
          ],
        },
      }),
      module: soccerModule,
      strategy: soccerFindTheEdgeStrategy,
      scoutingInput: normalizedInput,
      modelRequest: request(),
      expectedPromptBundle,
      expectedModel,
      calculationReferences: [calculation],
    });
    expect(report.sections[0]?.narrative).toBe(text);
  });

  it("keeps disabled and aborted adapters typed", async () => {
    await expect(
      createDisabledReportModelAdapter().generate(request()),
    ).rejects.toMatchObject({
      code: "DISABLED",
    } satisfies Partial<ReportModelProviderError>);
    const controller = new AbortController();
    controller.abort();
    await expect(
      createFakeReportModelAdapter({ output: {} }).generate(request(), {
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({
      code: "ABORTED",
    } satisfies Partial<ReportModelProviderError>);
  });

  it("makes set order stable while material identities change the request hash", () => {
    const first = request();
    const equivalent = request([calculation]);
    expect(equivalent.requestHash).toBe(first.requestHash);
    const changed = buildReportPromptRequest({
      schema: first.schema,
      sportKey: "soccer",
      moduleVersion: soccerModule.metadata.version,
      strategy: soccerFindTheEdgeStrategy,
      promptBundle: {
        id: "soccer-report",
        version: "2",
        trustedInstructions: ["Use citations only."],
      },
      scoutingInput: normalizedInput,
      calculationReferences: [calculation],
    });
    expect(changed.requestHash).not.toBe(first.requestHash);
  });

  it("rejects dangling citations in deterministic sections before projection", async () => {
    await expect(
      generateValidatedScoutingReport({
        provider: createFakeReportModelAdapter({
          output: {
            schemaId: "scout-report/soccer",
            schemaVersion: "1",
            sections: [
              {
                key: "final-plays",
                calculationCitations: ["missing-reference"],
              },
            ],
          },
        }),
        module: soccerModule,
        strategy: soccerFindTheEdgeStrategy,
        scoutingInput: normalizedInput,
        modelRequest: request(),
        expectedPromptBundle,
        expectedModel,
        calculationReferences: [calculation],
      }),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_CITATION" });
  });

  it("validates request identities and frames before invoking a provider", async () => {
    let called = false;
    const original = request();
    const mismatched = {
      ...original,
      identities: { ...original.identities, sportKey: "mlb" },
    };
    const telemetry: unknown[] = [];
    await expect(
      generateValidatedScoutingReport({
        provider: {
          generate() {
            called = true;
            return Promise.reject(new Error("must not be called"));
          },
        },
        module: soccerModule,
        strategy: soccerFindTheEdgeStrategy,
        scoutingInput: normalizedInput,
        modelRequest: mismatched,
        expectedPromptBundle,
        expectedModel,
        calculationReferences: [calculation],
        telemetry: (event) => telemetry.push(event),
      }),
    ).rejects.toMatchObject({ code: "INVALID_CONTEXT" });
    expect(called).toBe(false);
    expect(telemetry).toEqual([]);
  });

  it("rejects non-string prompt identifiers before framing", () => {
    expect(() =>
      buildReportPromptRequest({
        schema: {
          id: 42 as never,
          version: soccerModule.scoutingReportContract.schemaVersion,
        },
        sportKey: "soccer",
        moduleVersion: soccerModule.metadata.version,
        strategy: soccerFindTheEdgeStrategy,
        promptBundle: expectedPromptBundle,
        scoutingInput: normalizedInput,
        calculationReferences: [calculation],
      }),
    ).toThrow("report-prompt-input-invalid");
  });

  it.each([
    {
      label: "count",
      trustedInstructions: Array.from(
        { length: 33 },
        (_, index) => `Instruction ${index}.`,
      ),
    },
    { label: "whitespace", trustedInstructions: [" Use cited evidence."] },
    { label: "secret", trustedInstructions: ["api_key=supersecret"] },
    { label: "control", trustedInstructions: ["Use\u0000evidence."] },
    {
      label: "UTF-8 bytes",
      trustedInstructions: ["😀".repeat(1_025)],
    },
  ])(
    "applies trusted-instruction contract in the public builder: $label",
    ({ trustedInstructions }) => {
      expect(() =>
        buildReportPromptRequest({
          schema: {
            id: soccerModule.scoutingReportContract.schemaId,
            version: soccerModule.scoutingReportContract.schemaVersion,
          },
          sportKey: "soccer",
          moduleVersion: soccerModule.metadata.version,
          strategy: soccerFindTheEdgeStrategy,
          promptBundle: {
            ...expectedPromptBundle,
            trustedInstructions,
          },
          scoutingInput: normalizedInput,
          calculationReferences: [calculation],
        }),
      ).toThrow("report-prompt-input-invalid");
    },
  );

  it("preserves legitimate UTF-8 trusted instructions in the public builder", () => {
    expect(
      buildReportPromptRequest({
        schema: {
          id: soccerModule.scoutingReportContract.schemaId,
          version: soccerModule.scoutingReportContract.schemaVersion,
        },
        sportKey: "soccer",
        moduleVersion: soccerModule.metadata.version,
        strategy: soccerFindTheEdgeStrategy,
        promptBundle: {
          ...expectedPromptBundle,
          trustedInstructions: ["Use café and São Paulo evidence only."],
        },
        scoutingInput: normalizedInput,
        calculationReferences: [calculation],
      }).requestHash,
    ).toMatch(/^[a-f0-9]{64}$/);
  });

  it("deep-validates every calculation reference before prompt framing", () => {
    expect(() =>
      buildReportPromptRequest({
        schema: {
          id: soccerModule.scoutingReportContract.schemaId,
          version: soccerModule.scoutingReportContract.schemaVersion,
        },
        sportKey: "soccer",
        moduleVersion: soccerModule.metadata.version,
        strategy: soccerFindTheEdgeStrategy,
        promptBundle: expectedPromptBundle,
        scoutingInput: normalizedInput,
        calculationReferences: [
          {
            ...calculation,
            raw: { ...calculation.raw, undocumented: true },
          },
        ],
      }),
    ).toThrow("report-prompt-calculation-reference-invalid");
  });

  it.each([
    { key: "match-snapshot" },
    { key: "match-snapshot", classification: "summary" },
  ])("rejects any model-supplied unavailable-only section", async (section) => {
    await expect(
      generateValidatedScoutingReport({
        provider: createFakeReportModelAdapter({
          output: {
            schemaId: "scout-report/soccer",
            schemaVersion: "1",
            sections: [section],
          },
        }),
        module: unavailableSectionModule,
        strategy: soccerFindTheEdgeStrategy,
        scoutingInput: normalizedInput,
        modelRequest: request(),
        expectedPromptBundle,
        expectedModel,
        calculationReferences: [calculation],
      }),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_CITATION" });
  });

  it("binds framed instructions to the trusted expected prompt bundle", async () => {
    let called = false;
    await expect(
      generateValidatedScoutingReport({
        provider: {
          generate() {
            called = true;
            return Promise.reject(new Error("must not be called"));
          },
        },
        module: soccerModule,
        strategy: soccerFindTheEdgeStrategy,
        scoutingInput: normalizedInput,
        modelRequest: request(),
        expectedPromptBundle: {
          ...expectedPromptBundle,
          trustedInstructions: ["Different trusted instructions."],
        },
        expectedModel,
        calculationReferences: [calculation],
      }),
    ).rejects.toMatchObject({ code: "INVALID_CONTEXT" });
    expect(called).toBe(false);
  });

  it.each([
    {
      trustedInstructions: Array.from(
        { length: 33 },
        (_, index) => `Instruction ${index}.`,
      ),
    },
    { trustedInstructions: ["x".repeat(4_097)] },
    {
      trustedInstructions: [" Instruction with unsafe surrounding whitespace."],
    },
  ])(
    "rejects out-of-bounds trusted instruction frames before provider use",
    async ({ trustedInstructions }) => {
      const promptBundle = {
        ...expectedPromptBundle,
        trustedInstructions,
      };
      const validRequest = request();
      const instructionsJson = canonicalCalculationJson(trustedInstructions);
      const nextFrame = validRequest.framedContent.indexOf(
        "TRUSTED_IDENTITIES:",
      );
      const framedContent = `FTE-REPORT-REQUEST/1\nTRUSTED_INSTRUCTIONS:${new TextEncoder().encode(instructionsJson).length}\n${instructionsJson}\n${validRequest.framedContent.slice(nextFrame)}`;
      const oversizedRequest = {
        ...validRequest,
        framedContent,
        requestHash: sha256Hex(framedContent),
      };
      let called = false;
      await expect(
        generateValidatedScoutingReport({
          provider: {
            generate() {
              called = true;
              throw new Error("must not run");
            },
          },
          module: soccerModule,
          strategy: soccerFindTheEdgeStrategy,
          scoutingInput: normalizedInput,
          modelRequest: oversizedRequest,
          expectedPromptBundle: promptBundle,
          expectedModel,
          calculationReferences: [calculation],
        }),
      ).rejects.toMatchObject({ code: "INVALID_CONTEXT" });
      expect(called).toBe(false);
    },
  );

  it("races orchestration against abort when a provider ignores its signal", async () => {
    const controller = new AbortController();
    const pending = generateValidatedScoutingReport({
      provider: {
        generate: () => new Promise<never>(() => undefined),
      },
      module: soccerModule,
      strategy: soccerFindTheEdgeStrategy,
      scoutingInput: normalizedInput,
      modelRequest: request(),
      expectedPromptBundle,
      expectedModel,
      calculationReferences: [calculation],
      signal: controller.signal,
    });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "ABORTED" });
  });

  it("rejects model-authored classification in deterministic sections", async () => {
    await expect(
      generateValidatedScoutingReport({
        provider: createFakeReportModelAdapter({
          output: {
            schemaId: "scout-report/soccer",
            schemaVersion: "1",
            sections: [{ key: "final-plays", classification: "summary" }],
          },
        }),
        module: soccerModule,
        strategy: soccerFindTheEdgeStrategy,
        scoutingInput: normalizedInput,
        modelRequest: request(),
        expectedPromptBundle,
        expectedModel,
        calculationReferences: [calculation],
      }),
    ).rejects.toMatchObject({ code: "FORGED_AUTHORITY" });
  });

  it.each([
    {
      metadata: {
        ...expectedModel,
        usage: { inputUnits: 1, outputUnits: 1, totalUnits: 2, extra: 1 },
        latencyMilliseconds: 1,
      },
    },
    {
      metadata: {
        ...expectedModel,
        usage: { inputUnits: 1, outputUnits: 1, totalUnits: 2 },
        latencyMilliseconds: 1,
        extra: 1,
      },
    },
  ])(
    "rejects extra provider metadata keys as invalid results",
    async ({ metadata }) => {
      await expect(
        generateValidatedScoutingReport({
          provider: {
            generate() {
              return Promise.resolve({
                output: {
                  schemaId: "scout-report/soccer",
                  schemaVersion: "1",
                  sections: [],
                },
                metadata,
              });
            },
          },
          module: soccerModule,
          strategy: soccerFindTheEdgeStrategy,
          scoutingInput: normalizedInput,
          modelRequest: request(),
          expectedPromptBundle,
          expectedModel,
          calculationReferences: [calculation],
        }),
      ).rejects.toMatchObject({ code: "INVALID_RESULT" });
    },
  );

  it("keeps draft identity stable across usage and latency changes", async () => {
    const output = {
      schemaId: "scout-report/soccer",
      schemaVersion: "1",
      sections: [],
    };
    const generate = (inputUnits: number, latencyMilliseconds: number) =>
      generateValidatedScoutingReport({
        provider: createFakeReportModelAdapter({
          output,
          metadata: {
            usage: {
              inputUnits,
              outputUnits: 2,
              totalUnits: inputUnits + 2,
            },
            latencyMilliseconds,
          },
        }),
        module: soccerModule,
        strategy: soccerFindTheEdgeStrategy,
        scoutingInput: normalizedInput,
        modelRequest: request(),
        expectedPromptBundle,
        expectedModel,
        calculationReferences: [calculation],
      });
    const first = await generate(1, 5);
    const second = await generate(99, 500);
    expect(first.model.usage).not.toEqual(second.model.usage);
    expect(first.model.latencyMilliseconds).not.toBe(
      second.model.latencyMilliseconds,
    );
    expect(first.draftHash).toBe(second.draftHash);
  });

  it("treats non-available calculation states as unusable narrative support", async () => {
    const invalidFairValue = createReportCalculationReference({
      id: "fair-invalid",
      kind: "fair-value",
      canonicalEventId: "event-1",
      canonicalEventVersion: "1",
      sportKey: "soccer",
      marketKey: "moneyline",
      selectionKey: "club-a",
      snapshots: [snapshot],
      calculationInput: {
        fairProbability: 2,
        offeredAmerican: 120,
        stake: 10,
        fractionalKellyMultiplier: 0.25,
      },
      result: calculateFairValue({
        fairProbability: 2,
        offeredAmerican: 120,
        stake: 10,
        fractionalKellyMultiplier: 0.25,
      }),
    });
    await expect(
      generateValidatedScoutingReport({
        provider: createFakeReportModelAdapter({
          output: {
            schemaId: "scout-report/soccer",
            schemaVersion: "1",
            sections: [
              {
                key: "betting-market-analysis",
                narrative: "Market evidence is currently limited.",
                calculationCitations: [invalidFairValue.id],
              },
            ],
          },
        }),
        module: soccerModule,
        strategy: soccerFindTheEdgeStrategy,
        scoutingInput: normalizedInput,
        modelRequest: request([invalidFairValue]),
        expectedPromptBundle,
        expectedModel,
        calculationReferences: [invalidFairValue],
      }),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_CITATION" });
  });

  it("bounds canonical serialization failures during draft hashing", async () => {
    const references = Array.from({ length: 80 }, (_, index) =>
      createReportCalculationReference({
        id: `qualification-club-a-${index}`,
        kind: "qualification",
        canonicalEventId: "event-1",
        canonicalEventVersion: "1",
        sportKey: "soccer",
        marketKey: "moneyline",
        selectionKey: "club-a",
        snapshots: qualificationSnapshots,
        calculationInput: qualificationInput,
        result: qualification,
      }),
    );
    let providerCalled = false;
    await expect(
      generateValidatedScoutingReport({
        provider: {
          generate() {
            providerCalled = true;
            return createFakeReportModelAdapter({
              output: {
                schemaId: "scout-report/soccer",
                schemaVersion: "1",
                sections: [],
              },
            }).generate(request(references));
          },
        },
        module: soccerModule,
        strategy: soccerFindTheEdgeStrategy,
        scoutingInput: normalizedInput,
        modelRequest: request(references),
        expectedPromptBundle,
        expectedModel,
        calculationReferences: references,
      }),
    ).rejects.toMatchObject({ code: "INVALID_CONTEXT" });
    expect(providerCalled).toBe(false);
    // Eighty references means eighty real hashes. The work is deliberate and
    // the assertion is exact; only the clock needs the extra room, and CI's
    // runner crossed the default at 5.2s.
  }, 30_000);

  it("rejects an invalid expected model identity before calling the provider", async () => {
    let providerCalled = false;
    await expect(
      generateValidatedScoutingReport({
        provider: {
          generate() {
            providerCalled = true;
            throw new Error("must not run");
          },
        },
        module: soccerModule,
        strategy: soccerFindTheEdgeStrategy,
        scoutingInput: normalizedInput,
        modelRequest: request(),
        expectedPromptBundle,
        expectedModel: { ...expectedModel, modelId: "not valid whitespace" },
        calculationReferences: [calculation],
      }),
    ).rejects.toMatchObject({ code: "INVALID_CONTEXT" });
    expect(providerCalled).toBe(false);
  });

  it("enforces the total narrative limit in UTF-8 bytes", async () => {
    await expect(
      generateValidatedScoutingReport({
        provider: createFakeReportModelAdapter({
          output: {
            schemaId: "scout-report/soccer",
            schemaVersion: "1",
            sections: soccerModule.scoutingReportContract.sections
              .slice(0, 9)
              .map(({ key }) => ({ key, narrative: "😀".repeat(1_024) })),
          },
        }),
        module: soccerModule,
        strategy: soccerFindTheEdgeStrategy,
        scoutingInput: normalizedInput,
        modelRequest: request(),
        expectedPromptBundle,
        expectedModel,
        calculationReferences: [calculation],
      }),
    ).rejects.toMatchObject({ code: "UNSAFE_CONTENT" });
  });

  it("accepts a legitimate draft at the exact total narrative byte limit", async () => {
    const boundaryModule = {
      ...soccerModule,
      scoutingReportContract: {
        ...soccerModule.scoutingReportContract,
        sections: Array.from({ length: 8 }, (_, index) => ({
          key: `boundary-${index}`,
          title: `Boundary ${index}`,
          availability: "evidence" as const,
          content: "narrative" as const,
          allowedFactCategories: ["fixture"] as const,
          allowedCalculationKinds: [] as const,
        })),
      },
    };
    const report = await generateValidatedScoutingReport({
      provider: createFakeReportModelAdapter({
        output: {
          schemaId: "scout-report/soccer",
          schemaVersion: "1",
          sections: boundaryModule.scoutingReportContract.sections.map(
            ({ key }) => ({
              key,
              narrative: "x".repeat(4_096),
              factCitations: ["fact-fixture"],
            }),
          ),
        },
      }),
      module: boundaryModule,
      strategy: soccerFindTheEdgeStrategy,
      scoutingInput: normalizedInput,
      modelRequest: request([]),
      expectedPromptBundle,
      expectedModel,
      calculationReferences: [],
    });
    expect(
      report.sections.reduce(
        (total, section) => total + (section.narrative?.length ?? 0),
        0,
      ),
    ).toBe(32_768);
  });

  it("maps unknown provider failures to a bounded invalid-result error", async () => {
    await expect(
      generateValidatedScoutingReport({
        provider: {
          generate() {
            return Promise.reject(new Error("provider leaked payload details"));
          },
        },
        module: soccerModule,
        strategy: soccerFindTheEdgeStrategy,
        scoutingInput: normalizedInput,
        modelRequest: request(),
        expectedPromptBundle,
        expectedModel,
        calculationReferences: [calculation],
      }),
    ).rejects.toMatchObject({
      code: "INVALID_RESULT",
      message: "Report model provider invalid_result",
    });
  });

  it("aborts a pending fake output factory", async () => {
    const controller = new AbortController();
    const pending = createFakeReportModelAdapter({
      outputFactory: () => new Promise<never>(() => undefined),
    }).generate(request(), { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "ABORTED" });
  });

  it("rejects tampered calculation reference hashes", async () => {
    await expect(
      generateValidatedScoutingReport({
        provider: createFakeReportModelAdapter({ output: {} }),
        module: soccerModule,
        strategy: soccerFindTheEdgeStrategy,
        scoutingInput: normalizedInput,
        modelRequest: request(),
        expectedPromptBundle,
        expectedModel,
        calculationReferences: [
          { ...calculation, referenceHash: "f".repeat(64) },
        ],
      }),
    ).rejects.toMatchObject({ code: "INVALID_CONTEXT" });
  });

  it("canonicalizes equivalent calculation-reference order", async () => {
    const secondCalculation = createReportCalculationReference({
      id: "qualification-club-a-second",
      kind: "qualification",
      canonicalEventId: "event-1",
      canonicalEventVersion: "1",
      sportKey: "soccer",
      marketKey: "moneyline",
      selectionKey: "club-a",
      snapshots: qualificationSnapshots,
      calculationInput: qualificationInput,
      result: qualification,
    });
    const references = [calculation, secondCalculation];
    const modelRequest = request(references);
    const generate = (calculationReferences: typeof references) =>
      generateValidatedScoutingReport({
        provider: createFakeReportModelAdapter({
          output: {
            schemaId: "scout-report/soccer",
            schemaVersion: "1",
            sections: [],
          },
        }),
        module: soccerModule,
        strategy: soccerFindTheEdgeStrategy,
        scoutingInput: normalizedInput,
        modelRequest,
        expectedPromptBundle,
        expectedModel,
        calculationReferences,
      });
    const first = await generate(references);
    const reversed = await generate([...references].reverse());
    expect(reversed.draftHash).toBe(first.draftHash);
    expect(reversed.sections.at(-1)?.calculations.map(({ id }) => id)).toEqual(
      first.sections.at(-1)?.calculations.map(({ id }) => id),
    );
  });

  it("treats citation arrays as canonical sets", async () => {
    const input = {
      ...normalizedInput,
      facts: [
        ...normalizedInput.facts,
        {
          ...normalizedInput.facts[0]!,
          id: "fact-fixture-second",
          value: { competitionKey: "mls", phase: "regular-season" },
        },
      ],
    } as NormalizedScoutingInput;
    const modelRequest = buildReportPromptRequest({
      schema: {
        id: soccerModule.scoutingReportContract.schemaId,
        version: soccerModule.scoutingReportContract.schemaVersion,
      },
      sportKey: "soccer",
      moduleVersion: soccerModule.metadata.version,
      strategy: soccerFindTheEdgeStrategy,
      promptBundle: expectedPromptBundle,
      scoutingInput: input,
      calculationReferences: [calculation],
    });
    const generate = (factCitations: readonly string[]) =>
      generateValidatedScoutingReport({
        provider: createFakeReportModelAdapter({
          output: {
            schemaId: "scout-report/soccer",
            schemaVersion: "1",
            sections: [
              {
                key: "match-snapshot",
                narrative: "The competition context is established.",
                factCitations,
              },
            ],
          },
        }),
        module: soccerModule,
        strategy: soccerFindTheEdgeStrategy,
        scoutingInput: input,
        modelRequest,
        expectedPromptBundle,
        expectedModel,
        calculationReferences: [calculation],
      });
    const ids = ["fact-fixture", "fact-fixture-second"];
    const first = await generate(ids);
    const reversed = await generate([...ids].reverse());
    expect(reversed.draftHash).toBe(first.draftHash);
    expect(reversed.sections[0]?.facts.map(({ id }) => id)).toEqual(ids);
  });

  it("rejects incompatible reference algorithms and outer identity mismatches", async () => {
    const rehash = (material: Omit<typeof calculation, "referenceHash">) => ({
      ...material,
      referenceHash: calculationInputHash(
        "report-calculation-reference-v1",
        material,
      ),
    });
    const material = {
      id: calculation.id,
      kind: calculation.kind,
      canonicalEventId: calculation.canonicalEventId,
      canonicalEventVersion: calculation.canonicalEventVersion,
      sportKey: calculation.sportKey,
      marketKey: calculation.marketKey,
      selectionKey: calculation.selectionKey,
      snapshotIdentities: calculation.snapshotIdentities,
      calculationInput: calculation.calculationInput,
      calculationVersion: calculation.calculationVersion,
      status: calculation.status,
      raw: calculation.raw,
      display: calculation.display,
      provenance: calculation.provenance,
    };
    const incompatible = rehash({ ...material, kind: "fair-value" });
    const snapshotMismatch = rehash({
      ...material,
      snapshotIdentities: material.snapshotIdentities.map((identity) => ({
        ...identity,
        selectionKey: "club-b",
      })),
    });
    for (const candidate of [incompatible, snapshotMismatch]) {
      await expect(
        generateValidatedScoutingReport({
          provider: createFakeReportModelAdapter({ output: {} }),
          module: soccerModule,
          strategy: soccerFindTheEdgeStrategy,
          scoutingInput: normalizedInput,
          modelRequest: request(),
          expectedPromptBundle,
          expectedModel,
          calculationReferences: [candidate],
        }),
      ).rejects.toMatchObject({ code: "INVALID_CONTEXT" });
    }
  });

  it("does not allow unavailable evidence to support narrative", async () => {
    const unavailableInput = {
      ...normalizedInput,
      facts: normalizedInput.facts.map((fact) => ({
        ...fact,
        state: "unavailable",
        unavailableReason: "provider-unavailable",
      })),
    } as unknown as NormalizedScoutingInput;
    const unavailableRequest = buildReportPromptRequest({
      schema: {
        id: soccerModule.scoutingReportContract.schemaId,
        version: soccerModule.scoutingReportContract.schemaVersion,
      },
      sportKey: "soccer",
      moduleVersion: soccerModule.metadata.version,
      strategy: soccerFindTheEdgeStrategy,
      promptBundle: {
        id: "soccer-report",
        version: "1",
        trustedInstructions: ["Use citations only."],
      },
      scoutingInput: unavailableInput,
      calculationReferences: [calculation],
    });
    await expect(
      generateValidatedScoutingReport({
        provider: createFakeReportModelAdapter({
          output: {
            schemaId: "scout-report/soccer",
            schemaVersion: "1",
            sections: [
              {
                key: "match-snapshot",
                narrative: "The competition context is established.",
                factCitations: ["fact-fixture"],
              },
            ],
          },
        }),
        module: soccerModule,
        strategy: soccerFindTheEdgeStrategy,
        scoutingInput: unavailableInput,
        modelRequest: unavailableRequest,
        expectedPromptBundle: {
          ...expectedPromptBundle,
          trustedInstructions: ["Use citations only."],
        },
        expectedModel,
        calculationReferences: [calculation],
      }),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_CITATION" });
  });
});
