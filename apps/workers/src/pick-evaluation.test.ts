import { describe, expect, it } from "vitest";
import { defaultEvaluationPolicy } from "@find-the-edge/config";
import {
  MemoryEvaluationAttemptRepository,
  MemoryEvaluationEvidenceRepository,
  MemoryPaperEvaluationRepository,
  type EvaluationEvidenceResult,
} from "@find-the-edge/database";
import { normalizeFixtureOddsObservation } from "@find-the-edge/domain";
import {
  DisabledStructuredAnalysisModelAdapter,
  FakeStructuredAnalysisModelAdapter,
  normalizeAnalysisRequest,
  type AnalysisPolicyLike,
  type StructuredAnalysisModelAdapter,
} from "@find-the-edge/scouting";
import {
  PickEvaluationService,
  type SafeEvaluationTelemetry,
} from "./pick-evaluation";

const policy: AnalysisPolicyLike = {
  enabled: true,
  sportKey: "mlb",
  leagueKeys: ["mlb"],
  markets: [
    {
      marketKey: "moneyline",
      outcomeStructure: "two-way",
      selectionKinds: ["participant"],
      requiresPoint: false,
      legacyMarketAliases: [],
    },
  ],
  evidenceRequirements: [
    { category: "form", level: "hard", maximumAgeMinutes: 60 },
  ],
  probability: {
    minimum: 0.05,
    maximum: 0.95,
    maximumRangeWidth: 0.2,
    maximumUncertainty: 0.2,
  },
  contraindications: [],
  prohibitedClaims: ["lock"],
  versions: {
    contractVersion: "mlb@1",
    promptBundleId: "mlb",
    promptBundleVersion: "1",
    promptSections: {
      shared: { id: "shared", version: "1" },
      sport: { id: "mlb", version: "1" },
      strategy: { id: "fte", version: "1" },
      analysis: { id: "ml", version: "1" },
    },
    inputSchemaId: "input/mlb",
    inputSchemaVersion: "1",
    outputSchemaId: "output/mlb",
    outputSchemaVersion: "1",
    modelId: "model",
    modelVersion: "1",
  },
};
const strategy = { id: "fte", version: "1", prohibitedMarketKeys: [] };
const request = normalizeAnalysisRequest(
  {
    sportKey: "mlb",
    leagueKey: "mlb",
    eventId: "event",
    participantIds: ["away", "home"],
    startsAt: "2026-08-04T02:00:00.000Z",
    asOf: "2026-08-04T00:00:00.000Z",
    candidate: {
      marketKey: "moneyline",
      outcomeStructure: "two-way",
      selection: { kind: "participant", participantId: "home" },
    },
    evidence: [
      {
        id: "form",
        category: "form",
        status: "verified",
        observedAt: "2026-08-03T23:55:00.000Z",
        facts: { rating: 0.7 },
      },
    ],
  },
  policy,
  strategy,
);
const snapshot = (
  sportsbookId: string,
  selectionKey: string,
  americanOdds: number,
) =>
  normalizeFixtureOddsObservation({
    canonicalEventId: "event",
    canonicalEventVersion: 1,
    sportKey: "mlb",
    marketKey: "moneyline",
    selectionKey,
    sportsbookId,
    americanOdds,
    observedAt: "2026-08-03T23:58:00.000Z",
    retrievedAt: "2026-08-03T23:59:00.000Z",
  });
