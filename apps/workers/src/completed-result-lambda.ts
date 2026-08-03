import type { CompletedResultOrchestrator } from "./completed-result-orchestrator";
import { validateCompletedResultCommand } from "./completed-result-orchestrator";
export function validateCompletedResultInvocation(
  input: unknown,
  now: () => number = Date.now,
): readonly unknown[] {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("invalid-result-invocation");
  const value = input as Record<string, unknown>;
  if (value["commands"] !== undefined) {
    if (
      Object.keys(value).length !== 1 ||
      !Object.hasOwn(value, "commands") ||
      !Array.isArray(value["commands"]) ||
      value["commands"].length < 1 ||
      value["commands"].length > 12
    )
      throw new Error("invalid-result-invocation");
    try {
      const commands = value["commands"].map(validateCompletedResultCommand);
      if (commands.some((command) => command.mode === "scheduled"))
        throw new Error();
      return commands;
    } catch {
      throw new Error("invalid-result-invocation");
    }
  }
  const allowed = [
    "version",
    "id",
    "detail-type",
    "source",
    "account",
    "time",
    "region",
    "resources",
    "detail",
  ];
  const time = value["time"];
  if (
    Object.keys(value).length !== allowed.length ||
    !Object.keys(value).every((key) => allowed.includes(key)) ||
    value["version"] !== "0" ||
    value["detail-type"] !== "Scheduled Event" ||
    value["source"] !== "aws.events" ||
    typeof value["id"] !== "string" ||
    value["id"].length < 1 ||
    value["id"].length > 128 ||
    typeof value["account"] !== "string" ||
    !/^\d{12}$/.test(value["account"]) ||
    typeof value["region"] !== "string" ||
    !/^[a-z]{2}-[a-z]+-\d$/.test(value["region"]) ||
    !Array.isArray(value["resources"]) ||
    value["resources"].length < 1 ||
    value["resources"].length > 10 ||
    value["resources"].some(
      (resource) =>
        typeof resource !== "string" ||
        resource.length > 512 ||
        !resource.startsWith("arn:"),
    ) ||
    !value["detail"] ||
    typeof value["detail"] !== "object" ||
    Array.isArray(value["detail"]) ||
    Object.keys(value["detail"]).length !== 0 ||
    typeof time !== "string" ||
    time.length > 40 ||
    !Number.isFinite(Date.parse(time)) ||
    new Date(time).toISOString() !== time ||
    Math.abs(Date.parse(time) - now()) > 5 * 60_000
  )
    throw new Error("invalid-result-invocation");
  const end = new Date(time),
    start = new Date(end.getTime() - 72 * 3600000);
  return [
    {
      attemptId: `scheduled-mlb-${time}`,
      sportKey: "mlb" as never,
      leagueKey: "mlb",
      windowStart: start.toISOString() as never,
      windowEnd: end.toISOString() as never,
      pageLimit: 100,
      maxPages: 10,
      mode: "scheduled",
    },
    {
      attemptId: `scheduled-mls-${time}`,
      sportKey: "soccer" as never,
      leagueKey: "mls",
      windowStart: start.toISOString() as never,
      windowEnd: end.toISOString() as never,
      pageLimit: 100,
      maxPages: 10,
      mode: "scheduled",
    },
  ];
}
export const createCompletedResultHandler =
  (orchestrator: CompletedResultOrchestrator) => async (input: unknown) => {
    const commands = validateCompletedResultInvocation(input),
      runs = [];
    for (const command of commands)
      runs.push(await orchestrator.execute(command));
    if (runs.some((run) => run.status === "failed"))
      throw new Error("completed-result-run-failed");
    return { runs };
  };
export const handler = (input: unknown) => {
  void input;
  return Promise.reject(new Error("completed-results-runtime-not-configured"));
};
