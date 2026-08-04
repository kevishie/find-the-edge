import { describe, expect, it } from "vitest";
import { MemoryPaperPickRunRepository } from "./paper-pick-run-repository";
const identity = {
  policyId: "schedule",
  policyVersion: "1",
  scheduledFor: "2026-08-04T12:00:00.000Z",
  sportKey: "baseball",
  leagueKey: "mlb",
  strategyId: "ml",
  strategyVersion: "1",
  marketKey: "moneyline",
  mode: "shadow" as const,
};
const candidate = {
  eventId: "event",
  eventVersion: 1,
  sportKey: "baseball",
  leagueKey: "mlb",
  participantIds: ["away", "home"],
  startsAt: "2026-08-04T14:00:00.000Z",
};
describe("paper-pick run repository", () => {
  it("converges run/items and fences claims, budgets, and terminals", async () => {
    const repo = new MemoryPaperPickRunRepository();
    const generation = await repo.createGeneration(
      "schedule",
      "1",
      identity.scheduledFor,
      {
        events: 1,
        modelCalls: 1,
        inputTokens: 10,
        outputTokens: 10,
        costMicros: 10,
        concurrency: 1,
      },
    );
    const a = await repo.createRun(
      identity,
      identity.scheduledFor,
      [candidate],
      generation,
    );
    const b = await repo.createRun(
      identity,
      identity.scheduledFor,
      [candidate],
      generation,
    );
    expect(b.outcome).toBe("duplicate");
    const item = await repo.createItem(a.run.runId, candidate, "shadow");
    const claim = await repo.claimItem(
      item.itemId,
      "one",
      identity.scheduledFor,
      1000,
    );
    expect(claim).not.toBeNull();
    expect(
      await repo.claimItem(item.itemId, "two", identity.scheduledFor, 1000),
    ).toBeNull();
    const limits = {
      events: 1,
      modelCalls: 1,
      inputTokens: 10,
      outputTokens: 10,
      costMicros: 10,
      concurrency: 1,
    };
    expect(
      await repo.reserve(
        item.itemId,
        claim!.token,
        {
          modelCalls: 1,
          inputTokens: 10,
          outputTokens: 10,
          costMicros: 10,
          concurrency: 1,
        },
        limits,
      ),
    ).toBe("reserved");
    expect(
      await repo.reserve(
        item.itemId,
        claim!.token,
        {
          modelCalls: 1,
          inputTokens: 0,
          outputTokens: 0,
          costMicros: 0,
          concurrency: 0,
        },
        limits,
      ),
    ).toBe("model-call-limit");
    await repo.finishItem(
      item.itemId,
      claim!.token,
      "evaluation",
      "play",
      identity.scheduledFor,
      "evaluation:x",
    );
    expect((await repo.getItem(item.itemId))?.state).toBe("terminal");
  });
  it("allows takeover only after lease expiry", async () => {
    const repo = new MemoryPaperPickRunRepository();
    const generation = await repo.createGeneration(
      "schedule",
      "1",
      identity.scheduledFor,
      {
        events: 1,
        modelCalls: 1,
        inputTokens: 10,
        outputTokens: 10,
        costMicros: 10,
        concurrency: 1,
      },
    );
    const run = (
      await repo.createRun(
        identity,
        identity.scheduledFor,
        [candidate],
        generation,
      )
    ).run;
    const item = await repo.createItem(run.runId, candidate, "shadow");
    await repo.claimItem(item.itemId, "one", identity.scheduledFor, 1);
    expect(
      await repo.claimItem(item.itemId, "two", "2026-08-04T12:00:00.002Z", 100),
    ).not.toBeNull();
  });
  it("atomically returns an expired owner's concurrency slot during takeover", async () => {
    const repo = new MemoryPaperPickRunRepository();
    const limits = {
      events: 1,
      modelCalls: 2,
      inputTokens: 20,
      outputTokens: 20,
      costMicros: 20,
      concurrency: 1,
    };
    const generation = await repo.createGeneration(
      "schedule",
      "1",
      identity.scheduledFor,
      limits,
    );
    const run = (
      await repo.createRun(
        identity,
        identity.scheduledFor,
        [candidate],
        generation,
      )
    ).run;
    const item = await repo.createItem(run.runId, candidate, "shadow");
    const first = await repo.claimItem(
      item.itemId,
      "first",
      identity.scheduledFor,
      1,
    );
    expect(first).not.toBeNull();
    expect(
      await repo.reserve(
        item.itemId,
        first!.token,
        {
          modelCalls: 1,
          inputTokens: 10,
          outputTokens: 10,
          costMicros: 10,
          concurrency: 1,
        },
        limits,
      ),
    ).toBe("reserved");
    const second = await repo.claimItem(
      item.itemId,
      "second",
      "2026-08-04T12:00:00.002Z",
      100,
    );
    expect(second).not.toBeNull();
    expect(
      await repo.reserve(
        item.itemId,
        second!.token,
        {
          modelCalls: 1,
          inputTokens: 10,
          outputTokens: 10,
          costMicros: 10,
          concurrency: 1,
        },
        limits,
      ),
    ).toBe("reserved");
    await expect(
      repo.releaseConcurrency(item.itemId, first!.token),
    ).rejects.toThrow("lease-lost");
  });

  it("admits each event once against a generation-wide ceiling", async () => {
    const repo = new MemoryPaperPickRunRepository();
    const generation = await repo.createGeneration(
      "schedule",
      "1",
      identity.scheduledFor,
      {
        events: 1,
        modelCalls: 1,
        inputTokens: 1,
        outputTokens: 1,
        costMicros: 1,
        concurrency: 1,
      },
    );
    await expect(repo.admitEvent(generation, "one", 1, 1)).resolves.toBe(
      "admitted",
    );
    await expect(repo.admitEvent(generation, "one", 1, 1)).resolves.toBe(
      "existing",
    );
    await expect(repo.admitEvent(generation, "one", 2, 1)).resolves.toBe(
      "existing",
    );
    await expect(repo.admitEvent(generation, "two", 1, 1)).resolves.toBe(
      "event-limit",
    );
  });
});
