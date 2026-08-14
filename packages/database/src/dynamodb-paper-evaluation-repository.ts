import {
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  type DynamoDBDocumentClient,
} from "@aws-sdk/lib-dynamodb";
import {
  clonePaperEvaluationValue,
  createPaperEvaluation,
  assertEvaluationId,
  assertPaperBetId,
  normalizePaperBetRecord,
  normalizePaperEvaluationRecord,
  stablePaperEvaluationValue,
  type PaperBetRecord,
  type PaperEvaluationInput,
  type PaperEvaluationRecord,
} from "@find-the-edge/domain";
import {
  PaperEvaluationReplayConflictError,
  verifyPaperEvaluationReplay,
  type PaperEvaluationRepository,
  type PaperEvaluationPersistResult,
} from "./paper-evaluation-repository";

const partition = (hash: string) => `EVALUATION#${hash}`;
const conditionalCancellation = (error: unknown) => {
  if (
    !(error instanceof Error) ||
    error.name !== "TransactionCanceledException"
  )
    return false;
  const reasons = (error as unknown as { CancellationReasons?: unknown })
    .CancellationReasons;
  if (!Array.isArray(reasons)) return false;
  const codes = reasons.map((reason) =>
    reason && typeof reason === "object" && "Code" in reason
      ? (reason as { Code?: unknown }).Code
      : undefined,
  );
  return (
    codes.some((code) => code === "ConditionalCheckFailed") &&
    codes.every((code) => code === "None" || code === "ConditionalCheckFailed")
  );
};

export class DynamoPaperEvaluationRepository implements PaperEvaluationRepository {
  constructor(
    readonly client: DynamoDBDocumentClient,
    readonly tableName: string,
  ) {}

