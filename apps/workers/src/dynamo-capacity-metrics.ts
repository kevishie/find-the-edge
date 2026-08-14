import type { DynamoCapacityAttribution } from "@find-the-edge/database";

const bounded = (value: string, maximum: number, fallback: string) =>
  /^[A-Za-z][A-Za-z0-9#_-]*$/.test(value) && value.length <= maximum
    ? value
    : fallback;

/** Emits capacity metadata only: no table names, indexes, keys, or item data. */
export const emitDynamoCapacityMetrics = (value: DynamoCapacityAttribution) => {
  const Stage = bounded(
    process.env["FTE_AWS_STAGE"] ?? "unknown",
    32,
    "unknown",
  );
  const Operation = bounded(value.operation, 32, "unknown");
  const Prefix = bounded(value.prefix, 48, "UNATTRIBUTED");
  // Cause is reconstructed from already bounded categories. Never trust an
  // arbitrary caller string here because it could contain a key or item ID.
  const Cause = `${Operation}:${Prefix}`.slice(0, 64);
  const Resource = value.resource === "index" ? "index" : "table";
  const metrics = [
    { Name: "RequestCount", Unit: "Count" },
    ...(value.readUnits > 0
      ? [{ Name: "ReadCapacityUnits", Unit: "Count" }]
      : []),
    ...(value.writeUnits > 0
      ? [{ Name: "WriteCapacityUnits", Unit: "Count" }]
      : []),
    ...(["MIXED", "UNATTRIBUTED"].includes(Prefix)
      ? [{ Name: "UnattributedCapacityUnits", Unit: "Count" }]
      : []),
  ];
  process.stdout.write(
    `${JSON.stringify({
      _aws: {
        Timestamp: Date.now(),
        CloudWatchMetrics: [
          {
            Namespace: "FindTheEdge/DynamoCapacity",
            Dimensions: [["Stage", "Operation", "Cause", "Prefix", "Resource"]],
            Metrics: metrics,
          },
        ],
      },
      Stage,
      Operation,
      Cause,
      Prefix,
      Resource,
      RequestCount: 1,
      ...(value.readUnits > 0 ? { ReadCapacityUnits: value.readUnits } : {}),
      ...(value.writeUnits > 0 ? { WriteCapacityUnits: value.writeUnits } : {}),
      ...(["MIXED", "UNATTRIBUTED"].includes(Prefix)
        ? { UnattributedCapacityUnits: value.readUnits + value.writeUnits }
        : {}),
    })}\n`,
  );
};
