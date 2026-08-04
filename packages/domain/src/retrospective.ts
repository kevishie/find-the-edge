import { sha256Hex } from "./fixture-odds.js";
import { stableCohortValue } from "./cohort.js";

export const RETROSPECTIVE_TAXONOMY = [
  "data",
  "price",
  "model",
  "rule",
  "execution",
  "false-positive",
  "false-negative",
  "evidence-gap",
] as const;
export type RetrospectiveTaxonomyCode = (typeof RETROSPECTIVE_TAXONOMY)[number];
export type RetrospectiveEvidenceLayer = "decision-time" | "post-decision";
export type RetrospectiveState =
  "draft" | "changes-requested" | "approved" | "rejected";

export interface RetrospectiveEvidenceRef {
  readonly id: string;
  readonly kind: string;
  readonly layer: RetrospectiveEvidenceLayer;
  /** The immutable decision instant this evidence is classified against. */
  readonly decisionCutoff: string;
  readonly observedAt: string;
  readonly digest: string;
}
export interface RetrospectiveEvidenceManifest {
  readonly evaluationCutoff: string;
  readonly decisionTime: readonly RetrospectiveEvidenceRef[];
  readonly postDecision: readonly RetrospectiveEvidenceRef[];
  readonly decisionTimeDigest: string;
  readonly postDecisionDigest: string;
  readonly manifestDigest: string;
}
export interface RetrospectiveSlice {
  readonly dimension: "outcome" | "sport" | "league" | "market";
  readonly value: string;
  readonly memberCount: number;
  readonly wins: number;
  readonly losses: number;
  readonly pushes: number;
  readonly voids: number;
  readonly unresolved: number;
  readonly units: number | null;
  readonly roi: number | null;
}
export interface RetrospectiveObservation {
  readonly id: string;
  readonly taxonomyCode: RetrospectiveTaxonomyCode;
  readonly layer: RetrospectiveEvidenceLayer;
  readonly summary: string;
  readonly evidenceRefIds: readonly string[];
  readonly memberIds: readonly string[];
  readonly confidence: "review-only" | "not-evaluable";
}
export interface RetrospectiveCandidate {
  readonly candidateId: string;
  readonly kind: "data" | "prompt" | "strategy";
  readonly summary: string;
  readonly sourceObservationIds: readonly string[];
  readonly predecessorCandidateId: string | null;
  readonly executable: false;
}
export interface RetrospectiveVersion {
  readonly retrospectiveId: string;
  readonly versionId: string;
  readonly version: number;
  readonly predecessorVersionId: string | null;
  readonly cohortId: string;
  readonly reportId: string;
  readonly reportRevision: number;
  readonly createdAt: string;
  readonly state: RetrospectiveState;
  readonly stateVersion: number;
  readonly taxonomyVersion: "retrospective-taxonomy-v1";
  readonly evidence: RetrospectiveEvidenceManifest;
  readonly slices: readonly RetrospectiveSlice[];
  readonly observations: readonly RetrospectiveObservation[];
  readonly candidates: readonly RetrospectiveCandidate[];
  readonly memberCount: number;
  readonly caution: "single-member" | "small-sample" | "standard";
  readonly falseNegativeEvaluation: "not-evaluable";
  readonly contentDigest: string;
}
export interface RetrospectiveReviewDecision {
  readonly decisionId: string;
  readonly retrospectiveId: string;
  readonly versionId: string;
  readonly fromState: RetrospectiveState;
  readonly toState: RetrospectiveState;
  readonly stateVersion: number;
  readonly reviewerId: string;
  readonly reasonCode: "approve" | "reject" | "request-changes";
  readonly note: string | null;
  readonly decidedAt: string;
  readonly idempotencyKey: string;
}

const iso = (value: string) =>
  Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const safeId = (value: string) =>
  value.length > 0 && value.length <= 256 && value === value.trim();
const safeText = (value: string, max: number) =>
  value.length > 0 && value.length <= max && value === value.trim();
const digest = (value: unknown) => sha256Hex(stableCohortValue(value));
const frozenSorted = <T extends RetrospectiveEvidenceRef>(
  items: readonly T[],
) =>
  Object.freeze(
    [...items]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((item) => Object.freeze({ ...item })),
  );

