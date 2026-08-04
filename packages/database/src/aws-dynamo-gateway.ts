import {
  BatchGetCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactGetCommand,
  TransactWriteCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
} from "@aws-sdk/lib-dynamodb";
import type { IngestionCheckpoint } from "@find-the-edge/domain";
import type {
  DynamoGateway,
  DynamoItem,
  DynamoWrite,
} from "./dynamodb-event-ingestion";
import { DynamoConditionalConflict } from "./dynamodb-event-ingestion";
export class AwsDynamoGateway implements DynamoGateway {
  constructor(
    readonly client: DynamoDBDocumentClient,
    readonly tableName: string,
  ) {}
  async get(pk: string, sk: string) {
    const result = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { pk, sk },
        ConsistentRead: true,
      }),
    );
    return (result.Item as DynamoItem | undefined) ?? null;
  }
  async batchGet(
    keys: readonly { readonly pk: string; readonly sk: string }[],
  ) {
    const items: DynamoItem[] = [];
    for (let offset = 0; offset < keys.length; offset += 100) {
      let pending = keys.slice(offset, offset + 100);
      for (let attempt = 0; pending.length && attempt < 3; attempt++) {
        const result = await this.client.send(
          new BatchGetCommand({
            RequestItems: {
              [this.tableName]: {
                Keys: pending,
                ConsistentRead: true,
                ProjectionExpression: "pk, sk, #value, expiresAt",
                ExpressionAttributeNames: { "#value": "value" },
              },
            },
          }),
        );
        items.push(
          ...((result.Responses?.[this.tableName] ?? []) as DynamoItem[]),
        );
        pending = (result.UnprocessedKeys?.[this.tableName]?.Keys ?? []) as {
          pk: string;
          sk: string;
        }[];
      }
      if (pending.length) throw new Error("dynamo-batch-get-incomplete");
    }
    return items;
  }
  async queryUpTo(pk: string, limit: number) {
    const items: DynamoItem[] = [];
    let cursor: Record<string, unknown> | undefined;
    do {
      const result = await this.client.send(
        new QueryCommand({
          TableName: this.tableName,
          KeyConditionExpression: "pk = :pk",
          ExpressionAttributeValues: { ":pk": pk },
          ConsistentRead: true,
          ScanIndexForward: true,
          Limit: Math.max(1, limit - items.length),
          ...(cursor ? { ExclusiveStartKey: cursor } : {}),
        }),
      );
      items.push(...((result.Items as DynamoItem[] | undefined) ?? []));
      cursor = result.LastEvaluatedKey;
    } while (cursor && items.length < limit);
    return items.slice(0, limit);
  }
  async queryPage(pk: string, startSk: string | undefined, limit: number) {
    const result = await this.client.send(
      new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: "pk = :pk",
        ExpressionAttributeValues: { ":pk": pk },
        ConsistentRead: true,
        ScanIndexForward: true,
        Limit: limit,
        ...(startSk ? { ExclusiveStartKey: { pk, sk: startSk } } : {}),
      }),
    );
    return {
      items: (result.Items as DynamoItem[] | undefined) ?? [],
      ...(result.LastEvaluatedKey?.["sk"]
        ? { lastEvaluatedSk: String(result.LastEvaluatedKey["sk"]) }
        : {}),
    };
  }
  async transactGet(
    keys: readonly { readonly pk: string; readonly sk: string }[],
  ) {
    const result = await this.client.send(
      new TransactGetCommand({
        TransactItems: keys.map((Key) => ({
          Get: { TableName: this.tableName, Key },
        })),
      }),
    );
    return (result.Responses ?? []).map(
      (response) => (response.Item as DynamoItem | undefined) ?? null,
    );
  }
  async queryAll(pk: string) {
    const items: DynamoItem[] = [];
    let cursor: Record<string, unknown> | undefined;
    do {
      const result = await this.client.send(
        new QueryCommand({
          TableName: this.tableName,
          KeyConditionExpression: "pk = :pk",
          ExpressionAttributeValues: { ":pk": pk },
          ConsistentRead: true,
          ...(cursor ? { ExclusiveStartKey: cursor } : {}),
        }),
      );
      items.push(...((result.Items as DynamoItem[] | undefined) ?? []));
      cursor = result.LastEvaluatedKey;
    } while (cursor);
    return items;
  }
  async insert(item: DynamoItem) {
    try {
      await this.client.send(
        new PutCommand({
          TableName: this.tableName,
          Item: item,
          ConditionExpression: "attribute_not_exists(pk)",
        }),
      );
      return "inserted" as const;
    } catch (error) {
      if (
        error instanceof Error &&
        error.name === "ConditionalCheckFailedException"
      )
        return "exists" as const;
      throw error;
    }
  }
  async transact(writes: readonly DynamoWrite[]) {
    try {
      await this.client.send(
        new TransactWriteCommand({
          TransactItems: writes.map((write) =>
            write.kind === "put-provider-event-fence" ||
            write.kind === "put-bootstrap-marker"
              ? {
                  Put: {
                    TableName: this.tableName,
                    Item: write.item,
                    ConditionExpression:
                      "attribute_not_exists(pk) OR #value.#pagePositionDigest=:pagePositionDigest",
                    ExpressionAttributeNames: {
                      "#value": "value",
                      "#pagePositionDigest": "pagePositionDigest",
                    },
                    ExpressionAttributeValues: {
                      ":pagePositionDigest": write.expectedPagePositionDigest,
                    },
                  },
                }
              : write.kind === "check-identity"
                ? {
                    ConditionCheck: {
                      TableName: this.tableName,
                      Key: { pk: write.pk, sk: write.sk },
                      ConditionExpression:
                        "#value.#version=:version AND #value.#candidateEventIds=:candidateEventIds",
                      ExpressionAttributeNames: {
                        "#value": "value",
                        "#version": "version",
                        "#candidateEventIds": "candidateEventIds",
                      },
                      ExpressionAttributeValues: {
                        ":version": write.expectedVersion,
                        ":candidateEventIds": write.expectedCandidateEventIds,
                      },
                    },
                  }
                : write.kind === "check-identity-absent"
                  ? {
                      ConditionCheck: {
                        TableName: this.tableName,
                        Key: { pk: write.pk, sk: write.sk },
                        ConditionExpression: "attribute_not_exists(pk)",
                      },
                    }
                  : write.kind === "check-reconciliation-lock"
                    ? {
                        ConditionCheck: {
                          TableName: this.tableName,
                          Key: { pk: write.pk, sk: write.sk },
                          ConditionExpression:
                            "#value.#eventId=:token AND #value.#leaseUntil>:leaseAfter",
                          ExpressionAttributeNames: {
                            "#value": "value",
                            "#eventId": "eventId",
                            "#leaseUntil": "leaseUntil",
                          },
                          ExpressionAttributeValues: {
                            ":token": write.expectedToken,
                            ":leaseAfter": write.leaseAfter,
                          },
                        },
                      }
                    : write.kind === "renew-reconciliation-lock"
                      ? {
                          Put: {
                            TableName: this.tableName,
                            Item: write.item,
                            ConditionExpression: "#value.#eventId=:token",
                            ExpressionAttributeNames: {
                              "#value": "value",
                              "#eventId": "eventId",
                            },
                            ExpressionAttributeValues: {
                              ":token": write.expectedToken,
                            },
                          },
                        }
                      : write.kind === "check-event"
                        ? {
                            ConditionCheck: {
                              TableName: this.tableName,
                              Key: { pk: write.pk, sk: write.sk },
                              ConditionExpression:
                                "#value.#version=:version AND #value.#identity=:identity" +
                                (write.expectedSnapshot
                                  ? " AND #value=:snapshot"
                                  : ""),
                              ExpressionAttributeNames: {
                                "#value": "value",
                                "#version": "version",
                                "#identity": "candidateIdentity",
                              },
                              ExpressionAttributeValues: {
                                ":version": write.expectedVersion,
                                ":identity": write.expectedIdentity,
                                ...(write.expectedSnapshot
                                  ? { ":snapshot": write.expectedSnapshot }
                                  : {}),
                              },
                            },
                          }
                        : write.kind === "delete"
                          ? {
                              Delete: {
                                TableName: this.tableName,
                                Key: { pk: write.pk, sk: write.sk },
                                ...(write.expectedVersion !== undefined ||
                                write.expectedEventId !== undefined ||
                                write.expectedLeaseUntil !== undefined
                                  ? {
                                      ConditionExpression: [
                                        ...(write.expectedVersion !== undefined
                                          ? ["#value.#version=:version"]
                                          : []),
                                        ...(write.expectedEventId !== undefined
                                          ? [
                                              "(#value.#eventId=:eventId OR #value=:eventId)",
                                            ]
                                          : []),
                                        ...(write.expectedLeaseUntil !==
                                        undefined
                                          ? ["#value.#leaseUntil=:leaseUntil"]
                                          : []),
                                      ].join(" AND "),
                                      ExpressionAttributeNames: {
                                        "#value": "value",
                                        ...(write.expectedVersion !== undefined
                                          ? { "#version": "version" }
                                          : {}),
                                        ...(write.expectedEventId !== undefined
                                          ? { "#eventId": "eventId" }
                                          : {}),
                                        ...(write.expectedLeaseUntil !==
                                        undefined
                                          ? { "#leaseUntil": "leaseUntil" }
                                          : {}),
                                      },
                                      ExpressionAttributeValues: {
                                        ...(write.expectedVersion !== undefined
                                          ? {
                                              ":version": write.expectedVersion,
                                            }
                                          : {}),
                                        ...(write.expectedEventId !== undefined
                                          ? {
                                              ":eventId": write.expectedEventId,
                                            }
                                          : {}),
                                        ...(write.expectedLeaseUntil !==
                                        undefined
                                          ? {
                                              ":leaseUntil":
                                                write.expectedLeaseUntil,
                                            }
                                          : {}),
                                      },
                                    }
                                  : {}),
                              },
                            }
                          : write.kind === "put-projection"
                            ? {
                                Put: {
                                  TableName: this.tableName,
                                  Item: write.item,
                                  ...(write.expectedValue !== undefined
                                    ? {
                                        ConditionExpression:
                                          "#value = :projectionExpected",
                                        ExpressionAttributeNames: {
                                          "#value": "value",
                                        },
                                        ExpressionAttributeValues: {
                                          ":projectionExpected":
                                            write.expectedValue,
                                        },
                                      }
                                    : write.requireAbsent
                                      ? {
                                          ConditionExpression:
                                            "attribute_not_exists(pk)",
                                        }
                                      : {}),
                                },
                              }
                            : write.kind === "insert" ||
                                write.kind === "claim-identity"
                              ? {
                                  Put: {
                                    TableName: this.tableName,
                                    Item: write.item,
                                    ConditionExpression:
                                      "attribute_not_exists(pk)",
                                  },
                                }
                              : {
                                  Put: {
                                    TableName: this.tableName,
                                    Item: write.item,
                                    ConditionExpression:
                                      "#value.#version = :expected",
                                    ExpressionAttributeNames: {
                                      "#value": "value",
                                      "#version": "version",
                                    },
                                    ExpressionAttributeValues: {
                                      ":expected": write.expectedVersion,
                                    },
                                  },
                                },
          ),
        }),
      );
    } catch (error) {
      if (
        error instanceof Error &&
        (error.name === "ConditionalCheckFailedException" ||
          isConditionalTransactionCancellation(error))
      )
        throw new DynamoConditionalConflict();
      throw error;
    }
  }
  async compareAndSetCheckpoint(
    pk: string,
    expected: IngestionCheckpoint | null,
    next: IngestionCheckpoint,
  ) {
    try {
      await this.client.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { pk, sk: "CURRENT" },
          UpdateExpression: "SET #value=:value",
          ConditionExpression: expected
            ? "#value=:expected"
            : "attribute_not_exists(pk)",
          ExpressionAttributeNames: {
            "#value": "value",
          },
          ExpressionAttributeValues: {
            ":value": next,
            ...(expected ? { ":expected": expected } : {}),
          },
        }),
      );
      return true;
    } catch (error) {
      if (
        error instanceof Error &&
        error.name === "ConditionalCheckFailedException"
      )
        return false;
      throw error;
    }
  }
  async transactCheckpoint(
    pk: string,
    expected: IngestionCheckpoint | null,
    next: IngestionCheckpoint,
    writes: readonly DynamoWrite[],
  ) {
    try {
      await this.client.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Put: {
                TableName: this.tableName,
                Item: { pk, sk: "CURRENT", value: next },
                ConditionExpression: expected
                  ? "#value=:expected"
                  : "attribute_not_exists(pk)",
                ...(expected
                  ? {
                      ExpressionAttributeNames: { "#value": "value" },
                      ExpressionAttributeValues: { ":expected": expected },
                    }
                  : {}),
              },
            },
            ...writes.map((write) =>
              write.kind === "put-provider-event-fence" ||
              write.kind === "put-bootstrap-marker"
                ? {
                    Put: {
                      TableName: this.tableName,
                      Item: write.item,
                      ConditionExpression:
                        "attribute_not_exists(pk) OR #value.#pagePositionDigest=:pagePositionDigest",
                      ExpressionAttributeNames: {
                        "#value": "value",
                        "#pagePositionDigest": "pagePositionDigest",
                      },
                      ExpressionAttributeValues: {
                        ":pagePositionDigest": write.expectedPagePositionDigest,
                      },
                    },
                  }
                : write.kind === "check-identity"
                  ? {
                      ConditionCheck: {
                        TableName: this.tableName,
                        Key: { pk: write.pk, sk: write.sk },
                        ConditionExpression:
                          "#value.#version=:version AND #value.#candidateEventIds=:candidateEventIds",
                        ExpressionAttributeNames: {
                          "#value": "value",
                          "#version": "version",
                          "#candidateEventIds": "candidateEventIds",
                        },
                        ExpressionAttributeValues: {
                          ":version": write.expectedVersion,
                          ":candidateEventIds": write.expectedCandidateEventIds,
                        },
                      },
                    }
                  : write.kind === "check-identity-absent"
                    ? {
                        ConditionCheck: {
                          TableName: this.tableName,
                          Key: { pk: write.pk, sk: write.sk },
                          ConditionExpression: "attribute_not_exists(pk)",
                        },
                      }
                    : write.kind === "check-reconciliation-lock"
                      ? {
                          ConditionCheck: {
                            TableName: this.tableName,
                            Key: { pk: write.pk, sk: write.sk },
                            ConditionExpression:
                              "#value.#eventId=:token AND #value.#leaseUntil>:leaseAfter",
                            ExpressionAttributeNames: {
                              "#value": "value",
                              "#eventId": "eventId",
                              "#leaseUntil": "leaseUntil",
                            },
                            ExpressionAttributeValues: {
                              ":token": write.expectedToken,
                              ":leaseAfter": write.leaseAfter,
                            },
                          },
                        }
                      : write.kind === "renew-reconciliation-lock"
                        ? {
                            Put: {
                              TableName: this.tableName,
                              Item: write.item,
                              ConditionExpression: "#value.#eventId=:token",
                              ExpressionAttributeNames: {
                                "#value": "value",
                                "#eventId": "eventId",
                              },
                              ExpressionAttributeValues: {
                                ":token": write.expectedToken,
                              },
                            },
                          }
                        : write.kind === "check-event"
                          ? {
                              ConditionCheck: {
                                TableName: this.tableName,
                                Key: { pk: write.pk, sk: write.sk },
                                ConditionExpression:
                                  "#value.#version=:version AND #value.#identity=:identity" +
                                  (write.expectedSnapshot
                                    ? " AND #value=:snapshot"
                                    : ""),
                                ExpressionAttributeNames: {
                                  "#value": "value",
                                  "#version": "version",
                                  "#identity": "candidateIdentity",
                                },
                                ExpressionAttributeValues: {
                                  ":version": write.expectedVersion,
                                  ":identity": write.expectedIdentity,
                                  ...(write.expectedSnapshot
                                    ? { ":snapshot": write.expectedSnapshot }
                                    : {}),
                                },
                              },
                            }
                          : write.kind === "insert" ||
                              write.kind === "claim-identity"
                            ? {
                                Put: {
                                  TableName: this.tableName,
                                  Item: write.item,
                                  ConditionExpression:
                                    "attribute_not_exists(pk)",
                                },
                              }
                            : write.kind === "delete"
                              ? {
                                  Delete: {
                                    TableName: this.tableName,
                                    Key: { pk: write.pk, sk: write.sk },
                                    ...(write.expectedVersion !== undefined ||
                                    write.expectedEventId !== undefined ||
                                    write.expectedLeaseUntil !== undefined
                                      ? {
                                          ConditionExpression: [
                                            ...(write.expectedVersion !==
                                            undefined
                                              ? ["#value.#version=:version"]
                                              : []),
                                            ...(write.expectedEventId !==
                                            undefined
                                              ? [
                                                  "(#value.#eventId=:eventId OR #value=:eventId)",
                                                ]
                                              : []),
                                            ...(write.expectedLeaseUntil !==
                                            undefined
                                              ? [
                                                  "#value.#leaseUntil=:leaseUntil",
                                                ]
                                              : []),
                                          ].join(" AND "),
                                          ExpressionAttributeNames: {
                                            "#value": "value",
                                            ...(write.expectedVersion !==
                                            undefined
                                              ? { "#version": "version" }
                                              : {}),
                                            ...(write.expectedEventId !==
                                            undefined
                                              ? { "#eventId": "eventId" }
                                              : {}),
                                            ...(write.expectedLeaseUntil !==
                                            undefined
                                              ? { "#leaseUntil": "leaseUntil" }
                                              : {}),
                                          },
                                          ExpressionAttributeValues: {
                                            ...(write.expectedVersion !==
                                            undefined
                                              ? {
                                                  ":version":
                                                    write.expectedVersion,
                                                }
                                              : {}),
                                            ...(write.expectedEventId !==
                                            undefined
                                              ? {
                                                  ":eventId":
                                                    write.expectedEventId,
                                                }
                                              : {}),
                                            ...(write.expectedLeaseUntil !==
                                            undefined
                                              ? {
                                                  ":leaseUntil":
                                                    write.expectedLeaseUntil,
                                                }
                                              : {}),
                                          },
                                        }
                                      : {}),
                                  },
                                }
                              : write.kind === "put-projection"
                                ? {
                                    Put: {
                                      TableName: this.tableName,
                                      Item: write.item,
                                      ...(write.expectedValue !== undefined
                                        ? {
                                            ConditionExpression:
                                              "#value = :projectionExpected",
                                            ExpressionAttributeNames: {
                                              "#value": "value",
                                            },
                                            ExpressionAttributeValues: {
                                              ":projectionExpected":
                                                write.expectedValue,
                                            },
                                          }
                                        : write.requireAbsent
                                          ? {
                                              ConditionExpression:
                                                "attribute_not_exists(pk)",
                                            }
                                          : {}),
                                    },
                                  }
                                : {
                                    Put: {
                                      TableName: this.tableName,
                                      Item: write.item,
                                      ConditionExpression:
                                        "#value.#version=:version",
                                      ExpressionAttributeNames: {
                                        "#value": "value",
                                        "#version": "version",
                                      },
                                      ExpressionAttributeValues: {
                                        ":version": write.expectedVersion,
                                      },
                                    },
                                  },
            ),
          ],
        }),
      );
      return true;
    } catch (error) {
      if (
        error instanceof Error &&
        (error.name === "ConditionalCheckFailedException" ||
          isConditionalTransactionCancellation(error))
      )
        return false;
      throw error;
    }
  }
  async put(item: DynamoItem) {
    await this.client.send(
      new PutCommand({ TableName: this.tableName, Item: item }),
    );
  }
}

function isConditionalTransactionCancellation(error: Error): boolean {
  if (error.name !== "TransactionCanceledException") return false;
  const reasons = (
    error as Error & {
      CancellationReasons?: readonly { Code?: string }[];
    }
  ).CancellationReasons;
  return (
    !!reasons?.some((reason) => reason.Code === "ConditionalCheckFailed") &&
    reasons.every(
      (reason) =>
        !reason.Code ||
        reason.Code === "None" ||
        reason.Code === "ConditionalCheckFailed",
    )
  );
}
