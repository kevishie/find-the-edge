import { normalizeFixtureOddsObservation } from "@find-the-edge/domain";
import type { DynamoDBStreamEvent } from "aws-lambda";
import { describe, expect, it, vi } from "vitest";

import {
  createFixtureOddsProjectionHandler,
  isCanonicalSnapshotInsert,
} from "./fixture-odds-projection-lambda.js";

const snapshot = normalizeFixtureOddsObservation({
  canonicalEventId: "event-1",
  canonicalEventVersion: 1,
  sportKey: "baseball",
  marketKey: "moneyline",
  selectionKey: "team-1",
  sportsbookId: "draftkings",
  americanOdds: -110,
  observedAt: "2026-08-04T12:00:00.000Z",
  retrievedAt: "2026-08-04T12:00:01.000Z",
});
const attr = (value: unknown): Record<string, unknown> => {
  if (typeof value === "string") return { S: value };
  if (typeof value === "number") return { N: String(value) };
  if (value === null) return { NULL: true };
  if (Array.isArray(value)) return { L: value.map(attr) };
  return {
    M: Object.fromEntries(
      Object.entries(value as object).map(([k, v]) => [k, attr(v)]),
    ),
  };
};
const record = (id: string, overrides: Record<string, unknown> = {}) =>
  ({
    eventID: id,
    eventName: "INSERT",
    dynamodb: {
      Keys: { pk: { S: snapshot.partitionKey }, sk: { S: snapshot.sortKey } },
      NewImage: {
        pk: { S: snapshot.partitionKey },
        sk: { S: snapshot.sortKey },
        value: attr(snapshot),
      },
      ApproximateCreationDateTime: 1_722_772_800,
      SequenceNumber: `sequence-${id}`,
    },
    ...overrides,
  }) as unknown as DynamoDBStreamEvent["Records"][number];

describe("fixture odds projection stream", () => {
  it("filters exact immutable INSERT keys", () => {
    expect(isCanonicalSnapshotInsert(record("valid"))).toBe(true);
    expect(
      isCanonicalSnapshotInsert(record("modify", { eventName: "MODIFY" })),
    ).toBe(false);
    expect(
      isCanonicalSnapshotInsert(
        record("current", {
          dynamodb: {
            Keys: { pk: { S: snapshot.partitionKey }, sk: { S: "CURRENT" } },
          },
        }),
      ),
    ).toBe(false);
    expect(
      isCanonicalSnapshotInsert(
        record("mirror", {
          dynamodb: {
            Keys: {
              pk: { S: "ODDS_SNAPSHOTS_BY_ID" },
              sk: { S: snapshot.snapshotId },
            },
          },
        }),
      ),
    ).toBe(false);
  });

  it("processes valid records, ignores unrelated, and retries only malformed relevant records", async () => {
    const projector = {
      project: vi
        .fn()
        .mockResolvedValueOnce({ decision: "advanced", snapshot })
        .mockRejectedValueOnce(new Error("bad")),
    };
    const metrics = { emit: vi.fn() };
    const unrelated = record("event", {
      dynamodb: { Keys: { pk: { S: "EVENT#1" }, sk: { S: "CURRENT" } } },
    });
    const result = await createFixtureOddsProjectionHandler(
      projector as never,
      metrics,
      () => 1_722_772_801_000,
    )(
      { Records: [record("ok"), unrelated, record("bad")] },
      {} as never,
      vi.fn(),
    );
    expect(result).toEqual({
      batchItemFailures: [{ itemIdentifier: "sequence-bad" }],
    });
    expect(projector.project).toHaveBeenCalledTimes(2);
    expect(metrics.emit).toHaveBeenCalledWith("ProjectionProcessed", 1);
    expect(metrics.emit).toHaveBeenCalledWith("ProjectionAdvanced", 1);
    expect(metrics.emit).toHaveBeenCalledWith("ProjectionFailure", 1);
    expect(metrics.emit).toHaveBeenCalledWith(
      "ProjectionLagMilliseconds",
      1000,
    );
  });

  it("rejects mismatched envelope/image keys and logs only bounded locators", async () => {
    const projector = { project: vi.fn() };
    const metrics = { emit: vi.fn() };
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const mismatched = record("mismatch");
    mismatched.dynamodb!.NewImage!.pk = { S: `${snapshot.partitionKey}-other` };
    await expect(
      createFixtureOddsProjectionHandler(projector as never, metrics)(
        { Records: [mismatched] },
        {} as never,
        vi.fn(),
      ),
    ).resolves.toEqual({
      batchItemFailures: [{ itemIdentifier: "sequence-mismatch" }],
    });
    expect(projector.project).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('"sequenceNumber":"sequence-mismatch"'),
    );
    expect(error.mock.calls[0]![0]).not.toContain("americanOdds");
    error.mockRestore();
  });

  it("fails the whole invocation when a relevant record lacks a sequence number", async () => {
    const missing = record("missing");
    delete missing.dynamodb!.SequenceNumber;
    await expect(
      createFixtureOddsProjectionHandler({ project: vi.fn() } as never)(
        { Records: [missing] },
        {} as never,
        vi.fn(),
      ),
    ).rejects.toThrow("snapshot-stream-sequence-missing");
  });

  it("treats retained duplicate/out-of-order delivery as success", async () => {
    const projector = {
      project: vi.fn().mockResolvedValue({ decision: "retained", snapshot }),
    };
    const metrics = { emit: vi.fn() };
    const result = await createFixtureOddsProjectionHandler(
      projector as never,
      metrics,
    )(
      { Records: [record("duplicate"), record("older")] },
      {} as never,
      vi.fn(),
    );
    expect(result).toEqual({ batchItemFailures: [] });
    expect(metrics.emit).toHaveBeenCalledWith("ProjectionRetained", 1);
  });
});
