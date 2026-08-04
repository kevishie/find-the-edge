import { sha256Hex } from "./fixture-odds.js";
import { stableCohortValue } from "./cohort.js";

export type StrategyExperimentState =
  "failed" | "awaiting-approval" | "approved" | "active" | "superseded";
export type StrategyMetric =
  | "sample"
  | "roi"
  | "roi-lower-bound"
  | "clv"
  | "calibration-error"
  | "drawdown"
  | "baseline-regression";

export interface StrategyArtifact {
  readonly strategyId: string;
  readonly version: string;
  readonly digest: string;
  readonly deployedRevision: string;
  readonly deployed: true;
  readonly frozenAt: string;
}
export interface ExperimentWindow {
  readonly startsAt: string;
  readonly endsAt: string;
  readonly eventIds: readonly string[];
  readonly memberIds: readonly string[];
  readonly digest: string;
}
export interface StrategyPerformanceEvidence {
  readonly strategy: StrategyArtifact;
  readonly reportId: string;
  readonly reportRevision: number;
  readonly eventIds: readonly string[];
  readonly memberIds: readonly string[];
  readonly resultEvidenceIds: readonly string[];
  readonly metrics: Readonly<Partial<Record<StrategyMetric, number>>>;
  readonly digest: string;
}
export interface PromotionGateRule {
  readonly metric: StrategyMetric;
  readonly operator: "gte" | "gt" | "lte" | "lt";
  readonly threshold: number;
}
export interface PromotionGatePolicy {
  readonly id: string;
  readonly version: string;
  readonly rules: readonly PromotionGateRule[];
  readonly digest: string;
}
export interface PromotionGateResult extends PromotionGateRule {
  readonly actual: number | null;
  readonly passed: boolean;
  readonly reason: "passed" | "boundary-failed" | "metric-unavailable";
}
export interface StrategyExperiment {
  readonly experimentId: string;
  readonly baseline: StrategyArtifact;
  readonly challenger: StrategyArtifact;
  readonly train: ExperimentWindow;
  readonly tune: ExperimentWindow;
  readonly holdout: ExperimentWindow;
  readonly baselineEvidence: StrategyPerformanceEvidence;
  readonly challengerEvidence: StrategyPerformanceEvidence;
  readonly policy: PromotionGatePolicy;
  readonly gates: readonly PromotionGateResult[];
  readonly lineageDigests: readonly string[];
  readonly createdAt: string;
  readonly state: StrategyExperimentState;
  readonly stateVersion: number;
  readonly failureReasons: readonly string[];
  readonly contentDigest: string;
}
export interface StrategyPromotionDecision {
  readonly decisionId: string;
  readonly experimentId: string;
  readonly experimentDigest: string;
  readonly artifactDigest: string;
  readonly fromState: "awaiting-approval";
  readonly toState: "approved";
  readonly promoterId: string;
  readonly reason: string;
  readonly decidedAt: string;
  readonly idempotencyKey: string;
  readonly stateVersion: number;
}
export interface StrategyActivation {
  readonly activationId: string;
  readonly strategyId: string;
  readonly artifactVersion: string;
  readonly artifactDigest: string;
  readonly experimentId: string;
  readonly kind: "promotion" | "rollback";
  readonly effectiveAt: string;
  readonly actorId: string;
  readonly reason: string;
  readonly idempotencyKey: string;
  readonly predecessorActivationId: string | null;
}

const hash = (value: unknown) => sha256Hex(stableCohortValue(value));
const isIso = (value: string) =>
  Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const safe = (value: string, max = 256) =>
  value.length > 0 && value.length <= max && value.trim() === value;
const digestPattern = /^[a-f0-9]{64}$/;
const sortedUnique = (items: readonly string[]) => {
  if (items.some((item) => !safe(item)) || new Set(items).size !== items.length)
    throw new Error("strategy-experiment-manifest-invalid");
  return Object.freeze([...items].sort());
};

export function validateStrategyArtifact(value: StrategyArtifact) {
  if (
    !safe(value.strategyId, 128) ||
    !safe(value.version, 128) ||
    !digestPattern.test(value.digest) ||
    !safe(value.deployedRevision, 128) ||
    value.deployed !== true ||
    !isIso(value.frozenAt)
  )
    throw new Error("strategy-artifact-invalid");
  return Object.freeze({ ...value });
}

export function freezeExperimentWindow(input: {
  startsAt: string;
  endsAt: string;
  eventIds: readonly string[];
  memberIds: readonly string[];
}): ExperimentWindow {
  if (
    !isIso(input.startsAt) ||
    !isIso(input.endsAt) ||
    input.startsAt >= input.endsAt
  )
    throw new Error("strategy-experiment-window-invalid");
  const material = {
    startsAt: input.startsAt,
    endsAt: input.endsAt,
    eventIds: sortedUnique(input.eventIds),
    memberIds: sortedUnique(input.memberIds),
  };
  return Object.freeze({ ...material, digest: hash(material) });
}

