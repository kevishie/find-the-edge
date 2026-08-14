import { describe, expect, it, vi } from "vitest";
import {
  readEventProjectionReadiness,
  readEventProjectionReadinessStrong,
} from "./event-projection-readiness";

describe("event projection readiness", () => {
  it.each([
    ["stale miss", null],
    [
      "malformed prior value",
      {
        pk: "EVENT_PROJECTIONS",
        sk: "READINESS",
        value: { schemaVersion: 0, state: "initialized" },
      },
    ],
    [
      "unexpected extra field",
      {
        pk: "EVENT_PROJECTIONS",
        sk: "READINESS",
        value: { schemaVersion: 1, state: "initialized", unsafe: true },
      },
    ],
  ])("fails closed for a %s", async (_label, stored) => {
    const get = vi.fn().mockResolvedValue(stored);
    await expect(readEventProjectionReadiness({ get })).resolves.toBe(false);
    expect(get).toHaveBeenCalledWith("EVENT_PROJECTIONS", "READINESS", {
      consistentRead: false,
    });
  });

  it("accepts only the exact one-way initialized latch", async () => {
    const get = vi.fn().mockResolvedValue({
      pk: "EVENT_PROJECTIONS",
      sk: "READINESS",
      value: { schemaVersion: 1, state: "initialized" },
    });
    await expect(readEventProjectionReadiness({ get })).resolves.toBe(true);
  });

  it("uses the strong gateway default for callers that can persist a miss", async () => {
    const get = vi.fn().mockResolvedValue(null);
    await expect(readEventProjectionReadinessStrong({ get })).resolves.toBe(
      false,
    );
    expect(get).toHaveBeenCalledWith("EVENT_PROJECTIONS", "READINESS");
  });
});
