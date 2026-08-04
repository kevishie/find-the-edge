import { describe, expect, it } from "vitest";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { DynamoPaperPickRunRepository } from "./dynamodb-paper-pick-run-repository";

const identity = {
  policyId: "schedule",
  policyVersion: "1",
  scheduledFor: "2026-08-04T12:00:00.000Z",
  sportKey: "baseball",
  leagueKey: "mlb",
  strategyId: "ml",
  strategyVersion: "1",
  marketKey: "moneyline",
  mode: "shadow" as const,
};
const candidate = {
  eventId: "event",
  eventVersion: 1,
  sportKey: "baseball",
  leagueKey: "mlb",
  participantIds: ["away", "home"],
  startsAt: "2026-08-04T14:00:00.000Z",
};
describe("Dynamo paper-pick run repository", () => {
  it("uses conditional writes, run-partition queries, and one fenced budget transaction without Scan", async () => {
    const commands: unknown[] = [];
    const client = {
      send(command: {
        input: Record<string, unknown>;
        constructor: { name: string };
      }) {
        commands.push(command);
        if (
          command.constructor.name === "GetCommand" &&
          (command.input["Key"] as { sk?: string })?.sk === "META"
        )
          return Promise.resolve({
            Item: {
              value: {
                runId: "run",
                generationId: "generation",
              },
            },
          });
        if (command.constructor.name === "GetCommand")
          return Promise.resolve({
            Item: {
              pk: `PAPER_PICK_RUN#paper-pick-run:${"a".repeat(64)}`,
              sk: `ITEM#paper-pick-item:${"a".repeat(64)}:${"b".repeat(64)}`,
              value: { state: "claimed" },
            },
          });
        if (command.constructor.name === "QueryCommand")
          return Promise.resolve({
            Items: [
              {
                pk: "run",
                sk: "item",
                claimToken: "token",
                concurrencyHeld: false,
              },
            ],
          });
        return Promise.resolve({ Attributes: { value: { state: "claimed" } } });
      },
    } as unknown as DynamoDBDocumentClient;
    const repo = new DynamoPaperPickRunRepository(client, "table");
    const generationId = await repo.createGeneration(
      "schedule",
      "1",
      identity.scheduledFor,
      {
        events: 1,
        modelCalls: 2,
        inputTokens: 200,
        outputTokens: 100,
        costMicros: 20,
        concurrency: 1,
      },
    );
    await repo.createRun(
      identity,
      identity.scheduledFor,
      [candidate],
      generationId,
    );
    const runId = (
      commands[1] as { input: { Item: { value: { runId: string } } } }
    ).input.Item.value.runId;
    await repo.createItem(runId, candidate, "shadow");
    const itemId = `paper-pick-item:${runId.slice("paper-pick-run:".length)}:${"b".repeat(64)}`;
    await repo.reserve(
      itemId,
      "token",
      {
        modelCalls: 1,
        inputTokens: 100,
        outputTokens: 50,
        costMicros: 10,
        concurrency: 1,
      },
      {
        events: 1,
        modelCalls: 2,
        inputTokens: 200,
        outputTokens: 100,
        costMicros: 20,
        concurrency: 1,
      },
    );
    const rendered = JSON.stringify(
      commands.map((command) => ({
        name: (command as { constructor: { name: string } }).constructor.name,
        input: (command as { input: unknown }).input,
      })),
    );
    expect(rendered).toContain("TransactWriteCommand");
    expect(rendered).toContain("leaseExpiresAt > :now");
    expect(rendered).not.toContain("ScanCommand");
    expect(rendered).not.toContain("FilterExpression");
  });

  it("atomically transfers an expired held concurrency slot by exact item key", async () => {
    const commands: unknown[] = [];
    const runId = `paper-pick-run:${"a".repeat(64)}`;
    const itemId = `paper-pick-item:${"a".repeat(64)}:${"b".repeat(64)}`;
    const client = {
      send(command: {
        input: Record<string, unknown>;
        constructor: { name: string };
      }) {
        commands.push(command);
        if (command.constructor.name === "GetCommand") {
          const key = command.input["Key"] as { sk: string };
          if (key.sk.startsWith("ITEM#"))
            return Promise.resolve({
              Item: {
                pk: `PAPER_PICK_RUN#${runId}`,
                sk: `ITEM#${itemId}`,
                value: {
                  ...candidate,
                  itemId,
                  runId,
                  mode: "shadow",
                  state: "claimed",
                },
                claimToken: "old-token",
                leaseExpiresAt: "2026-08-04T12:00:00.001Z",
                concurrencyHeld: true,
              },
            });
          return Promise.resolve({
            Item: { value: { runId, generationId: "generation" } },
          });
        }
        return Promise.resolve({});
      },
    } as unknown as DynamoDBDocumentClient;
    const repo = new DynamoPaperPickRunRepository(client, "table");
    await expect(
      repo.claimItem(itemId, "new-owner", "2026-08-04T12:00:00.002Z", 60_000),
    ).resolves.toMatchObject({ item: { state: "claimed" } });
    const transaction = commands.find(
      (command) =>
        (command as { constructor: { name: string } }).constructor.name ===
        "TransactWriteCommand",
    ) as { input: unknown } | undefined;
    const rendered = JSON.stringify(transaction?.input);
    expect(rendered).toContain("budget.concurrency=budget.concurrency-:one");
    expect(rendered).toContain(`ITEM#${itemId}`);
    expect(rendered).toContain("claimToken=:priorToken");
    expect(JSON.stringify(commands)).not.toContain("QueryCommand");
  });
});
