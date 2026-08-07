import { describe, expect, it, vi } from "vitest";
import { DynamoOpportunityLifecycleEventEvidenceSource } from "./opportunity-lifecycle-event-evidence";

describe("opportunity lifecycle event evidence", () => {
  it("strongly rereads the pointer and returns its material fence", async () => {
    const pointer = {
      pk: "EVENT_DETAIL#event-1",
      sk: "CURRENT",
      value: {
        materialVersion: 4,
        sportPk: "sport-pk",
        sportSk: "sport-sk",
      },
    };
    const get = vi
      .fn()
      .mockResolvedValueOnce(pointer)
      .mockResolvedValueOnce({
        pk: "sport-pk",
        sk: "sport-sk",
        value: {
          eventId: "event-1",
          materialVersion: 4,
          sportKey: "mlb",
          status: "scheduled",
          startsAt: "2026-08-06T20:00:00.000Z",
          canonicalFreshness: "2026-08-06T11:59:00.000Z",
        },
      })
      .mockResolvedValueOnce(pointer);
    const result = await new DynamoOpportunityLifecycleEventEvidenceSource({
      get,
    }).read("event-1", "2026-08-06T12:00:00.000Z");
    expect(result.evidence).toMatchObject({
      availability: "current",
      canonicalEventVersion: 4,
      status: "scheduled",
    });
    expect(result.fence.expectedMaterialVersion).toBe(4);
    expect(get).toHaveBeenCalledTimes(3);
  });

  it("fences a stable missing pointer without fabricating event state", async () => {
    const get = vi.fn().mockResolvedValue(null);
    const result = await new DynamoOpportunityLifecycleEventEvidenceSource({
      get,
    }).read("event-1", "2026-08-06T12:00:00.000Z");
    expect(result.evidence.availability).toBe("missing");
    expect(result.evidence.status).toBeNull();
    expect(result.fence.expectedMaterialVersion).toBeNull();
  });

  it("suspends through indeterminate evidence when the event projection is stale", async () => {
    const pointer = {
      pk: "EVENT_DETAIL#event-1",
      sk: "CURRENT",
      value: {
        materialVersion: 4,
        sportPk: "sport-pk",
        sportSk: "sport-sk",
      },
    };
    const get = vi
      .fn()
      .mockResolvedValueOnce(pointer)
      .mockResolvedValueOnce({
        value: {
          eventId: "event-1",
          materialVersion: 4,
          sportKey: "mlb",
          status: "scheduled",
          startsAt: "2026-08-06T20:00:00.000Z",
          canonicalFreshness: "2026-08-06T09:00:00.000Z",
        },
      })
      .mockResolvedValueOnce(pointer);
    const result = await new DynamoOpportunityLifecycleEventEvidenceSource({
      get,
    }).read("event-1", "2026-08-06T12:00:00.000Z");
    expect(result.evidence).toMatchObject({
      availability: "indeterminate",
      status: null,
    });
    expect(result.fence.expectedMaterialVersion).toBe(4);
  });

  it.each(["cancelled", "started", "completed"])(
    "preserves known terminal %s status even when metadata is stale",
    async (status) => {
      const pointer = {
        value: {
          materialVersion: 4,
          sportPk: "sport-pk",
          sportSk: "sport-sk",
        },
      };
      const get = vi
        .fn()
        .mockResolvedValueOnce(pointer)
        .mockResolvedValueOnce({
          value: {
            eventId: "event-1",
            materialVersion: 4,
            sportKey: "mlb",
            status,
            startsAt: "2026-08-06T10:00:00.000Z",
            canonicalFreshness: "2026-08-06T09:00:00.000Z",
          },
        })
        .mockResolvedValueOnce(pointer);
      const result = await new DynamoOpportunityLifecycleEventEvidenceSource({
        get,
      }).read("event-1", "2026-08-06T12:00:00.000Z");
      expect(result.evidence).toMatchObject({
        availability: "current",
        status,
        canonicalEventVersion: 4,
      });
    },
  );
});
