import {
  GetCommand,
  PutCommand,
  QueryCommand,
  type DynamoDBDocumentClient,
} from "@aws-sdk/lib-dynamodb";
import {
  normalizeClosingLinesRecord,
  normalizeClosingBookRecord,
  normalizeClosingEventBinding,
  type ClosingBookRecord,
  type ClosingEventBinding,
  type ClosingLinesRecord,
} from "@find-the-edge/domain";

export interface ClosingLinesRepository {
  /** Writes once per canonical event; a second capture is a silent no-op so
   * the record stays the first post-start snapshot forever. */
  capture(record: ClosingLinesRecord): Promise<"created" | "exists">;
  get(canonicalEventId: string): Promise<ClosingLinesRecord | null>;
  bind(binding: ClosingEventBinding): Promise<"updated" | "retained">;
  getBinding(canonicalEventId: string): Promise<ClosingEventBinding | null>;
  listBindings(
    canonicalEventId: string,
  ): Promise<readonly ClosingEventBinding[]>;
  finalizeBook(record: ClosingBookRecord): Promise<"created" | "exists">;
  listFinalized(
    canonicalEventId: string,
  ): Promise<readonly ClosingBookRecord[]>;
}

/** Derives the same public board shape from independently immutable books.
 * The first configured complete display book wins; Pinnacle only annotates an
 * exactly matching proposition and never creates a fabricated display row. */
export function projectFinalizedClosingSelections(
  books: readonly ClosingBookRecord[],
  sportsbookIds: readonly string[],
): readonly import("@find-the-edge/domain").GameOddsSelectionDto[] | null {
  const completeMarkets = (book: ClosingBookRecord) => {
    const byMarket = new Map<string, ClosingBookRecord["selections"]>();
    for (const selection of book.selections) {
      const rows = byMarket.get(selection.marketKey) ?? [];
      byMarket.set(selection.marketKey, [...rows, selection]);
    }
    return [...byMarket.entries()].filter(([marketKey, rows]) => {
      const keys = new Set(rows.map(({ selectionKey }) => selectionKey));
      if (keys.size !== rows.length) return false;
      if (marketKey === "moneyline")
        return rows.length === 2 || (rows.length === 3 && keys.has("draw"));
      if (marketKey === "spread")
        return (
          rows.length === 2 && rows.every(({ point }) => point !== undefined)
        );
      if (marketKey === "total")
        return (
          rows.length === 2 &&
          keys.has("over") &&
          keys.has("under") &&
          rows[0]!.point === rows[1]!.point
        );
      return false;
    });
  };
  const groups = new Map<string, ClosingBookRecord[]>();
  for (const book of books) {
    const groupKey = `${book.canonicalEventVersion}\u0000${book.providerEventId}`;
    groups.set(groupKey, [...(groups.get(groupKey) ?? []), book]);
  }
  const coherentBooks = [...groups.values()]
    .sort(
      (left, right) =>
        (right[0]?.canonicalEventVersion ?? 0) -
          (left[0]?.canonicalEventVersion ?? 0) ||
        (right[0]?.retrievedAt ?? "").localeCompare(
          left[0]?.retrievedAt ?? "",
        ) ||
        (right[0]?.providerEventId ?? "").localeCompare(
          left[0]?.providerEventId ?? "",
        ),
    )
    .find((group) => {
      const byId = new Map(group.map((book) => [book.sportsbookId, book]));
      return sportsbookIds
        .filter((id) => id !== "pinnacle")
        .some((id) => {
          const book = byId.get(id);
          return (
            !!book && completeMarkets(book).some(([key]) => key === "moneyline")
          );
        });
    });
  if (!coherentBooks) return null;
  const byId = new Map(coherentBooks.map((book) => [book.sportsbookId, book]));
  const display = sportsbookIds
    .filter((id) => id !== "pinnacle")
    .map((id) => byId.get(id))
    .find(
      (book): book is ClosingBookRecord =>
        !!book && completeMarkets(book).some(([key]) => key === "moneyline"),
    );
  if (!display) return null;
  const selected = completeMarkets(display).flatMap(([, rows]) => rows);
  const sharp = byId.get("pinnacle");
  const anchors = new Map(
    (sharp ? completeMarkets(sharp).flatMap(([, rows]) => rows) : []).map(
      (selection) => [
        `${selection.marketKey}\u0000${selection.selectionKey}\u0000${selection.point ?? ""}`,
        selection.americanOdds,
      ],
    ),
  );
  return selected.map((selection) => {
    const anchor = anchors.get(
      `${selection.marketKey}\u0000${selection.selectionKey}\u0000${selection.point ?? ""}`,
    );
    const {
      providerMarketId: _providerMarketId,
      providerSelectionId: _providerSelectionId,
      canonicalKey: _canonicalKey,
      decimalOdds: _decimalOdds,
      impliedProbability: _impliedProbability,
      noVigProbability: _noVigProbability,
      fairCloseDecimal: _fairCloseDecimal,
      closingProbability: _closingProbability,
      ...publicSelection
    } = selection;
    void _providerMarketId;
    void _providerSelectionId;
    void _canonicalKey;
    void _decimalOdds;
    void _impliedProbability;
    void _noVigProbability;
    void _fairCloseDecimal;
    void _closingProbability;
    return anchor === undefined
      ? publicSelection
      : { ...publicSelection, sharpAmericanOdds: anchor };
  });
}

