import { describe, expect, it } from "vitest";
import {
  MemoryPaperEvaluationRepository,
  PaperEvaluationReplayConflictError,
} from "./paper-evaluation-repository";
import { paperInput } from "./paper-evaluation-test-fixture";

describe("MemoryPaperEvaluationRepository", () => {
  it("atomically persists Play, returns exact clones, and makes retries idempotent", async () => {
    const repository = new MemoryPaperEvaluationRepository();
    const first = await repository.persist(paperInput());
    const second = await repository.persist(paperInput());
    expect(first.outcome).toBe("created");
    expect(second.outcome).toBe("duplicate");
    expect(
      await repository.getEvaluation(first.pair.evaluation.evaluationId),
    ).toEqual(first.pair.evaluation);
    expect(
      await repository.getPaperBet(first.pair.paperBet!.paperBetId),
    ).toEqual(first.pair.paperBet);
    expect(first.pair).not.toBe(second.pair);
  });
  it("persists a complete No Bet without a paper bet", async () => {
    const repository = new MemoryPaperEvaluationRepository();
    const result = await repository.persist(paperInput("no-bet"));
    expect(result.pair.evaluation.reasonCodes).toEqual(["insufficient-edge"]);
    expect(result.pair.paperBet).toBeNull();
  });
  it("keeps the first timestamp on exact retry and conflicts on changed decision content", async () => {
    const repository = new MemoryPaperEvaluationRepository();
    await repository.persist(paperInput());
    const retry = await repository.persist({
      ...paperInput(),
      createdAt: "2026-08-03T22:00:00.000Z",
    });
    expect(retry.outcome).toBe("duplicate");
    expect(retry.pair.evaluation.createdAt).toBe("2026-08-03T21:00:00.000Z");
    expect(retry.pair.paperBet?.createdAt).toBe("2026-08-03T21:00:00.000Z");
    await expect(
      repository.persist({ ...paperInput(), reasonCodes: ["different"] }),
    ).rejects.toBeInstanceOf(PaperEvaluationReplayConflictError);
  });
  it("rejects ID aliases, corrupt stored records, and paper-only partial state", async () => {
    const repository = new MemoryPaperEvaluationRepository();
    const pair = (await repository.persist(paperInput())).pair;
    await expect(
      repository.getEvaluation(pair.evaluation.inputHash),
    ).rejects.toThrow("evaluation-id-invalid");
    await expect(
      repository.getPaperBet(pair.evaluation.evaluationId),
    ).rejects.toThrow("paper-bet-id-invalid");
    const internals = repository as unknown as {
      evaluations: Map<string, unknown>;
      paperBets: Map<string, unknown>;
    };
    internals.evaluations.set(pair.evaluation.evaluationId, {
      ...pair.evaluation,
      inputHash: "0".repeat(64),
    });
    await expect(
      repository.getEvaluation(pair.evaluation.evaluationId),
    ).rejects.toThrow();
    const empty = new MemoryPaperEvaluationRepository();
    const emptyInternals = empty as unknown as {
      paperBets: Map<string, unknown>;
    };
    emptyInternals.paperBets.set(pair.paperBet!.paperBetId, pair.paperBet!);
    await expect(empty.persist(paperInput())).rejects.toThrow(
      "partial-paper-bet-state",
    );
    const evaluationOnly = new MemoryPaperEvaluationRepository();
    const evaluationOnlyInternals = evaluationOnly as unknown as {
      evaluations: Map<string, unknown>;
    };
    evaluationOnlyInternals.evaluations.set(
      pair.evaluation.evaluationId,
      pair.evaluation,
    );
    await expect(evaluationOnly.persist(paperInput())).rejects.toThrow(
      "paper-bet-replay-conflict",
    );
  });
  it("serializes concurrent identical writes and returns deeply isolated frozen records", async () => {
    const repository = new MemoryPaperEvaluationRepository();
    const [one, two] = await Promise.all([
      repository.persist(paperInput()),
      repository.persist(paperInput()),
    ]);
    expect([one.outcome, two.outcome].sort()).toEqual(["created", "duplicate"]);
    expect(one.pair).not.toBe(two.pair);
    expect(Object.isFrozen(one.pair.evaluation.manifest.versions)).toBe(true);
    const copy = await repository.getEvaluation(
      one.pair.evaluation.evaluationId,
    );
    expect(copy).not.toBe(one.pair.evaluation);
    expect(copy?.manifest).not.toBe(one.pair.evaluation.manifest);
  });
});