export function freezeRetrospectiveEvidence(input: {
  readonly evaluationCutoff: string;
  readonly refs: readonly RetrospectiveEvidenceRef[];
}): RetrospectiveEvidenceManifest {
  if (!iso(input.evaluationCutoff))
    throw new Error("retrospective-cutoff-invalid");
  if (new Set(input.refs.map((ref) => ref.id)).size !== input.refs.length)
    throw new Error("retrospective-evidence-duplicate");
  for (const ref of input.refs) {
    if (
      !safeId(ref.id) ||
      !safeId(ref.kind) ||
      !iso(ref.decisionCutoff) ||
      !iso(ref.observedAt) ||
      !/^[a-f0-9]{64}$/.test(ref.digest) ||
      !["decision-time", "post-decision"].includes(ref.layer)
    )
      throw new Error("retrospective-evidence-invalid");
    if (ref.decisionCutoff > input.evaluationCutoff)
      throw new Error("retrospective-decision-cutoff-after-evaluation-cutoff");
    if (ref.observedAt > input.evaluationCutoff)
      throw new Error("retrospective-evidence-after-evaluation-cutoff");
    if (ref.layer === "decision-time" && ref.observedAt > ref.decisionCutoff)
      throw new Error("retrospective-decision-evidence-after-cutoff");
    if (ref.layer === "post-decision" && ref.observedAt <= ref.decisionCutoff)
      throw new Error("retrospective-post-evidence-before-decision-cutoff");
  }
  const decisionTime = frozenSorted(
      input.refs.filter((ref) => ref.layer === "decision-time"),
    ),
    postDecision = frozenSorted(
      input.refs.filter((ref) => ref.layer === "post-decision"),
    ),
    decisionTimeDigest = digest(decisionTime),
    postDecisionDigest = digest(postDecision);
  return Object.freeze({
    evaluationCutoff: input.evaluationCutoff,
    decisionTime,
    postDecision,
    decisionTimeDigest,
    postDecisionDigest,
    manifestDigest: digest({
      evaluationCutoff: input.evaluationCutoff,
      decisionTimeDigest,
      postDecisionDigest,
    }),
  });
}

