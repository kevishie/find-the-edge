import {
  createRetrospectiveVersion,
  type RetrospectiveEvidenceManifest,
  type RetrospectiveObservation,
  type RetrospectiveSlice,
  type RetrospectiveVersion,
} from "@find-the-edge/domain";

export interface RetrospectiveMemberReview {
  readonly memberId: string;
  readonly sport: string;
  readonly league: string;
  readonly market: string;
  readonly outcome: "won" | "lost" | "push" | "void" | "unresolved";
  readonly profit: number | null;
  readonly evidenceRefIds: readonly string[];
}
const summarize = (
  dimension: RetrospectiveSlice["dimension"],
  value: string,
  members: readonly RetrospectiveMemberReview[],
  authoritative?: {
    readonly units: number | null;
    readonly roi: number | null;
  },
): RetrospectiveSlice => ({
  dimension,
  value,
  memberCount: members.length,
  wins: members.filter((m) => m.outcome === "won").length,
  losses: members.filter((m) => m.outcome === "lost").length,
  pushes: members.filter((m) => m.outcome === "push").length,
  voids: members.filter((m) => m.outcome === "void").length,
  unresolved: members.filter((m) => m.outcome === "unresolved").length,
  units: authoritative?.units ?? null,
  roi: authoritative?.roi ?? null,
});
const values = (
  members: readonly RetrospectiveMemberReview[],
  select: (m: RetrospectiveMemberReview) => string,
) => [...new Set(members.map(select))].sort();

/** Pure review construction. It labels opportunities, never causal errors. */
export function buildRetrospective(input: {
  readonly cohortId: string;
  readonly reportId: string;
  readonly reportRevision: number;
  readonly version: number;
  readonly predecessorVersionId?: string | null;
  readonly createdAt: string;
  readonly evidence: RetrospectiveEvidenceManifest;
  readonly members: readonly RetrospectiveMemberReview[];
  readonly reportMetrics: {
    readonly units: number;
    readonly roi: number | null;
  };
}): RetrospectiveVersion {
  if (!input.members.length) throw new Error("retrospective-members-empty");
  const members = [...input.members].sort((a, b) =>
    a.memberId.localeCompare(b.memberId),
  );
  if (new Set(members.map((m) => m.memberId)).size !== members.length)
    throw new Error("retrospective-member-duplicate");
  const slices: RetrospectiveSlice[] = [
    summarize("outcome", "all", members, input.reportMetrics),
    ...values(members, (m) => m.sport).map((value) =>
      summarize(
        "sport",
        value,
        members.filter((m) => m.sport === value),
      ),
    ),
    ...values(members, (m) => m.league).map((value) =>
      summarize(
        "league",
        value,
        members.filter((m) => m.league === value),
      ),
    ),
    ...values(members, (m) => m.market).map((value) =>
      summarize(
        "market",
        value,
        members.filter((m) => m.market === value),
      ),
    ),
  ];
  const postIds = new Set(input.evidence.postDecision.map((ref) => ref.id));
  const observations: RetrospectiveObservation[] = [];
  // A losing result is an outcome, not evidence that the original decision was
  // a false positive. That taxonomy label requires an independently cited
  // review signal, which this deterministic report does not manufacture.
  const unresolved = members.filter((m) => m.outcome === "unresolved");
  const unresolvedRefs = [
    ...new Set(
      unresolved
        .flatMap((m) => m.evidenceRefIds)
        .filter((id) => postIds.has(id)),
    ),
  ].sort();
  if (unresolvedRefs.length)
    observations.push({
      id: "unresolved-evidence-review",
      taxonomyCode: "evidence-gap",
      layer: "post-decision",
      summary: `${unresolved.length} member${unresolved.length === 1 ? " has" : "s have"} unresolved outcome evidence.`,
      evidenceRefIds: unresolvedRefs,
      memberIds: unresolved.map((m) => m.memberId),
      confidence: "review-only",
    });
  observations.push({
    id: "false-negative-unavailable",
    taxonomyCode: "false-negative",
    layer: "decision-time",
    summary:
      "False-negative review is not evaluable because this cohort has no frozen non-play universe.",
    // This statement is a cohort-policy limitation, not a claim supported by
    // an arbitrary member's evaluation evidence.
    evidenceRefIds: [],
    memberIds: [],
    confidence: "not-evaluable",
  });
  return createRetrospectiveVersion({
    ...input,
    slices,
    observations,
    candidates: [],
    memberCount: members.length,
  });
}
