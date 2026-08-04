import {
  normalizeFixtureOddsObservation,
  EvaluationManifestInput,
  PaperEvaluationInput,
} from "@find-the-edge/domain";

export const paperInput = (
  decision: "play" | "no-bet" = "play",
): PaperEvaluationInput => {
  const snapshot = normalizeFixtureOddsObservation({
    canonicalEventId: "event-1",
    canonicalEventVersion: 1,
    sportKey: "baseball",
    marketKey: "moneyline",
    selectionKey: "home",
    sportsbookId: "sharpapi",
    americanOdds: 120,
    observedAt: "2026-08-03T20:00:00.000Z",
    retrievedAt: "2026-08-03T20:00:01.000Z",
  });
  const manifest: EvaluationManifestInput = {
    mode: "decision-time",
    sportKey: "baseball",
    leagueKey: "mlb",
    eventId: "event-1",
    marketKey: "moneyline",
    selectionKey: "home",
    offeredOdds: {
      partitionKey: snapshot.partitionKey,
      sortKey: snapshot.sortKey,
      snapshotId: snapshot.snapshotId,
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
    evidenceCompleteness: "complete",
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
  };
  return {
    manifest,
    decision,
    reasonCodes: [decision === "play" ? "positive-ev" : "insufficient-edge"],
    createdAt: "2026-08-03T21:00:00.000Z",
  };
};