const key = (canonicalEventId: string) => ({
  pk: `CLOSING_LINES#${canonicalEventId}`,
  sk: "RECORD" as const,
});
const eventPk = (canonicalEventId: string) =>
  `CLOSING_LINES#${canonicalEventId}`;
const bindingKey = (canonicalEventId: string) => ({
  pk: eventPk(canonicalEventId),
  sk: "BINDING" as const,
});
const bindingHistoryKey = (canonicalEventId: string) => ({
  pk: eventPk(canonicalEventId),
  sk: "BINDING_HISTORY" as const,
});
interface BindingHistoryValue {
  readonly version: number;
  readonly bindings: readonly ClosingEventBinding[];
}
const bookKey = (
  record: Pick<
    ClosingBookRecord,
    | "canonicalEventId"
    | "canonicalEventVersion"
    | "providerEventId"
    | "sportsbookId"
  >,
) => ({
  pk: eventPk(record.canonicalEventId),
  sk: `BOOK#${record.canonicalEventVersion}#${encodeURIComponent(record.providerEventId)}#${record.sportsbookId}`,
});
const sameFinalizedSource = (
  left: ClosingBookRecord,
  right: ClosingBookRecord,
) => {
  const source = (record: ClosingBookRecord) => {
    const { retrievedAt: ignoredRetrievedAt, selections, ...identity } = record;
    void ignoredRetrievedAt;
    return {
      ...identity,
      selections: selections
        .map((selection) => {
          const { retrievedAt: ignoredSelectionRetrievedAt, ...price } =
            selection;
          void ignoredSelectionRetrievedAt;
          return price;
        })
        .sort(
          (left, right) =>
            left.marketKey.localeCompare(right.marketKey) ||
            left.selectionKey.localeCompare(right.selectionKey) ||
            (left.point ?? 0) - (right.point ?? 0),
        ),
    };
  };
  return JSON.stringify(source(left)) === JSON.stringify(source(right));
};

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

  async bind(binding: ClosingEventBinding) {
    const value = normalizeClosingEventBinding(binding);
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const historyResult = await this.client.send(
        new GetCommand({
          TableName: this.tableName,
          Key: bindingHistoryKey(value.canonicalEventId),
          ConsistentRead: true,
        }),
      );
      const stored = historyResult.Item?.["value"] as
        BindingHistoryValue | undefined;
      let existing = (stored?.bindings ?? []).map(normalizeClosingEventBinding);
      if (!stored) {
        const legacy = await this.client.send(
          new QueryCommand({
            TableName: this.tableName,
            KeyConditionExpression: "pk = :pk AND begins_with(sk, :binding)",
            ExpressionAttributeValues: {
              ":pk": eventPk(value.canonicalEventId),
              ":binding": "BINDING_HISTORY#",
            },
            ScanIndexForward: false,
            Limit: 7,
            ConsistentRead: true,
          }),
        );
        existing = (legacy.Items ?? []).map((item) =>
          normalizeClosingEventBinding(item["value"] as ClosingEventBinding),
        );
      }
      const bindings = [value, ...existing]
        .filter(
          (candidate, index, all) =>
            all.findIndex(
              (other) =>
                other.canonicalEventVersion ===
                  candidate.canonicalEventVersion &&
                other.providerEventId === candidate.providerEventId,
            ) === index,
        )
        .sort((left, right) => right.observedAt.localeCompare(left.observedAt))
        .slice(0, 8);
      const version = stored?.version ?? 0;
      try {
        await this.client.send(
          new PutCommand({
            TableName: this.tableName,
            Item: {
              ...bindingHistoryKey(value.canonicalEventId),
              value: { version: version + 1, bindings },
            },
            ConditionExpression:
              version === 0
                ? "attribute_not_exists(pk)"
                : "#value.#version = :version",
            ...(version === 0
              ? {}
              : {
                  ExpressionAttributeNames: {
                    "#value": "value",
                    "#version": "version",
                  },
                  ExpressionAttributeValues: { ":version": version },
                }),
          }),
        );
        break;
      } catch (error) {
        if (
          !(error instanceof Error) ||
          error.name !== "ConditionalCheckFailedException" ||
          attempt === 3
        )
          throw error;
      }
    }
    try {
      await this.client.send(
        new PutCommand({
          TableName: this.tableName,
          Item: { ...bindingKey(value.canonicalEventId), value },
          ConditionExpression:
            "attribute_not_exists(pk) OR #value.observedAt <= :observedAt",
          ExpressionAttributeNames: { "#value": "value" },
          ExpressionAttributeValues: { ":observedAt": value.observedAt },
        }),
      );
      return "updated" as const;
    } catch (error) {
      if (
        error instanceof Error &&
        error.name === "ConditionalCheckFailedException"
      )
        return "retained" as const;
      throw error;
    }
  }

  async getBinding(canonicalEventId: string) {
    const result = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: bindingKey(canonicalEventId),
        ConsistentRead: true,
      }),
    );
    const stored = result.Item?.["value"] as ClosingEventBinding | undefined;
    return stored ? normalizeClosingEventBinding(stored) : null;
  }

  async listBindings(canonicalEventId: string) {
    const result = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: bindingHistoryKey(canonicalEventId),
        ConsistentRead: true,
      }),
    );
    const stored = result.Item?.["value"] as BindingHistoryValue | undefined;
    if (stored)
      return stored.bindings.map(normalizeClosingEventBinding).slice(0, 8);
    const legacy = await this.client.send(
      new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: "pk = :pk AND begins_with(sk, :binding)",
        ExpressionAttributeValues: {
          ":pk": eventPk(canonicalEventId),
          ":binding": "BINDING_HISTORY#",
        },
        ScanIndexForward: false,
        Limit: 8,
        ConsistentRead: true,
      }),
    );
    return (legacy.Items ?? []).map((item) =>
      normalizeClosingEventBinding(item["value"] as ClosingEventBinding),
    );
  }

  async finalizeBook(record: ClosingBookRecord) {
    const value = normalizeClosingBookRecord(record);
    try {
      await this.client.send(
        new PutCommand({
          TableName: this.tableName,
          Item: { ...bookKey(value), value },
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
          Key: bookKey(value),
          ConsistentRead: true,
        }),
      );
      const stored = result.Item?.["value"] as ClosingBookRecord | undefined;
      const existing = stored ? normalizeClosingBookRecord(stored) : null;
      if (!existing || !sameFinalizedSource(existing, value))
        throw new Error("closing-book-finalization-conflict");
      return "exists" as const;
    }
  }

  async listFinalized(canonicalEventId: string) {
    const result = await this.client.send(
      new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: "pk = :pk AND begins_with(sk, :book)",
        ExpressionAttributeValues: {
          ":pk": eventPk(canonicalEventId),
          ":book": "BOOK#",
        },
        ConsistentRead: true,
      }),
    );
    return (result.Items ?? [])
      .map((item) =>
        normalizeClosingBookRecord(item["value"] as ClosingBookRecord),
      )
      .sort(
        (left, right) =>
          left.sportsbookId.localeCompare(right.sportsbookId) ||
          left.canonicalEventVersion - right.canonicalEventVersion,
      );
  }
}

