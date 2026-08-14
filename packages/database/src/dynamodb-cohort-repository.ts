import {
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  type DynamoDBDocumentClient,
} from "@aws-sdk/lib-dynamodb";
import {
  freezeCohort,
  performanceReportId,
  stableCohortValue,
  sha256Hex,
  type CohortDefinition,
  type CohortMember,
  type FrozenCohort,
} from "@find-the-edge/domain";
import {
  CohortConflictError,
  type CohortRepository,
  type StoredPerformanceReport,
  validateStoredPerformanceReport,
} from "./cohort-repository";
const conditional = (error: unknown) =>
  error instanceof Error &&
  (error.name === "ConditionalCheckFailedException" ||
    error.name === "TransactionCanceledException");
export class DynamoCohortRepository implements CohortRepository {
  constructor(
    private readonly client: DynamoDBDocumentClient,
    private readonly tableName: string,
  ) {}
  async putCohort(input: {
    readonly definition: CohortDefinition;
    readonly cutoff: string;
    readonly members: readonly CohortMember[];
  }) {
    const value = freezeCohort(input);
    const cohortPk = `PERFORMANCE_COHORT#${value.cohortId}`;
    const putImmutable = async (sk: string, material: unknown) => {
      try {
        await this.client.send(
          new PutCommand({
            TableName: this.tableName,
            Item: { pk: cohortPk, sk, value: material },
            ConditionExpression:
              "attribute_not_exists(pk) AND attribute_not_exists(sk)",
          }),
        );
      } catch (error) {
        if (!conditional(error)) throw error;
        const current = await this.client.send(
          new GetCommand({
            TableName: this.tableName,
            Key: { pk: cohortPk, sk },
            // Immutable-row replay must observe the winning stored material.
            ConsistentRead: true,
          }),
        );
        if (
          stableCohortValue(current.Item?.["value"]) !==
          stableCohortValue(material)
        )
          throw new CohortConflictError("cohort-row-conflict");
      }
    };
    await putImmutable("DEFINITION", {
      definition: value.definition,
      definitionHash: value.definitionHash,
      cutoff: value.cutoff,
    });
    for (const member of value.members)
      await putImmutable(`MEMBER#${member.paperBetId}`, member);
    const persisted: CohortMember[] = [];
    let memberCursor: Record<string, unknown> | undefined;
    do {
      const rows = await this.client.send(
        new QueryCommand({
          TableName: this.tableName,
          KeyConditionExpression: "pk = :pk AND begins_with(sk, :member)",
          ExpressionAttributeValues: { ":pk": cohortPk, ":member": "MEMBER#" },
          // Finalization must see every just-written member before sealing the
          // immutable membership digest.
          ConsistentRead: true,
          ...(memberCursor ? { ExclusiveStartKey: memberCursor } : {}),
        }),
      );
      persisted.push(
        ...(rows.Items ?? []).map((row) => row["value"] as CohortMember),
      );
      memberCursor = rows.LastEvaluatedKey;
    } while (memberCursor);
    const verified = freezeCohort({
      definition: value.definition,
      cutoff: value.cutoff,
      members: persisted,
    });
    if (
      verified.members.length !== value.members.length ||
      verified.membershipDigest !== value.membershipDigest
    )
      throw new CohortConflictError("cohort-finalization-mismatch");
    await putImmutable("FINAL", {
      count: value.members.length,
      membershipDigest: value.membershipDigest,
      cohortId: value.cohortId,
    });
    const finalizationKey = {
      pk: `PERFORMANCE_COHORT_CUTOFF#${value.definitionHash}`,
      sk: value.cutoff,
    };
    try {
      await this.client.send(
        new PutCommand({
          TableName: this.tableName,
          Item: {
            ...finalizationKey,
            value: {
              membershipDigest: value.membershipDigest,
              cohortId: value.cohortId,
            },
          },
          ConditionExpression:
            "attribute_not_exists(pk) AND attribute_not_exists(sk)",
        }),
      );
    } catch (error) {
      if (!conditional(error)) throw error;
      const existing = await this.client.send(
        new GetCommand({
          TableName: this.tableName,
          Key: finalizationKey,
          // A cutoff may bind to only one immutable membership digest.
          ConsistentRead: true,
        }),
      );
      const finalized = existing.Item?.["value"] as
        { membershipDigest?: unknown } | undefined;
      if (finalized?.membershipDigest !== value.membershipDigest)
        throw new CohortConflictError("cohort-cutoff-finalized");
    }
    try {
      await this.client.send(
        new PutCommand({
          TableName: this.tableName,
          Item: { pk: "PERFORMANCE_COHORTS", sk: value.cohortId, value },
          ConditionExpression:
            "attribute_not_exists(pk) AND attribute_not_exists(sk)",
        }),
      );
    } catch (error) {
      if (!conditional(error)) throw error;
      const existing = await this.getCohort(value.cohortId);
      if (!existing || stableCohortValue(existing) !== stableCohortValue(value))
        throw new CohortConflictError("cohort-conflict");
    }
    return structuredClone(value);
  }
  async getCohort(id: string) {
    const result = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { pk: "PERFORMANCE_COHORTS", sk: id },
        // Report binding and replay must observe the durable cohort winner.
        ConsistentRead: true,
      }),
    );
    const stored = result.Item?.["value"] as FrozenCohort | undefined;
    if (!stored) return null;
    const verified = freezeCohort(stored);
    if (
      verified.cohortId !== id ||
      stableCohortValue(verified) !== stableCohortValue(stored)
    )
      throw new CohortConflictError("cohort-corrupt");
    return verified;
  }
  async listCohorts(input: {
    readonly limit: number;
    readonly cursor?: string;
  }) {
    if (
      !Number.isSafeInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > 100
    )
      throw new Error("cohort-limit-invalid");
    const pk = "PERFORMANCE_COHORTS",
      decodeCursor = (cursor: string) => {
        try {
          const parsed = JSON.parse(
            Buffer.from(cursor, "base64url").toString(),
          ) as { key?: unknown; sig?: unknown; scope?: unknown };
          if (
            parsed.scope !== "cohorts" ||
            typeof parsed.key !== "string" ||
            parsed.sig !== sha256Hex(`${parsed.key}|cohorts|${this.tableName}`)
          )
            throw new Error();
          return parsed.key;
        } catch {
          throw new Error("cohort-cursor-invalid");
        }
      },
      cursorKey = input.cursor ? decodeCursor(input.cursor) : undefined,
      result = await this.client.send(
        new QueryCommand({
          TableName: this.tableName,
          KeyConditionExpression: "pk = :pk",
          ExpressionAttributeValues: { ":pk": pk },
          Limit: input.limit,
          // Cohorts are immutable catalogue entries; report binding and
          // scheduled revision decisions retain their strong reads.
          ConsistentRead: false,
          ...(cursorKey ? { ExclusiveStartKey: { pk, sk: cursorKey } } : {}),
        }),
      );
    return {
      items: (result.Items ?? []).map((item) => item["value"] as FrozenCohort),
      ...(result.LastEvaluatedKey?.["sk"]
        ? {
            nextCursor: Buffer.from(
              JSON.stringify({
                scope: "cohorts",
                key: String(result.LastEvaluatedKey["sk"]),
                sig: sha256Hex(
                  `${String(result.LastEvaluatedKey["sk"])}|cohorts|${this.tableName}`,
                ),
              }),
            ).toString("base64url"),
          }
        : {}),
    };
  }
  async putReport<T>(input: Omit<StoredPerformanceReport<T>, "reportId">) {
    const cohort = await this.getCohort(input.cohortId);
    if (!cohort || cohort.cutoff !== input.cutoff)
      throw new CohortConflictError(
        "performance-report-cohort-binding-invalid",
      );
    const reportId = performanceReportId(
        input.cohortId,
        input.evidenceDigest,
        input.cutoff,
        input.revision,
      ),
      value = { ...input, reportId },
      indexKey = `${input.createdAt}#${String(input.revision).padStart(8, "0")}#${reportId}`;
    try {
      await this.client.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Put: {
                TableName: this.tableName,
                Item: {
                  pk: `PERFORMANCE_REPORT#${reportId}`,
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
                Item: { pk: "PERFORMANCE_REPORTS", sk: indexKey, value },
                ConditionExpression:
                  "attribute_not_exists(pk) AND attribute_not_exists(sk)",
              },
            },
          ],
        }),
      );
    } catch (error) {
      if (!conditional(error)) throw error;
      const existing = await this.getReport(reportId);
      if (!existing || stableCohortValue(existing) !== stableCohortValue(value))
        throw new CohortConflictError("performance-report-conflict");
    }
    return structuredClone(value);
  }
  async getReport<T>(id: string) {
    const result = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { pk: `PERFORMANCE_REPORT#${id}`, sk: "RECORD" },
        // Report replay must observe the immutable winning report.
        ConsistentRead: true,
      }),
    );
    const stored = result.Item?.["value"] as
      StoredPerformanceReport<T> | undefined;
    return stored ? validateStoredPerformanceReport(stored) : null;
  }
  async listReports<T>(input: {
    readonly limit: number;
    readonly cursor?: string;
  }) {
    if (
      !Number.isSafeInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > 100
    )
      throw new Error("report-limit-invalid");
    const pk = "PERFORMANCE_REPORTS",
      decodeCursor = (cursor: string) => {
        try {
          const parsed = JSON.parse(
            Buffer.from(cursor, "base64url").toString(),
          ) as { key?: unknown; sig?: unknown };
          if (
            typeof parsed.key !== "string" ||
            parsed.sig !== sha256Hex(`${parsed.key}|reports|${this.tableName}`)
          )
            throw new Error();
          return parsed.key;
        } catch {
          throw new Error("report-cursor-invalid");
        }
      },
      cursorKey = input.cursor ? decodeCursor(input.cursor) : undefined,
      result = await this.client.send(
        new QueryCommand({
          TableName: this.tableName,
          KeyConditionExpression: "pk = :pk",
          ExpressionAttributeValues: { ":pk": pk },
          Limit: input.limit,
          // Scheduled revision and duplicate selection require a complete list.
          ConsistentRead: true,
          ScanIndexForward: false,
          ...(cursorKey ? { ExclusiveStartKey: { pk, sk: cursorKey } } : {}),
        }),
      );
    return {
      items: (result.Items ?? []).map((item) =>
        validateStoredPerformanceReport(
          item["value"] as StoredPerformanceReport<T>,
        ),
      ),
      ...(result.LastEvaluatedKey?.["sk"]
        ? {
            nextCursor: Buffer.from(
              JSON.stringify({
                key: String(result.LastEvaluatedKey["sk"]),
                sig: sha256Hex(
                  `${String(result.LastEvaluatedKey["sk"])}|reports|${this.tableName}`,
                ),
              }),
            ).toString("base64url"),
          }
        : {}),
    };
  }
}
