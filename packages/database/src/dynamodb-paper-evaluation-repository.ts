import {
  GetCommand,
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
  type PaperBetRecord,
  type PaperEvaluationInput,
  type PaperEvaluationRecord,
} from "@find-the-edge/domain";
import {
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
        ConsistentRead: true,
      }),
    );
    const value = response.Item?.["value"] as
      PaperEvaluationRecord | PaperBetRecord | undefined;
    return value ?? null;
  }
}
