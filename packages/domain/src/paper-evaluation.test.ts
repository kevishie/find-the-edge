import { describe, expect, it } from "vitest";
import {
  createPaperEvaluation,
  normalizeEvaluationManifest,
  PaperEvaluationInputError,
  type EvaluationManifestInput,
} from "./paper-evaluation";

const ref = (book: string) => {
  const snapshotId =
    book === "offered"
      ? "a".repeat(64)
      : book === "b"
        ? "b".repeat(64)
        : "c".repeat(64);
  return {
    partitionKey: `FIXTURE_ODDS#${JSON.stringify(["event-1", 1, "baseball", "moneyline", "home", book])}`,
    sortKey: `SNAPSHOT#2026-08-03T20:00:00.000Z#${snapshotId}`,
    snapshotId,
  };
};
export const manifest = (
  override: Partial<EvaluationManifestInput> = {},
): EvaluationManifestInput => ({
  mode: "decision-time",
  sportKey: "baseball",
  leagueKey: "mlb",
  eventId: "event-1",
  marketKey: "moneyline",
  selectionKey: "home",
  offeredOdds: ref("offered"),
  comparisonEvidence: [ref("c"), ref("b")],
  probability: { point: 0.58 },
  uncertainty: 0.04,
  noVigProbability: 0.52,
  expectedValue: 0.08,
  thresholds: {
    minimumExpectedValue: 0.03,
    minimumComparisonBooks: 2,
    maximumPriceAgeMinutes: 15,
  },
  evidenceCompleteness: "complete",
  versions: {
    sportModule: { id: "mlb", version: "1" },
    strategy: { id: "ml", version: "2" },
    model: { id: "model", version: "3" },
    promptBundle: null,
    calculation: { id: "edge", version: "1" },
    inputSchema: { id: "input", version: "1" },
    manifestSchema: { id: "manifest", version: "1" },
  },
  provenanceReferences: ["provider:sharp", "run:1"],
  ...override,
});

