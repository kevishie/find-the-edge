import {
  GetCommand,
  PutCommand,
  type DynamoDBDocumentClient,
} from "@aws-sdk/lib-dynamodb";
import {
  createOpportunityCandidate,
  normalizeOpportunityCandidate,
  type OpportunityCandidate,
  type OpportunityCandidateInput,
} from "@find-the-edge/domain";
import {
  opportunityCandidatesEqual,
  type OpportunityCandidateRepository,
} from "./opportunity-candidate-repository";

export class DynamoOpportunityCandidateRepository implements OpportunityCandidateRepository {
  constructor(
    private readonly client: DynamoDBDocumentClient,
    private readonly tableName: string,
  ) {}

  async persist(input: OpportunityCandidateInput) {
    const candidate = createOpportunityCandidate(input);
    const key = {
      pk: `OPPORTUNITY_CANDIDATE#${candidate.occurrenceId}`,
      sk: "RECORD",
    };
    try {
      await this.client.send(
        new PutCommand({
          TableName: this.tableName,
          Item: { ...key, value: candidate },
          ConditionExpression: "attribute_not_exists(pk)",
        }),
      );
      return { outcome: "created" as const, candidate };
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
          // Candidate replay must observe the winning lifecycle input.
          ConsistentRead: true,
        }),
      );
      const stored = result.Item?.["value"] as OpportunityCandidate | undefined;
      const normalized = stored ? normalizeOpportunityCandidate(stored) : null;
      if (!normalized || !opportunityCandidatesEqual(normalized, candidate))
        throw new Error("opportunity-candidate-replay-conflict");
      return { outcome: "duplicate" as const, candidate: normalized };
    }
  }

  async get(occurrenceId: string) {
    const result = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: {
          pk: `OPPORTUNITY_CANDIDATE#${occurrenceId}`,
          sk: "RECORD",
        },
        // Rank projection must bind to the authoritative candidate record.
        ConsistentRead: true,
      }),
    );
    if (result.Item?.["value"] === undefined) return null;
    const candidate = normalizeOpportunityCandidate(
      result.Item["value"] as OpportunityCandidate,
    );
    if (candidate.occurrenceId !== occurrenceId)
      throw new Error("opportunity-candidate-key-mismatch");
    return candidate;
  }
}