export function freezeStrategyEvidence(
  input: Omit<StrategyPerformanceEvidence, "digest">,
): StrategyPerformanceEvidence {
  const strategy = validateStrategyArtifact(input.strategy);
  if (
    !/^performance-report:[a-f0-9]{64}$/.test(input.reportId) ||
    !Number.isSafeInteger(input.reportRevision) ||
    input.reportRevision < 1 ||
    Object.values(input.metrics).some((metric) => !Number.isFinite(metric))
  )
    throw new Error("strategy-evidence-invalid");
  const material = {
    strategy,
    reportId: input.reportId,
    reportRevision: input.reportRevision,
    eventIds: sortedUnique(input.eventIds),
    memberIds: sortedUnique(input.memberIds),
    resultEvidenceIds: sortedUnique(input.resultEvidenceIds),
    metrics: Object.freeze(
      Object.fromEntries(Object.entries(input.metrics).sort()),
    ),
  };
  return Object.freeze({ ...material, digest: hash(material) });
}

export function freezePromotionPolicy(
  input: Omit<PromotionGatePolicy, "digest">,
) {
  const required: StrategyMetric[] = [
    "sample",
    "roi",
    "roi-lower-bound",
    "clv",
    "calibration-error",
    "drawdown",
    "baseline-regression",
  ];
  if (
    !safe(input.id, 128) ||
    !safe(input.version, 128) ||
    input.rules.length !== required.length
  )
    throw new Error("promotion-policy-invalid");
  const rules = [...input.rules].sort((a, b) =>
    a.metric.localeCompare(b.metric),
  );
  if (
    new Set(rules.map((rule) => rule.metric)).size !== rules.length ||
    required.some((metric) => !rules.some((rule) => rule.metric === metric)) ||
    rules.some(
      (rule) =>
        !["gte", "gt", "lte", "lt"].includes(rule.operator) ||
        !Number.isFinite(rule.threshold),
    )
  )
    throw new Error("promotion-policy-invalid");
  const material = {
    id: input.id,
    version: input.version,
    rules: Object.freeze(rules.map((rule) => Object.freeze({ ...rule }))),
  };
  return Object.freeze({ ...material, digest: hash(material) });
}

export function evaluatePromotionGates(
  policy: PromotionGatePolicy,
  metrics: Readonly<Partial<Record<StrategyMetric, number>>>,
) {
  return Object.freeze(
    policy.rules.map((rule): PromotionGateResult => {
      const actual = metrics[rule.metric];
      if (actual === undefined || !Number.isFinite(actual))
        return Object.freeze({
          ...rule,
          actual: null,
          passed: false,
          reason: "metric-unavailable",
        });
      const passed =
        rule.operator === "gte"
          ? actual >= rule.threshold
          : rule.operator === "gt"
            ? actual > rule.threshold
            : rule.operator === "lte"
              ? actual <= rule.threshold
              : actual < rule.threshold;
      return Object.freeze({
        ...rule,
        actual,
        passed,
        reason: passed ? "passed" : "boundary-failed",
      });
    }),
  );
}

const intersects = (left: readonly string[], right: readonly string[]) =>
  left.some((value) => right.includes(value));
export function createStrategyExperiment(input: {
  baseline: StrategyArtifact;
  challenger: StrategyArtifact;
  train: ExperimentWindow;
  tune: ExperimentWindow;
  holdout: ExperimentWindow;
  baselineEvidence: StrategyPerformanceEvidence;
  challengerEvidence: StrategyPerformanceEvidence;
  policy: PromotionGatePolicy;
  priorEvidenceDigests: readonly string[];
  lineageDigests?: readonly string[];
  createdAt: string;
}): StrategyExperiment {
  if (!isIso(input.createdAt))
    throw new Error("strategy-experiment-created-at-invalid");
  const baseline = validateStrategyArtifact(input.baseline),
    challenger = validateStrategyArtifact(input.challenger);
  const failures: string[] = [];
  if (!(
    input.train.endsAt <= input.tune.startsAt &&
    input.tune.endsAt <= input.holdout.startsAt
  ))
    failures.push("window-chronology");
  for (const [left, right] of [
    [input.train, input.tune],
    [input.train, input.holdout],
    [input.tune, input.holdout],
  ] as const)
    if (
      intersects(left.eventIds, right.eventIds) ||
      intersects(left.memberIds, right.memberIds)
    )
      failures.push("window-overlap");
  if (challenger.frozenAt > input.holdout.startsAt)
    failures.push("challenger-frozen-late");
  if (
    stableCohortValue(input.baselineEvidence.eventIds) !==
      stableCohortValue(input.holdout.eventIds) ||
    stableCohortValue(input.challengerEvidence.eventIds) !==
      stableCohortValue(input.holdout.eventIds)
  )
    failures.push("holdout-universe-mismatch");
  if (
    stableCohortValue(input.baselineEvidence.memberIds) !==
      stableCohortValue(input.holdout.memberIds) ||
    stableCohortValue(input.challengerEvidence.memberIds) !==
      stableCohortValue(input.holdout.memberIds) ||
    stableCohortValue(input.baselineEvidence.memberIds) !==
      stableCohortValue(input.challengerEvidence.memberIds)
  )
    failures.push("holdout-member-manifest-mismatch");
  if (
    input.baselineEvidence.strategy.digest !== baseline.digest ||
    input.challengerEvidence.strategy.digest !== challenger.digest
  )
    failures.push("strategy-evidence-mismatch");
  if (
    !input.baselineEvidence.resultEvidenceIds.length ||
    !input.challengerEvidence.resultEvidenceIds.length ||
    stableCohortValue(input.baselineEvidence.resultEvidenceIds) !==
      stableCohortValue(input.challengerEvidence.resultEvidenceIds)
  )
    failures.push("result-evidence-mismatch");
  if (input.priorEvidenceDigests.includes(input.holdout.digest))
    failures.push("holdout-evidence-reused");
  if (input.priorEvidenceDigests.includes(input.tune.digest))
    failures.push("tune-evidence-reused");
  const gates = evaluatePromotionGates(
    input.policy,
    input.challengerEvidence.metrics,
  );
  const lineageDigests = sortedUnique([
    ...(input.lineageDigests ?? []),
    input.tune.digest,
    input.holdout.digest,
  ]);
  const material = {
    baseline,
    challenger,
    train: input.train,
    tune: input.tune,
    holdout: input.holdout,
    baselineEvidence: input.baselineEvidence,
    challengerEvidence: input.challengerEvidence,
    policy: input.policy,
    gates,
    lineageDigests,
    failureReasons: Object.freeze([...new Set(failures)].sort()),
  };
  const contentDigest = hash(material),
    experimentId = `strategy-experiment:${hash({ contentDigest })}`;
  const state =
    failures.length || gates.some((gate) => !gate.passed)
      ? "failed"
      : "awaiting-approval";
  return Object.freeze({
    ...material,
    experimentId,
    createdAt: input.createdAt,
    state,
    stateVersion: 1,
    failureReasons: material.failureReasons,
    contentDigest,
  });
}

