import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

export const DYNAMO_CAPACITY_UNATTRIBUTED = "UNATTRIBUTED";
export const DYNAMO_CAPACITY_MIXED = "MIXED";

export interface DynamoCapacityAttribution {
  readonly operation: string;
  readonly cause: string;
  readonly prefix: string;
  readonly resource: "table" | "index";
  readonly readUnits: number;
  readonly writeUnits: number;
}

export type DynamoCapacityReporter = (value: DynamoCapacityAttribution) => void;

type UnknownRecord = Record<string, unknown>;

// DocumentClient middleware receives the wrapped client-dynamodb command name,
// not the public lib-dynamodb command name used at the call site.
const capacityCommands = new Map([
  ["BatchGetItemCommand", "batch-get"],
  ["BatchWriteItemCommand", "batch-write"],
  ["DeleteItemCommand", "delete"],
  ["GetItemCommand", "get"],
  ["PutItemCommand", "put"],
  ["QueryCommand", "query"],
  ["ScanCommand", "scan"],
  ["TransactGetItemsCommand", "transact-get"],
  ["TransactWriteItemsCommand", "transact-write"],
  ["UpdateItemCommand", "update"],
]);

const record = (value: unknown): UnknownRecord | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : undefined;

const safeUnits = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;

/** Returns a bounded category only. The key suffix is never retained. */
export const safeDynamoPartitionPrefix = (value: unknown): string => {
  if (typeof value !== "string") return DYNAMO_CAPACITY_UNATTRIBUTED;
  const control = /^ODDS_CONTROL#([A-Z][A-Z0-9_]{0,23})#/.exec(value);
  if (control) return `ODDS_CONTROL#${control[1]}`;
  const general = /^([A-Z][A-Z0-9_]{1,31})#/.exec(value);
  return general?.[1] ?? DYNAMO_CAPACITY_UNATTRIBUTED;
};

const addKeyPrefix = (prefixes: Set<string>, value: unknown) => {
  const key = record(value);
  if (!key) return;
  const prefix = safeDynamoPartitionPrefix(key["pk"]);
  if (prefix !== DYNAMO_CAPACITY_UNATTRIBUTED) prefixes.add(prefix);
};

const addItemPrefix = addKeyPrefix;

