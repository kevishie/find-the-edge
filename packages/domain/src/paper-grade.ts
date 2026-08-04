import { sha256Hex } from "./fixture-odds.js";

export type PaperGradeOutcome = "won" | "lost" | "push" | "void" | "unresolved";
export type PaperGradeReason =
  | "moneyline-final"
  | "spread-final"
  | "cancelled"
  | "no-contest"
  | "postponed"
  | "scores-missing"
  | "spread-evidence-missing"
  | "two-way-tie"
  | "sport-mismatch"
  | "event-mismatch"
  | "event-version-mismatch"
  | "result-scope-mismatch"
  | "participant-mismatch"
  | "selection-mismatch"
  | "legacy-grading-terms-missing"
  | "sport-grading-unsupported";
export interface PaperGradeRecord {
  readonly gradeId: string;
  readonly paperBetId: string;
  readonly evaluationId: string;
  readonly eventId: string;
  readonly resultObservationId: string;
  readonly resultAuthority: string;
  readonly oddsPartitionKey: string;
  readonly oddsSortKey: string;
  readonly oddsSnapshotId: string;
  readonly outcome: PaperGradeOutcome;
  readonly reason: PaperGradeReason;
  readonly stake: 1;
  readonly profit: number;
  readonly payout: number;
  readonly roi: number;
  readonly supersedesGradeId?: string;
  readonly correctionOrdinal: number;
  readonly gradedAt: string;
  readonly policyVersion: "paper-grading-v1";
}
export type PaperGradeInput = Omit<
  PaperGradeRecord,
  "gradeId" | "stake" | "policyVersion"
> & {
  readonly gradeId?: string;
  readonly stake?: 1;
  readonly policyVersion?: "paper-grading-v1";
};
const text = (value: unknown, label: string) => {
  if (
    typeof value !== "string" ||
    !value.length ||
    value.length > 1024 ||
    !/^[\x20-\x7e]+$/.test(value)
  )
    throw new Error(`${label}-invalid`);
  return value;
};
const finite = (value: number, label: string) => {
  if (!Number.isFinite(value)) throw new Error(`${label}-invalid`);
  return Object.is(value, -0) ? 0 : value;
};
export type PaperGradeProvenance = Pick<
  PaperGradeRecord,
  | "paperBetId"
  | "evaluationId"
  | "eventId"
  | "resultObservationId"
  | "resultAuthority"
  | "oddsPartitionKey"
  | "oddsSortKey"
  | "oddsSnapshotId"
>;
const canonicalGradeValue = (value: unknown): unknown => {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new Error("grade-canonical-value-invalid");
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) return value.map(canonicalGradeValue);
  if (!value || typeof value !== "object")
    throw new Error("grade-canonical-value-invalid");
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .map((key) => [key, canonicalGradeValue(record[key])]),
  );
};
export const stablePaperGradeValue = (value: unknown) =>
  JSON.stringify(canonicalGradeValue(value));
export const paperGradeIdentity = (input: PaperGradeProvenance) =>
  `paper-grade:${sha256Hex(
    stablePaperGradeValue({
      paperBetId: input.paperBetId,
      evaluationId: input.evaluationId,
      eventId: input.eventId,
      resultObservationId: input.resultObservationId,
      resultAuthority: input.resultAuthority,
      oddsPartitionKey: input.oddsPartitionKey,
      oddsSortKey: input.oddsSortKey,
      oddsSnapshotId: input.oddsSnapshotId,
      policyVersion: "paper-grading-v1",
    }),
  )}`;
