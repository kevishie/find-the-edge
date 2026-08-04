import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import {
  AwsDynamoGateway,
  AwsFixtureOddsGateway,
  DynamoEventIngestionStore,
  DynamoFixtureOddsAdapter,
  DynamoExactOddsSnapshotRepository,
} from "@find-the-edge/database";
import { seedFixtureOdds } from "./fixture-odds-seed";

export function assertFixtureSeedEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
): string {
  if (environment["FTE_AWS_STAGE"] !== "dev")
    throw new Error("fixture odds seed is restricted to the dev stage");
  if (environment["FTE_FIXTURE_ODDS_SEED_ENABLED"] !== "true")
    throw new Error("fixture odds seed is disabled");
  const tableName = environment["FTE_EVENT_TABLE"]?.trim();
  if (!tableName) throw new Error("FTE_EVENT_TABLE required and nonblank");
  return tableName;
}

export const handler = async () => {
  const tableName = assertFixtureSeedEnvironment(process.env);
  const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  const summary = await seedFixtureOdds(
    new DynamoEventIngestionStore(new AwsDynamoGateway(client, tableName)),
    new DynamoFixtureOddsAdapter(
      new AwsFixtureOddsGateway(client, tableName),
      new DynamoExactOddsSnapshotRepository(client, tableName),
    ),
  );
  process.stdout.write(
    `${JSON.stringify({ event: "fixture-odds-seed-complete", ...summary })}\n`,
  );
  return summary;
};
