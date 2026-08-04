import { describe, expect, it } from "vitest";
import { normalizeFixtureOddsObservation } from "@find-the-edge/domain";
import { MemoryPaperEvaluationRepository } from "./paper-evaluation-repository";
import { MemoryResultRepository } from "./result-repository";
import {
  PaperGradingEvidenceError,
  PaperGradingEvidenceRepository,
} from "./paper-grading-evidence-repository";
import { paperInput } from "./paper-evaluation-test-fixture";
describe("PaperGradingEvidenceRepository", () => {
  it("strongly resolves exact immutable evidence and rejects a stale result", async () => {
    const evaluations = new MemoryPaperEvaluationRepository(),
      persisted = await evaluations.persist(paperInput()),
      snapshot = normalizeFixtureOddsObservation({
        canonicalEventId: "event-1",
        canonicalEventVersion: 1,
        sportKey: "baseball",
        marketKey: "moneyline",
        selectionKey: "home",
        sportsbookId: "sharpapi",
        americanOdds: 120,
        observedAt: "2026-08-03T20:00:00.000Z",
        retrievedAt: "2026-08-03T20:00:01.000Z",
      }),
      results = new MemoryResultRepository(),
      first = await results.persist({
        providerId: "p",
        providerEventId: "pe",
        canonicalEventId: "event-1" as never,
        canonicalEventVersion: 1,
        sportKey: "baseball" as never,
        leagueKey: "mlb",
        state: "final",
        scoreScope: "regulation",
        scores: [
          { participantId: "away" as never, score: 2 },
          { participantId: "home" as never, score: 3 },
        ],
        providerRevision: {
          providerId: "p",
          updatedAt: "2026-08-03T22:00:00.000Z" as never,
          authorityRank: 1,
          sequence: 1,
          token: "1",
        },
        providerTimestamp: "2026-08-03T22:00:00.000Z" as never,
        retrievedAt: "2026-08-03T22:01:00.000Z" as never,
        sourceProvenance: "fixture",
      }),
      repository = new PaperGradingEvidenceRepository(
        evaluations,
        {
          getExact: (pk, sk) =>
            Promise.resolve(
              pk === snapshot.partitionKey && sk === snapshot.sortKey
                ? { pk, sk, value: snapshot }
                : null,
            ),
        },
        results,
      );
    await expect(
      repository.read(
        persisted.pair.paperBet!.paperBetId,
        first.observation.id,
      ),
    ).resolves.toMatchObject({
      odds: { snapshotId: snapshot.snapshotId },
      result: { id: first.observation.id },
    });
    let resultReadsBeforeOdds = 0;
    const missingOdds = new PaperGradingEvidenceRepository(
      evaluations,
      { getExact: () => Promise.resolve(null) },
      {
        current: () => {
          resultReadsBeforeOdds++;
          return Promise.resolve(first.observation);
        },
        exact: () => Promise.resolve(first.observation),
      },
    );
    await expect(
      missingOdds.read(
        persisted.pair.paperBet!.paperBetId,
        first.observation.id,
      ),
    ).rejects.toThrow("odds-evidence-substituted");
    expect(resultReadsBeforeOdds).toBe(0);
    const { id: _firstId, ...firstMaterial } = first.observation;
    void _firstId;
    const correction = await results.persist({
      ...firstMaterial,
      providerRevision: {
        ...first.observation.providerRevision,
        sequence: 2,
        token: "2",
      },
      scores: [
        { participantId: "away" as never, score: 4 },
        { participantId: "home" as never, score: 3 },
      ],
    });
    await expect(
      repository.read(
        persisted.pair.paperBet!.paperBetId,
        first.observation.id,
      ),
    ).rejects.toBeInstanceOf(PaperGradingEvidenceError);
    await expect(
      repository.read(
        persisted.pair.paperBet!.paperBetId,
        correction.observation.id,
      ),
    ).resolves.toBeTruthy();
    let fenceRead = 0;
    const changedDuringRead = new PaperGradingEvidenceRepository(
      evaluations,
      {
        getExact: (pk, sk) => Promise.resolve({ pk, sk, value: snapshot }),
      },
      {
        current: () =>
          Promise.resolve(
            fenceRead++ === 0 ? first.observation : correction.observation,
          ),
        exact: () => Promise.resolve(first.observation),
      },
    );
    await expect(
      changedDuringRead.read(
        persisted.pair.paperBet!.paperBetId,
        first.observation.id,
      ),
    ).rejects.toThrow("result-current-changed");
  });
});