export function createRetrospectiveVersion(input: {
  readonly cohortId: string;
  readonly reportId: string;
  readonly reportRevision: number;
  readonly version: number;
  readonly predecessorVersionId?: string | null;
  readonly createdAt: string;
  readonly evidence: RetrospectiveEvidenceManifest;
  readonly slices: readonly RetrospectiveSlice[];
  readonly observations: readonly RetrospectiveObservation[];
  readonly candidates: readonly Omit<
    RetrospectiveCandidate,
    "candidateId" | "executable"
  >[];
  readonly memberCount: number;
}): RetrospectiveVersion {
  if (
    !/^cohort:[a-f0-9]{64}$/.test(input.cohortId) ||
    !/^performance-report:[a-f0-9]{64}$/.test(input.reportId) ||
    !Number.isSafeInteger(input.reportRevision) ||
    input.reportRevision < 1 ||
    !Number.isSafeInteger(input.version) ||
    input.version < 1 ||
    !iso(input.createdAt) ||
    !Number.isSafeInteger(input.memberCount) ||
    input.memberCount < 1 ||
    (input.version === 1 && input.predecessorVersionId) ||
    (input.version > 1 &&
      !/^retrospective-version:[a-f0-9]{64}$/.test(
        input.predecessorVersionId ?? "",
      ))
  )
    throw new Error("retrospective-version-input-invalid");
  const evidence = freezeRetrospectiveEvidence({
    evaluationCutoff: input.evidence.evaluationCutoff,
    refs: [...input.evidence.decisionTime, ...input.evidence.postDecision],
  });
  if (evidence.manifestDigest !== input.evidence.manifestDigest)
    throw new Error("retrospective-evidence-digest-mismatch");
  const evidenceIds = new Set(
    [...evidence.decisionTime, ...evidence.postDecision].map((ref) => ref.id),
  );
  const observations = [...input.observations]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((observation) => {
      if (
        !safeId(observation.id) ||
        !RETROSPECTIVE_TAXONOMY.includes(observation.taxonomyCode) ||
        !safeText(observation.summary, 500) ||
        !["decision-time", "post-decision"].includes(observation.layer) ||
        !["review-only", "not-evaluable"].includes(observation.confidence) ||
        (observation.evidenceRefIds.length === 0 &&
          observation.taxonomyCode !== "false-negative") ||
        new Set(observation.evidenceRefIds).size !==
          observation.evidenceRefIds.length ||
        observation.evidenceRefIds.some((id) => !evidenceIds.has(id)) ||
        observation.memberIds.some((id) => !safeId(id)) ||
        new Set(observation.memberIds).size !== observation.memberIds.length ||
        (observation.layer === "decision-time" &&
          observation.evidenceRefIds.some((id) =>
            evidence.postDecision.some((ref) => ref.id === id),
          )) ||
        (observation.layer === "post-decision" &&
          observation.evidenceRefIds.some((id) =>
            evidence.decisionTime.some((ref) => ref.id === id),
          )) ||
        (observation.taxonomyCode === "false-negative" &&
          observation.confidence !== "not-evaluable")
      )
        throw new Error("retrospective-observation-invalid");
      return Object.freeze({
        ...observation,
        evidenceRefIds: Object.freeze([...observation.evidenceRefIds].sort()),
        memberIds: Object.freeze([...observation.memberIds].sort()),
      });
    });
  if (new Set(observations.map((item) => item.id)).size !== observations.length)
    throw new Error("retrospective-observation-duplicate");
  const observationIds = new Set(observations.map((item) => item.id));
  const candidates = [...input.candidates]
    .map((candidate) => {
      if (
        !["data", "prompt", "strategy"].includes(candidate.kind) ||
        !safeText(candidate.summary, 500) ||
        candidate.sourceObservationIds.length === 0 ||
        new Set(candidate.sourceObservationIds).size !==
          candidate.sourceObservationIds.length ||
        candidate.sourceObservationIds.some((id) => !observationIds.has(id)) ||
        (candidate.predecessorCandidateId !== null &&
          !/^retrospective-candidate:[a-f0-9]{64}$/.test(
            candidate.predecessorCandidateId,
          ))
      )
        throw new Error("retrospective-candidate-invalid");
      const material = {
        kind: candidate.kind,
        summary: candidate.summary,
        sourceObservationIds: [...candidate.sourceObservationIds].sort(),
        predecessorCandidateId: candidate.predecessorCandidateId,
      };
      return Object.freeze({
        ...material,
        candidateId: `retrospective-candidate:${digest(material)}`,
        executable: false as const,
      });
    })
    .sort((a, b) => a.candidateId.localeCompare(b.candidateId));
  if (
    new Set(candidates.map((candidate) => candidate.candidateId)).size !==
    candidates.length
  )
    throw new Error("retrospective-candidate-duplicate");
  const slices = [...input.slices].sort(
    (a, b) =>
      a.dimension.localeCompare(b.dimension) || a.value.localeCompare(b.value),
  );
  for (const slice of slices)
    if (
      !["outcome", "sport", "league", "market"].includes(slice.dimension) ||
      !safeText(slice.value, 128) ||
      ![
        slice.memberCount,
        slice.wins,
        slice.losses,
        slice.pushes,
        slice.voids,
        slice.unresolved,
      ].every((count) => Number.isSafeInteger(count) && count >= 0) ||
      slice.wins +
        slice.losses +
        slice.pushes +
        slice.voids +
        slice.unresolved !==
        slice.memberCount ||
      (slice.units !== null && !Number.isFinite(slice.units)) ||
      (slice.roi !== null && !Number.isFinite(slice.roi))
    )
      throw new Error("retrospective-slice-invalid");
  if (
    new Set(slices.map((slice) => `${slice.dimension}:${slice.value}`)).size !==
    slices.length
  )
    throw new Error("retrospective-slice-duplicate");
  const retrospectiveId = `retrospective:${digest({ cohortId: input.cohortId })}`;
  const content = {
    retrospectiveId,
    version: input.version,
    predecessorVersionId: input.predecessorVersionId ?? null,
    cohortId: input.cohortId,
    reportId: input.reportId,
    reportRevision: input.reportRevision,
    evidence,
    slices,
    observations,
    candidates,
    memberCount: input.memberCount,
    caution:
      input.memberCount === 1
        ? ("single-member" as const)
        : input.memberCount < 30
          ? ("small-sample" as const)
          : ("standard" as const),
    falseNegativeEvaluation: "not-evaluable" as const,
    taxonomyVersion: "retrospective-taxonomy-v1" as const,
  };
  const contentDigest = digest(content),
    versionId = `retrospective-version:${digest({ retrospectiveId, version: input.version, contentDigest })}`;
  return Object.freeze({
    ...content,
    versionId,
    createdAt: input.createdAt,
    state: "draft",
    stateVersion: 1,
    contentDigest,
  });
}