describe("paper evaluation domain", () => {
  it("preserves complete comparison vectors and consensus provenance", () => {
    const awayId = "d".repeat(64);
    const away = {
      partitionKey: `FIXTURE_ODDS#${JSON.stringify(["event-1", 1, "baseball", "moneyline", "away", "b"])}`,
      sortKey: `SNAPSHOT#2026-08-03T20:00:00.000Z#${awayId}`,
      snapshotId: awayId,
    };
    const first = normalizeEvaluationManifest(
      manifest({
        comparisonOutcomeEvidence: [ref("b"), away],
        consensusProvenance: {
          includedSportsbookIds: ["b"],
          comparisonWeights: { b: 1.25 },
          outlierThreshold: 0.1,
          conservativeProbability: "interval-low",
        },
      }),
    );
    const { inputHash, ...firstWithoutHash } = first;
    expect(inputHash).toMatch(/^[a-f0-9]{64}$/);
    const changed = normalizeEvaluationManifest({
      ...firstWithoutHash,
      consensusProvenance: {
        ...first.consensusProvenance!,
        comparisonWeights: { b: 1.5 },
      },
    });
    expect(first.comparisonOutcomeEvidence).toHaveLength(2);
    expect(first.inputHash).not.toBe(changed.inputHash);
  });
  it("canonicalizes semantic sets but preserves meaningful ordered data", () => {
    const a = normalizeEvaluationManifest(manifest());
    const b = normalizeEvaluationManifest(
      manifest({
        comparisonEvidence: [ref("b"), ref("c"), ref("b")],
        provenanceReferences: ["run:1", "provider:sharp"],
      }),
    );
    expect(a.inputHash).toBe(b.inputHash);
    expect(a.comparisonEvidence.map((x) => x.snapshotId)).toEqual([
      "b".repeat(64),
      "c".repeat(64),
    ]);
  });
  it("supports point and range probabilities and changes identity with thresholds", () => {
    const point = normalizeEvaluationManifest(manifest());
    const range = normalizeEvaluationManifest(
      manifest({ probability: { minimum: 0.54, maximum: 0.6 } }),
    );
    const threshold = normalizeEvaluationManifest(
      manifest({
        thresholds: { ...manifest().thresholds, minimumExpectedValue: 0.04 },
      }),
    );
    expect(
      new Set([point.inputHash, range.inputHash, threshold.inputHash]).size,
    ).toBe(3);
  });
  it("rejects CURRENT, mismatched snapshots, incomplete versions, forged hashes and unsafe fields", () => {
    expect(() =>
      normalizeEvaluationManifest(
        manifest({ offeredOdds: { ...ref("offered"), sortKey: "CURRENT" } }),
      ),
    ).toThrow(PaperEvaluationInputError);
    expect(() =>
      normalizeEvaluationManifest(
        manifest({
          offeredOdds: {
            ...ref("offered"),
            snapshotId: "d".repeat(64),
          },
        }),
      ),
    ).toThrow("snapshot-identity-mismatch");
    expect(() =>
      normalizeEvaluationManifest({ ...manifest(), inputHash: "forged" }),
    ).toThrow("input-hash-invalid");
    expect(() =>
      normalizeEvaluationManifest({
        ...manifest(),
        versions: {
          ...manifest().versions,
          model: {},
        } as EvaluationManifestInput["versions"],
      }),
    ).toThrow("fields-invalid");
    expect(() =>
      normalizeEvaluationManifest({
        ...manifest(),
        rawPayload: "unsafe",
      } as EvaluationManifestInput),
    ).toThrow("unsafe-field");
  });
  it("binds canonical snapshot keys to the manifest dimensions", () => {
    expect(() =>
      normalizeEvaluationManifest(manifest({ eventId: "event-2" })),
    ).toThrow("offered-evidence-binding-invalid");
    expect(() =>
      normalizeEvaluationManifest(
        manifest({
          offeredOdds: {
            ...ref("offered"),
            partitionKey:
              'FIXTURE_ODDS#["event-1",1,"baseball","moneyline","home", "offered"]',
          },
        }),
      ),
    ).toThrow("partition-key-invalid");
    expect(() =>
      normalizeEvaluationManifest(
        manifest({
          comparisonEvidence: [
            {
              ...ref("b"),
              partitionKey: `FIXTURE_ODDS#${JSON.stringify(["event-1", 1, "baseball", "spread", "home", "b"])}`,
            },
          ],
        }),
      ),
    ).toThrow("comparison-evidence-binding-invalid");
  });
  it("rejects embedded credentials and raw payloads without rejecting safe identifiers", () => {
    for (const unsafe of [
      "provider:x?access_token=abc",
      "meta?authorization=Bearer",
      "cookie=session",
      "raw_payload={}",
    ])
      expect(() =>
        normalizeEvaluationManifest(
          manifest({ provenanceReferences: [unsafe] }),
        ),
      ).toThrow("unsafe-value");
    expect(() =>
      normalizeEvaluationManifest(
        manifest({
          provenanceReferences: [
            "tokenization:model-v1",
            "authoritative:sharpapi",
          ],
        }),
      ),
    ).not.toThrow();
  });
  it("derives records, sorts reasons, enforces decisions and deeply freezes output", () => {
    const play = createPaperEvaluation({
      manifest: manifest(),
      decision: "play",
      reasonCodes: ["positive-ev", "complete", "positive-ev"],
      createdAt: "2026-08-03T21:00:00.000Z",
    });
    expect(play.paperBet?.evaluationId).toBe(play.evaluation.evaluationId);
    expect(play.evaluation.reasonCodes).toEqual(["complete", "positive-ev"]);
    expect(Object.isFrozen(play.evaluation.manifest.versions.model)).toBe(true);
    expect(() =>
      createPaperEvaluation({
        manifest: manifest(),
        decision: "no-bet",
        reasonCodes: ["stale"],
        createdAt: "2026-08-03T21:00:00.000Z",
        paperBetId: "x",
      }),
    ).toThrow("no-bet-cannot-have-paper-bet");
    expect(() =>
      createPaperEvaluation({
        manifest: manifest(),
        decision: "play",
        reasonCodes: ["ok"],
        createdAt: "2026-08-03T21:00:00.000Z",
        evaluationId: "forged",
      }),
    ).toThrow("evaluation-id-invalid");
  });
});
