import {
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  type DynamoDBDocumentClient,
} from "@aws-sdk/lib-dynamodb";
import {
  stableCohortValue,
  transitionRetrospective,
  validateRetrospectiveVersion,
  type RetrospectiveReviewDecision,
  type RetrospectiveVersion,
} from "@find-the-edge/domain";
import {
  RetrospectiveConflictError,
  RetrospectiveNotFoundError,
  validateRetrospectiveReviewReplay,
  type PublicRetrospectiveAudit,
  type RetrospectiveRepository,
} from "./retrospective-repository";
import { EventCursorError } from "./event-errors";
import type { EventCursorCodec } from "./event-repository";
const conditional = (error: unknown) =>
  error instanceof Error &&
  ["ConditionalCheckFailedException", "TransactionCanceledException"].includes(
    error.name,
  );
const listIndexSk = (createdAt: string, retrospectiveId: string) =>
  `${String(8_640_000_000_000_000 - Date.parse(createdAt)).padStart(16, "0")}#${retrospectiveId}`;
export class DynamoRetrospectiveRepository implements RetrospectiveRepository {
  constructor(
    private readonly client: DynamoDBDocumentClient,
    private readonly tableName: string,
    private readonly cursorCodec?: EventCursorCodec,
  ) {}
  private cursor(scope: string, key: string) {
    if (!this.cursorCodec)
      throw new Error("retrospective-cursor-codec-missing");
    const now = new Date();
    return this.cursorCodec.encode(
      `RETROSPECTIVE_CURSOR#${scope}`,
      key,
      now.toISOString(),
      now,
    );
  }
  private decode(scope: string, cursor: string) {
    if (!this.cursorCodec) throw new EventCursorError("invalid-cursor");
    return this.cursorCodec.decode(cursor, `RETROSPECTIVE_CURSOR#${scope}`)
      .lastSk;
  }
  async putVersion(value: RetrospectiveVersion) {
    validateRetrospectiveVersion(value);
    let predecessor: RetrospectiveVersion | null = null;
    if (value.version > 1) {
      predecessor = value.predecessorVersionId
        ? await this.getVersion(value.predecessorVersionId)
        : null;
      const current = await this.getCurrent(value.retrospectiveId);
      if (
        !predecessor ||
        predecessor.retrospectiveId !== value.retrospectiveId ||
        predecessor.version + 1 !== value.version ||
        current?.versionId !== predecessor.versionId
      )
        throw new RetrospectiveConflictError("retrospective-lineage-conflict");
    }
    const indexValue = {
      retrospectiveId: value.retrospectiveId,
      versionId: value.versionId,
      version: value.version,
      createdAt: value.createdAt,
    };
    try {
      await this.client.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Put: {
                TableName: this.tableName,
                Item: {
                  pk: `RETROSPECTIVE#${value.retrospectiveId}`,
                  sk: `VERSION#${String(value.version).padStart(8, "0")}`,
                  value,
                },
                ConditionExpression:
                  "attribute_not_exists(pk) AND attribute_not_exists(sk)",
              },
            },
            {
              Put: {
                TableName: this.tableName,
                Item: {
                  pk: `RETROSPECTIVE_REPORT#${value.retrospectiveId}`,
                  sk: value.reportId,
                  value: {
                    retrospectiveId: value.retrospectiveId,
                    reportId: value.reportId,
                    versionId: value.versionId,
                  },
                },
                ConditionExpression:
                  "attribute_not_exists(pk) AND attribute_not_exists(sk)",
              },
            },
            {
              Put: {
                TableName: this.tableName,
                Item: {
                  pk: `RETROSPECTIVE_VERSION#${value.versionId}`,
                  sk: "RECORD",
                  value,
                },
                ConditionExpression:
                  "attribute_not_exists(pk) AND attribute_not_exists(sk)",
              },
            },
            {
              Put: {
                TableName: this.tableName,
                Item: {
                  pk: `RETROSPECTIVE#${value.retrospectiveId}`,
                  sk: "CURRENT",
                  value: { versionId: value.versionId, version: value.version },
                },
                ...(value.version > 1
                  ? {
                      ConditionExpression: "#value.#version = :previous",
                      ExpressionAttributeNames: {
                        "#value": "value",
                        "#version": "version",
                      },
                      ExpressionAttributeValues: {
                        ":previous": value.version - 1,
                      },
                    }
                  : {
                      ConditionExpression:
                        "attribute_not_exists(pk) AND attribute_not_exists(sk)",
                    }),
              },
            },
            ...(value.version > 1 && value.predecessorVersionId
              ? [
                  {
                    Delete: {
                      TableName: this.tableName,
                      Key: {
                        pk: "RETROSPECTIVES",
                        sk: listIndexSk(
                          predecessor!.createdAt,
                          value.retrospectiveId,
                        ),
                      },
                      ConditionExpression: "#value.#version = :previous",
                      ExpressionAttributeNames: {
                        "#value": "value",
                        "#version": "version",
                      },
                      ExpressionAttributeValues: {
                        ":previous": value.version - 1,
                      },
                    },
                  },
                ]
              : []),
            {
              Put: {
                TableName: this.tableName,
                Item: {
                  pk: "RETROSPECTIVES",
                  sk: listIndexSk(value.createdAt, value.retrospectiveId),
                  value: indexValue,
                },
                ConditionExpression:
                  "attribute_not_exists(pk) AND attribute_not_exists(sk)",
              },
            },
          ],
        }),
      );
    } catch (error) {
      if (!conditional(error)) throw error;
      const existing = await this.getVersion(value.versionId);
      if (!existing || stableCohortValue(existing) !== stableCohortValue(value))
        throw new RetrospectiveConflictError("retrospective-version-conflict");
    }
    return structuredClone(value);
  }
  async getVersion(id: string) {
    const result = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { pk: `RETROSPECTIVE_VERSION#${id}`, sk: "RECORD" },
        ConsistentRead: true,
      }),
    );
    const value = result.Item?.["value"] as RetrospectiveVersion | undefined;
    return value ? validateRetrospectiveVersion(value) : null;
  }
  async getCurrent(id: string) {
    const result = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { pk: `RETROSPECTIVE#${id}`, sk: "CURRENT" },
        ConsistentRead: true,
      }),
    );
    const versionId = (
      result.Item?.["value"] as { versionId?: unknown } | undefined
    )?.versionId;
    return typeof versionId === "string" ? this.getVersion(versionId) : null;
  }
  async getByReport(retrospectiveId: string, reportId: string) {
    const result = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { pk: `RETROSPECTIVE_REPORT#${retrospectiveId}`, sk: reportId },
        ConsistentRead: true,
      }),
    );
    if (!result.Item) return null;
    const link = result.Item["value"] as {
      retrospectiveId?: unknown;
      reportId?: unknown;
      versionId?: unknown;
    };
    if (
      link.retrospectiveId !== retrospectiveId ||
      link.reportId !== reportId ||
      typeof link.versionId !== "string"
    )
      throw new RetrospectiveConflictError(
        "retrospective-report-index-corrupt",
      );
    const stored = await this.getVersion(link.versionId);
    if (
      !stored ||
      stored.retrospectiveId !== retrospectiveId ||
      stored.reportId !== reportId
    )
      throw new RetrospectiveConflictError(
        "retrospective-report-index-corrupt",
      );
    return stored;
  }
  private async query(
    pk: string,
    scope: string,
    input: { limit: number; cursor?: string },
    reverse = true,
    prefix?: string,
  ) {
    if (
      !Number.isSafeInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > 50
    )
      throw new Error("retrospective-limit-invalid");
    const key = input.cursor ? this.decode(scope, input.cursor) : undefined;
    if (key) {
      const cursorRow = await this.client.send(
        new GetCommand({
          TableName: this.tableName,
          Key: { pk, sk: key },
          ConsistentRead: true,
        }),
      );
      if (!cursorRow.Item || (prefix && !key.startsWith(prefix)))
        throw new EventCursorError("invalid-cursor");
    }
    const result = await this.client.send(
      new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: prefix
          ? "pk = :pk AND begins_with(sk, :prefix)"
          : "pk = :pk",
        ExpressionAttributeValues: {
          ":pk": pk,
          ...(prefix ? { ":prefix": prefix } : {}),
        },
        Limit: input.limit,
        ScanIndexForward: !reverse,
        ConsistentRead: true,
        ...(key ? { ExclusiveStartKey: { pk, sk: key } } : {}),
      }),
    );
    return {
      rows: result.Items ?? [],
      ...(result.LastEvaluatedKey?.["sk"]
        ? {
            nextCursor: this.cursor(
              scope,
              String(result.LastEvaluatedKey["sk"]),
            ),
          }
        : {}),
    };
  }
  async list(input: { limit: number; cursor?: string }) {
    const page = await this.query(
      "RETROSPECTIVES",
      "retrospectives",
      input,
      false,
    );
    const items = await Promise.all(
      page.rows.map(async (row) => {
        const index = row["value"] as {
          retrospectiveId?: unknown;
          versionId?: unknown;
          version?: unknown;
          createdAt?: unknown;
        };
        if (
          row["sk"] !==
            listIndexSk(
              String(index.createdAt),
              String(index.retrospectiveId),
            ) ||
          typeof index.retrospectiveId !== "string" ||
          typeof index.versionId !== "string" ||
          !Number.isSafeInteger(index.version) ||
          typeof index.createdAt !== "string"
        )
          throw new RetrospectiveConflictError("retrospective-index-corrupt");
        const current = await this.getCurrent(index.retrospectiveId);
        if (
          !current ||
          current.versionId !== index.versionId ||
          current.version !== index.version ||
          current.createdAt !== index.createdAt
        )
          throw new RetrospectiveConflictError("retrospective-index-corrupt");
        return current;
      }),
    );
    return {
      items,
      ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    };
  }
  async listVersions(input: {
    retrospectiveId: string;
    limit: number;
    cursor?: string;
  }) {
    const page = await this.query(
      `RETROSPECTIVE#${input.retrospectiveId}`,
      `versions:${input.retrospectiveId}`,
      input,
      true,
      "VERSION#",
    );
    const indexItems = page.rows.map((row) => ({
      row,
      value: row["value"] as RetrospectiveVersion,
    }));
    const items = await Promise.all(
      indexItems.map(async ({ row, value: index }) => {
        if (
          row["sk"] !== `VERSION#${String(index.version).padStart(8, "0")}` ||
          index.retrospectiveId !== input.retrospectiveId
        )
          throw new RetrospectiveConflictError("retrospective-index-corrupt");
        const stored = await this.getVersion(index.versionId);
        if (!stored || stableCohortValue(stored) !== stableCohortValue(index))
          throw new RetrospectiveConflictError("retrospective-index-corrupt");
        return stored;
      }),
    );
    return {
      items,
      ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    };
  }
  async review(input: Parameters<RetrospectiveRepository["review"]>[0]) {
    const replay = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: {
          pk: `RETROSPECTIVE_REPLAY#${input.versionId}`,
          sk: input.idempotencyKey,
        },
        ConsistentRead: true,
      }),
    );
    if (replay.Item?.["value"]) {
      const value = replay.Item["value"] as {
        version: RetrospectiveVersion;
        decision: RetrospectiveReviewDecision;
      };
      return validateRetrospectiveReviewReplay(value, input);
    }
    const stored = await this.getVersion(input.versionId);
    if (!stored)
      throw new RetrospectiveNotFoundError("retrospective-not-found");
    let result;
    try {
      result = transitionRetrospective(stored, input);
    } catch {
      throw new RetrospectiveConflictError("retrospective-review-conflict");
    }
    try {
      await this.client.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Put: {
                TableName: this.tableName,
                Item: {
                  pk: `RETROSPECTIVE_VERSION#${input.versionId}`,
                  sk: "RECORD",
                  value: result.version,
                },
                ConditionExpression:
                  "#value.#state = :state AND #value.#stateVersion = :version",
                ExpressionAttributeNames: {
                  "#value": "value",
                  "#state": "state",
                  "#stateVersion": "stateVersion",
                },
                ExpressionAttributeValues: {
                  ":state": input.expectedState,
                  ":version": input.expectedStateVersion,
                },
              },
            },
            {
              Put: {
                TableName: this.tableName,
                Item: {
                  pk: `RETROSPECTIVE_AUDIT#${input.versionId}`,
                  sk: `${input.decidedAt}#${result.decision.decisionId}`,
                  value: result.decision,
                },
                ConditionExpression:
                  "attribute_not_exists(pk) AND attribute_not_exists(sk)",
              },
            },
            {
              Put: {
                TableName: this.tableName,
                Item: {
                  pk: `RETROSPECTIVE_REPLAY#${input.versionId}`,
                  sk: input.idempotencyKey,
                  value: result,
                },
                ConditionExpression:
                  "attribute_not_exists(pk) AND attribute_not_exists(sk)",
              },
            },
          ],
        }),
      );
    } catch (error) {
      if (!conditional(error)) throw error;
      const retry = await this.client.send(
        new GetCommand({
          TableName: this.tableName,
          Key: {
            pk: `RETROSPECTIVE_REPLAY#${input.versionId}`,
            sk: input.idempotencyKey,
          },
          ConsistentRead: true,
        }),
      );
      if (retry.Item?.["value"]) {
        const value = retry.Item["value"] as typeof result;
        return validateRetrospectiveReviewReplay(value, input);
      }
      throw new RetrospectiveConflictError("retrospective-review-conflict");
    }
    return result;
  }
  async listAudit(input: Parameters<RetrospectiveRepository["listAudit"]>[0]) {
    const page = await this.query(
      `RETROSPECTIVE_AUDIT#${input.versionId}`,
      `audit:${input.versionId}`,
      input,
      false,
    );
    const decisions = page.rows.map((row) => {
      const decision = row["value"] as RetrospectiveReviewDecision;
      if (
        row["sk"] !== `${decision.decidedAt}#${decision.decisionId}` ||
        decision.versionId !== input.versionId ||
        !["draft", "changes-requested", "approved", "rejected"].includes(
          decision.fromState,
        ) ||
        !["draft", "changes-requested", "approved", "rejected"].includes(
          decision.toState,
        ) ||
        !["approve", "reject", "request-changes"].includes(
          decision.reasonCode,
        ) ||
        !Number.isSafeInteger(decision.stateVersion) ||
        !/^retrospective-decision:[a-f0-9]{64}$/.test(decision.decisionId)
      )
        throw new RetrospectiveConflictError("retrospective-audit-corrupt");
      return decision;
    });
    const items: PublicRetrospectiveAudit[] = decisions.map(
      ({
        decisionId,
        versionId: id,
        fromState,
        toState,
        reasonCode,
        decidedAt,
      }) => ({
        decisionId,
        versionId: id,
        fromState,
        toState,
        reasonCode,
        decidedAt,
      }),
    );
    return {
      items,
      ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    };
  }
}