export class MemoryClosingLinesRepository implements ClosingLinesRepository {
  readonly records = new Map<string, ClosingLinesRecord>();
  readonly bindings = new Map<string, ClosingEventBinding>();
  readonly bindingHistory = new Map<string, Map<string, ClosingEventBinding>>();
  readonly books = new Map<string, Map<string, ClosingBookRecord>>();

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

  async bind(binding: ClosingEventBinding) {
    await Promise.resolve();
    const value = normalizeClosingEventBinding(binding);
    const existing = this.bindings.get(value.canonicalEventId);
    const history =
      this.bindingHistory.get(value.canonicalEventId) ??
      new Map<string, ClosingEventBinding>();
    history.set(
      `${value.canonicalEventVersion}\u0000${value.providerEventId}`,
      value,
    );
    while (history.size > 8) {
      const oldest = [...history.entries()].sort(([, left], [, right]) =>
        left.observedAt.localeCompare(right.observedAt),
      )[0]?.[0];
      if (oldest === undefined) break;
      history.delete(oldest);
    }
    this.bindingHistory.set(value.canonicalEventId, history);
    if (existing && existing.observedAt > value.observedAt)
      return "retained" as const;
    this.bindings.set(value.canonicalEventId, value);
    return "updated" as const;
  }

  async getBinding(canonicalEventId: string) {
    await Promise.resolve();
    const value = this.bindings.get(canonicalEventId);
    return value ? normalizeClosingEventBinding(value) : null;
  }

