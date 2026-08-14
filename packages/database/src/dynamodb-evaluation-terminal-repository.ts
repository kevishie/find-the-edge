import {
  GetCommand,
  PutCommand,
  type DynamoDBDocumentClient,
} from "@aws-sdk/lib-dynamodb";
import {
  EvaluationTerminalConflictError,
  type EvaluationTerminalClaim,
  type EvaluationTerminalRepository,
} from "./evaluation-terminal-repository";

export class DynamoEvaluationTerminalRepository implements EvaluationTerminalRepository {
  constructor(
    private readonly client: DynamoDBDocumentClient,
    private readonly tableName: string,
  ) {}
  async claim(input: EvaluationTerminalClaim) {
    const key = {
      pk: `EVALUATION_TERMINAL#${input.semanticInputHash}`,
      sk: "CLAIM",
    };
    try {
      await this.client.send(
        new PutCommand({
          TableName: this.tableName,
          Item: { ...key, value: input },
          ConditionExpression: "attribute_not_exists(pk)",
        }),
      );
      return "created" as const;
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
          // Exactly-once terminal claims must observe the winning record.
          ConsistentRead: true,
        }),
      );
      if (JSON.stringify(result.Item?.["value"]) !== JSON.stringify(input))
        throw new EvaluationTerminalConflictError(
          "evaluation-terminal-conflict",
        );
      return "duplicate" as const;
    }
  }
}
