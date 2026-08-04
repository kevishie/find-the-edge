import { sha256Hex } from "./fixture-odds.js";

export type PaperPickMode = "shadow" | "paper";
export type PaperPickItemTerminal =
  "evaluation" | "attempt" | "skipped" | "limit" | "failed";
export interface PaperPickRunIdentityInput {
  readonly policyId: string;
  readonly policyVersion: string;
  readonly scheduledFor: string;
  readonly sportKey: string;
  readonly leagueKey: string;
  readonly strategyId: string;
  readonly strategyVersion: string;
  readonly marketKey: string;
  readonly mode: PaperPickMode;
}
export interface PaperPickRunRecord extends PaperPickRunIdentityInput {
  readonly runId: string;
  readonly generationId: string;
  readonly createdAt: string;
  readonly state: "ready" | "running" | "partial" | "complete" | "stopped";
  readonly counters: {
    readonly discovered: number;
    readonly terminal: number;
    readonly evaluations: number;
    readonly attempts: number;
    readonly skipped: number;
    readonly limits: number;
    readonly failures: number;
  };
  readonly candidateManifest: readonly {
    readonly eventId: string;
    readonly eventVersion: number;
    readonly sportKey: string;
    readonly leagueKey: string;
    readonly participantIds: readonly string[];
    readonly startsAt: string;
  }[];
}
export const createPaperPickGenerationId = (
  policyId: string,
  policyVersion: string,
  scheduledFor: string,
) => {
  safe(policyId);
  safe(policyVersion);
  iso(scheduledFor);
  return `paper-pick-generation:${sha256Hex(
    stable({ policyId, policyVersion, scheduledFor }),
  )}`;
};
export interface PaperPickRunItem {
  readonly itemId: string;
  readonly runId: string;
  readonly eventId: string;
  readonly eventVersion: number;
  readonly sportKey: string;
  readonly leagueKey: string;
  readonly participantIds: readonly string[];
  readonly startsAt: string;
  readonly mode: PaperPickMode;
  readonly state: "ready" | "claimed" | "terminal";
  readonly terminal?: PaperPickItemTerminal;
  readonly reasonCode?: string;
}
export interface PaperPickRunProvenance {
  readonly runId: string;
  readonly itemId: string;
  readonly mode: PaperPickMode;
  readonly policyId: string;
  readonly policyVersion: string;
  readonly scheduledFor: string;
}
const stable = (value: unknown) =>
  JSON.stringify(value, Object.keys(value as object).sort());
const iso = (value: string) => {
  if (
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  )
    throw new Error("paper-pick-time-invalid");
  return value;
};
const safe = (value: string) => {
  if (!/^[a-zA-Z0-9._/@:-]{1,256}$/.test(value))
    throw new Error("paper-pick-id-invalid");
  return value;
};
export const createPaperPickRunId = (input: PaperPickRunIdentityInput) => {
  Object.values(input).forEach(
    (value) => typeof value === "string" && safe(value),
  );
  iso(input.scheduledFor);
  return `paper-pick-run:${sha256Hex(stable(input))}`;
};
export const createPaperPickItemId = (
  runId: string,
  eventId: string,
  eventVersion: number,
) => {
  if (
    !/^paper-pick-run:[a-f0-9]{64}$/.test(runId) ||
    !Number.isSafeInteger(eventVersion) ||
    eventVersion < 1
  )
    throw new Error("paper-pick-item-identity-invalid");
  safe(eventId);
  return `paper-pick-item:${runId.slice("paper-pick-run:".length)}:${sha256Hex(stable({ eventId, eventVersion, runId }))}`;
};
export function normalizePaperPickCandidateManifest(
  identity: PaperPickRunIdentityInput,
  candidates: PaperPickRunRecord["candidateManifest"],
): PaperPickRunRecord["candidateManifest"] {
  const rawCandidates: unknown = candidates;
  if (!Array.isArray(rawCandidates) || rawCandidates.length > 1000)
    throw new Error("paper-pick-candidate-manifest-invalid");
  const entries = rawCandidates as readonly unknown[];
  const seen = new Set<string>();
  const normalized: PaperPickRunRecord["candidateManifest"][number][] =
    entries.map((rawCandidate) => {
      if (
        !rawCandidate ||
        typeof rawCandidate !== "object" ||
        Array.isArray(rawCandidate)
      )
        throw new Error("paper-pick-candidate-manifest-invalid");
      const candidate = rawCandidate as Record<string, unknown>;
      if (
        typeof candidate["eventId"] !== "string" ||
        typeof candidate["sportKey"] !== "string" ||
        typeof candidate["leagueKey"] !== "string" ||
        typeof candidate["startsAt"] !== "string"
      )
        throw new Error("paper-pick-candidate-manifest-invalid");
      const eventId = safe(candidate["eventId"]);
      const eventVersion = candidate["eventVersion"];
      const participantValue: unknown = candidate["participantIds"];
      if (!Array.isArray(participantValue))
        throw new Error("paper-pick-candidate-manifest-invalid");
      const participantIds = (participantValue as readonly unknown[]).map(
        (participant) => {
          if (typeof participant !== "string")
            throw new Error("paper-pick-candidate-manifest-invalid");
          return safe(participant);
        },
      );
      const sportKey = candidate["sportKey"];
      const leagueKey = candidate["leagueKey"];
      const startsAt = candidate["startsAt"];
      if (
        !Number.isSafeInteger(eventVersion) ||
        Number(eventVersion) < 1 ||
        sportKey !== identity.sportKey ||
        leagueKey !== identity.leagueKey ||
        participantIds.length < 2 ||
        new Set(participantIds).size !== participantIds.length
      )
        throw new Error("paper-pick-candidate-manifest-invalid");
      iso(startsAt);
      const key = `${eventId}\0${String(eventVersion)}`;
      if (seen.has(key)) throw new Error("paper-pick-candidate-duplicate");
      seen.add(key);
      return {
        eventId,
        eventVersion: Number(eventVersion),
        sportKey,
        leagueKey,
        participantIds,
        startsAt,
      };
    });
  return Object.freeze(
    normalized.sort(
      (left, right) =>
        left.startsAt.localeCompare(right.startsAt) ||
        left.eventId.localeCompare(right.eventId) ||
        left.eventVersion - right.eventVersion,
    ),
  );
}
export function assertPaperPickTransition(
  from: PaperPickRunRecord["state"],
  to: PaperPickRunRecord["state"],
) {
  const legal: Record<
    PaperPickRunRecord["state"],
    readonly PaperPickRunRecord["state"][]
  > = {
    ready: ["running", "partial", "complete", "stopped"],
    running: ["partial", "complete", "stopped"],
    partial: ["running", "complete", "stopped"],
    complete: [],
    stopped: [],
  };
  if (!legal[from].includes(to))
    throw new Error("paper-pick-run-transition-invalid");
}
export function assertPaperPickItemTransition(
  from: PaperPickRunItem["state"],
  to: PaperPickRunItem["state"],
) {
  const legal: Record<
    PaperPickRunItem["state"],
    readonly PaperPickRunItem["state"][]
  > = { ready: ["claimed"], claimed: ["claimed", "terminal"], terminal: [] };
  if (!legal[from].includes(to))
    throw new Error("paper-pick-item-transition-invalid");
}
