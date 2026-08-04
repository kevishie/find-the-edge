import { describe, expect, it } from "vitest";
import {
  assessEventMetadata,
  validateEventMetadataAssessment,
} from "./event-metadata";

describe("event metadata assessment", () => {
  const now = "2026-08-04T12:00:00.000Z";
  it("keeps exactly two hours current and marks one millisecond more stale", () => {
    expect(
      assessEventMetadata("scheduled", "2026-08-04T10:00:00.000Z", now)
        .freshness.state,
    ).toBe("current");
    expect(
      assessEventMetadata("scheduled", "2026-08-04T09:59:59.999Z", now)
        .freshness.state,
    ).toBe("stale");
  });
  it.each([
    [null, "missing-evidence-time"],
    ["not-a-time", "malformed-evidence-time"],
    ["2026-08-04T12:00:00.001Z", "future-evidence-time"],
  ])("makes invalid evidence unavailable", (evidence, reason) => {
    const result = assessEventMetadata("scheduled", evidence, now);
    expect(result.availability).toBe("unavailable");
    expect(result.freshness.missingReason).toBe(reason);
  });
  it("keeps lifecycle independent from freshness", () => {
    const postponed = assessEventMetadata(
      "postponed",
      "2026-08-04T01:00:00.000Z",
      now,
    );
    expect(postponed.lifecycle.state).toBe("postponed");
    expect(postponed.freshness.state).toBe("stale");
    const unknown = assessEventMetadata(
      "unknown",
      "2026-08-04T11:00:00.000Z",
      now,
    );
    expect(unknown.availability).toBe("partial");
    expect(unknown.lifecycle.known).toBe(false);
  });
  it("preserves a canonical future timestamp for audit while refusing freshness", () => {
    const future = "2026-08-04T12:00:00.001Z";
    const result = assessEventMetadata("scheduled", future, now);
    expect(result.freshness).toMatchObject({
      state: "unavailable",
      evidenceAt: future,
      ageSeconds: null,
      missingReason: "future-evidence-time",
    });
  });
  it("rejects missing, contradictory, and forged assessments", () => {
    const valid = assessEventMetadata(
      "scheduled",
      "2026-08-04T11:00:00.000Z",
      now,
    );
    expect(
      validateEventMetadataAssessment(
        valid,
        "scheduled",
        "2026-08-04T11:00:00.000Z",
        now,
      ),
    ).toEqual(valid);
    for (const invalid of [
      null,
      { ...valid, availability: "partial" },
      { ...valid, extra: true },
    ])
      expect(() =>
        validateEventMetadataAssessment(
          invalid,
          "scheduled",
          "2026-08-04T11:00:00.000Z",
          now,
        ),
      ).toThrow("invalid-event-metadata-assessment");
  });
  it("accepts structurally identical assessments regardless of object key order", () => {
    const valid = assessEventMetadata(
      "cancelled",
      "2026-08-04T11:00:00.000Z",
      now,
    );
    const reordered = {
      reasonCodes: valid.reasonCodes,
      freshness: {
        missingReason: valid.freshness.missingReason,
        thresholdSeconds: valid.freshness.thresholdSeconds,
        ageSeconds: valid.freshness.ageSeconds,
        evidenceAt: valid.freshness.evidenceAt,
        state: valid.freshness.state,
      },
      availability: valid.availability,
      lifecycle: { known: valid.lifecycle.known, state: valid.lifecycle.state },
      evaluatedAt: valid.evaluatedAt,
      policyVersion: valid.policyVersion,
    };
    expect(
      validateEventMetadataAssessment(
        reordered,
        "cancelled",
        "2026-08-04T11:00:00.000Z",
        now,
      ),
    ).toEqual(valid);
  });
});