const offered = {
  sportsbookId: "hardrock",
  snapshots: [
    snapshot("hardrock", "away", -130),
    snapshot("hardrock", "home", 120),
  ],
};
const comparisons = [
  {
    sportsbookId: "draftkings",
    snapshots: [
      snapshot("draftkings", "away", -120),
      snapshot("draftkings", "home", 110),
    ],
  },
  {
    sportsbookId: "fanduel",
    snapshots: [
      snapshot("fanduel", "away", -115),
      snapshot("fanduel", "home", 105),
    ],
  },
  {
    sportsbookId: "betmgm",
    snapshots: [
      snapshot("betmgm", "away", -118),
      snapshot("betmgm", "home", 108),
    ],
  },
];
const output = {
  candidate: request.candidate,
  versions: policy.versions,
  probability: { estimate: 0.58, low: 0.55, high: 0.61, uncertainty: 0.03 },
  status: "complete",
  abstentionCodes: [],
  summary: "Home rates above market.",
  assertions: [
    {
      text: "Home rates above market.",
      classification: "factual",
      citationIds: ["form"],
    },
  ],
};
const modelResult = {
  output,
  model: { id: "model", version: "1", deploymentId: "fixture" },
  usage: { inputTokens: 10, outputTokens: 10, latencyMs: 1 },
};
const service = (
  model: StructuredAnalysisModelAdapter = new FakeStructuredAnalysisModelAdapter(
    modelResult,
  ),
  evidenceResult: EvaluationEvidenceResult = {
    status: "ready",
    reasonCodes: [],
    offered,
    comparisons,
  },
  telemetry?: SafeEvaluationTelemetry,
) => {
  const attempts = new MemoryEvaluationAttemptRepository();
  const evaluations = new MemoryPaperEvaluationRepository();
  return {
    attempts,
    evaluations,
    service: new PickEvaluationService({
      evidence: new MemoryEvaluationEvidenceRepository(evidenceResult),
      model,
      attempts,
      evaluations,
      ...(telemetry ? { telemetry } : {}),
    }),
  };
};
const input = {
  request,
  analysisPolicy: policy,
  strategy,
  evaluationPolicy: defaultEvaluationPolicy,
  eventVersion: 1,
  selectionKeys: ["away", "home"],
  comparisonSportsbookIds: ["draftkings", "fanduel", "betmgm"],
  promptHash: "c".repeat(64),
} as const;

