import { describe, expect, it } from "vitest";
import { assessEventMetadata } from "@find-the-edge/domain";
import {
  eventFreshnessPresentation,
  eventLifecyclePresentation,
  eventMetadataReasonText,
} from "./event-metadata";

describe("event metadata presentation", () => {
  it.each([
    "scheduled",
    "postponed",
    "cancelled",
    "started",
    "completed",
    "unknown",
  ] as const)("maps lifecycle %s to text and a cue", (state) => {
    const result = eventLifecyclePresentation(state);
    expect(result.label).toBeTruthy();
    expect(result.icon).toBeTruthy();
    expect(result.ariaLabel).toBeTruthy();
  });
  it.each(["current", "stale", "unavailable"] as const)(
    "maps freshness %s to text and a cue",
    (state) => {
      const result = eventFreshnessPresentation(state);
      expect(result.label).toBeTruthy();
      expect(result.icon).toBeTruthy();
      expect(result.ariaLabel).toBeTruthy();
    },
  );
  it.each([
    ["current", "2026-08-04T11:00:00.000Z", "within the two-hour"],
    ["stale", "2026-08-04T09:00:00.000Z", "older than the two-hour"],
    ["missing", null, "is missing"],
    ["malformed", "bad-time", "is malformed"],
    ["future", "2026-08-04T13:00:00.000Z", "in the future"],
  ])("explains %s freshness", (_case, evidence, text) => {
    const assessment = assessEventMetadata(
      "scheduled",
      evidence,
      "2026-08-04T12:00:00.000Z",
    );
    expect(eventMetadataReasonText(assessment).join(" ")).toContain(text);
  });
  it("explains unknown lifecycle independently", () => {
    const assessment = assessEventMetadata(
      "unknown",
      "2026-08-04T11:00:00.000Z",
      "2026-08-04T12:00:00.000Z",
    );
    expect(eventMetadataReasonText(assessment).join(" ")).toContain(
      "lifecycle status is unavailable",
    );
  });
});