  async listBindings(canonicalEventId: string) {
    await Promise.resolve();
    return [...(this.bindingHistory.get(canonicalEventId)?.values() ?? [])]
      .map(normalizeClosingEventBinding)
      .sort((left, right) => right.observedAt.localeCompare(left.observedAt))
      .slice(0, 8);
  }

  async finalizeBook(record: ClosingBookRecord) {
    await Promise.resolve();
    const value = normalizeClosingBookRecord(record);
    const books =
      this.books.get(value.canonicalEventId) ??
      new Map<string, ClosingBookRecord>();
    const sourceKey = `${value.canonicalEventVersion}\u0000${value.providerEventId}\u0000${value.sportsbookId}`;
    const existing = books.get(sourceKey);
    if (existing) {
      if (!sameFinalizedSource(existing, value))
        throw new Error("closing-book-finalization-conflict");
      return "exists" as const;
    }
    books.set(sourceKey, value);
    this.books.set(value.canonicalEventId, books);
    return "created" as const;
  }

  async listFinalized(canonicalEventId: string) {
    await Promise.resolve();
    return [...(this.books.get(canonicalEventId)?.values() ?? [])]
      .map(normalizeClosingBookRecord)
      .sort(
        (left, right) =>
          left.sportsbookId.localeCompare(right.sportsbookId) ||
          left.canonicalEventVersion - right.canonicalEventVersion,
      );
  }
}
