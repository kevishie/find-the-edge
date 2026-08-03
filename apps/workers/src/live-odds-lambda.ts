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
  DynamoEventIngestionStore,
  DynamoFixtureOddsAdapter,
} from "@find-the-edge/database";
import { ingestLiveOdds, type LiveOddsStateStore } from "./live-odds-ingestion";

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
  if (!tableName || !secretId)
    throw new Error("live-odds-configuration-invalid");
  const secret = await new SecretsManagerClient({}).send(
    new GetSecretValueCommand({ SecretId: secretId }),
  );
  const apiKey = parseTheOddsApiSecret(secret.SecretString);
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
  const summary = await ingestLiveOdds(
    new DynamoEventIngestionStore(new AwsDynamoGateway(client, tableName)),
    new DynamoFixtureOddsAdapter(new AwsFixtureOddsGateway(client, tableName)),
    stateStore,
    apiKey,
    { forceRefresh: invocation.forceRefresh },
  );
  process.stdout.write(
    `${JSON.stringify({ event: "live-odds-ingestion-complete", ...summary })}\n`,
  );
  return summary;
};
