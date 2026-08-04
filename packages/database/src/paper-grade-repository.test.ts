import { describe, expect, it } from "vitest";
import type { PaperGradeInput } from "@find-the-edge/domain";
import {
  MemoryPaperGradeRepository,
  PaperGradeConflictError,
} from "./paper-grade-repository";
const input = (
  authorityRank = 1,
  result = `result:${"c".repeat(64)}`,
  overrides: Record<string, unknown> = {},
): PaperGradeInput => ({
  paperBetId: "paper-bet:" + "a".repeat(64),
  evaluationId: "evaluation:" + "a".repeat(64),
  eventId: "event",
  resultObservationId: result,
  resultAuthority: `${String(authorityRank).padStart(6, "0")}#2026-08-04T00:00:00.000Z#${String(authorityRank).padStart(12, "0")}#31#2026-08-04T00:00:00.000Z#${result}`,
  oddsPartitionKey: "FIXTURE_ODDS#x",
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
describe("MemoryPaperGradeRepository", () => {
  it("is idempotent and appends correction history", async () => {
    const repo = new MemoryPaperGradeRepository(),
      first = await repo.persist(input());
    expect(first.outcome).toBe("created");
    expect((await repo.persist(input())).outcome).toBe("duplicate");
    const corrected = await repo.persist(
      input(2, `result:${"d".repeat(64)}`, {
        outcome: "lost",
        profit: -1,
        payout: 0,
        roi: -1,
        supersedesGradeId: first.grade.gradeId,
        correctionOrdinal: 1,
      }),
    );
    expect(corrected.outcome).toBe("created");
    expect(
      (await repo.historyPage(input().paperBetId, 100)).items.map(
        (g) => g.outcome,
      ),
    ).toEqual(["won", "lost"]);
    expect((await repo.current(input().paperBetId))?.gradeId).toBe(
      corrected.grade.gradeId,
    );
  });
  it("rejects a correction not linked to current", async () => {
    const repo = new MemoryPaperGradeRepository();
    await repo.persist(input());
    await expect(
      repo.persist(
        input(2, `result:${"d".repeat(64)}`, {
          correctionOrdinal: 1,
          supersedesGradeId: "paper-grade:" + "0".repeat(64),
        }),
      ),
    ).rejects.toBeInstanceOf(PaperGradeConflictError);
  });
  it("does not let stale authority replace current", async () => {
    const repo = new MemoryPaperGradeRepository();
    await repo.persist(input(2));
    expect(
      (await repo.persist(input(1, `result:${"e".repeat(64)}`))).outcome,
    ).toBe("stale");
  });
});