export function transitionRetrospective(
  version: RetrospectiveVersion,
  input: {
    readonly reviewerId: string;
    readonly reasonCode: RetrospectiveReviewDecision["reasonCode"];
    readonly note?: string | null;
    readonly decidedAt: string;
    readonly idempotencyKey: string;
    readonly expectedState: RetrospectiveState;
    readonly expectedStateVersion: number;
  },
): {
  readonly version: RetrospectiveVersion;
  readonly decision: RetrospectiveReviewDecision;
} {
  if (
    !safeId(input.reviewerId) ||
    !safeId(input.idempotencyKey) ||
    !iso(input.decidedAt) ||
    (input.note != null && input.note.length > 1000) ||
    input.expectedState !== version.state ||
    input.expectedStateVersion !== version.stateVersion ||
    !["approve", "reject", "request-changes"].includes(input.reasonCode) ||
    !["draft", "changes-requested", "approved", "rejected"].includes(
      input.expectedState,
    )
  )
    throw new Error("retrospective-review-conflict");
  const toState: RetrospectiveState =
    input.reasonCode === "approve"
      ? "approved"
      : input.reasonCode === "reject"
        ? "rejected"
        : "changes-requested";
  if (version.state !== "draft")
    throw new Error("retrospective-transition-invalid");
  const stateVersion = version.stateVersion + 1;
  const decisionMaterial = {
    retrospectiveId: version.retrospectiveId,
    versionId: version.versionId,
    fromState: version.state,
    toState,
    stateVersion,
    reviewerId: input.reviewerId,
    reasonCode: input.reasonCode,
    note: input.note ?? null,
    decidedAt: input.decidedAt,
    idempotencyKey: input.idempotencyKey,
  };
  return {
    version: Object.freeze({ ...version, state: toState, stateVersion }),
    decision: Object.freeze({
      ...decisionMaterial,
      decisionId: `retrospective-decision:${digest(decisionMaterial)}`,
    }),
  };
}

/** Rebuilds immutable identity/content and validates the separate review state. */
export function validateRetrospectiveVersion(
  value: RetrospectiveVersion,
): RetrospectiveVersion {
  const rebuilt = createRetrospectiveVersion({
    cohortId: value.cohortId,
    reportId: value.reportId,
    reportRevision: value.reportRevision,
    version: value.version,
    predecessorVersionId: value.predecessorVersionId,
    createdAt: value.createdAt,
    evidence: value.evidence,
    slices: value.slices,
    observations: value.observations,
    candidates: value.candidates.map(
      ({ kind, summary, sourceObservationIds, predecessorCandidateId }) => ({
        kind,
        summary,
        sourceObservationIds,
        predecessorCandidateId,
      }),
    ),
    memberCount: value.memberCount,
  });
  if (!(
    (value.state === "draft" && value.stateVersion === 1) ||
    (["approved", "rejected", "changes-requested"].includes(value.state) &&
      value.stateVersion === 2)
  ))
    throw new Error("retrospective-state-corrupt");
  const expected = {
    ...rebuilt,
    state: value.state,
    stateVersion: value.stateVersion,
  };
  if (stableCohortValue(expected) !== stableCohortValue(value))
    throw new Error("retrospective-version-corrupt");
  return Object.freeze(value);
}
