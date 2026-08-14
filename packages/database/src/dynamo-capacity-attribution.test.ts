import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it, vi } from "vitest";
import {
  attributedDynamoCapacity,
  dynamoRequestPrefix,
  instrumentDynamoCapacity,
  safeDynamoPartitionPrefix,
} from "./dynamo-capacity-attribution";

describe("DynamoDB capacity attribution", () => {
  it("reduces keys to bounded categories and never returns identifiers", () => {
    expect(safeDynamoPartitionPrefix("ODDS_CONTROL#RUN#secret-run-id")).toBe(
      "ODDS_CONTROL#RUN",
    );
    expect(safeDynamoPartitionPrefix("EVENT#private-event-id")).toBe("EVENT");
    expect(safeDynamoPartitionPrefix("private-user-id")).toBe("UNATTRIBUTED");
  });

  it("attributes single-prefix keys across direct, batch, query, and transaction inputs", () => {
    expect(dynamoRequestPrefix({ Key: { pk: "EVENT#secret" } })).toBe("EVENT");
    expect(
      dynamoRequestPrefix({
        RequestItems: {
          table: { Keys: [{ pk: "ODDS_CONTROL#HEALTH#secret" }] },
        },
      }),
    ).toBe("ODDS_CONTROL#HEALTH");
    expect(
      dynamoRequestPrefix({
        KeyConditionExpression: "#pk = :pk AND begins_with(#sk, :sk)",
        ExpressionAttributeNames: { "#pk": "pk", "#sk": "sk" },
        ExpressionAttributeValues: { ":pk": "BOARD#mlb", ":sk": "EVENT#fake" },
      }),
    ).toBe("BOARD");
    expect(
      dynamoRequestPrefix({
        TransactItems: [
          { Update: { Key: { pk: "ODDS_CONTROL#PAGE#one" } } },
          { Put: { Item: { pk: "ODDS_CONTROL#PAGE#two" } } },
        ],
      }),
    ).toBe("ODDS_CONTROL#PAGE");
  });

  it("does not mistake a query sort-key value for the partition prefix", () => {
    expect(
      dynamoRequestPrefix({
        KeyConditionExpression: "#partition = :partition AND #sort > :sort",
        ExpressionAttributeNames: { "#partition": "pk", "#sort": "sk" },
        ExpressionAttributeValues: {
          ":partition": "EVENT#real-partition",
          ":sort": "BOARD#prefix-looking-sort-key",
        },
      }),
    ).toBe("EVENT");
    expect(
      dynamoRequestPrefix({
        KeyConditionExpression: "#sort > :sort",
        ExpressionAttributeNames: { "#sort": "sk" },
        ExpressionAttributeValues: { ":sort": "BOARD#not-a-partition" },
      }),
    ).toBe("UNATTRIBUTED");
  });

  it("keeps mixed transactions and unknown scans in truthful residual buckets", () => {
    expect(
      dynamoRequestPrefix({
        TransactItems: [
          { Update: { Key: { pk: "ODDS_CONTROL#RUN#one" } } },
          { Put: { Item: { pk: "EVENT#two" } } },
        ],
      }),
    ).toBe("MIXED");
    expect(dynamoRequestPrefix({ TableName: "table" })).toBe("UNATTRIBUTED");
  });

  it("reports table and index units without heuristically splitting a mixed transaction", () => {
    expect(
      attributedDynamoCapacity(
        "TransactWriteCommand",
        {
          TransactItems: [
            { Put: { Item: { pk: "EVENT#one" } } },
            { Put: { Item: { pk: "BOARD#two" } } },
          ],
        },
        {
          ConsumedCapacity: [
            {
              TableName: "secret-table-name",
              Table: { WriteCapacityUnits: 3 },
              GlobalSecondaryIndexes: {
                "secret-index-name": { WriteCapacityUnits: 2 },
              },
            },
          ],
        },
      ),
    ).toEqual([
      {
        operation: "transact-write",
        cause: "transact-write:MIXED",
        prefix: "MIXED",
        resource: "table",
        readUnits: 0,
        writeUnits: 3,
      },
      {
        operation: "transact-write",
        cause: "transact-write:MIXED",
        prefix: "MIXED",
        resource: "index",
        readUnits: 0,
        writeUnits: 2,
      },
    ]);
  });

  it("handles the singular consumed-capacity response used by reads", () => {
    expect(
      attributedDynamoCapacity(
        "GetCommand",
        { Key: { pk: "EVENT#not-exported", sk: "CURRENT" } },
        { ConsumedCapacity: { Table: { ReadCapacityUnits: 0.5 } } },
      ),
    ).toEqual([
      expect.objectContaining({
        operation: "get",
        prefix: "EVENT",
        readUnits: 0.5,
        writeUnits: 0,
      }),
    ]);
  });

  it("does not emit zero-only or malformed capacity rows", () => {
    expect(
      attributedDynamoCapacity(
        "GetCommand",
        { Key: { pk: "EVENT#x" } },
        {
          ConsumedCapacity: { Table: { CapacityUnits: 1 } },
        },
      ),
    ).toEqual([]);
  });

  it("requests INDEXES and isolates reporter failures from successful storage calls", async () => {
    let installed:
      | ((
          next: (args: { input: unknown }) => Promise<unknown>,
          context: { commandName: string },
        ) => (args: { input: unknown }) => Promise<unknown>)
      | undefined;
    const client = {
      middlewareStack: {
        add(value: typeof installed) {
          installed = value;
        },
      },
    } as unknown as DynamoDBDocumentClient;
    const reporter = vi.fn(() => {
      throw new Error("telemetry-down");
    });
    instrumentDynamoCapacity(client, reporter);
    const input = { Key: { pk: "EVENT#never-log-this" } };
    const expected = {
      output: { ConsumedCapacity: { Table: { ReadCapacityUnits: 1 } } },
    };
    const next = vi.fn().mockResolvedValue(expected);

    const actual = await installed!(next, { commandName: "GetItemCommand" })({
      input,
    });

    expect(input).toEqual({ Key: { pk: "EVENT#never-log-this" } });
    expect(next).toHaveBeenCalledWith({
      input: {
        Key: { pk: "EVENT#never-log-this" },
        ReturnConsumedCapacity: "INDEXES",
      },
    });
    expect(actual).toBe(expected);
    expect(reporter).toHaveBeenCalledWith(
      expect.objectContaining({ prefix: "EVENT", readUnits: 1 }),
    );
    expect(JSON.stringify(reporter.mock.calls)).not.toContain("never-log-this");
  });

  it("uses the low-level command names exposed by DocumentClient middleware", async () => {
    const client = DynamoDBDocumentClient.from(
      new DynamoDBClient({
        region: "us-east-1",
        credentials: { accessKeyId: "test", secretAccessKey: "test" },
      }),
    );
    let commandName = "";
    let observedInput: unknown;
    instrumentDynamoCapacity(client, vi.fn());
    client.middlewareStack.add(
      (_next, context) => (args) => {
        commandName = context.commandName ?? "";
        observedInput = args.input;
        return Promise.reject(new Error("request-short-circuited"));
      },
      {
        step: "initialize",
        priority: "low",
        name: "observeDocumentClientCommandName",
      },
    );
    const input = { TableName: "test", Key: { pk: "EVENT#private" } };

    await expect(client.send(new GetCommand(input))).rejects.toThrow(
      "request-short-circuited",
    );

    expect(commandName).toBe("GetItemCommand");
    expect(observedInput).toMatchObject({ ReturnConsumedCapacity: "INDEXES" });
    expect(input).not.toHaveProperty("ReturnConsumedCapacity");
  });

  it("does not attach unsupported capacity parameters or invent missing metrics", async () => {
    let installed:
      | ((
          next: (args: { input: unknown }) => Promise<unknown>,
          context: { commandName: string },
        ) => (args: { input: unknown }) => Promise<unknown>)
      | undefined;
    const client = {
      middlewareStack: {
        add(value: unknown) {
          installed = value as NonNullable<typeof installed>;
        },
      },
    } as unknown as DynamoDBDocumentClient;
    const reporter = vi.fn();
    instrumentDynamoCapacity(client, reporter);
    const input = { SecretId: "secret" };
    await installed!(
      (args: { input: unknown }) => Promise.resolve({ output: {}, args }),
      { commandName: "GetSecretValueCommand" },
    )({ input });
    expect(input).toEqual({ SecretId: "secret" });
    expect(reporter).not.toHaveBeenCalled();
  });
});
