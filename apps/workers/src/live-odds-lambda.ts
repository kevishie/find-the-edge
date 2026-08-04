import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  AwsDynamoGateway,
  AwsFixtureOddsGateway,
  DynamoBettingSplitRepository,
  DynamoEventIngestionStore,
  DynamoFixtureOddsAdapter,
  DynamoExactOddsSnapshotRepository,
  DynamoOddsControlPlaneStore,
} from "@find-the-edge/database";
import { ingestLiveOdds, type LiveOddsStateStore } from "./live-odds-ingestion";
import { runProductionOddsControlPlane } from "./production-odds-control-plane";
import { embeddedOddsControlPlaneMetrics } from "./odds-control-plane";

export function parseTheOddsApiSecret(value: string | undefined): string {
  if (!value) throw new Error("the-odds-api-secret-missing");
  try {
    const parsed: unknown = JSON.parse(value);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const key = (parsed as Record<string, unknown>)["apiKey"];
      if (
        typeof key === "string" &&
        key.trim() === key &&
        key.length > 0 &&
        key.length <= 512
      )
        return key;
      throw new Error("the-odds-api-secret-invalid");
    }
  } catch {
    /* allow a plain secret string */
  }
  if (value.trim() === value && value.length > 0 && value.length <= 512)
    return value;
  throw new Error("the-odds-api-secret-invalid");
}

export function parseLiveOddsInvocation(event: unknown): {
  readonly forceRefresh: boolean;
} {
  if (event === undefined || event === null) return { forceRefresh: false };
  if (!event || typeof event !== "object" || Array.isArray(event))
    throw new Error("live-odds-invocation-invalid");
  const record = event as Record<string, unknown>;
  if (Array.isArray(record["Records"])) {
    const records = record["Records"];
    if (
      records.length !== 1 ||
      !records[0] ||
      typeof records[0] !== "object" ||
      (records[0] as Record<string, unknown>)["eventSource"] !== "aws:sqs"
    )
      throw new Error("live-odds-invocation-invalid");
    return { forceRefresh: false };
  }
  if (!Object.prototype.hasOwnProperty.call(record, "forceRefresh"))
    return { forceRefresh: false };
  if (Reflect.ownKeys(record).length !== 1 || record["forceRefresh"] !== true)
    throw new Error("live-odds-invocation-invalid");
  return { forceRefresh: true };
}

export const handler = async (event?: unknown) => {
  const invocation = parseLiveOddsInvocation(event);
  const tableName = process.env["FTE_EVENT_TABLE"];
  const secretId = process.env["FTE_THE_ODDS_API_SECRET_ID"];
  const sharpSecretId = process.env["FTE_SHARP_API_SECRET_ID"];
  const sharpEnabled = process.env["FTE_SHARP_API_ENABLED"] === "true";
  if (!tableName || (sharpEnabled ? !sharpSecretId || !secretId : !secretId))
    throw new Error("live-odds-configuration-invalid");
  const secrets = new SecretsManagerClient({});
  const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  const stateStore: LiveOddsStateStore = {
    async read(leagueKey) {
      const result = await client.send(
        new GetCommand({
          TableName: tableName,
          Key: { pk: `LIVE_ODDS_STATE#${leagueKey}`, sk: "CURRENT" },
          ConsistentRead: true,
        }),
      );
      return (
        (result.Item?.["value"] as Awaited<
          ReturnType<LiveOddsStateStore["read"]>
        >) ?? null
      );
    },
    async write(leagueKey, value) {
      await client.send(
        new PutCommand({
          TableName: tableName,
          Item: { pk: `LIVE_ODDS_STATE#${leagueKey}`, sk: "CURRENT", value },
        }),
      );
    },
  };
  const eventStore = new DynamoEventIngestionStore(
    new AwsDynamoGateway(client, tableName),
  );
  const oddsStore = new DynamoFixtureOddsAdapter(
    new AwsFixtureOddsGateway(client, tableName),
    new DynamoExactOddsSnapshotRepository(client, tableName),
  );
  let provider = "the-odds-api";
  let summary: unknown;
  if (sharpEnabled && sharpSecretId) {
    const [sharpSecret, fallbackSecret] = await Promise.all([
      secrets.send(new GetSecretValueCommand({ SecretId: sharpSecretId })),
      secrets.send(new GetSecretValueCommand({ SecretId: secretId! })),
    ]);
    const sharpApiKey = parseTheOddsApiSecret(sharpSecret.SecretString);
    const theOddsApiKey = parseTheOddsApiSecret(fallbackSecret.SecretString);
    summary = await runProductionOddsControlPlane({
      events: eventStore,
      odds: oddsStore,
      splits: new DynamoBettingSplitRepository(client, tableName),
      control: new DynamoOddsControlPlaneStore(client, tableName),
      sharpApiKey,
      theOddsApiKey,
      ...(invocation.forceRefresh ? { forceRefresh: true } : {}),
      metrics: embeddedOddsControlPlaneMetrics,
    });
    provider = "odds-control-plane";
  }
  if (!sharpEnabled && secretId) {
    const secret = await secrets.send(
      new GetSecretValueCommand({ SecretId: secretId }),
    );
    const apiKey = parseTheOddsApiSecret(secret.SecretString);
    summary = await ingestLiveOdds(eventStore, oddsStore, stateStore, apiKey, {
      forceRefresh: invocation.forceRefresh,
    });
  }
  process.stdout.write(
    `${JSON.stringify({ event: "live-odds-ingestion-complete", provider, summary })}\n`,
  );
  return summary;
};
