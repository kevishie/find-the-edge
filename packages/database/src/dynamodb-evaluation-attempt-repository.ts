import {
  GetCommand,
  PutCommand,
  type DynamoDBDocumentClient,
} from "@aws-sdk/lib-dynamodb";
import {
  createEvaluationAttempt,
  type EvaluationAttemptInput,
  type EvaluationAttemptRecord,
} from "@find-the-edge/domain";
import type { EvaluationAttemptRepository } from "./evaluation-attempt-repository";

const normalize = (value: unknown): EvaluationAttemptRecord => {
  const record = value as EvaluationAttemptRecord;
  const rebuilt = createEvaluationAttempt(record);
  if (rebuilt.attemptId !== record.attemptId)
    throw new Error("stored-evaluation-attempt-invalid");
  return rebuilt;
};
export class DynamoEvaluationAttemptRepository implements EvaluationAttemptRepository {
  constructor(
    private readonly client: DynamoDBDocumentClient,
    private readonly tableName: string,
  ) {}
  async persist(input: EvaluationAttemptInput) {
    const attempt = createEvaluationAttempt(input);
    const key = { pk: `EVALUATION_ATTEMPT#${attempt.attemptId}`, sk: "RECORD" };
    try {
      await this.client.send(
        new PutCommand({
          TableName: this.tableName,
          Item: { ...key, value: attempt },
          ConditionExpression: "attribute_not_exists(pk)",
        }),
      );
      return { outcome: "created" as const, attempt };
    } catch (error) {
      if (
        !(error instanceof Error) ||
        error.name !== "ConditionalCheckFailedException"
      )
        throw error;
      const result = await this.client.send(
        new GetCommand({
          TableName: this.tableName,
          Key: key,
          // Attempt replay must observe the winning evaluation evidence.
          ConsistentRead: true,
        }),
      );
      const stored =
        result.Item?.["value"] === undefined
          ? null
          : normalize(result.Item["value"]);
      if (!stored || JSON.stringify(stored) !== JSON.stringify(attempt))
        throw new Error("evaluation-attempt-replay-conflict");
      return { outcome: "duplicate" as const, attempt: stored };
    }
  }
  async get(attemptId: string) {
    const result = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { pk: `EVALUATION_ATTEMPT#${attemptId}`, sk: "RECORD" },
        // Evaluation consumers must bind to the latest durable attempt.
        ConsistentRead: true,
      }),
    );
    return result.Item?.["value"] === undefined
      ? null
      : normalize(result.Item["value"]);
  }
}
