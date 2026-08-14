import { describe, expect, it, vi } from "vitest";
import { TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { DynamoDbStrategyExperimentRepository } from "./dynamodb-strategy-experiment-repository.js";

describe("Dynamo strategy experiment repository", () => {
  it("allows a stale audit omission without weakening authoritative experiment reads", async () => {
    const authoritative = { experimentId: "experiment-1", state: "paper" };
    const audit = { experimentId: "experiment-1", action: "approved" };
    const send = vi
      .fn()
      .mockResolvedValueOnce({ Items: [] })
      .mockResolvedValueOnce({ Item: { value: authoritative } })
      .mockResolvedValueOnce({ Items: [{ value: audit }] });
    const repo = new DynamoDbStrategyExperimentRepository(
      { send } as never,
      "table",
      {} as never,
    );
    await expect(repo.listAudit("experiment-1")).resolves.toEqual([]);
    await expect(repo.getExperiment("experiment-1")).resolves.toEqual(
      authoritative,
    );
    await expect(repo.listAudit("experiment-1")).resolves.toEqual([audit]);
    expect(
      (send.mock.calls[0]?.[0] as { input: Record<string, unknown> }).input,
    ).toMatchObject({ ConsistentRead: false, Limit: 100 });
    expect(
      (send.mock.calls[1]?.[0] as { input: Record<string, unknown> }).input,
    ).toMatchObject({ ConsistentRead: true });
    expect(
      (send.mock.calls[2]?.[0] as { input: Record<string, unknown> }).input,
    ).toMatchObject({ ConsistentRead: false, Limit: 100 });
    expect(
      (
        send.mock.calls as unknown as readonly [
          { readonly constructor: { readonly name: string } },
        ][]
      ).map(([command]) => command.constructor.name),
    ).toEqual(["QueryCommand", "GetCommand", "QueryCommand"]);
  });

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