/** Examines key categories, but never returns or copies a complete key. */
export const dynamoRequestPrefix = (inputValue: unknown): string => {
  const input = record(inputValue);
  if (!input) return DYNAMO_CAPACITY_UNATTRIBUTED;
  const prefixes = new Set<string>();
  addKeyPrefix(prefixes, input["Key"]);
  addItemPrefix(prefixes, input["Item"]);

  const requestItems = record(input["RequestItems"]);
  for (const tableRequests of Object.values(requestItems ?? {})) {
    if (Array.isArray(tableRequests)) {
      for (const request of tableRequests) {
        const write = record(request);
        addItemPrefix(prefixes, record(write?.["PutRequest"])?.["Item"]);
        addKeyPrefix(prefixes, record(write?.["DeleteRequest"])?.["Key"]);
      }
      continue;
    }
    const batch = record(tableRequests);
    for (const key of Array.isArray(batch?.["Keys"]) ? batch["Keys"] : [])
      addKeyPrefix(prefixes, key);
  }

  for (const transaction of Array.isArray(input["TransactItems"])
    ? input["TransactItems"]
    : []) {
    const item = record(transaction);
    for (const actionName of [
      "ConditionCheck",
      "Delete",
      "Get",
      "Put",
      "Update",
    ])
      addKeyPrefix(
        prefixes,
        record(item?.[actionName])?.[actionName === "Put" ? "Item" : "Key"],
      );
  }

  // Query partition values are expression values rather than a Key object.
  const values = record(input["ExpressionAttributeValues"]);
  const names = record(input["ExpressionAttributeNames"]);
  const condition = input["KeyConditionExpression"];
  if (typeof condition === "string") {
    const partitionAliases = Object.entries(names ?? {})
      .filter(([, name]) => name === "pk")
      .map(([alias]) => alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    const directPk = /(?:^|\s)pk\s*=\s*(:[A-Za-z0-9_]+)/.exec(condition)?.[1];
    const aliasedPk = partitionAliases
      .map(
        (alias) =>
          new RegExp(`(?:^|\\s)${alias}\\s*=\\s*(:[A-Za-z0-9_]+)`).exec(
            condition,
          )?.[1],
      )
      .find(Boolean);
    const prefix = safeDynamoPartitionPrefix(
      values?.[directPk ?? aliasedPk ?? ""],
    );
    if (prefix !== DYNAMO_CAPACITY_UNATTRIBUTED) prefixes.add(prefix);
  }

  if (prefixes.size === 0) return DYNAMO_CAPACITY_UNATTRIBUTED;
  if (prefixes.size > 1) return DYNAMO_CAPACITY_MIXED;
  return [...prefixes][0]!;
};

const operationName = (commandName: string) =>
  (capacityCommands.get(commandName) ?? commandName)
    .replace(/Command$/, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase()
    .slice(0, 32);

const capacityRows = (outputValue: unknown): readonly UnknownRecord[] => {
  const output = record(outputValue);
  const raw = output?.["ConsumedCapacity"];
  if (Array.isArray(raw))
    return raw.map(record).filter(Boolean) as UnknownRecord[];
  const one = record(raw);
  return one ? [one] : [];
};

export const attributedDynamoCapacity = (
  commandName: string,
  input: unknown,
  output: unknown,
): readonly DynamoCapacityAttribution[] => {
  const operation = operationName(commandName);
  const prefix = dynamoRequestPrefix(input);
  const cause = `${operation}:${prefix}`.slice(0, 64);
  const result: DynamoCapacityAttribution[] = [];
  for (const capacity of capacityRows(output)) {
    const table = record(capacity["Table"]);
    const indexes = record(capacity["GlobalSecondaryIndexes"]);
    const tableUnits = table ?? capacity;
    const tableRead = safeUnits(tableUnits["ReadCapacityUnits"]);
    const tableWrite = safeUnits(tableUnits["WriteCapacityUnits"]);
    if (tableRead > 0 || tableWrite > 0)
      result.push({
        operation,
        cause,
        prefix,
        resource: "table",
        readUnits: tableRead,
        writeUnits: tableWrite,
      });
    for (const value of Object.values(indexes ?? {})) {
      const index = record(value);
      if (!index) continue;
      const readUnits = safeUnits(index["ReadCapacityUnits"]);
      const writeUnits = safeUnits(index["WriteCapacityUnits"]);
      if (readUnits > 0 || writeUnits > 0)
        result.push({
          operation,
          cause,
          prefix,
          resource: "index",
          readUnits,
          writeUnits,
        });
    }
  }
  return result;
};

/**
 * Adds capacity measurement to an existing shared client. The middleware asks
 * DynamoDB for INDEXES detail and observes only the response metadata. A
 * broken reporter is deliberately swallowed after the database request has
 * completed, so observability can never change storage behavior.
 */
export const instrumentDynamoCapacity = (
  client: DynamoDBDocumentClient,
  reporter: DynamoCapacityReporter,
): DynamoDBDocumentClient => {
  const middleware =
    (
      next: (args: { input: unknown }) => Promise<unknown>,
      context: { commandName?: string },
    ) =>
    async (args: { input: unknown }) => {
      const commandName = context.commandName ?? "UnknownCommand";
      const originalInput = record(args.input);
      const input = originalInput ? { ...originalInput } : undefined;
      const measured = capacityCommands.has(commandName);
      if (input && measured) input["ReturnConsumedCapacity"] = "INDEXES";
      const response = await next(
        input && measured ? { ...args, input } : args,
      );
      const output = record(response)?.["output"];
      for (const value of attributedDynamoCapacity(
        commandName,
        input,
        output,
      )) {
        try {
          reporter(value);
        } catch {
          // Measurement is intentionally best-effort after a successful call.
        }
      }
      return response;
    };
  client.middlewareStack.add(middleware as never, {
    step: "initialize",
    name: "findTheEdgeDynamoCapacityAttribution",
  });
  return client;
};
