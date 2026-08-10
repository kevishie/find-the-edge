import { describe, expect, it, vi } from "vitest";
import type { OpportunityExpirationWorker } from "./opportunity-expiration-worker";
import {
  createOpportunityExpirationHandler,
  normalizeOpportunitySportKeys,
  validateOpportunityExpirationInvocation,
} from "./opportunity-expiration-lambda";

const scheduled = (time: string) => ({
  source: "aws.events",
  "detail-type": "Scheduled Event",
  time,
});

describe("opportunity expiration lambda", () => {
  it("accepts only a fresh EventBridge schedule and uses fixed bounds", async () => {
    const time = "2026-08-06T12:00:00.000Z";
    expect(
      validateOpportunityExpirationInvocation(scheduled(time), () =>
        Date.parse(time),
      ),
    ).toBe(time);
    // Live EventBridge stamps schedules at second precision; the validator
    // must accept that shape and return the normalized millisecond instant.
    expect(
      validateOpportunityExpirationInvocation(
        scheduled("2026-08-06T12:00:00Z"),
        () => Date.parse(time),
      ),
    ).toBe(time);
    expect(() =>
      validateOpportunityExpirationInvocation(
        { ...scheduled(time), source: "custom" },
        () => Date.parse(time),
      ),
    ).toThrow("opportunity-expiration-invocation-invalid");
    expect(() =>
      validateOpportunityExpirationInvocation(
        scheduled("2026-08-06T12:00:01.000Z"),
        () => Date.parse(time),
      ),
    ).toThrow("opportunity-expiration-invocation-invalid");
    const run = vi.fn().mockResolvedValue({ transitionCount: 0 });
    const handler = createOpportunityExpirationHandler(
      { run } as unknown as OpportunityExpirationWorker,
      ["mlb", "soccer"],
      () => Date.parse(time),
    );
    await handler(scheduled(time));
    expect(run).toHaveBeenCalledWith({
      asOf: time,
      sportKeys: ["mlb", "soccer"],
      pageLimit: 100,
      maximumPages: 10,
    });
  });

  it("normalizes safe sport keys and rejects empty, unsafe, or duplicate values", () => {
    expect(normalizeOpportunitySportKeys([" mlb ", "soccer"])).toEqual([
      "mlb",
      "soccer",
    ]);
    expect(() => normalizeOpportunitySportKeys([])).toThrow(
      "opportunity-expiration-sport-keys-invalid",
    );
    expect(() => normalizeOpportunitySportKeys(["mlb", " mlb "])).toThrow(
      "opportunity-expiration-sport-keys-invalid",
    );
    expect(() => normalizeOpportunitySportKeys(["MLB!"])).toThrow(
      "opportunity-expiration-sport-keys-invalid",
    );
  });
});
