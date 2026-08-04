import { sha256Hex } from "./fixture-odds.js";

export type EvaluationAttemptStatus = "abstained" | "invalid" | "failed";
export interface EvaluationAttemptInput {
  readonly semanticInputHash: string;
  readonly status: EvaluationAttemptStatus;
  readonly reasonCodes: readonly string[];
  readonly sportKey: string;
  readonly leagueKey: string;
  readonly eventId: string;
  readonly strategy: { readonly id: string; readonly version: string };
  readonly model: { readonly id: string; readonly version: string };
  readonly createdAt: string;
  readonly execution?: {
    readonly mode: "shadow" | "paper";
    readonly runId: string;
    readonly itemId: string;
    readonly policyId: string;
    readonly policyVersion: string;
    readonly scheduledFor: string;
  };
}
export interface EvaluationAttemptRecord extends EvaluationAttemptInput {
  readonly attemptId: string;
}
const safe = /^[a-zA-Z0-9._:@/-]{1,256}$/;
const hash = /^[a-f0-9]{64}$/;
export function createEvaluationAttempt(
  input: EvaluationAttemptInput,
): EvaluationAttemptRecord {
  if (!(["abstained", "invalid", "failed"] as const).includes(input.status))
    throw new Error("attempt-status-invalid");
  if (!hash.test(input.semanticInputHash))
    throw new Error("attempt-input-hash-invalid");
  for (const value of [
    ...input.reasonCodes,
    input.sportKey,
    input.leagueKey,
    input.eventId,
    input.strategy.id,
    input.strategy.version,
    input.model.id,
    input.model.version,
  ])
    if (
      !safe.test(value) ||
      /secret|credential|api[_-]?key|raw[_-]?payload/i.test(value)
    )
      throw new Error("attempt-metadata-invalid");
  const reasonCodes = [...new Set(input.reasonCodes)].sort();
  if (!reasonCodes.length || reasonCodes.length > 32)
    throw new Error("attempt-reasons-invalid");
  if (new Date(input.createdAt).toISOString() !== input.createdAt)
    throw new Error("attempt-created-at-invalid");
  if (input.execution) {
    const execution = input.execution;
    const runMatch = execution.runId.match(/^paper-pick-run:([a-f0-9]{64})$/);
    if (
      (execution.mode !== "shadow" && execution.mode !== "paper") ||
      !runMatch ||
      !new RegExp(`^paper-pick-item:${runMatch[1]}:[a-f0-9]{64}$`).test(
        execution.itemId,
      ) ||
      !safe.test(execution.policyId) ||
      !safe.test(execution.policyVersion) ||
      new Date(execution.scheduledFor).toISOString() !== execution.scheduledFor
    )
      throw new Error("attempt-execution-invalid");
  }
  return Object.freeze({
    ...structuredClone(input),
    reasonCodes: Object.freeze(reasonCodes),
    attemptId: `evaluation-attempt:${sha256Hex(input.semanticInputHash)}`,
  });
}
