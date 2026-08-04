import {
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  type DynamoDBDocumentClient,
} from "@aws-sdk/lib-dynamodb";
import {
  createPaperGrade,
  normalizePaperGradeRecord,
  stablePaperGradeValue,
  type PaperGradeInput,
} from "@find-the-edge/domain";
import {
  PaperGradeConflictError,
  type PaperGradeRepository,
} from "./paper-grade-repository";
export class DynamoPaperGradeRepository implements PaperGradeRepository {
  constructor(
    readonly client: DynamoDBDocumentClient,
    readonly tableName: string,
  ) {}
  async persist(input: PaperGradeInput) {
    const grade = createPaperGrade(input),
      pk = `PAPER_GRADE#${grade.paperBetId}`,
      existingHistory = await this.exactHistory(grade),
      current = await this.current(grade.paperBetId);
    if (current) {
      const currentHistory =
        current.gradeId === grade.gradeId
          ? existingHistory
          : await this.exactHistory(current);
      if (!currentHistory)
        throw new PaperGradeConflictError("grade-partial-state");
      if (
        stablePaperGradeValue(currentHistory) !== stablePaperGradeValue(current)
      )
        throw new PaperGradeConflictError("grade-replay-conflict");
    }
    if (existingHistory) {
      if (
        stablePaperGradeValue(existingHistory) !== stablePaperGradeValue(grade)
      )
        throw new PaperGradeConflictError("grade-replay-conflict");
      return { outcome: "duplicate" as const, grade: existingHistory };
    }
    if (current && grade.resultAuthority <= current.resultAuthority) {
      if (current.gradeId === grade.gradeId)
        throw new PaperGradeConflictError("grade-partial-state");
      return { outcome: "stale" as const, grade };
    }
    if (
      current
        ? grade.supersedesGradeId !== current.gradeId ||
          grade.correctionOrdinal !== current.correctionOrdinal + 1
        : grade.supersedesGradeId !== undefined || grade.correctionOrdinal !== 0
    )
      throw new PaperGradeConflictError("grade-current-conflict");
    try {
      await this.client.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Put: {
                TableName: this.tableName,
                Item: {
                  pk,
                  sk: `HISTORY#${String(grade.correctionOrdinal).padStart(8, "0")}#${grade.gradeId}`,
                  value: grade,
                },
                ConditionExpression:
                  "attribute_not_exists(pk) AND attribute_not_exists(sk)",
              },
            },
            {
              Put: {
                TableName: this.tableName,
                Item: { pk, sk: "CURRENT", value: grade },
                ConditionExpression: current
                  ? "#value.#gradeId = :prior"
                  : "attribute_not_exists(pk) AND attribute_not_exists(sk)",
                ExpressionAttributeNames: current
                  ? { "#value": "value", "#gradeId": "gradeId" }
                  : undefined,
                ExpressionAttributeValues: current
                  ? { ":prior": current.gradeId }
                  : undefined,
              },
            },
          ],
        }),
      );
      return { outcome: "created" as const, grade };
    } catch (error) {
      if (
        !(error instanceof Error) ||
        error.name !== "TransactionCanceledException"
      )
        throw error;
      const exact = await this.current(grade.paperBetId);
      const history = await this.exactHistory(grade);
      if (history) {
        if (stablePaperGradeValue(history) !== stablePaperGradeValue(grade))
          throw new PaperGradeConflictError("grade-replay-conflict");
        if (exact?.gradeId !== grade.gradeId)
          throw new PaperGradeConflictError("grade-partial-state");
        if (stablePaperGradeValue(exact) !== stablePaperGradeValue(grade))
          throw new PaperGradeConflictError("grade-replay-conflict");
        return { outcome: "duplicate" as const, grade: history };
      }
      if (exact) {
        const exactCurrentHistory = await this.exactHistory(exact);
        if (!exactCurrentHistory)
          throw new PaperGradeConflictError("grade-partial-state");
        if (
          stablePaperGradeValue(exactCurrentHistory) !==
          stablePaperGradeValue(exact)
        )
          throw new PaperGradeConflictError("grade-replay-conflict");
      }
      if (exact && grade.resultAuthority <= exact.resultAuthority)
        return { outcome: "stale" as const, grade };
      throw new PaperGradeConflictError("grade-concurrent-conflict");
    }
  }
  async current(paperBetId: string) {
    const r = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { pk: `PAPER_GRADE#${paperBetId}`, sk: "CURRENT" },
        ConsistentRead: true,
      }),
    );
    if (r.Item?.["value"] === undefined) return null;
    const grade = normalizePaperGradeRecord(r.Item["value"]);
    if (grade.paperBetId !== paperBetId)
      throw new PaperGradeConflictError("grade-current-key-mismatch");
    return grade;
  }
  private async exactHistory(grade: ReturnType<typeof createPaperGrade>) {
    const r = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: {
          pk: `PAPER_GRADE#${grade.paperBetId}`,
          sk: `HISTORY#${String(grade.correctionOrdinal).padStart(8, "0")}#${grade.gradeId}`,
        },
        ConsistentRead: true,
      }),
    );
    if (r.Item?.["value"] === undefined) return null;
    const stored = normalizePaperGradeRecord(r.Item["value"]);
    if (
      stored.paperBetId !== grade.paperBetId ||
      stored.gradeId !== grade.gradeId ||
      stored.correctionOrdinal !== grade.correctionOrdinal
    )
      throw new PaperGradeConflictError("grade-history-key-mismatch");
    return stored;
  }
  async historyPage(paperBetId: string, limit: number, cursor?: string) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw new Error("grade-page-invalid");
    if (
      cursor !== undefined &&
      !/^HISTORY#\d{8}#paper-grade:[a-f0-9]{64}$/.test(cursor)
    )
      throw new Error("grade-cursor-invalid");
    const pk = `PAPER_GRADE#${paperBetId}`;
    if (cursor !== undefined) {
      const cursorItem = await this.client.send(
        new GetCommand({
          TableName: this.tableName,
          Key: { pk, sk: cursor },
          ConsistentRead: true,
        }),
      );
      if (cursorItem.Item?.["value"] === undefined)
        throw new Error("grade-cursor-invalid");
      const cursorGrade = normalizePaperGradeRecord(cursorItem.Item["value"]);
      if (
        cursor !==
        `HISTORY#${String(cursorGrade.correctionOrdinal).padStart(8, "0")}#${cursorGrade.gradeId}`
      )
        throw new Error("grade-cursor-invalid");
    }
    const r = await this.client.send(
      new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
        ExpressionAttributeValues: { ":pk": pk, ":prefix": "HISTORY#" },
        Limit: limit,
        ConsistentRead: true,
        ...(cursor ? { ExclusiveStartKey: { pk, sk: cursor } } : {}),
      }),
    );
    return {
      items: (r.Items ?? []).map((i) => {
        const grade = normalizePaperGradeRecord(i["value"]);
        if (grade.paperBetId !== paperBetId)
          throw new PaperGradeConflictError("grade-history-key-mismatch");
        return grade;
      }),
      ...(typeof r.LastEvaluatedKey?.["sk"] === "string"
        ? { nextCursor: r.LastEvaluatedKey["sk"] }
        : {}),
    };
  }
}
