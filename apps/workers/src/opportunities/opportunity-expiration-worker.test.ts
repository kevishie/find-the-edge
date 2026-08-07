import { describe, expect, it, vi } from "vitest";
import {
  OpportunityLifecycleConflictError,
  type OpportunityLifecycleRepository,
} from "@find-the-edge/database";
import type { OpportunityLifecycleHead } from "@find-the-edge/domain";
import { OpportunityExpirationWorker } from "./opportunity-expiration-worker";
import type { OpportunityLifecycleService } from "./opportunity-lifecycle-service";

const head = {
  logicalOpportunityId: "opportunity:one",
  canonicalEventId: "event-1",
  state: "active",
  sportKey: "mlb",
} as OpportunityLifecycleHead;
const secondHead = {
  ...head,
  logicalOpportunityId: "opportunity:two",
} as OpportunityLifecycleHead;
const stale = { ...head, state: "stale" } as OpportunityLifecycleHead;
const page = (
  items: readonly OpportunityLifecycleHead[],
  override: Partial<{
    nextCursor: string | null;
    staleActiveKeys: readonly string[];
    discoveryFailureCount: number;
    discoveryFailureKeys: readonly string[];
  }> = {},
) => ({
  items,
  nextCursor: null,
  staleActiveCount: override.staleActiveKeys?.length ?? 0,
  staleActiveKeys: override.staleActiveKeys ?? [],
  discoveryFailureCount: override.discoveryFailureCount ?? 0,
  discoveryFailureKeys: override.discoveryFailureKeys ?? [],
  ...override,
});
const repository = (discoverActive: ReturnType<typeof vi.fn>) => {
  const checkpoints = new Map<string, string>();
  return {
    discoverActive,
    get: vi.fn(),
    getSweepCursor: vi.fn((sportKey: string, mode: string) =>
      Promise.resolve(checkpoints.get(`${sportKey}:${mode}`) ?? null),
    ),
    setSweepCursor: vi.fn(
      (input: { sportKey: string; mode: string; cursor: string | null }) => {
        if (input.cursor === null)
          checkpoints.delete(`${input.sportKey}:${input.mode}`);
        else checkpoints.set(`${input.sportKey}:${input.mode}`, input.cursor);
        return Promise.resolve();
      },
    ),
  } as unknown as OpportunityLifecycleRepository;
};

describe("opportunity expiration worker", () => {
  it("deduplicates heads and unique physical stale rows across discovery modes", async () => {
    const discoverActive = vi
      .fn()
      .mockResolvedValueOnce(page([head], { staleActiveKeys: ["same", "due"] }))
      .mockResolvedValueOnce(page([head], { staleActiveKeys: ["same"] }));
    const lifecycle = repository(discoverActive);
    const sweepHead = vi.fn().mockResolvedValue({
      outcome: "applied",
      head: stale,
    });
    const emit = vi.fn();
    const worker = new OpportunityExpirationWorker({
      lifecycle,
      service: { sweepHead } as unknown as OpportunityLifecycleService,
      telemetry: { emit },
    });
    await expect(
      worker.run({
        asOf: "2026-08-06T12:15:00.001Z",
        sportKeys: ["mlb"],
      }),
    ).resolves.toEqual({
      discoveredCount: 1,
      transitionCount: 1,
      expirationCount: 1,
      conflictCount: 0,
      staleActiveCount: 2,
      failureCount: 0,
    });
    expect(discoverActive).toHaveBeenCalledTimes(2);
    expect(sweepHead).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({ staleActiveCount: 2 }),
    );
  });

  it("persists bounded continuation and resumes beyond the first page", async () => {
    const discoverActive = vi
      .fn()
      .mockResolvedValueOnce(page([head], { nextCursor: "cursor-1" }))
      .mockResolvedValueOnce(page([]))
      .mockResolvedValueOnce(page([secondHead]))
      .mockResolvedValueOnce(page([]));
    const lifecycle = repository(discoverActive);
    const sweepHead = vi.fn().mockResolvedValue({ outcome: "noop", head });
    const worker = new OpportunityExpirationWorker({
      lifecycle,
      service: { sweepHead } as unknown as OpportunityLifecycleService,
    });
    const command = {
      asOf: "2026-08-06T12:15:00.001Z",
      sportKeys: ["mlb"],
      maximumPages: 1,
    } as const;
    await worker.run(command);
    await worker.run(command);
    expect(discoverActive.mock.calls[2]?.[0]).toMatchObject({
      cursor: "cursor-1",
      through: command.asOf,
    });
    expect(sweepHead).toHaveBeenCalledWith(secondHead, command.asOf);
  });

  it("rereads and converges after a conditional refresh race", async () => {
    const lifecycle = repository(
      vi
        .fn()
        .mockResolvedValueOnce(page([head]))
        .mockResolvedValueOnce(page([])),
    );
    const get = vi.fn().mockResolvedValue(head);
    Object.assign(lifecycle, { get });
    const sweepHead = vi
      .fn()
      .mockRejectedValueOnce(
        new OpportunityLifecycleConflictError(
          "opportunity-lifecycle-transition-conflict",
        ),
      )
      .mockResolvedValueOnce({ outcome: "applied", head: stale });
    const result = await new OpportunityExpirationWorker({
      lifecycle,
      service: { sweepHead } as unknown as OpportunityLifecycleService,
    }).run({
      asOf: "2026-08-06T12:15:00.001Z",
      sportKeys: ["mlb"],
    });
    expect(result.conflictCount).toBe(1);
    expect(result.expirationCount).toBe(1);
    expect(get).toHaveBeenCalledTimes(1);
  });

  it("records a corrupt head failure and continues sweeping remaining heads", async () => {
    const lifecycle = repository(
      vi
        .fn()
        .mockResolvedValueOnce(page([head, secondHead]))
        .mockResolvedValueOnce(page([])),
    );
    const sweepHead = vi
      .fn()
      .mockRejectedValueOnce(new Error("corrupt-head"))
      .mockResolvedValueOnce({ outcome: "applied", head: stale });
    const emit = vi.fn();
    const result = await new OpportunityExpirationWorker({
      lifecycle,
      service: { sweepHead } as unknown as OpportunityLifecycleService,
      telemetry: { emit },
    }).run({
      asOf: "2026-08-06T12:15:00.001Z",
      sportKeys: ["mlb"],
    });
    expect(result).toMatchObject({
      discoveredCount: 2,
      transitionCount: 1,
      failureCount: 1,
    });
    expect(sweepHead).toHaveBeenCalledTimes(2);
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "failure", failureCount: 1 }),
    );
  });
});
