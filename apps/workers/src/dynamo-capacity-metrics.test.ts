import { describe, expect, it, vi } from "vitest";
import { emitDynamoCapacityMetrics } from "./dynamo-capacity-metrics";

interface EmfPayload {
  readonly _aws: {
    readonly CloudWatchMetrics: readonly {
      readonly Namespace: string;
      readonly Dimensions: readonly (readonly string[])[];
      readonly Metrics: readonly {
        readonly Name: string;
        readonly Unit: string;
      }[];
    }[];
  };
  readonly Stage: string;
  readonly Operation: string;
  readonly Cause: string;
  readonly Prefix: string;
  readonly Resource: string;
  readonly RequestCount: number;
  readonly WriteCapacityUnits?: number;
  readonly UnattributedCapacityUnits?: number;
}

describe("Dynamo capacity EMF", () => {
  it("emits exact bounded dimensions and units", () => {
    vi.stubEnv("FTE_AWS_STAGE", "prod");
    const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    emitDynamoCapacityMetrics({
      operation: "transact-write",
      cause: "transact-write:ODDS_CONTROL#RUN",
      prefix: "ODDS_CONTROL#RUN",
      resource: "table",
      readUnits: 0,
      writeUnits: 3,
    });
    const payload = JSON.parse(String(write.mock.calls[0]?.[0])) as EmfPayload;
    expect(payload._aws.CloudWatchMetrics[0]).toEqual({
      Namespace: "FindTheEdge/DynamoCapacity",
      Dimensions: [["Stage", "Operation", "Cause", "Prefix", "Resource"]],
      Metrics: [
        { Name: "RequestCount", Unit: "Count" },
        { Name: "WriteCapacityUnits", Unit: "Count" },
      ],
    });
    expect(payload).toMatchObject({
      Stage: "prod",
      Operation: "transact-write",
      Prefix: "ODDS_CONTROL#RUN",
      Resource: "table",
      RequestCount: 1,
      WriteCapacityUnits: 3,
    });
    write.mockRestore();
    vi.unstubAllEnvs();
  });

  it("marks mixed units as unattributed and cannot expose arbitrary labels", () => {
    vi.stubEnv("FTE_AWS_STAGE", "unsafe stage value");
    const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    emitDynamoCapacityMetrics({
      operation: "get\nsecret",
      cause: "full-private-key-value",
      prefix: "MIXED",
      resource: "index",
      readUnits: 2,
      writeUnits: 0,
    });
    const serialized = String(write.mock.calls[0]?.[0]);
    const payload = JSON.parse(serialized) as EmfPayload;
    expect(payload).toMatchObject({
      Stage: "unknown",
      Operation: "unknown",
      Cause: "unknown:MIXED",
      Prefix: "MIXED",
      Resource: "index",
      UnattributedCapacityUnits: 2,
    });
    expect(serialized).not.toContain("private-key");
    write.mockRestore();
    vi.unstubAllEnvs();
  });
});
