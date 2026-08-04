import type { PaperPickScheduler } from "./paper-pick-scheduler";

export interface PaperPickInternalCommand {
  readonly source: "aws.events" | "aws.states";
  readonly detailType: "FTE Paper Pick Generation";
  readonly generatedAt: string;
  readonly scheduledFor: string;
  readonly generationMinutes: number;
}
export function createPaperPickSchedulerHandler(
  scheduler: PaperPickScheduler,
  now: () => Date = () => new Date(),
  emit: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
  expectedGenerationMinutes = 15,
) {
  return async (unknownCommand: unknown) => {
    if (
      !unknownCommand ||
      typeof unknownCommand !== "object" ||
      Array.isArray(unknownCommand)
    )
      throw new Error("paper-pick-command-invalid");
    const command = unknownCommand as Record<string, unknown>;
    if (
      Object.keys(command).sort().join("|") !==
        [
          "detailType",
          "generatedAt",
          "generationMinutes",
          "scheduledFor",
          "source",
        ].join("|") ||
      !["aws.events", "aws.states"].includes(String(command["source"])) ||
      command["detailType"] !== "FTE Paper Pick Generation" ||
      command["generationMinutes"] !== expectedGenerationMinutes
    )
      throw new Error("paper-pick-command-invalid");
    const generatedAt = String(command["generatedAt"]),
      scheduledFor = String(command["scheduledFor"]),
      maximumAgeMs =
        command["source"] === "aws.states" ? 14 * 24 * 60 * 60_000 : 5 * 60_000;
    if (
      new Date(generatedAt).toISOString() !== generatedAt ||
      new Date(scheduledFor).toISOString() !== scheduledFor ||
      Math.abs(now().getTime() - Date.parse(generatedAt)) > maximumAgeMs
    )
      throw new Error("paper-pick-command-stale");
    const result = await scheduler.generate(scheduledFor);
    emit(
      JSON.stringify({
        _aws: {
          Timestamp: now().getTime(),
          CloudWatchMetrics: [
            {
              Namespace: "FindTheEdge/PaperPicks",
              Dimensions: [["Mode"]],
              Metrics: [
                { Name: "Runs", Unit: "Count" },
                { Name: "Terminals", Unit: "Count" },
                { Name: "Limits", Unit: "Count" },
                { Name: "Failures", Unit: "Count" },
              ],
            },
          ],
        },
        Mode: "controlled",
        Runs: result.runIds.length,
        Terminals: result.terminal,
        Limits: result.limits,
        Failures: result.reasonCode ? 1 : 0,
        ...(result.reasonCode ? { ReasonCode: result.reasonCode } : {}),
      }),
    );
    return result;
  };
}