  async persist(
    input: PaperEvaluationInput,
  ): Promise<PaperEvaluationPersistResult> {
    const intended = createPaperEvaluation(input);
    const pk = partition(intended.evaluation.inputHash);
    const puts = [
      {
        Put: {
          TableName: this.tableName,
          Item: { pk, sk: "RECORD", value: intended.evaluation },
          ConditionExpression:
            "attribute_not_exists(pk) AND attribute_not_exists(sk)",
        },
      },
      ...(intended.paperBet
        ? [
            {
              Put: {
                TableName: this.tableName,
                Item: { pk, sk: "PAPER_BET", value: intended.paperBet },
                ConditionExpression:
                  "attribute_not_exists(pk) AND attribute_not_exists(sk)",
              },
            },
            {
              Put: {
                TableName: this.tableName,
                Item: {
                  pk: `PAPER_BETS_BY_DAY#${intended.paperBet.createdAt.slice(0, 10)}`,
                  sk: intended.paperBet.paperBetId,
                  value: intended.paperBet,
                },
                ConditionExpression:
                  "attribute_not_exists(pk) AND attribute_not_exists(sk)",
              },
            },
            {
              Put: {
                TableName: this.tableName,
                Item: {
                  pk: `PAPER_BETS_BY_EVENT#${intended.evaluation.manifest.eventId}`,
                  sk: intended.paperBet.paperBetId,
                  value: intended.paperBet,
                },
                ConditionExpression:
                  "attribute_not_exists(pk) AND attribute_not_exists(sk)",
              },
            },
          ]
        : []),
    ];
    try {
      await this.client.send(new TransactWriteCommand({ TransactItems: puts }));
      return { outcome: "created", pair: clonePaperEvaluationValue(intended) };
    } catch (error) {
      if (!conditionalCancellation(error)) throw error;
      const [evaluation, paperBet] = await Promise.all([
        this.getEvaluation(intended.evaluation.evaluationId),
        this.getPaperBet(`paper-bet:${intended.evaluation.inputHash}`),
      ]);
      const pair = verifyPaperEvaluationReplay(intended, evaluation, paperBet);
      if (pair.paperBet) {
        const [indexed, dayIndexed] = await Promise.all([
          this.client.send(
            new GetCommand({
              TableName: this.tableName,
              Key: {
                pk: `PAPER_BETS_BY_EVENT#${pair.evaluation.manifest.eventId}`,
                sk: pair.paperBet.paperBetId,
              },
              // Transaction replay must see an existing event admission row.
              ConsistentRead: true,
            }),
          ),
          this.client.send(
            new GetCommand({
              TableName: this.tableName,
              Key: {
                pk: `PAPER_BETS_BY_DAY#${pair.paperBet.createdAt.slice(0, 10)}`,
                sk: pair.paperBet.paperBetId,
              },
              // Transaction replay must see an existing daily admission row.
              ConsistentRead: true,
            }),
          ),
        ]);
        const indexedItem = indexed.Item as Record<string, unknown> | undefined;
        const value = indexedItem?.["value"];
        if (
          !value ||
          stablePaperEvaluationValue(normalizePaperBetRecord(value)) !==
            stablePaperEvaluationValue(pair.paperBet)
        )
          throw new PaperEvaluationReplayConflictError(
            "paper-bet-event-index-conflict",
          );
        if (
          stablePaperEvaluationValue(
            normalizePaperBetRecord(dayIndexed.Item?.["value"]),
          ) !== stablePaperEvaluationValue(pair.paperBet)
        )
          throw new PaperEvaluationReplayConflictError(
            "paper-bet-day-index-conflict",
          );
      }
      return { outcome: "duplicate", pair };
    }
  }
  async getEvaluation(
    evaluationId: string,
  ): Promise<PaperEvaluationRecord | null> {
    const canonicalId = assertEvaluationId(evaluationId);
    const value = await this.read(
      canonicalId.slice("evaluation:".length),
      "RECORD",
    );
    return value ? normalizePaperEvaluationRecord(value) : null;
  }
  async getPaperBet(paperBetId: string): Promise<PaperBetRecord | null> {
    const canonicalId = assertPaperBetId(paperBetId);
    const value = await this.read(
      canonicalId.slice("paper-bet:".length),
      "PAPER_BET",
    );
    return value ? normalizePaperBetRecord(value) : null;
  }
  private async read(hash: string, sk: "RECORD" | "PAPER_BET") {
    const response = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { pk: partition(hash), sk },
        // Evaluation replay must bind to the authoritative stored pair.
        ConsistentRead: true,
      }),
    );
    const value = response.Item?.["value"] as
      PaperEvaluationRecord | PaperBetRecord | undefined;
    return value ?? null;
  }
  async listPaperBetsByEvent(input: {
    readonly eventId: string;
    readonly limit: number;
    readonly cursor?: string;
  }) {
    if (
      !input.eventId ||
      !Number.isSafeInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > 100
    )
      throw new Error("paper-bet-event-query-invalid");
    if (input.cursor !== undefined) assertPaperBetId(input.cursor);
    const pk = `PAPER_BETS_BY_EVENT#${input.eventId}`;
    if (input.cursor !== undefined) {
      const cursorItem = await this.client.send(
        new GetCommand({
          TableName: this.tableName,
          Key: { pk, sk: input.cursor },
          // Cursor validation must not accept a stale or removed boundary row.
          ConsistentRead: true,
        }),
      );
      const cursorRecord = cursorItem.Item as
        Record<string, unknown> | undefined;
      const cursorValue = cursorRecord?.["value"];
      if (
        cursorRecord?.["sk"] !== undefined &&
        cursorRecord["sk"] !== input.cursor
      )
        throw new Error("paper-bet-event-cursor-invalid");
      if (
        cursorValue === undefined ||
        normalizePaperBetRecord(cursorValue).paperBetId !== input.cursor
      )
        throw new Error("paper-bet-event-cursor-invalid");
    }
    const response = await this.client.send(
      new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: "pk = :pk",
        ExpressionAttributeValues: {
          ":pk": pk,
        },
        Limit: input.limit,
        // Grading must not permanently skip a newly written paper bet.
        ConsistentRead: true,
        ...(input.cursor
          ? {
              ExclusiveStartKey: {
                pk,
                sk: input.cursor,
              },
            }
          : {}),
      }),
    );
    const items = (response.Items ?? []).map((item) => {
      const value = normalizePaperBetRecord(item["value"]);
      if (item["pk"] !== pk || item["sk"] !== value.paperBetId)
        throw new Error("paper-bet-event-index-corrupt");
      return value;
    });
    return {
      items,
      ...(response.LastEvaluatedKey?.["sk"]
        ? { nextCursor: String(response.LastEvaluatedKey["sk"]) }
        : {}),
    };
  }
  async listPaperBetsByDecisionDay(input: {
    readonly day: string;
    readonly limit: number;
    readonly cursor?: string;
  }) {
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(input.day) ||
      !Number.isSafeInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > 100
    )
      throw new Error("paper-bet-day-query-invalid");
    let cursorId: string | undefined;
    if (input.cursor) {
      try {
        const parsed = JSON.parse(
          Buffer.from(input.cursor, "base64url").toString(),
        ) as { day?: unknown; id?: unknown };
        if (parsed.day !== input.day || typeof parsed.id !== "string")
          throw new Error();
        cursorId = assertPaperBetId(parsed.id);
      } catch {
        throw new Error("paper-bet-day-cursor-invalid");
      }
    }
    const pk = `PAPER_BETS_BY_DAY#${input.day}`;
    const response = await this.client.send(
      new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: "pk = :pk",
        ExpressionAttributeValues: { ":pk": pk },
        Limit: input.limit,
        // Cohort sourcing must enumerate the complete authoritative set.
        ConsistentRead: true,
        ...(cursorId ? { ExclusiveStartKey: { pk, sk: cursorId } } : {}),
      }),
    );
    const items = (response.Items ?? []).map((item) => {
      const value = normalizePaperBetRecord(item["value"]);
      if (
        item["pk"] !== pk ||
        item["sk"] !== value.paperBetId ||
        value.createdAt.slice(0, 10) !== input.day
      )
        throw new Error("paper-bet-day-index-corrupt");
      return value;
    });
    return {
      items,
      ...(response.LastEvaluatedKey?.["sk"]
        ? {
            nextCursor: Buffer.from(
              JSON.stringify({
                day: input.day,
                id: String(response.LastEvaluatedKey["sk"]),
              }),
            ).toString("base64url"),
          }
        : {}),
    };
  }
}