describe("pick evaluation service", () => {
  it("persists reproducible Play and converges exact retries", async () => {
    const fixture = service();
    const first = await fixture.service.evaluate(input);
    const second = await fixture.service.evaluate(input);
    expect(first.terminal).toBe("evaluation");
    expect(
      first.terminal === "evaluation" && first.pair.evaluation.decision,
    ).toBe("play");
    expect(second.terminal === "evaluation" && second.outcome).toBe(
      "duplicate",
    );
    if (first.terminal !== "evaluation") throw new Error("expected evaluation");
    const expectedInputHash =
      "3962d85067338a4cb1df22b52b212b9a3841f23686dc85fef2a8cddd1cc5a8ec";
    expect(first.pair.evaluation).toMatchObject({
      evaluationId: `evaluation:${expectedInputHash}`,
      inputHash: expectedInputHash,
      decision: "play",
      reasonCodes: ["positive-ev-qualified"],
      manifest: {
        inputHash: expectedInputHash,
        consensusProvenance: {
          disagreementWarningThreshold:
            defaultEvaluationPolicy.disagreementWarningThreshold,
          disagreementBlockThreshold:
            defaultEvaluationPolicy.disagreementBlockThreshold,
          marketDisagreement: 0.010_881_111_518_467_379,
        },
      },
    });
    expect(first.pair.paperBet?.paperBetId).toBe(
      `paper-bet:${expectedInputHash}`,
    );
    expect(first.pair.evaluation.manifest.gradingTerms).toEqual({
      schemaVersion: "1",
      canonicalEventVersion: 1,
      participants: ["away", "home"],
      market: { kind: "moneyline", outcomeCount: 2, resultScope: "full-event" },
    });
    expect(first.pair.evaluation.manifest.expectedValue).toBeCloseTo(0.21, 12);
    expect(first.pair.evaluation.manifest.versions.calculation).toEqual({
      id: "qualification",
      version: "deterministic-qualification-v1",
    });
    expect(first.pair.evaluation.manifest.versions.manifestSchema).toEqual({
      id: "paper-evaluation",
      version: "3",
    });
    const persistedProvenance =
      first.pair.evaluation.manifest.calculationProvenance;
    expect(persistedProvenance).toMatchObject({
      hashStrategyVersion: "calculation-input-sha256-v1",
      precisionPolicyVersion: "display-precision-v1",
      root: {
        algorithm: {
          id: "qualification",
          version: "deterministic-qualification-v1",
        },
      },
    });
    expect(
      persistedProvenance?.components.map(({ algorithm }) => algorithm),
    ).toEqual([
      { id: "market-disagreement", version: "market-disagreement-v1" },
      { id: "market-outlier", version: "market-outlier-v1" },
      { id: "weighted-consensus", version: "weighted-consensus-v2" },
    ]);
    for (const component of persistedProvenance?.components ?? []) {
      expect(component.inputHash).toMatch(/^[a-f0-9]{64}$/);
    }
  });
  it("canonicalizes selection order and binds the complete evidence vectors", async () => {
    const fixture = service();
    const first = await fixture.service.evaluate({
      ...input,
      selectionKeys: ["home", "away"],
    });
    const second = await fixture.service.evaluate(input);
    expect(second.terminal === "evaluation" && second.outcome).toBe(
      "duplicate",
    );
    if (first.terminal !== "evaluation") throw new Error("expected evaluation");
    expect(
      first.pair.evaluation.manifest.comparisonOutcomeEvidence,
    ).toHaveLength(6);
    expect(first.pair.evaluation.decision).toBe("play");
    expect(first.pair.evaluation.manifest.noVigProbability).toBeCloseTo(
      0.471_159_935_342_345_2,
      12,
    );
    expect(first.pair.evaluation.manifest.consensusProvenance).toMatchObject({
      includedSportsbookIds: ["betmgm", "draftkings", "fanduel"],
      conservativeProbability: "interval-low",
    });
    expect(first.pair.evaluation.manifest.comparisonEvidence).toHaveLength(3);
  });
  it("changes failed-attempt identity when exact evidence materially changes", async () => {
    let reads = 0;
    const changedOffered = {
      sportsbookId: "hardrock",
      snapshots: [
        snapshot("hardrock", "away", -125),
        snapshot("hardrock", "home", 115),
      ],
    };
    const attempts = new MemoryEvaluationAttemptRepository();
    const evaluations = new MemoryPaperEvaluationRepository();
    const evaluator = new PickEvaluationService({
      evidence: {
        read: () => {
          reads += 1;
          return Promise.resolve({
            status: "ready" as const,
            reasonCodes: [],
            offered: reads === 1 ? offered : changedOffered,
            comparisons,
          });
        },
      },
      model: new DisabledStructuredAnalysisModelAdapter(),
      attempts,
      evaluations,
    });
    const first = await evaluator.evaluate(input);
    const second = await evaluator.evaluate(input);
    expect(first.terminal === "attempt" && second.terminal === "attempt").toBe(
      true,
    );
    expect(first.terminal === "attempt" && first.attemptId).not.toBe(
      second.terminal === "attempt" ? second.attemptId : "",
    );
  });
  it("persists deterministic No Bet for negative conservative EV", async () => {
    const fixture = service(
      new FakeStructuredAnalysisModelAdapter({
        ...modelResult,
        output: {
          ...output,
          probability: {
            estimate: 0.43,
            low: 0.4,
            high: 0.46,
            uncertainty: 0.03,
          },
        },
      }),
    );
    const result = await fixture.service.evaluate(input);
    expect(
      result.terminal === "evaluation" && result.pair.evaluation.decision,
    ).toBe("no-bet");
    expect(result.terminal === "evaluation" && result.pair.paperBet).toBeNull();
  });
  it("persists a scheduled shadow Play without a paper-bet record", async () => {
    const runHash = "a".repeat(64);
    const result = await service().service.evaluate({
      ...input,
      execution: {
        mode: "shadow",
        runId: `paper-pick-run:${runHash}`,
        itemId: `paper-pick-item:${runHash}:${"b".repeat(64)}`,
        policyId: "schedule",
        policyVersion: "1",
        scheduledFor: "2026-08-04T00:00:00.000Z",
      },
    });
    expect(result.terminal).toBe("evaluation");
    expect(
      result.terminal === "evaluation" && result.pair.evaluation.decision,
    ).toBe("play");
    expect(result.terminal === "evaluation" && result.pair.paperBet).toBeNull();
  });
  it("binds scheduled run provenance to a model-disabled attempt", async () => {
    const fixture = service(new DisabledStructuredAnalysisModelAdapter());
    const runHash = "d".repeat(64);
    const result = await fixture.service.evaluate({
      ...input,
      execution: {
        mode: "shadow",
        runId: `paper-pick-run:${runHash}`,
        itemId: `paper-pick-item:${runHash}:${"e".repeat(64)}`,
        policyId: "schedule",
        policyVersion: "1",
        scheduledFor: "2026-08-04T00:00:00.000Z",
      },
    });
    expect(result.terminal).toBe("attempt");
    if (result.terminal !== "attempt") throw new Error("expected attempt");
    expect(
      (await fixture.attempts.get(result.attemptId))?.execution,
    ).toMatchObject({
      mode: "shadow",
      runId: `paper-pick-run:${runHash}`,
    });
  });
  it("records evidence abstention without invoking the model", async () => {
    const model = new FakeStructuredAnalysisModelAdapter(modelResult);
    const fixture = service(model, {
      status: "invalid",
      reasonCodes: ["offered-stale"],
      offered: null,
      comparisons: [],
    });
    const result = await fixture.service.evaluate(input);
    expect(result).toMatchObject({
      terminal: "attempt",
      reasonCode: "offered-stale",
    });
    expect(model.calls).toHaveLength(0);
  });
  it("preserves every evidence failure reason", async () => {
    const result = await service(undefined, {
      status: "invalid",
      reasonCodes: [
        "comparison-sparse",
        "comparison-incomplete",
        "comparison-stale",
      ],
      offered,
      comparisons: [],
    }).service.evaluate(input);
    expect(result.terminal === "attempt" && result.reasonCodes).toEqual([
      "comparison-incomplete",
      "comparison-sparse",
      "comparison-stale",
    ]);
  });
  it("turns evidence failures and malformed adapter envelopes into terminal attempts", async () => {
    const attempts = new MemoryEvaluationAttemptRepository();
    const evaluations = new MemoryPaperEvaluationRepository();
    const evidenceFailure = new PickEvaluationService({
      evidence: { read: () => Promise.reject(new Error("storage")) },
      model: new FakeStructuredAnalysisModelAdapter(modelResult),
      attempts,
      evaluations,
    });
    expect(await evidenceFailure.evaluate(input)).toMatchObject({
      terminal: "attempt",
      reasonCode: "evidence-read-failed",
    });
    const malformed = service({ analyze: () => Promise.resolve({} as never) });
    expect(await malformed.service.evaluate(input)).toMatchObject({
      terminal: "attempt",
      reasonCode: "model-envelope-invalid",
    });
  });
  it("rejects model-authored decision fields and creates an invalid attempt", async () => {
    const fixture = service(
      new FakeStructuredAnalysisModelAdapter({
        ...modelResult,
        output: { ...output, expectedValue: 1 },
      }),
    );
    expect(await fixture.service.evaluate(input)).toMatchObject({
      terminal: "attempt",
      reasonCode: "model-invalid:unknown_field",
    });
  });
  it("fails closed when the production model is disabled", async () => {
    const fixture = service(new DisabledStructuredAnalysisModelAdapter());
    expect(await fixture.service.evaluate(input)).toMatchObject({
      terminal: "attempt",
      reasonCode: "model-disabled",
    });
  });
  it("records adapter throws and timeouts without fabricating probability", async () => {
    const throwing: StructuredAnalysisModelAdapter = {
      analyze: () => Promise.reject(new Error("provider down")),
    };
    expect(await service(throwing).service.evaluate(input)).toMatchObject({
      terminal: "attempt",
      reasonCode: "model-failed",
    });
    const hanging: StructuredAnalysisModelAdapter = {
      analyze: () => new Promise(() => undefined),
    };
    expect(
      await service(hanging).service.evaluate({ ...input, timeoutMs: 1 }),
    ).toMatchObject({ terminal: "attempt", reasonCode: "model-timeout" });
  });
  it("isolates telemetry failure after persistence", async () => {
    const fixture = service(undefined, undefined, {
      emit: () => {
        throw new Error("metrics down");
      },
    });
    await expect(fixture.service.evaluate(input)).resolves.toMatchObject({
      terminal: "evaluation",
    });
  });
  it("emits only bounded calculation version and hash telemetry", async () => {
    const events: Parameters<SafeEvaluationTelemetry["emit"]>[0][] = [];
    const fixture = service(undefined, undefined, {
      emit: (event) => events.push(event),
    });
    await fixture.service.evaluate(input);
    expect(events).toHaveLength(1);
    expect(events[0]?.calculationVersion).toBe(
      "deterministic-qualification-v1",
    );
    expect(events[0]?.calculationInputHash).toMatch(/^[a-f0-9]{64}$/);
    expect(events[0]?.calculationHashStrategyVersion).toBe(
      "calculation-input-sha256-v1",
    );
    expect(JSON.stringify(events[0])).not.toMatch(/api[_-]?key|prompt/i);
  });
  it("prevents fail-then-success from creating conflicting terminals", async () => {
    let calls = 0;
    const adapter: StructuredAnalysisModelAdapter = {
      analyze: () => {
        calls += 1;
        return calls === 1
          ? Promise.reject(new Error("temporary"))
          : Promise.resolve(modelResult);
      },
    };
    const fixture = service(adapter);
    await expect(fixture.service.evaluate(input)).resolves.toMatchObject({
      terminal: "attempt",
    });
    await expect(fixture.service.evaluate(input)).rejects.toThrow(
      "evaluation-terminal-conflict",
    );
    expect(
      await fixture.evaluations.getEvaluation(`evaluation:${"0".repeat(64)}`),
    ).toBeNull();
  });
  it("produces a reproducible three-way soccer Play", async () => {
    const soccerPolicy: AnalysisPolicyLike = {
      ...policy,
      sportKey: "soccer",
      leagueKeys: ["mls"],
      markets: [
        {
          marketKey: "moneyline",
          outcomeStructure: "three-way",
          selectionKinds: ["participant", "draw"],
          requiresPoint: false,
          legacyMarketAliases: [],
        },
      ],
      versions: {
        ...policy.versions,
        contractVersion: "soccer@1",
        inputSchemaId: "input/soccer",
        outputSchemaId: "output/soccer",
      },
    };
    const soccerRequest = normalizeAnalysisRequest(
      {
        sportKey: "soccer",
        leagueKey: "mls",
        eventId: "soccer-event",
        participantIds: ["away", "home"],
        startsAt: "2026-08-04T02:00:00.000Z",
        asOf: "2026-08-04T00:00:00.000Z",
        candidate: {
          marketKey: "moneyline",
          outcomeStructure: "three-way",
          selection: { kind: "draw" },
        },
        evidence: [
          {
            id: "form",
            category: "form",
            status: "verified",
            observedAt: "2026-08-03T23:55:00.000Z",
            facts: { rating: 0.5 },
          },
        ],
      },
      soccerPolicy,
      strategy,
    );
    const soccerSnapshot = (book: string, selectionKey: string, odds: number) =>
      normalizeFixtureOddsObservation({
        canonicalEventId: "soccer-event",
        canonicalEventVersion: 1,
        sportKey: "soccer",
        marketKey: "moneyline",
        selectionKey,
        sportsbookId: book,
        americanOdds: odds,
        observedAt: "2026-08-03T23:58:00.000Z",
        retrievedAt: "2026-08-03T23:59:00.000Z",
      });
    const selections = ["away", "draw", "home"];
    const soccerEvidence: EvaluationEvidenceResult = {
      status: "ready",
      reasonCodes: [],
      offered: {
        sportsbookId: "hardrock",
        snapshots: selections.map((selection, index) =>
          soccerSnapshot("hardrock", selection, [240, 260, 220][index]!),
        ),
      },
      comparisons: ["draftkings", "fanduel", "betmgm"].map((book) => ({
        sportsbookId: book,
        snapshots: selections.map((selection, index) =>
          soccerSnapshot(book, selection, [230, 250, 210][index]!),
        ),
      })),
    };
    const soccerOutput = {
      candidate: soccerRequest.candidate,
      versions: soccerPolicy.versions,
      probability: {
        estimate: 0.36,
        low: 0.34,
        high: 0.38,
        uncertainty: 0.02,
      },
      status: "complete",
      abstentionCodes: [],
      summary: "Draw probability exceeds market.",
      assertions: [
        {
          text: "Draw probability exceeds market.",
          classification: "inference",
          citationIds: [],
        },
      ],
    };
    const fixture = service(
      new FakeStructuredAnalysisModelAdapter({
        ...modelResult,
        output: soccerOutput,
      }),
      soccerEvidence,
    );
    const result = await fixture.service.evaluate({
      ...input,
      request: soccerRequest,
      analysisPolicy: soccerPolicy,
      selectionKeys: selections,
    });
    expect(
      result.terminal === "evaluation" && result.pair.evaluation.decision,
    ).toBe("play");
  });
});
