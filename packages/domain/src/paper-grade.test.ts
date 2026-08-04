import { describe, expect, it } from "vitest";
import {
  createPaperGrade,
  normalizePaperGradeRecord,
  stablePaperGradeValue,
  type PaperGradeInput,
} from "./paper-grade";

const resultId = `result:${"c".repeat(64)}`;
const authority = `000001#2026-08-04T00:00:00.000Z#000000000001#31#2026-08-04T00:00:00.000Z#${resultId}`;
const input = (overrides: Record<string, unknown> = {}): PaperGradeInput => ({
  paperBetId: `paper-bet:${"a".repeat(64)}`,
  evaluationId: `evaluation:${"a".repeat(64)}`,
  eventId: "event",
  resultObservationId: resultId,
  resultAuthority: authority,
  oddsPartitionKey: "FIXTURE_ODDS#event#book#moneyline#away",
  oddsSortKey: `SNAPSHOT#${"b".repeat(64)}`,
  oddsSnapshotId: "b".repeat(64),
  outcome: "won" as const,
  reason: "moneyline-final",
  profit: 1.2,
  payout: 2.2,
  roi: 1.2,
  correctionOrdinal: 0,
  gradedAt: "2026-08-04T00:00:00.000Z",
  ...overrides,
});

describe("paper grade", () => {
  it("derives a stable identity and normalizes an exact record", () => {
    const first = createPaperGrade(input());
    expect(createPaperGrade(input()).gradeId).toBe(first.gradeId);
    expect(normalizePaperGradeRecord(first)).toEqual(first);
    expect(Object.isFrozen(first)).toBe(true);
    expect(
      createPaperGrade(input({ eventId: "other-event" })).gradeId,
    ).not.toBe(first.gradeId);
    expect(stablePaperGradeValue({ z: { b: 2, a: 1 }, a: [2, 1] })).toBe(
      stablePaperGradeValue({ a: [2, 1], z: { a: 1, b: 2 } }),
    );
  });

  it("enforces outcome financial and correction invariants", () => {
    expect(() => createPaperGrade(input({ profit: 0 }))).toThrow(
      "grade-financial-invariant",
    );
    expect(() => createPaperGrade(input({ correctionOrdinal: 1 }))).toThrow(
      "grade-supersession-invalid",
    );
    expect(() =>
      createPaperGrade(input({ policyVersion: "paper-grading-v2" })),
    ).toThrow("grade-input-invalid");
    expect(() =>
      createPaperGrade(input({ resultAuthority: "forged" })),
    ).toThrow("result-authority-invalid");
    expect(() =>
      createPaperGrade(input({ outcome: "lost", reason: "cancelled" })),
    ).toThrow("grade-reason-outcome-invalid");
    expect(() =>
      createPaperGrade(
        input({
          outcome: "void",
          reason: "moneyline-final",
          profit: 0,
          payout: 1,
          roi: 0,
        }),
      ),
    ).toThrow("grade-reason-outcome-invalid");
    expect(() =>
      createPaperGrade(input({ evaluationId: `evaluation:${"d".repeat(64)}` })),
    ).toThrow("paper-evaluation-identity-mismatch");
  });
});