export function createPaperGrade(input: PaperGradeInput): PaperGradeRecord {
  const allowed = [
    "gradeId",
    "paperBetId",
    "evaluationId",
    "eventId",
    "resultObservationId",
    "resultAuthority",
    "oddsPartitionKey",
    "oddsSortKey",
    "oddsSnapshotId",
    "outcome",
    "reason",
    "profit",
    "payout",
    "roi",
    "supersedesGradeId",
    "correctionOrdinal",
    "gradedAt",
    "stake",
    "policyVersion",
  ];
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).some((key) => !allowed.includes(key)) ||
    (input.stake !== undefined && input.stake !== 1) ||
    (input.policyVersion !== undefined &&
      input.policyVersion !== "paper-grading-v1")
  )
    throw new Error("grade-input-invalid");
  const outcome = input.outcome;
  if (!["won", "lost", "push", "void", "unresolved"].includes(outcome))
    throw new Error("grade-outcome-invalid");
  const reasons: readonly PaperGradeReason[] = [
    "moneyline-final",
    "spread-final",
    "cancelled",
    "no-contest",
    "postponed",
    "scores-missing",
    "spread-evidence-missing",
    "two-way-tie",
    "sport-mismatch",
    "event-mismatch",
    "event-version-mismatch",
    "result-scope-mismatch",
    "participant-mismatch",
    "selection-mismatch",
    "legacy-grading-terms-missing",
    "sport-grading-unsupported",
  ];
  if (!reasons.includes(input.reason)) throw new Error("grade-reason-invalid");
  const terminalReasons = new Set<PaperGradeReason>([
    "moneyline-final",
    "spread-final",
  ]);
  const unresolvedReasons = new Set<PaperGradeReason>([
    "postponed",
    "scores-missing",
    "spread-evidence-missing",
    "two-way-tie",
    "sport-mismatch",
    "event-mismatch",
    "event-version-mismatch",
    "result-scope-mismatch",
    "participant-mismatch",
    "selection-mismatch",
    "legacy-grading-terms-missing",
    "sport-grading-unsupported",
  ]);
  if (
    ((outcome === "won" || outcome === "lost") &&
      !terminalReasons.has(input.reason)) ||
    (outcome === "push" && input.reason !== "spread-final") ||
    (outcome === "void" &&
      input.reason !== "cancelled" &&
      input.reason !== "no-contest") ||
    (outcome === "unresolved" && !unresolvedReasons.has(input.reason))
  )
    throw new Error("grade-reason-outcome-invalid");
  const profit = finite(input.profit, "grade-profit"),
    payout = finite(input.payout, "grade-payout"),
    roi = finite(input.roi, "grade-roi");
  if (
    (outcome === "won" && !(profit > 0 && payout > 1 && roi === profit)) ||
    (outcome === "lost" && !(profit === -1 && payout === 0 && roi === -1)) ||
    (["push", "void", "unresolved"].includes(outcome) &&
      !(profit === 0 && payout === 1 && roi === 0))
  )
    throw new Error("grade-financial-invariant");
  if (
    !Number.isSafeInteger(input.correctionOrdinal) ||
    input.correctionOrdinal < 0 ||
    (input.correctionOrdinal === 0) !== (input.supersedesGradeId === undefined)
  )
    throw new Error("grade-supersession-invalid");
  if (
    input.supersedesGradeId !== undefined &&
    !/^paper-grade:[a-f0-9]{64}$/.test(
      text(input.supersedesGradeId, "supersedes-grade-id"),
    )
  )
    throw new Error("supersedes-grade-id-invalid");
  if (!/^paper-bet:[a-f0-9]{64}$/.test(input.paperBetId))
    throw new Error("paper-bet-id-invalid");
  if (!/^evaluation:[a-f0-9]{64}$/.test(input.evaluationId))
    throw new Error("evaluation-id-invalid");
  if (!/^result:[a-f0-9]{64}$/.test(input.resultObservationId))
    throw new Error("result-id-invalid");
  if (!/^[a-f0-9]{64}$/.test(input.oddsSnapshotId))
    throw new Error("odds-id-invalid");
  if (
    input.paperBetId.slice("paper-bet:".length) !==
    input.evaluationId.slice("evaluation:".length)
  )
    throw new Error("paper-evaluation-identity-mismatch");
  if (
    /CURRENT/i.test(input.oddsPartitionKey) ||
    /CURRENT/i.test(input.oddsSortKey) ||
    !input.oddsSortKey.endsWith(input.oddsSnapshotId)
  )
    throw new Error("odds-reference-invalid");
  if (
    !/^\d{6}#\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z#\d{12}#[0-9a-f]+#\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z#result:[a-f0-9]{64}$/.test(
      input.resultAuthority,
    ) ||
    !input.resultAuthority.endsWith(`#${input.resultObservationId}`)
  )
    throw new Error("result-authority-invalid");
  const gradeId = paperGradeIdentity(input);
  if (input.gradeId !== undefined && input.gradeId !== gradeId)
    throw new Error("grade-id-invalid");
  if (input.supersedesGradeId === gradeId)
    throw new Error("grade-supersession-invalid");
  if (
    !Number.isFinite(Date.parse(input.gradedAt)) ||
    new Date(input.gradedAt).toISOString() !== input.gradedAt
  )
    throw new Error("grade-time-invalid");
  return Object.freeze({
    gradeId,
    paperBetId: text(input.paperBetId, "paper-bet-id"),
    evaluationId: text(input.evaluationId, "evaluation-id"),
    eventId: text(input.eventId, "event-id"),
    resultObservationId: text(input.resultObservationId, "result-id"),
    resultAuthority: text(input.resultAuthority, "result-authority"),
    oddsPartitionKey: text(input.oddsPartitionKey, "odds-pk"),
    oddsSortKey: text(input.oddsSortKey, "odds-sk"),
    oddsSnapshotId: text(input.oddsSnapshotId, "odds-id"),
    outcome,
    reason: input.reason,
    profit,
    payout,
    roi,
    ...(input.supersedesGradeId !== undefined
      ? { supersedesGradeId: input.supersedesGradeId }
      : {}),
    correctionOrdinal: input.correctionOrdinal,
    gradedAt: input.gradedAt,
    stake: 1,
    policyVersion: "paper-grading-v1",
  });
}
export function normalizePaperGradeRecord(value: unknown): PaperGradeRecord {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("grade-record-invalid");
  const record = value as Record<string, unknown>,
    keys = [
      "gradeId",
      "paperBetId",
      "evaluationId",
      "eventId",
      "resultObservationId",
      "resultAuthority",
      "oddsPartitionKey",
      "oddsSortKey",
      "oddsSnapshotId",
      "outcome",
      "reason",
      "stake",
      "profit",
      "payout",
      "roi",
      "correctionOrdinal",
      "gradedAt",
      "policyVersion",
      ...(Object.hasOwn(record, "supersedesGradeId")
        ? ["supersedesGradeId"]
        : []),
    ];
  if (
    Object.keys(record).length !== keys.length ||
    Object.keys(record).some((key) => !keys.includes(key)) ||
    record["stake"] !== 1 ||
    record["policyVersion"] !== "paper-grading-v1"
  )
    throw new Error("grade-record-invalid");
  return createPaperGrade({
    gradeId: record["gradeId"] as string,
    paperBetId: record["paperBetId"] as string,
    evaluationId: record["evaluationId"] as string,
    eventId: record["eventId"] as string,
    resultObservationId: record["resultObservationId"] as string,
    resultAuthority: record["resultAuthority"] as string,
    oddsPartitionKey: record["oddsPartitionKey"] as string,
    oddsSortKey: record["oddsSortKey"] as string,
    oddsSnapshotId: record["oddsSnapshotId"] as string,
    outcome: record["outcome"] as PaperGradeOutcome,
    reason: record["reason"] as PaperGradeReason,
    profit: record["profit"] as number,
    payout: record["payout"] as number,
    roi: record["roi"] as number,
    ...(record["supersedesGradeId"] !== undefined
      ? { supersedesGradeId: record["supersedesGradeId"] as string }
      : {}),
    correctionOrdinal: record["correctionOrdinal"] as number,
    gradedAt: record["gradedAt"] as string,
  });
}
