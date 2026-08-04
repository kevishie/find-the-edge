import { describe, expect, it, vi } from "vitest";
import { createPaperPickSchedulerHandler } from "./paper-pick-scheduler-lambda";
import type { PaperPickScheduler } from "./paper-pick-scheduler";
const now = new Date("2026-08-04T12:00:00.000Z");
describe("paper-pick scheduler lambda", () => {
  it("accepts only fresh exact internal commands and emits safe EMF", async () => {
    const generate = vi
      .fn()
      .mockResolvedValue({ runIds: ["safe"], discovered: 1, terminal: 1 });
    const lines: string[] = [];
    const handler = createPaperPickSchedulerHandler(
      { generate } as unknown as PaperPickScheduler,
      () => now,
      (line) => lines.push(line),
    );
    await expect(
      handler({
        source: "aws.events",
        detailType: "FTE Paper Pick Generation",
        generatedAt: now.toISOString(),
        scheduledFor: now.toISOString(),
        generationMinutes: 15,
      }),
    ).resolves.toMatchObject({ terminal: 1 });
    expect(generate).toHaveBeenCalledTimes(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({
      Mode: "controlled",
      Runs: 1,
    });
    expect(lines[0]).not.toContain("prompt");
  });
  it("rejects stale, public, or client-enriched commands", async () => {
    const handler = createPaperPickSchedulerHandler(
      {
        generate: vi
          .fn()
          .mockResolvedValue({ runIds: [], terminal: 0, limits: 0 }),
      } as unknown as PaperPickScheduler,
      () => now,
      () => undefined,
    );
    const base = {
      source: "aws.events",
      detailType: "FTE Paper Pick Generation",
      generatedAt: now.toISOString(),
      scheduledFor: now.toISOString(),
      generationMinutes: 15,
    };
    await expect(handler({ ...base, prompt: "client" })).rejects.toThrow(
      "command-invalid",
    );
    await expect(handler({ ...base, source: "client" })).rejects.toThrow(
      "command-invalid",
    );
    await expect(
      handler({ ...base, generatedAt: "2026-08-04T11:00:00.000Z" }),
    ).rejects.toThrow("command-stale");
    await expect(
      handler({
        ...base,
        source: "aws.states",
        generatedAt: "2026-07-22T12:00:00.000Z",
      }),
    ).resolves.toBeDefined();
    await expect(
      handler({
        ...base,
        source: "aws.states",
        generatedAt: "2026-07-20T11:59:59.999Z",
      }),
    ).rejects.toThrow("command-stale");
  });
});
