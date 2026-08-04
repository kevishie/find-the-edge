import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import {
  AwsDynamoGateway,
  AwsFixtureOddsGateway,
  DynamoBettingSplitRepository,
  DynamoEventIngestionStore,
  DynamoFixtureOddsAdapter,
  DynamoExactOddsSnapshotRepository,
  DynamoOddsControlPlaneStore,
} from "@find-the-edge/database";
import {
  runFocusedSharpOddsIngestion,
  runProductionOddsControlPlane,
} from "./production-odds-control-plane";
import { embeddedOddsControlPlaneMetrics } from "./odds-control-plane";

export function parseProviderApiSecret(value: string | undefined): string {
  if (!value) throw new Error("provider-api-secret-missing");
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
      throw new Error("provider-api-secret-invalid");
    }
  } catch {
    /* allow a plain secret string */
  }
  if (value.trim() === value && value.length > 0 && value.length <= 512)
    return value;
  throw new Error("provider-api-secret-invalid");
}

export function parseLiveOddsInvocation(event: unknown): {
  readonly forceRefresh: boolean;
  readonly focused?: {
    readonly leagueKey:
      "mlb" | "mls" | "epl" | "liga-mx" | "uefa-champions-league";
    readonly providerEventId: string;
  };
} {
  if (event === undefined || event === null) return { forceRefresh: false };
  if (!event || typeof event !== "object" || Array.isArray(event))
    throw new Error("live-odds-invocation-invalid");
  const record = event as Record<string, unknown>;
  if (record["mode"] === "focused") {
    const leagueKey = record["leagueKey"];
    const providerEventId = record["providerEventId"];
    if (
      Reflect.ownKeys(record).length !== 3 ||
      !["mlb", "mls", "epl", "liga-mx", "uefa-champions-league"].includes(
        String(leagueKey),
      ) ||
      typeof providerEventId !== "string" ||
      providerEventId.trim() !== providerEventId ||
      providerEventId.length === 0 ||
      providerEventId.length > 256
    )
      throw new Error("live-odds-invocation-invalid");
    return {
      forceRefresh: false,
      focused: {
        leagueKey: leagueKey as
          "mlb" | "mls" | "epl" | "liga-mx" | "uefa-champions-league",
        providerEventId,
      },
    };
  }
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
  const sharpSecretId = process.env["FTE_SHARP_API_SECRET_ID"];
  const sharpEnabled = process.env["FTE_SHARP_API_ENABLED"] === "true";
  if (!tableName || !sharpEnabled || !sharpSecretId)
    throw new Error("live-odds-configuration-invalid");
  const secrets = new SecretsManagerClient({});
  const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  const eventStore = new DynamoEventIngestionStore(
    new AwsDynamoGateway(client, tableName),
  );
  const oddsStore = new DynamoFixtureOddsAdapter(
    new AwsFixtureOddsGateway(client, tableName),
    new DynamoExactOddsSnapshotRepository(client, tableName),
  );
  const provider = "odds-control-plane";
  const sharpSecret = await secrets.send(
    new GetSecretValueCommand({ SecretId: sharpSecretId }),
  );
  const sharpApiKey = parseProviderApiSecret(sharpSecret.SecretString);
  const common = {
    events: eventStore,
    odds: oddsStore,
    control: new DynamoOddsControlPlaneStore(client, tableName),
    sharpApiKey,
    metrics: embeddedOddsControlPlaneMetrics,
  };
  const summary = invocation.focused
    ? await runFocusedSharpOddsIngestion({
        ...common,
        request: invocation.focused,
      })
    : await runProductionOddsControlPlane({
        ...common,
        splits: new DynamoBettingSplitRepository(client, tableName),
        ...(invocation.forceRefresh ? { forceRefresh: true } : {}),
      });
  process.stdout.write(
    `${JSON.stringify({ event: "live-odds-ingestion-complete", provider, summary })}\n`,
  );
  return summary;
};
