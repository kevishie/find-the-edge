import { describe, expect, it, vi } from "vitest";
import { createPaperGrade, type PaperGradeInput } from "@find-the-edge/domain";
import { DynamoPaperGradeRepository } from "./dynamodb-paper-grade-repository";
import { PaperGradeConflictError } from "./paper-grade-repository";

const input = (
  authorityRank = 1,
  resultObservationId = `result:${"c".repeat(64)}`,
  overrides: Record<string, unknown> = {},
): PaperGradeInput => ({
  paperBetId: `paper-bet:${"a".repeat(64)}`,
  evaluationId: `evaluation:${"a".repeat(64)}`,
  eventId: "event",
  resultObservationId,
  resultAuthority: `${String(authorityRank).padStart(6, "0")}#2026-08-04T00:00:00.000Z#${String(authorityRank).padStart(12, "0")}#31#2026-08-04T00:00:00.000Z#${resultObservationId}`,
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

const cancellation = () =>
  Object.assign(new Error("cancelled"), {
    name: "TransactionCanceledException",
  });

describe("DynamoPaperGradeRepository", () => {
  it("atomically appends history and current, then verifies exact replay", async () => {
    const grade = createPaperGrade(input());
    const send = vi
      .fn()
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ Item: { value: grade } })
      .mockResolvedValueOnce({ Item: { value: grade } });
    const repository = new DynamoPaperGradeRepository(
      { send } as never,
      "table",
    );
    expect((await repository.persist(input())).outcome).toBe("created");
    const transaction = send.mock.calls[2]![0] as {
      input: { TransactItems: readonly unknown[] };
    };
    expect(transaction.input.TransactItems).toHaveLength(2);
    expect((await repository.persist(input())).outcome).toBe("duplicate");
    for (const call of send.mock.calls.slice(3, 5))
      expect(
        (call[0] as { input: { ConsistentRead: boolean } }).input
          .ConsistentRead,
      ).toBe(true);
  });

  it("rejects CURRENT without matching immutable history", async () => {
    const grade = createPaperGrade(input());
    const send = vi
      .fn()
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ Item: { value: grade } });
    const repository = new DynamoPaperGradeRepository(
      { send } as never,
      "table",
    );
    await expect(repository.persist(input())).rejects.toThrow(
      "grade-partial-state",
    );
  });

  it("rejects conflicting history and classifies a post-race winner", async () => {
    const grade = createPaperGrade(input());
    const conflicting = { ...grade, reason: "spread-final" };
    const conflictSend = vi
      .fn()
      .mockResolvedValueOnce({ Item: { value: conflicting } })
      .mockResolvedValueOnce({});
    await expect(
      new DynamoPaperGradeRepository(
        { send: conflictSend } as never,
        "table",
      ).persist(input()),
    ).rejects.toBeInstanceOf(PaperGradeConflictError);

    const newer = createPaperGrade(
      input(2, `result:${"d".repeat(64)}`, {
        correctionOrdinal: 1,
        supersedesGradeId: grade.gradeId,
      }),
    );
    const raceSend = vi
      .fn()
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(cancellation())
      .mockResolvedValueOnce({ Item: { value: newer } })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ Item: { value: newer } });
    expect(
      (
        await new DynamoPaperGradeRepository(
          { send: raceSend } as never,
          "table",
        ).persist(input())
      ).outcome,
    ).toBe("stale");
  });

  it("validates audit cursors before issuing the query", async () => {
    const send = vi.fn();
    const repository = new DynamoPaperGradeRepository(
      { send } as never,
      "table",
    );
    await expect(
      repository.historyPage(input().paperBetId, 10, "forged"),
    ).rejects.toThrow("grade-cursor-invalid");
    expect(send).not.toHaveBeenCalled();
  });
});
