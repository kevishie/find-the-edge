import { describe, expect, it, vi } from "vitest";
import { createPaperEvaluation } from "@find-the-edge/domain";
import { DynamoPaperEvaluationRepository } from "./dynamodb-paper-evaluation-repository";
import { PaperEvaluationReplayConflictError } from "./paper-evaluation-repository";
import { paperInput } from "./paper-evaluation-test-fixture";

const conditionalCancellation = () =>
  Object.assign(new Error("cancelled"), {
    name: "TransactionCanceledException",
    CancellationReasons: [{ Code: "ConditionalCheckFailed" }, { Code: "None" }],
  });

describe("DynamoPaperEvaluationRepository", () => {
  it("writes the exact Play pair keys, values, table and conditions", async () => {
    const send = vi.fn().mockResolvedValue({});
    const repository = new DynamoPaperEvaluationRepository(
      { send } as never,
      "paper-table",
    );
    const intended = createPaperEvaluation(paperInput());
    await expect(repository.persist(paperInput())).resolves.toMatchObject({
      outcome: "created",
    });
    const command = send.mock.calls[0]![0] as {
      input: { TransactItems: unknown[] };
    };
    const pk = `EVALUATION#${intended.evaluation.inputHash}`;
    expect(command.input.TransactItems).toEqual([
      {
        Put: {
          TableName: "paper-table",
          Item: { pk, sk: "RECORD", value: intended.evaluation },
          ConditionExpression:
            "attribute_not_exists(pk) AND attribute_not_exists(sk)",
        },
      },
      {
        Put: {
          TableName: "paper-table",
          Item: { pk, sk: "PAPER_BET", value: intended.paperBet },
          ConditionExpression:
            "attribute_not_exists(pk) AND attribute_not_exists(sk)",
        },
      },
    ]);
  });

  it("strongly rereads both records after conditional cancellation and keeps the first timestamp", async () => {
    const pair = createPaperEvaluation(paperInput());
    const send = vi
      .fn()
      .mockRejectedValueOnce(conditionalCancellation())
      .mockResolvedValueOnce({ Item: { value: pair.evaluation } })
      .mockResolvedValueOnce({ Item: { value: pair.paperBet } });
    const repository = new DynamoPaperEvaluationRepository(
      { send } as never,
      "table",
    );
    const result = await repository.persist({
      ...paperInput(),
      createdAt: "2026-08-03T22:00:00.000Z",
    });
    expect(result.outcome).toBe("duplicate");
    expect(result.pair.evaluation.createdAt).toBe("2026-08-03T21:00:00.000Z");
    expect(send).toHaveBeenCalledTimes(3);
    for (const call of send.mock.calls.slice(1))
      expect(
        (call[0] as { input: { ConsistentRead: boolean } }).input
          .ConsistentRead,
      ).toBe(true);
  });

  it("accepts an exact No Bet duplicate and verifies no paper record exists", async () => {
    const pair = createPaperEvaluation(paperInput("no-bet"));
    const send = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(conditionalCancellation(), {
          CancellationReasons: [{ Code: "ConditionalCheckFailed" }],
        }),
      )
      .mockResolvedValueOnce({ Item: { value: pair.evaluation } })
      .mockResolvedValueOnce({});
    const repository = new DynamoPaperEvaluationRepository(
      { send } as never,
      "table",
    );
    await expect(repository.persist(paperInput("no-bet"))).resolves.toEqual({
      outcome: "duplicate",
      pair,
    });
    expect(send).toHaveBeenCalledTimes(3);
  });

  it("rejects partial state and runtime-invalid stored values", async () => {
    const pair = createPaperEvaluation(paperInput());
    const send = vi
      .fn()
      .mockRejectedValueOnce(conditionalCancellation())
      .mockResolvedValueOnce({ Item: { value: pair.evaluation } })
      .mockResolvedValueOnce({});
    const repository = new DynamoPaperEvaluationRepository(
      { send } as never,
      "table",
    );
    await expect(repository.persist(paperInput())).rejects.toBeInstanceOf(
      PaperEvaluationReplayConflictError,
    );

    const invalidSend = vi.fn().mockResolvedValue({
      Item: { value: { ...pair.evaluation, inputHash: "0".repeat(64) } },
    });
    const invalidRepository = new DynamoPaperEvaluationRepository(
      { send: invalidSend } as never,
      "table",
    );
    await expect(
      invalidRepository.getEvaluation(pair.evaluation.evaluationId),
    ).rejects.toThrow();
  });

  it("propagates non-conditional transaction cancellations and service failures without rereading", async () => {
    for (const error of [
      Object.assign(new Error("capacity"), {
        name: "TransactionCanceledException",
        CancellationReasons: [{ Code: "ProvisionedThroughputExceeded" }],
      }),
      Object.assign(new Error("throttled"), {
        name: "ThrottlingException",
      }),
      Object.assign(new Error("invalid"), { name: "ValidationException" }),
    ]) {
      const send = vi.fn().mockRejectedValue(error);
      const repository = new DynamoPaperEvaluationRepository(
        { send } as never,
        "table",
      );
      await expect(repository.persist(paperInput())).rejects.toBe(error);
      expect(send).toHaveBeenCalledTimes(1);
    }
  });

  it("propagates read failures and rejects noncanonical ID aliases", async () => {
    const failure = Object.assign(new Error("read-throttled"), {
      name: "ThrottlingException",
    });
    const send = vi.fn().mockRejectedValue(failure);
    const repository = new DynamoPaperEvaluationRepository(
      { send } as never,
      "table",
    );
    const pair = createPaperEvaluation(paperInput());
    await expect(
      repository.getEvaluation(pair.evaluation.evaluationId),
    ).rejects.toBe(failure);
    await expect(
      repository.getEvaluation(pair.evaluation.inputHash),
    ).rejects.toThrow("evaluation-id-invalid");
    await expect(
      repository.getPaperBet(pair.evaluation.evaluationId),
    ).rejects.toThrow("paper-bet-id-invalid");
  });
});
