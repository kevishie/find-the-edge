import { describe, expect, it, vi } from "vitest";
import {
  normalizeFixtureOddsObservation,
  type CompletedEventResultObservation,
} from "@find-the-edge/domain";
import {
  MemoryPaperEvaluationRepository,
  MemoryPaperGradeRepository,
  MemoryResultRepository,
  PaperGradingEvidenceRepository,
} from "@find-the-edge/database";
import {
  embeddedPaperGradingTelemetry,
  PaperGradingService,
} from "./paper-grading";
const noTelemetry = { emit: () => undefined };
const persistedPlayInput = (offeredOdds: typeof odds) => ({
  manifest: {
    mode: "decision-time" as const,
    sportKey: "mlb",
    leagueKey: "mlb",
    eventId: "event-1",
    marketKey: "moneyline",
    selectionKey: "home",
    gradingTerms: {
      schemaVersion: "1" as const,
      canonicalEventVersion: 1,
      participants: ["away", "home"] as const,
      market: {
        kind: "moneyline" as const,
        outcomeCount: 2 as const,
        resultScope: "full-event" as const,
      },
    },
    offeredOdds: {
      partitionKey: offeredOdds.partitionKey,
      sortKey: offeredOdds.sortKey,
      snapshotId: offeredOdds.snapshotId,
    },
    comparisonEvidence: [],
    probability: { point: 0.58 },
    uncertainty: 0.04,
    noVigProbability: 0.52,
    expectedValue: 0.08,
    thresholds: {
      minimumExpectedValue: 0.03,
      minimumComparisonBooks: 0,
      maximumPriceAgeMinutes: 15,
    },
    evidenceCompleteness: "complete" as const,
    versions: {
      sportModule: { id: "mlb", version: "1" },
      strategy: { id: "ml", version: "1" },
      model: { id: "model", version: "1" },
      promptBundle: null,
      calculation: { id: "edge", version: "1" },
      inputSchema: { id: "input", version: "1" },
      manifestSchema: { id: "manifest", version: "1" },
    },
    provenanceReferences: ["provider:sharpapi"],
  },
  decision: "play" as const,
  reasonCodes: ["positive-ev"],
  createdAt: "2026-08-03T21:00:00.000Z",
});
const paper = {
  paperBetId: "paper-bet:" + "a".repeat(64),
  evaluationId: "evaluation:" + "a".repeat(64),
  inputHash: "a".repeat(64),
  mode: "decision-time" as const,
  offeredOdds: {
    partitionKey: "FIXTURE_ODDS#x",
    sortKey: "SNAPSHOT#x",
    snapshotId: "b".repeat(64),
  },
  createdAt: "2026-08-04T00:00:00.000Z",
};
const odds = normalizeFixtureOddsObservation({
  canonicalEventId: "event",
  canonicalEventVersion: 1,
  sportKey: "mlb",
  marketKey: "moneyline",
  selectionKey: "away",
  sportsbookId: "book",
  americanOdds: 150,
  observedAt: "2026-08-03T23:00:00.000Z",
  retrievedAt: "2026-08-03T23:01:00.000Z",
});
const result = {
  id: `result:${"c".repeat(64)}`,
  providerId: "p",
  providerEventId: "pe",
  canonicalEventId: "event",
  canonicalEventVersion: 1,
  sportKey: "mlb",
  leagueKey: "mlb",
  state: "final",
  scoreScope: "regulation",
  scores: [
    { participantId: "away", score: 5 },
    { participantId: "home", score: 3 },
  ],
  providerRevision: {
    providerId: "p",
    updatedAt: "2026-08-04T01:00:00.000Z",
    authorityRank: 1,
    sequence: 1,
    token: "1",
  },
  providerTimestamp: "2026-08-04T01:00:00.000Z",
  retrievedAt: "2026-08-04T01:01:00.000Z",
  sourceProvenance: "fixture",
} as const;
const evaluation = {
  evaluationId: paper.evaluationId,
  inputHash: paper.inputHash,
  decision: "play" as const,
  reasonCodes: ["positive-ev"],
  createdAt: paper.createdAt,
  manifest: {
    inputHash: paper.inputHash,
    mode: "decision-time" as const,
    sportKey: "mlb",
    leagueKey: "mlb",
    eventId: "event",
    marketKey: "moneyline",
    selectionKey: "away",
    gradingTerms: {
      schemaVersion: "1" as const,
      canonicalEventVersion: 1,
      participants: ["away", "home"] as const,
      market: {
        kind: "moneyline" as const,
        outcomeCount: 2 as const,
        resultScope: "full-event" as const,
      },
    },
    offeredOdds: paper.offeredOdds,
    comparisonEvidence: [],
    probability: { point: 0.6 },
    uncertainty: 0.1,
    noVigProbability: 0.55,
    expectedValue: 0.1,
    thresholds: {
      minimumExpectedValue: 0.02,
      minimumComparisonBooks: 0,
      maximumPriceAgeMinutes: 15,
    },
    evidenceCompleteness: "complete" as const,
    versions: {} as never,
    provenanceReferences: [],
  },
};
describe("PaperGradingService", () => {
  it("grades, repairs duplicate result replay, and appends a correction", async () => {
    let currentResult = result as unknown as CompletedEventResultObservation;
    const grades = new MemoryPaperGradeRepository(),
      evidence = {
        read: () =>
          Promise.resolve({
            paperBet: paper,
            evaluation,
            odds,
            result: currentResult,
          }),
      },
      service = new PaperGradingService(
        { listPaperBetsByEvent: () => Promise.resolve({ items: [paper] }) },
        evidence as never,
        grades,
        noTelemetry,
      );
    expect((await service.gradeCurrentResult("event", result.id)).graded).toBe(
      1,
    );
    expect(
      (await service.gradeCurrentResult("event", result.id)).duplicate,
    ).toBe(1);
    const correction = {
      ...result,
      id: `result:${"d".repeat(64)}`,
      scores: [
        { participantId: "away", score: 2 },
        { participantId: "home", score: 3 },
      ],
      providerRevision: { ...result.providerRevision, sequence: 2, token: "2" },
    };
    currentResult = correction as unknown as CompletedEventResultObservation;
    expect(
      (await service.gradeCurrentResult("event", correction.id)).regraded,
    ).toBe(1);
    expect(
      (await grades.historyPage(paper.paperBetId, 100)).items.map(
        (g) => g.outcome,
      ),
    ).toEqual(["won", "lost"]);
  });
  it("isolates legacy unresolved and per-pick evidence failure", async () => {
    const grades = new MemoryPaperGradeRepository(),
      legacy = {
        ...evaluation,
        manifest: { ...evaluation.manifest, gradingTerms: undefined },
      },
      service = new PaperGradingService(
        {
          listPaperBetsByEvent: () =>
            Promise.resolve({
              items: [
                paper,
                { ...paper, paperBetId: "paper-bet:" + "c".repeat(64) },
              ],
            }),
        },
        {
          read: (id: string) => {
            if (id.includes("c")) return Promise.reject(new Error("missing"));
            return Promise.resolve({
              paperBet: paper,
              evaluation: legacy,
              odds,
              result,
            });
          },
        } as never,
        grades,
        noTelemetry,
      );
    const counters = await service.gradeCurrentResult("event", result.id);
    expect(counters).toMatchObject({
      unresolved: 1,
      failed: 1,
      failureReasons: { "evidence-invalid": 0, unexpected: 1 },
      failureAudits: [
        { paperBetId: `paper-bet:${"c".repeat(64)}`, code: "unexpected" },
      ],
    });
  });
  it("distinguishes legacy supported records from unsupported sports", async () => {
    const grades = new MemoryPaperGradeRepository(),
      unsupported = {
        ...evaluation,
        manifest: {
          ...evaluation.manifest,
          sportKey: "nfl",
          gradingTerms: undefined,
        },
      },
      service = new PaperGradingService(
        { listPaperBetsByEvent: () => Promise.resolve({ items: [paper] }) },
        {
          read: () =>
            Promise.resolve({
              paperBet: paper,
              evaluation: unsupported,
              odds,
              result,
            }),
        } as never,
        grades,
        noTelemetry,
      );
    expect(await service.gradeCurrentResult("event", result.id)).toMatchObject({
      unresolved: 1,
      failed: 0,
    });
    expect((await grades.current(paper.paperBetId))?.reason).toBe(
      "sport-grading-unsupported",
    );
  });
  it("emits the exact bounded EMF metrics used by grading alarms", () => {
    const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    embeddedPaperGradingTelemetry.emit({
      discovered: 1,
      graded: 1,
      regraded: 2,
      duplicate: 0,
      unresolved: 3,
      stale: 0,
      failed: 4,
      failureReasons: {
        "evidence-invalid": 1,
        "grade-conflict": 1,
        "index-invalid": 1,
        unexpected: 1,
      },
      failureAudits: [
        {
          paperBetId: `paper-bet:${"a".repeat(64)}`,
          code: "evidence-invalid",
        },
      ],
    });
    const rendered = write.mock.calls.map(([value]) => String(value)).join("");
    expect(rendered).toContain('"Namespace":"FindTheEdge/PaperGrading"');
    expect(rendered).toContain('"PaperGradingFailed":4');
    expect(rendered).toContain('"PaperGradingUnresolved":3');
    expect(rendered).toContain('"PaperGradingRegraded":2');
    expect(rendered).toContain('"event":"PaperGradingFailure"');
    expect(rendered).toContain(`"paperBetId":"paper-bet:${"a".repeat(64)}"`);
    expect(rendered).not.toContain("stack");
    write.mockRestore();
  });
  it("settles a real persisted Play, then retains final and correction P/L history", async () => {
    const storedOdds = normalizeFixtureOddsObservation({
      canonicalEventId: "event-1",
      canonicalEventVersion: 1,
      sportKey: "mlb",
      marketKey: "moneyline",
      selectionKey: "home",
      sportsbookId: "sharpapi",
      americanOdds: 120,
      observedAt: "2026-08-03T20:00:00.000Z",
      retrievedAt: "2026-08-03T20:00:01.000Z",
    });
    const evaluations = new MemoryPaperEvaluationRepository();
    const persisted = await evaluations.persist(persistedPlayInput(storedOdds));
    const results = new MemoryResultRepository();
    const first = await results.persist({
      providerId: "fixture",
      providerEventId: "provider-event",
      canonicalEventId: "event-1" as never,
      canonicalEventVersion: 1,
      sportKey: "mlb" as never,
      leagueKey: "mlb",
      state: "final",
      scoreScope: "regulation",
      scores: [
        { participantId: "away" as never, score: 2 },
        { participantId: "home" as never, score: 3 },
      ],
      providerRevision: {
        providerId: "fixture",
        updatedAt: "2026-08-04T01:00:00.000Z" as never,
        authorityRank: 1,
        sequence: 1,
        token: "1",
      },
      providerTimestamp: "2026-08-04T01:00:00.000Z" as never,
      retrievedAt: "2026-08-04T01:01:00.000Z" as never,
      sourceProvenance: "fixture",
    });
    const grades = new MemoryPaperGradeRepository();
    const service = new PaperGradingService(
      evaluations,
      new PaperGradingEvidenceRepository(
        evaluations,
        {
          getExact: (pk, sk) => Promise.resolve({ pk, sk, value: storedOdds }),
        },
        results,
      ),
      grades,
      noTelemetry,
    );
    expect(
      (await service.gradeCurrentResult("event-1", first.observation.id))
        .graded,
    ).toBe(1);
    const { id: _firstId, ...material } = first.observation;
    void _firstId;
    const corrected = await results.persist({
      ...material,
      scores: [
        { participantId: "away" as never, score: 4 },
        { participantId: "home" as never, score: 3 },
      ],
      providerRevision: {
        ...material.providerRevision,
        sequence: 2,
        token: "2",
      },
    });
    expect(
      (await service.gradeCurrentResult("event-1", corrected.observation.id))
        .regraded,
    ).toBe(1);
    const history = await grades.historyPage(
      persisted.pair.paperBet!.paperBetId,
      100,
    );
    expect(history.items.map(({ outcome }) => outcome)).toEqual([
      "won",
      "lost",
    ]);
    expect(history.items[0]!.profit).toBeCloseTo(1.2);
    expect(history.items[1]!.profit).toBe(-1);
    expect(history.items[1]!.supersedesGradeId).toBe(history.items[0]!.gradeId);
  });
});
