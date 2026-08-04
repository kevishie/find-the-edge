export type PaperPickExecutionMode = "shadow" | "paper";

export interface PaperPickAllowlistTuple {
  readonly sportKey: string;
  readonly leagueKey: string;
  readonly strategyId: string;
  readonly strategyVersion: string;
  readonly marketKey: string;
  readonly mode: PaperPickExecutionMode;
}

export interface PaperPickSchedulePolicy {
  readonly id: string;
  readonly version: string;
  readonly enabled: boolean;
  readonly killSwitch: "open" | "killed";
  readonly generationMinutes: number;
  readonly candidateWindowMinutes: {
    readonly minimum: number;
    readonly maximum: number;
  };
  readonly limits: {
    readonly events: number;
    readonly concurrency: number;
    readonly modelCalls: number;
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly costMicros: number;
  };
  readonly allowlist: readonly PaperPickAllowlistTuple[];
}

export class PaperPickSchedulePolicyError extends Error {
  override readonly name = "PaperPickSchedulePolicyError";
}

const SAFE_ID = /^[a-z0-9][a-z0-9._/@:-]{0,127}$/;
const positiveInteger = (value: unknown, label: string, max: number) => {
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > max)
    throw new PaperPickSchedulePolicyError(`${label}-invalid`);
  return Number(value);
};
const identifier = (value: unknown, label: string) => {
  if (typeof value !== "string" || !SAFE_ID.test(value))
    throw new PaperPickSchedulePolicyError(`${label}-invalid`);
  return value;
};

export function validatePaperPickSchedulePolicy(
  value: PaperPickSchedulePolicy,
): Readonly<PaperPickSchedulePolicy> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new PaperPickSchedulePolicyError("policy-object-required");
  const expected = [
    "allowlist",
    "candidateWindowMinutes",
    "enabled",
    "generationMinutes",
    "id",
    "killSwitch",
    "limits",
    "version",
  ].sort();
  if (Object.keys(value).sort().join("|") !== expected.join("|"))
    throw new PaperPickSchedulePolicyError("policy-fields-invalid");
  if (typeof value.enabled !== "boolean")
    throw new PaperPickSchedulePolicyError("enabled-invalid");
  if (value.killSwitch !== "open" && value.killSwitch !== "killed")
    throw new PaperPickSchedulePolicyError("kill-switch-invalid");
  identifier(value.id, "policy-id");
  identifier(value.version, "policy-version");
  positiveInteger(value.generationMinutes, "generation-minutes", 1440);
  const { minimum, maximum } = value.candidateWindowMinutes;
  if (
    !Number.isSafeInteger(minimum) ||
    minimum < 0 ||
    !Number.isSafeInteger(maximum) ||
    maximum < 1 ||
    maximum > 10080 ||
    minimum >= maximum
  )
    throw new PaperPickSchedulePolicyError("candidate-window-invalid");
  positiveInteger(value.limits.events, "event-limit", 1000);
  positiveInteger(value.limits.concurrency, "concurrency-limit", 100);
  positiveInteger(value.limits.modelCalls, "model-call-limit", 1000);
  positiveInteger(value.limits.inputTokens, "input-token-limit", 100_000_000);
  positiveInteger(value.limits.outputTokens, "output-token-limit", 100_000_000);
  positiveInteger(value.limits.costMicros, "cost-limit", 1_000_000_000);
  const rawAllowlist: unknown = value.allowlist;
  if (!Array.isArray(rawAllowlist) || rawAllowlist.length > 100)
    throw new PaperPickSchedulePolicyError("allowlist-invalid");
  const allowlist = rawAllowlist as readonly unknown[];
  const seen = new Set<string>();
  for (const rawTuple of allowlist) {
    if (
      !rawTuple ||
      typeof rawTuple !== "object" ||
      Array.isArray(rawTuple) ||
      Object.getPrototypeOf(rawTuple) !== Object.prototype ||
      Object.keys(rawTuple).sort().join("|") !==
        [
          "leagueKey",
          "marketKey",
          "mode",
          "sportKey",
          "strategyId",
          "strategyVersion",
        ].join("|")
    )
      throw new PaperPickSchedulePolicyError("allowlist-tuple-fields-invalid");
    const tuple = rawTuple as Record<string, unknown>;
    const sportKey = identifier(tuple["sportKey"], "allowlist-sportKey");
    const leagueKey = identifier(tuple["leagueKey"], "allowlist-leagueKey");
    const strategyId = identifier(tuple["strategyId"], "allowlist-strategyId");
    const strategyVersion = identifier(
      tuple["strategyVersion"],
      "allowlist-strategyVersion",
    );
    const marketKey = identifier(tuple["marketKey"], "allowlist-marketKey");
    if (tuple["mode"] !== "shadow" && tuple["mode"] !== "paper")
      throw new PaperPickSchedulePolicyError("allowlist-mode-invalid");
    const identity = [
      sportKey,
      leagueKey,
      strategyId,
      strategyVersion,
      marketKey,
      tuple["mode"],
    ].join("\0");
    if (seen.has(identity))
      throw new PaperPickSchedulePolicyError("allowlist-duplicate");
    seen.add(identity);
  }
  if (value.enabled && (!value.allowlist.length || value.killSwitch !== "open"))
    throw new PaperPickSchedulePolicyError("enabled-policy-not-runnable");
  return Object.freeze(structuredClone(value));
}

export const disabledPaperPickSchedulePolicy = validatePaperPickSchedulePolicy({
  id: "paper-pick-schedule",
  version: "1",
  enabled: false,
  killSwitch: "killed",
  generationMinutes: 15,
  candidateWindowMinutes: { minimum: 30, maximum: 1440 },
  limits: {
    events: 1,
    concurrency: 1,
    modelCalls: 1,
    inputTokens: 1,
    outputTokens: 1,
    costMicros: 1,
  },
  allowlist: [],
});
