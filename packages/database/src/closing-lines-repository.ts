import {
  GetCommand,
  PutCommand,
  type DynamoDBDocumentClient,
} from "@aws-sdk/lib-dynamodb";
import {
  normalizeClosingLinesRecord,
  type ClosingLinesRecord,
} from "@find-the-edge/domain";

export interface ClosingLinesRepository {
  /** Writes once per canonical event; a second capture is a silent no-op so
   * the record stays the first post-start snapshot forever. */
  capture(record: ClosingLinesRecord): Promise<"created" | "exists">;
  get(canonicalEventId: string): Promise<ClosingLinesRecord | null>;
}

const key = (canonicalEventId: string) => ({
  pk: `CLOSING_LINES#${canonicalEventId}`,
  sk: "RECORD" as const,
});

export class DynamoClosingLinesRepository implements ClosingLinesRepository {
  constructor(
    private readonly client: DynamoDBDocumentClient,
    private readonly tableName: string,
  ) {}

  async capture(record: ClosingLinesRecord) {
    const validated = normalizeClosingLinesRecord(record);
    try {
      await this.client.send(
        new PutCommand({
          TableName: this.tableName,
          Item: { ...key(validated.canonicalEventId), value: validated },
          ConditionExpression: "attribute_not_exists(pk)",
        }),
      );
      return "created" as const;
    } catch (error) {
      if (
        error instanceof Error &&
        error.name === "ConditionalCheckFailedException"
      )
        return "exists" as const;
      throw error;
    }
  }

  async get(canonicalEventId: string) {
    const result = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: key(canonicalEventId),
      }),
    );
    const stored = result.Item?.["value"] as ClosingLinesRecord | undefined;
    return stored ? normalizeClosingLinesRecord(stored) : null;
  }
}

export class MemoryClosingLinesRepository implements ClosingLinesRepository {
  readonly records = new Map<string, ClosingLinesRecord>();

  async capture(record: ClosingLinesRecord) {
    await Promise.resolve();
    const validated = normalizeClosingLinesRecord(record);
    if (this.records.has(validated.canonicalEventId)) return "exists" as const;
    this.records.set(validated.canonicalEventId, validated);
    return "created" as const;
  }

  async get(canonicalEventId: string) {
    await Promise.resolve();
    const stored = this.records.get(canonicalEventId);
    return stored ? normalizeClosingLinesRecord(stored) : null;
  }
}
