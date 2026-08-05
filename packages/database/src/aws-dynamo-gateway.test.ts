import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it, vi } from "vitest";
import { AwsDynamoGateway } from "./aws-dynamo-gateway";
import {
  DynamoConditionalConflict,
  DynamoTransactionConflict,
} from "./dynamodb-event-ingestion";
describe("Dynamo gateway", () => {
  it("paginates strongly consistent primary queries", async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({
        Items: [{ pk: "x" }],
        LastEvaluatedKey: { pk: "x", sk: "1" },
      })
      .mockResolvedValueOnce({ Items: [{ pk: "y" }] });
    const gateway = new AwsDynamoGateway(
      { send } as unknown as DynamoDBDocumentClient,
      "table",
    );
    expect(await gateway.queryUpTo("identity", 2)).toHaveLength(2);
    expect(send).toHaveBeenCalledTimes(2);
    const first = send.mock.calls[0]?.[0] as {
      input: { ConsistentRead?: boolean };
    };
    expect(first.input.ConsistentRead).toBe(true);
  });

  it("distinguishes conditional, transaction-conflict, and service cancellations", async () => {
    const conditional = Object.assign(new Error("cancelled"), {
      name: "TransactionCanceledException",
      CancellationReasons: [{ Code: "ConditionalCheckFailed" }],
    });
    const throttled = Object.assign(new Error("throttled"), {
      name: "TransactionCanceledException",
      CancellationReasons: [{ Code: "ThrottlingError" }],
    });
    const conflicted = Object.assign(new Error("conflicted"), {
      name: "TransactionCanceledException",
      CancellationReasons: [{ Code: "TransactionConflict" }],
    });
    const mixedOwnership = Object.assign(new Error("mixed"), {
      name: "TransactionCanceledException",
      CancellationReasons: [
        { Code: "ConditionalCheckFailed" },
        { Code: "TransactionConflict" },
      ],
    });
    const send = vi
      .fn()
      .mockRejectedValueOnce(conditional)
      .mockRejectedValueOnce(mixedOwnership)
      .mockRejectedValueOnce(conflicted)
      .mockRejectedValueOnce(throttled);
    const gateway = new AwsDynamoGateway(
      { send } as unknown as DynamoDBDocumentClient,
      "table",
    );
    await expect(
      gateway.transact([
        {
          kind: "insert",
          item: { pk: "pk", sk: "sk", value: {} },
        },
      ]),
    ).rejects.toBeInstanceOf(DynamoConditionalConflict);
    await expect(
      gateway.transact([
        {
          kind: "insert",
          item: { pk: "mixed-1", sk: "CURRENT", value: {} },
        },
        {
          kind: "insert",
          item: { pk: "mixed-2", sk: "CURRENT", value: {} },
        },
      ]),
    ).rejects.toBeInstanceOf(DynamoConditionalConflict);
    await expect(
      gateway.transact([
        {
          kind: "insert",
          item: { pk: "pk", sk: "sk", value: {} },
        },
      ]),
    ).rejects.toBeInstanceOf(DynamoTransactionConflict);
    await expect(
      gateway.transact([
        {
          kind: "insert",
          item: { pk: "pk", sk: "sk", value: {} },
        },
      ]),
    ).rejects.toBe(throttled);
  });

  it("emits conditional identity release and acquisition in one transaction", async () => {
    const send = vi.fn().mockResolvedValue({});
    const gateway = new AwsDynamoGateway(
      { send } as unknown as DynamoDBDocumentClient,
      "table",
    );
    await gateway.transact([
      {
        kind: "delete",
        pk: "IDENTITY_OWNER#old",
        sk: "CURRENT",
        expectedVersion: 4,
        expectedEventId: "event",
      },
      {
        kind: "claim-identity",
        item: {
          pk: "IDENTITY_OWNER#new",
          sk: "CURRENT",
          value: { eventId: "event", version: 1 },
        },
        eventId: "event",
      },
    ]);
    const command = send.mock.calls[0]?.[0] as {
      input: {
        TransactItems: readonly [
          { Delete: { ConditionExpression: string } },
          { Put: { ConditionExpression: string } },
        ];
      };
    };
    expect(command.input.TransactItems[0].Delete.ConditionExpression).toContain(
      "#value.#eventId=:eventId",
    );
    expect(
      command.input.TransactItems[0].Delete.ConditionExpression,
    ).not.toContain("#value=:eventId");
    expect(command.input.TransactItems[1].Put.ConditionExpression).toBe(
      "attribute_not_exists(pk)",
    );
  });

  it("deletes reconciliation locks with an owner and optional lease fence", async () => {
    const send = vi.fn().mockResolvedValue({});
    const gateway = new AwsDynamoGateway(
      { send } as unknown as DynamoDBDocumentClient,
      "table",
    );
    await gateway.deleteOwnedReconciliationLock(
      "EVENT_RECONCILIATION#scope",
      "owner",
      "2026-08-05T01:00:00.000Z",
    );
    const command = send.mock.calls[0]?.[0] as {
      input: {
        Key: { pk: string; sk: string };
        ConditionExpression: string;
      };
    };
    expect(command.input.Key).toEqual({
      pk: "EVENT_RECONCILIATION#scope",
      sk: "CURRENT",
    });
    expect(command.input.ConditionExpression).toBe(
      "#value.#eventId=:eventId AND #value.#leaseUntil=:leaseUntil",
    );
  });

  it("rejects non-lock deletes and maps transient delete contention", async () => {
    const conflict = new Error("sensitive");
    conflict.name = "TransactionConflictException";
    const send = vi.fn().mockRejectedValue(conflict);
    const gateway = new AwsDynamoGateway(
      { send } as unknown as DynamoDBDocumentClient,
      "table",
    );
    await expect(
      gateway.deleteOwnedReconciliationLock("EVENT#unsafe", "owner"),
    ).rejects.toThrow("invalid-reconciliation-lock-key");
    expect(send).not.toHaveBeenCalled();
    await expect(
      gateway.deleteOwnedReconciliationLock(
        "EVENT_RECONCILIATION#scope",
        "owner",
      ),
    ).rejects.toBeInstanceOf(DynamoTransactionConflict);
  });
});
