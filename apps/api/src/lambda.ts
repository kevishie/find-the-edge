import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import {
  AwsDynamoGateway,
  DynamoGamesRepository,
  DynamoBettingSplitRepository,
  DynamoEventRepository,
  DynamoCohortRepository,
  EventCursorCodec,
} from "@find-the-edge/database";
import { createEventHandler } from "./handler";
import { loadSecretRing } from "./secrets";
interface LambdaEvent {
  readonly routeKey?: string;
  readonly pathParameters?: { readonly eventId?: string };
  readonly queryStringParameters?: Record<string, string | undefined>;
  readonly requestContext?: {
    readonly authorizer?: {
      readonly jwt?: {
        readonly claims?: Record<string, unknown>;
        readonly scopes?: string[];
      };
    };
  };
}
const tableName = process.env["FTE_EVENT_TABLE_NAME"] ?? "";
const secretArn = process.env["FTE_EVENT_CURSOR_SECRET_ARN"] ?? "";
if (!tableName || !secretArn)
  throw new Error("missing-event-api-configuration");
const gateway = new AwsDynamoGateway(
  DynamoDBDocumentClient.from(new DynamoDBClient({})),
  tableName,
);
const secrets = new SecretsManagerClient({});
export const handler = async (event: LambdaEvent) => {
  const ring = await loadSecretRing(secrets, secretArn);
  const repository = new DynamoEventRepository(
    gateway,
    new EventCursorCodec(ring),
    async () => {
      const item = await gateway.get("EVENT_PROJECTIONS", "READINESS");
      return (
        !!item &&
        JSON.stringify(item.value) ===
          JSON.stringify({ schemaVersion: 1, state: "initialized" })
      );
    },
  );
  const games = new DynamoGamesRepository(repository, gateway);
  const documentClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  const claims = event.requestContext?.authorizer?.jwt?.claims;
  const route = event.routeKey?.startsWith("GET /games")
    ? "games"
    : event.routeKey?.startsWith("GET /splits")
      ? "splits"
      : event.routeKey === "GET /performance/reports"
        ? "performance-reports"
        : event.routeKey?.startsWith("GET /performance/reports/")
          ? "performance-detail"
          : event.routeKey?.startsWith("GET /performance/cohorts/")
            ? "performance-members"
            : event.routeKey?.startsWith("GET /performance/cohorts")
              ? "performance-list"
              : event.routeKey?.includes("/{eventId}")
                ? "detail"
                : "list";
  const eventId = event.pathParameters?.eventId;
  const subject =
    typeof claims?.["sub"] === "string" ? claims["sub"] : undefined;
  const scopes = event.requestContext?.authorizer?.jwt?.scopes;
  const query = event.queryStringParameters;
  return createEventHandler(
    repository,
    games,
    undefined,
    new DynamoBettingSplitRepository(
      DynamoDBDocumentClient.from(new DynamoDBClient({})),
      tableName,
    ),
    new DynamoCohortRepository(documentClient, tableName),
  )({
    route,
    ...(subject ? { subject } : {}),
    ...(scopes ? { scopes } : {}),
    ...(eventId ? { eventId } : {}),
    ...(query ? { query } : {}),
  });
};
