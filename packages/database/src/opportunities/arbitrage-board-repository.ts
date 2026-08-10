import {
  GetCommand,
  PutCommand,
  type DynamoDBDocumentClient,
} from "@aws-sdk/lib-dynamodb";
import {
  normalizeArbitrageFinding,
  type ArbitrageFinding,
} from "@find-the-edge/domain";

export const ARBITRAGE_BOARD_SCHEMA_VERSION = "arbitrage-board-v1" as const;
/** Bounded so one stored item always fits inside DynamoDB's 400KB item
 * limit even with full slates and slim competing evidence; the scanner
 * sorts by hold before persisting, so a truncated board keeps its best
 * findings and records how many were dropped. */
export const ARBITRAGE_BOARD_LIMIT = 12;

export interface ArbitrageBoard {
  readonly schemaVersion: typeof ARBITRAGE_BOARD_SCHEMA_VERSION;
  readonly scannedAt: string;
  readonly findings: readonly ArbitrageFinding[];
  /** Findings produced by the scan, including any dropped by the limit. */
  readonly totalCount: number;
}

export interface ArbitrageBoardRepository {
  /** Latest scan wins; an older scan never replaces a newer board. */
  putBoard(
    sportKey: string,
    findings: readonly ArbitrageFinding[],
    scannedAt: string,
  ): Promise<void>;
  listCurrent(sportKey: string, asOf: string): Promise<ArbitrageBoard | null>;
}

const boardKey = (sportKey: string) => ({
  pk: `ARB_BOARD#${sportKey}`,
  sk: "CURRENT" as const,
});

function buildBoard(
  findings: readonly ArbitrageFinding[],
  scannedAt: string,
): ArbitrageBoard {
  if (
    !Number.isFinite(Date.parse(scannedAt)) ||
    new Date(scannedAt).toISOString() !== scannedAt
  )
    throw new Error("arbitrage-board-scanned-at-invalid");
  const ordered = [...findings]
    .map((finding) => normalizeArbitrageFinding(finding))
    .sort(
      (left, right) =>
        left.holdPercentage - right.holdPercentage ||
        left.findingId.localeCompare(right.findingId),
    );
  return {
    schemaVersion: ARBITRAGE_BOARD_SCHEMA_VERSION,
    scannedAt,
    findings: ordered.slice(0, ARBITRAGE_BOARD_LIMIT),
    totalCount: ordered.length,
  };
}

function currentBoard(
  stored: ArbitrageBoard | undefined | null,
  asOf: string,
): ArbitrageBoard | null {
  if (!stored) return null;
  if (
    stored.schemaVersion !== ARBITRAGE_BOARD_SCHEMA_VERSION ||
    !Number.isFinite(Date.parse(stored.scannedAt)) ||
    !Number.isSafeInteger(stored.totalCount) ||
    stored.totalCount < 0 ||
    !Array.isArray(stored.findings)
  )
    throw new Error("stored-arbitrage-board-invalid");
  const cutoff = Date.parse(asOf);
  const findings = (stored.findings as readonly ArbitrageFinding[])
    .map((finding) => normalizeArbitrageFinding(finding))
    .filter((finding) => Date.parse(finding.expiresAt) > cutoff);
  return { ...stored, findings };
}

export class DynamoArbitrageBoardRepository implements ArbitrageBoardRepository {
  constructor(
    private readonly client: DynamoDBDocumentClient,
    private readonly tableName: string,
  ) {}

  async putBoard(
    sportKey: string,
    findings: readonly ArbitrageFinding[],
    scannedAt: string,
  ) {
    const board = buildBoard(findings, scannedAt);
    try {
      await this.client.send(
        new PutCommand({
          TableName: this.tableName,
          Item: { ...boardKey(sportKey), value: board },
          ConditionExpression:
            "attribute_not_exists(pk) OR #value.scannedAt < :scannedAt",
          ExpressionAttributeNames: { "#value": "value" },
          ExpressionAttributeValues: { ":scannedAt": scannedAt },
        }),
      );
    } catch (error) {
      // A newer scan already landed; losing this write is correct.
      if (
        error instanceof Error &&
        error.name === "ConditionalCheckFailedException"
      )
        return;
      throw error;
    }
  }

  async listCurrent(sportKey: string, asOf: string) {
    const result = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: boardKey(sportKey),
      }),
    );
    return currentBoard(
      result.Item?.["value"] as ArbitrageBoard | undefined,
      asOf,
    );
  }
}

export class MemoryArbitrageBoardRepository implements ArbitrageBoardRepository {
  readonly boards = new Map<string, ArbitrageBoard>();

  async putBoard(
    sportKey: string,
    findings: readonly ArbitrageFinding[],
    scannedAt: string,
  ) {
    await Promise.resolve();
    const board = buildBoard(findings, scannedAt);
    const existing = this.boards.get(sportKey);
    if (!existing || existing.scannedAt < scannedAt)
      this.boards.set(sportKey, board);
  }

  async listCurrent(sportKey: string, asOf: string) {
    await Promise.resolve();
    return currentBoard(this.boards.get(sportKey), asOf);
  }
}
