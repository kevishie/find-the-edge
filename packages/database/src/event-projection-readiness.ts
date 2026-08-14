import type { DynamoGateway } from "./dynamodb-event-ingestion";

/**
 * Projection readiness is a one-way initialization latch. An eventual miss
 * fails closed and merely delays projection work until a later invocation.
 */
export async function readEventProjectionReadiness(
  gateway: Pick<DynamoGateway, "get">,
): Promise<boolean> {
  return isReady(
    await gateway.get("EVENT_PROJECTIONS", "READINESS", {
      consistentRead: false,
    }),
  );
}

/** Durable-decision callers must not turn a replica-lagged miss into a write. */
export async function readEventProjectionReadinessStrong(
  gateway: Pick<DynamoGateway, "get">,
): Promise<boolean> {
  return isReady(await gateway.get("EVENT_PROJECTIONS", "READINESS"));
}

const isReady = (item: Awaited<ReturnType<DynamoGateway["get"]>>): boolean => {
  if (!item || item.pk !== "EVENT_PROJECTIONS" || item.sk !== "READINESS")
    return false;
  const value = item.value;
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Reflect.ownKeys(value).length === 2 &&
    Reflect.get(value, "schemaVersion") === 1 &&
    Reflect.get(value, "state") === "initialized"
  );
};
