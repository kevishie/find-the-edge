import { describe, expect, it } from "vitest";
import { normalizeFixtureOddsObservation } from "@find-the-edge/domain";
import { CALCULATION_VERSION } from "@find-the-edge/odds";
import { composePrompt } from "@find-the-edge/scouting";
import { mlbFindTheEdgeStrategy, mlbModule } from "@find-the-edge/sports";
import { MemoryPaperEvaluationRepository } from "./paper-evaluation-repository";
import { paperInput } from "./paper-evaluation-test-fixture";

describe("paper evaluation fixture round trip", () => {
  it("reconstructs exact odds and registered decision versions", async () => {
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
    const base = paperInput();
    const prompt = composePrompt(
      "mlb-pregame",
      "1.0.0",
      "scouting-model-2026-08",
      [
        { id: "shared", version: "1", kind: "shared", content: "Shared." },
        {
          id: "mlb",
          version: mlbModule.metadata.version,
          kind: "sport",
          content: "MLB.",
        },
        {
          id: mlbFindTheEdgeStrategy.id,
          version: mlbFindTheEdgeStrategy.version,
          kind: "strategy",
          content: "Strategy.",
        },
        { id: "pregame", version: "1", kind: "analysis", content: "Analyze." },
      ],
    );
    const input = {
      ...base,
      manifest: {
        ...base.manifest,
        offeredOdds: {
          partitionKey: snapshot.partitionKey,
          sortKey: snapshot.sortKey,
          snapshotId: snapshot.snapshotId,
        },
        versions: {
          ...base.manifest.versions,
          sportModule: {
            id: mlbModule.key,
            version: mlbModule.metadata.version,
          },
          strategy: {
            id: mlbFindTheEdgeStrategy.id,
            version: mlbFindTheEdgeStrategy.version,
          },
          model: { id: "scouting-model", version: prompt.modelVersion },
          promptBundle: { id: prompt.id, version: prompt.version },
          calculation: {
            id: "edge-calculation",
            version: CALCULATION_VERSION,
          },
        },
      },
    };
    const repository = new MemoryPaperEvaluationRepository();
    const persisted = await repository.persist(input);
    const evaluation = await repository.getEvaluation(
      persisted.pair.evaluation.evaluationId,
    );
    const paperBet = await repository.getPaperBet(
      persisted.pair.paperBet!.paperBetId,
    );
    expect(evaluation?.manifest.offeredOdds).toEqual({
      partitionKey: snapshot.partitionKey,
      sortKey: snapshot.sortKey,
      snapshotId: snapshot.snapshotId,
    });
    expect(evaluation?.manifest.versions).toEqual(input.manifest.versions);
    expect(paperBet?.offeredOdds.snapshotId).toBe(snapshot.snapshotId);
  });
});
