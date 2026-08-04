import { describe, expect, it, vi } from "vitest";
import { TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { DynamoDbStrategyExperimentRepository } from "./dynamodb-strategy-experiment-repository.js";

describe("Dynamo strategy experiment repository", () => {
  it("persists deployed artifacts conditionally without Scan", async () => {
    const send = vi.fn().mockResolvedValue({});
    const repo = new DynamoDbStrategyExperimentRepository(
      { send } as never,
      "table",
      {} as never,
    );
    await repo.putArtifact({
      strategyId: "fte",
      version: "2",
      digest: "a".repeat(64),
      deployedRevision: "revision-2",
      deployed: true,
      frozenAt: "2026-08-04T00:00:00.000Z",
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[0]).toBeInstanceOf(TransactWriteCommand);
    expect(JSON.stringify(send.mock.calls[0]?.[0])).not.toContain("Scan");
  });
});
