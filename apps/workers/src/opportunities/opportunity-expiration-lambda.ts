import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import {
  AwsDynamoGateway,
  DynamoOpportunityCandidateRepository,
  DynamoOpportunityLifecycleEventEvidenceSource,
  DynamoOpportunityLifecycleRepository,
} from "@find-the-edge/database";
import { OpportunityExpirationWorker } from "./opportunity-expiration-worker";
import { OpportunityLifecycleService } from "./opportunity-lifecycle-service";

export function validateOpportunityExpirationInvocation(
  input: unknown,
  now: () => number = Date.now,
): string {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("opportunity-expiration-invocation-invalid");
  const value = input as Record<string, unknown>;
  const time = value["time"];
  const scheduledAt = typeof time === "string" ? Date.parse(time) : NaN;
  const currentTime = now();
  // EventBridge stamps scheduled events at second precision; the normalized
  // millisecond instant is what downstream lifecycle contracts require.
  const normalized = Number.isFinite(scheduledAt)
    ? new Date(scheduledAt).toISOString()
    : "";
  if (
    value["source"] !== "aws.events" ||
    value["detail-type"] !== "Scheduled Event" ||
    typeof time !== "string" ||
    !normalized ||
    !Number.isFinite(currentTime) ||
    (time !== normalized && time !== normalized.replace(".000Z", "Z")) ||
    scheduledAt > currentTime ||
    currentTime - scheduledAt > 5 * 60_000
  )
    throw new Error("opportunity-expiration-invocation-invalid");
  return normalized;
}

const SPORT_KEY = /^[a-z0-9][a-z0-9_-]{0,63}$/;
export function normalizeOpportunitySportKeys(
  sportKeys: readonly string[],
): readonly string[] {
  const normalized = sportKeys.map((sportKey) => sportKey.trim());
  if (
    normalized.length === 0 ||
    normalized.some((sportKey) => !SPORT_KEY.test(sportKey)) ||
    new Set(normalized).size !== normalized.length
  )
    throw new Error("opportunity-expiration-sport-keys-invalid");
  return Object.freeze(normalized);
}

export const createOpportunityExpirationHandler = (
  worker: OpportunityExpirationWorker,
  sportKeys: readonly string[],
  now: () => number = Date.now,
) => {
  const normalizedSportKeys = normalizeOpportunitySportKeys(sportKeys);
  return async (input: unknown) =>
    worker.run({
      asOf: validateOpportunityExpirationInvocation(input, now),
      sportKeys: normalizedSportKeys,
      pageLimit: 100,
      maximumPages: 10,
    });
};

const telemetry = {
  emit() {},
};
let runtime: ((input: unknown) => Promise<unknown>) | undefined;
export const handler = (input: unknown) => {
  if (!runtime) {
    const tableName = process.env["FTE_EVENT_TABLE"] ?? "";
    const sportKeys = (process.env["FTE_OPPORTUNITY_SPORT_KEYS"] ?? "")
      .split(",")
      .map((sportKey) => sportKey.trim())
      .filter(Boolean);
    if (!tableName)
      throw new Error("opportunity-expiration-configuration-missing");
    const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));
    const lifecycle = new DynamoOpportunityLifecycleRepository(
      client,
      tableName,
    );
    const candidates = new DynamoOpportunityCandidateRepository(
      client,
      tableName,
    );
    const events = new DynamoOpportunityLifecycleEventEvidenceSource(
      new AwsDynamoGateway(client, tableName),
    );
    const service = new OpportunityLifecycleService({
      lifecycle,
      candidates,
      events,
      telemetry,
    });
    runtime = createOpportunityExpirationHandler(
      new OpportunityExpirationWorker({ lifecycle, service, telemetry }),
      sportKeys,
    );
  }
  return runtime(input);
};