export function approveStrategyExperiment(
  experiment: StrategyExperiment,
  input: {
    promoterId: string;
    reason: string;
    decidedAt: string;
    idempotencyKey: string;
    expectedStateVersion: number;
    expectedDigest: string;
    artifactDigest: string;
  },
): { experiment: StrategyExperiment; decision: StrategyPromotionDecision } {
  if (
    experiment.state !== "awaiting-approval" ||
    experiment.stateVersion !== input.expectedStateVersion ||
    experiment.contentDigest !== input.expectedDigest ||
    experiment.challenger.digest !== input.artifactDigest
  )
    throw new Error("strategy-promotion-conflict");
  if (
    !safe(input.promoterId) ||
    !safe(input.reason, 1000) ||
    !safe(input.idempotencyKey, 128) ||
    !isIso(input.decidedAt)
  )
    throw new Error("strategy-promotion-request-invalid");
  const decisionMaterial = {
    experimentId: experiment.experimentId,
    experimentDigest: experiment.contentDigest,
    artifactDigest: input.artifactDigest,
    fromState: "awaiting-approval" as const,
    toState: "approved" as const,
    promoterId: input.promoterId,
    reason: input.reason,
    decidedAt: input.decidedAt,
    idempotencyKey: input.idempotencyKey,
    stateVersion: experiment.stateVersion + 1,
  };
  return {
    experiment: Object.freeze({
      ...experiment,
      state: "approved",
      stateVersion: experiment.stateVersion + 1,
    }),
    decision: Object.freeze({
      ...decisionMaterial,
      decisionId: `strategy-decision:${hash(decisionMaterial)}`,
    }),
  };
}

export function createStrategyActivation(
  input: Omit<StrategyActivation, "activationId"> & {
    artifact: StrategyArtifact;
    approvedArtifactDigests: readonly string[];
  },
): StrategyActivation {
  validateStrategyArtifact(input.artifact);
  if (
    !input.approvedArtifactDigests.includes(input.artifact.digest) ||
    input.artifact.digest !== input.artifactDigest ||
    input.artifact.version !== input.artifactVersion ||
    input.artifact.strategyId !== input.strategyId
  )
    throw new Error("strategy-activation-artifact-not-approved");
  if (
    !isIso(input.effectiveAt) ||
    !safe(input.actorId) ||
    !safe(input.reason, 1000) ||
    !safe(input.idempotencyKey, 128) ||
    (input.predecessorActivationId !== null &&
      !/^strategy-activation:[a-f0-9]{64}$/.test(input.predecessorActivationId))
  )
    throw new Error("strategy-activation-invalid");
  const material = {
    strategyId: input.strategyId,
    artifactVersion: input.artifactVersion,
    artifactDigest: input.artifactDigest,
    experimentId: input.experimentId,
    kind: input.kind,
    effectiveAt: input.effectiveAt,
    actorId: input.actorId,
    reason: input.reason,
    idempotencyKey: input.idempotencyKey,
    predecessorActivationId: input.predecessorActivationId,
  };
  return Object.freeze({
    ...material,
    activationId: `strategy-activation:${hash(material)}`,
  });
}
