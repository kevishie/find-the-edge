import type {
  EventStatus,
  GameDisplayDto,
  GameOddsComparisonDto,
  GameOddsSelectionDto,
  EntityId,
  RankedOpportunityDto,
  ProviderStatusPageDto,
  PublicScoutingJob,
} from "@find-the-edge/domain";
import {
  collapseNearDuplicateGames,
  EVENT_LIFECYCLE_STATES,
  normalizeRankedOpportunityDto,
  normalizeProviderStatusPageDto,
  validateEventMetadataAssessment,
  participantSelectionKey,
  SCOUTING_FAILURE_CODES,
  SCOUTING_JOB_STATUSES,
  SCOUTING_MAX_ATTEMPTS,
  SCOUTING_WORKFLOW_INTENT,
  isRetryableScoutingFailure,
} from "@find-the-edge/domain";
import { impliedProbability } from "@find-the-edge/odds";

import type {
  Result,
  RuntimeBootstrap,
  RuntimeConfigError,
} from "./runtime-config";

// The gateway decodes a path parameter exactly once before the Lambda reads
// it, so a canonical event ID is encoded exactly once. Encoding twice escapes
// the percent signs its own inner segments already carry and resolves to a
// different, non-existent event.
const encodeCanonicalEventPathSegment = (eventId: string) =>
  encodeURIComponent(eventId);

export type GamesSport = "mlb" | "soccer";

export interface RankedOpportunityPageDto {
  readonly schemaVersion: "ranked-opportunity-page-v1";
  readonly rankingPolicy: { readonly id: string; readonly version: string };
  readonly items: readonly RankedOpportunityDto[];
  readonly nextCursor: string | null;
  readonly snapshotAt: string;
  readonly evaluationState: "complete" | "partial";
  readonly hasMoreUnknown: boolean;
  readonly evaluatedCount: number;
  readonly filteredCount: number;
  readonly staleCount: number;
  readonly joinFailureCount: number;
}

export interface GamesFilter {
  readonly sport: GamesSport;
  readonly day: string;
  readonly status?: EventStatus | "all";
}

export interface GamesLifecycleCoverage {
  readonly requested: readonly EventStatus[];
  readonly loaded: readonly EventStatus[];
  readonly unavailable: readonly EventStatus[];
}

export interface GamesPageDto {
  readonly items: readonly GameDisplayDto[];
  readonly nextCursor: null;
  readonly projectionState: "ready" | "uninitialized";
  readonly evaluationState: "complete";
  readonly hasMoreUnknown: false;
  readonly snapshotAt: string | null;
  readonly freshness: string | null;
  readonly unavailableReason: "projection-uninitialized" | null;
}

export interface GamesExplorerPageDto extends GamesPageDto {
  readonly lifecycleCoverage?: GamesLifecycleCoverage;
}

interface GamesPartialPageDto extends Omit<
  GamesPageDto,
  "nextCursor" | "evaluationState" | "hasMoreUnknown"
> {
  readonly nextCursor: string;
  readonly evaluationState: "partial";
  readonly hasMoreUnknown: true;
}

type GamesResponsePageDto = GamesPageDto | GamesPartialPageDto;

export interface BettingSplitDto {
  readonly id: string;
  readonly providerId: string;
  readonly providerEventId: string;
  readonly canonicalEventId: string;
  readonly canonicalEventVersion: number;
  readonly sportKey: string;
  readonly leagueKey: string;
  readonly marketKey: string;
  readonly selectionKey: string;
  readonly point?: number;
  readonly americanOdds?: number;
  readonly betPercent?: number;
  readonly moneyPercent?: number;
  readonly betCount?: number;
  readonly moneyAmount?: number;
  readonly providerTimestamp: string;
  readonly retrievedAt: string;
  readonly scope?: string;
}

export interface SplitsPageDto extends Omit<GamesPageDto, "items"> {
  readonly items: readonly (GameDisplayDto & {
    readonly splits: readonly BettingSplitDto[];
  })[];
}

export interface OddsHistoryPointDto {
  readonly observationId: string;
  readonly state: "active" | "suspended" | "unavailable";
  readonly point?: number;
  readonly americanOdds: number;
  readonly impliedProbability: number;
  readonly observedAt: string;
  readonly retrievedAt: string;
  readonly isOpening: boolean;
  readonly isCurrent: boolean;
}

export interface OddsHistorySeriesDto {
  readonly marketKey: string;
  readonly selectionKey: string;
  readonly selectionLabel: string;
  readonly sportsbookId: string;
  readonly sportsbookLabel: string;
  readonly points: readonly OddsHistoryPointDto[];
}

export interface OddsHistoryDto {
  readonly eventId: string;
  readonly generatedAt: string;
  readonly markerScope: "page" | "loaded";
  readonly coverage: readonly {
    readonly sportsbookId: string;
    readonly sportsbookLabel: string;
    readonly status: "available" | "unavailable";
  }[];
  readonly series: readonly OddsHistorySeriesDto[];
  readonly nextCursor: string | null;
}

export interface ArbitrageLegDto {
  readonly selectionKey: string;
  readonly point: number | null;
  readonly best: {
    readonly sportsbookId: string;
    readonly americanOdds: number;
    readonly observedAt: string;
  };
}

export interface ArbitrageFindingDto {
  readonly findingId: string;
  readonly classification: "arbitrage" | "low-hold";
  readonly holdPercentage: number;
  readonly sumInverseDecimal: number;
  readonly marketKey: string;
  readonly canonicalEventId: string;
  readonly startsAt: string;
  readonly evaluatedAt: string;
  readonly expiresAt: string;
  readonly legs: readonly ArbitrageLegDto[];
}

export interface ArbitragePageDto {
  readonly snapshotAt: string | null;
  readonly totalCount: number;
  readonly items: readonly ArbitrageFindingDto[];
}

export interface GamesClient {
  providerStatus?(signal: AbortSignal): Promise<ProviderStatusPageDto>;
  listOpportunities?(
    sportKey: GamesSport,
    signal: AbortSignal,
  ): Promise<RankedOpportunityPageDto>;
  listArbitrage?(
    sportKey: GamesSport,
    signal: AbortSignal,
  ): Promise<ArbitragePageDto>;
  listExperiments?(signal: AbortSignal): Promise<
    readonly {
      readonly experimentId: string;
      readonly state: string;
      readonly createdAt: string;
      readonly baseline: {
        readonly strategyId: string;
        readonly version: string;
        readonly digest: string;
      };
      readonly challenger: {
        readonly strategyId: string;
        readonly version: string;
        readonly digest: string;
      };
      readonly stateVersion: number;
      readonly gates: readonly {
        readonly metric: string;
        readonly actual: number | null;
        readonly passed: boolean;
        readonly reason: string;
      }[];
      readonly failureReasons: readonly string[];
    }[]
  >;
  getExperiment?(id: string, signal: AbortSignal): Promise<unknown>;
  canManageExperiments?(): Promise<boolean>;
  manageExperiment?(
    id: string,
    action: "approve" | "promote" | "rollback",
    body: Readonly<Record<string, unknown>>,
    signal: AbortSignal,
  ): Promise<unknown>;
  list(filter: GamesFilter, signal: AbortSignal): Promise<GamesExplorerPageDto>;
  detail?(eventId: string, signal: AbortSignal): Promise<GameOddsComparisonDto>;
  oddsHistory?(eventId: string, signal: AbortSignal): Promise<OddsHistoryDto>;
  listSplits?(filter: GamesFilter, signal: AbortSignal): Promise<SplitsPageDto>;
  listPerformance?(signal: AbortSignal): Promise<PerformanceReportDto | null>;
  listRetrospectives?(
    signal: AbortSignal,
  ): Promise<readonly RetrospectiveDto[]>;
  getRetrospective?(
    versionId: string,
    signal: AbortSignal,
  ): Promise<RetrospectiveDto>;
  listRetrospectiveVersions?(
    retrospectiveId: string,
    signal: AbortSignal,
  ): Promise<readonly RetrospectiveDto[]>;
  canReviewRetrospectives?(): Promise<boolean>;
  reviewRetrospective?(
    version: RetrospectiveDto,
    input: {
      readonly reasonCode: "approve" | "reject" | "request-changes";
      readonly note: string;
      readonly idempotencyKey: string;
    },
    signal: AbortSignal,
  ): Promise<RetrospectiveDto>;
  createScoutingJob?(
    eventId: string,
    idempotencyKey: string,
    signal: AbortSignal,
  ): Promise<PublicScoutingJob>;
  getScoutingJob?(
    jobId: string,
    signal: AbortSignal,
  ): Promise<PublicScoutingJob>;
  retryScoutingJob?(
    jobId: string,
    expectedStateVersion: number,
    idempotencyKey: string,
    signal: AbortSignal,
  ): Promise<PublicScoutingJob>;
}
export interface RetrospectiveDto {
  readonly retrospectiveId: string;
  readonly versionId: string;
  readonly version: number;
  readonly predecessorVersionId: string | null;
  readonly cohortId: string;
  readonly reportId: string;
  readonly reportRevision: number;
  readonly createdAt: string;
  readonly state: "draft" | "changes-requested" | "approved" | "rejected";
  readonly stateVersion: number;
  readonly memberCount: number;
  readonly caution: "single-member" | "small-sample" | "standard";
  readonly falseNegativeEvaluation: "not-evaluable";
  readonly taxonomyVersion: "retrospective-taxonomy-v1";
  readonly evidence: {
    readonly evaluationCutoff: string;
    readonly decisionTime: readonly {
      readonly id: string;
      readonly kind: string;
      readonly layer: "decision-time";
      readonly decisionCutoff: string;
      readonly observedAt: string;
      readonly digest: string;
    }[];
    readonly postDecision: readonly {
      readonly id: string;
      readonly kind: string;
      readonly layer: "post-decision";
      readonly decisionCutoff: string;
      readonly observedAt: string;
      readonly digest: string;
    }[];
    readonly decisionTimeDigest: string;
    readonly postDecisionDigest: string;
    readonly manifestDigest: string;
  };
  readonly slices: readonly {
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
  }[];
  readonly observations: readonly {
    readonly id: string;
    readonly taxonomyCode: string;
    readonly layer: "decision-time" | "post-decision";
    readonly summary: string;
    readonly evidenceRefIds: readonly string[];
    readonly memberIds: readonly string[];
    readonly confidence: "review-only" | "not-evaluable";
  }[];
  readonly candidates: readonly {
    readonly candidateId: string;
    readonly kind: string;
    readonly summary: string;
    readonly sourceObservationIds: readonly string[];
    readonly predecessorCandidateId: string | null;
    readonly executable: false;
  }[];
  readonly contentDigest: string;
  readonly audit?: {
    readonly items: readonly {
      readonly decisionId: string;
      readonly versionId: string;
      readonly fromState: RetrospectiveDto["state"];
      readonly toState: RetrospectiveDto["state"];
      readonly reasonCode: "approve" | "reject" | "request-changes";
      readonly decidedAt: string;
    }[];
    readonly nextCursor?: string;
  };
}
const taxonomy = new Set([
  "data",
  "price",
  "model",
  "rule",
  "execution",
  "false-positive",
  "false-negative",
  "evidence-gap",
]);
const validRetrospective = (value: unknown): value is RetrospectiveDto => {
  if (!plain(value)) return false;
  const keys = [
    "retrospectiveId",
    "versionId",
    "version",
    "predecessorVersionId",
    "cohortId",
    "reportId",
    "reportRevision",
    "createdAt",
    "state",
    "stateVersion",
    "taxonomyVersion",
    "evidence",
    "slices",
    "observations",
    "candidates",
    "memberCount",
    "caution",
    "falseNegativeEvaluation",
    "contentDigest",
    ...(Object.hasOwn(value, "audit") ? ["audit"] : []),
  ];
  if (!exact(value, keys)) return false;
  if (!(
    /^retrospective:[a-f0-9]{64}$/.test(String(value["retrospectiveId"])) &&
    /^retrospective-version:[a-f0-9]{64}$/.test(String(value["versionId"])) &&
    /^cohort:[a-f0-9]{64}$/.test(String(value["cohortId"])) &&
    /^performance-report:[a-f0-9]{64}$/.test(String(value["reportId"])) &&
    Number.isSafeInteger(value["version"]) &&
    Number(value["version"]) > 0 &&
    ((value["version"] === 1 && value["predecessorVersionId"] === null) ||
      (Number(value["version"]) > 1 &&
        /^retrospective-version:[a-f0-9]{64}$/.test(
          String(value["predecessorVersionId"]),
        ))) &&
    Number.isSafeInteger(value["reportRevision"]) &&
    Number(value["reportRevision"]) > 0 &&
    iso(value["createdAt"]) &&
    ["draft", "changes-requested", "approved", "rejected"].includes(
      String(value["state"]),
    ) &&
    Number.isSafeInteger(value["memberCount"]) &&
    Number(value["memberCount"]) > 0 &&
    Number.isSafeInteger(value["stateVersion"]) &&
    Number(value["stateVersion"]) > 0 &&
    ["single-member", "small-sample", "standard"].includes(
      String(value["caution"]),
    ) &&
    value["falseNegativeEvaluation"] === "not-evaluable" &&
    value["taxonomyVersion"] === "retrospective-taxonomy-v1" &&
    /^[a-f0-9]{64}$/.test(String(value["contentDigest"])) &&
    plain(value["evidence"]) &&
    Array.isArray(value["slices"]) &&
    Array.isArray(value["observations"]) &&
    Array.isArray(value["candidates"]) &&
    (value["candidates"] as unknown[]).every(
      (candidate) => plain(candidate) && candidate["executable"] === false,
    )
  ))
    return false;
  const evidence = value["evidence"];
  if (
    !exact(evidence, [
      "evaluationCutoff",
      "decisionTime",
      "postDecision",
      "decisionTimeDigest",
      "postDecisionDigest",
      "manifestDigest",
    ]) ||
    !iso(evidence["evaluationCutoff"]) ||
    !Array.isArray(evidence["decisionTime"]) ||
    !Array.isArray(evidence["postDecision"]) ||
    ![
      evidence["decisionTimeDigest"],
      evidence["postDecisionDigest"],
      evidence["manifestDigest"],
    ].every((item) => /^[a-f0-9]{64}$/.test(String(item)))
  )
    return false;
  const decisionRefs = evidence["decisionTime"] as unknown[];
  const postRefs = evidence["postDecision"] as unknown[];
  const refs = [...decisionRefs, ...postRefs];
  const refIds = new Set<string>();
  if (
    !refs.every((ref) => {
      if (
        !plain(ref) ||
        !exact(ref, [
          "id",
          "kind",
          "layer",
          "decisionCutoff",
          "observedAt",
          "digest",
        ]) ||
        !boundedString(ref["id"]) ||
        !boundedString(ref["kind"]) ||
        !["decision-time", "post-decision"].includes(String(ref["layer"])) ||
        !iso(ref["decisionCutoff"]) ||
        !iso(ref["observedAt"]) ||
        !/^[a-f0-9]{64}$/.test(String(ref["digest"])) ||
        refIds.has(String(ref["id"]))
      )
        return false;
      refIds.add(String(ref["id"]));
      return true;
    })
  )
    return false;
  const observationIds = new Set<string>();
  if (
    !(value["observations"] as unknown[]).every((observation) => {
      if (
        !plain(observation) ||
        !exact(observation, [
          "id",
          "taxonomyCode",
          "layer",
          "summary",
          "evidenceRefIds",
          "memberIds",
          "confidence",
        ]) ||
        !boundedString(observation["id"]) ||
        observationIds.has(String(observation["id"])) ||
        !taxonomy.has(String(observation["taxonomyCode"])) ||
        !["decision-time", "post-decision"].includes(
          String(observation["layer"]),
        ) ||
        !boundedString(observation["summary"], 500) ||
        !Array.isArray(observation["evidenceRefIds"]) ||
        (observation["evidenceRefIds"].length === 0 &&
          observation["taxonomyCode"] !== "false-negative") ||
        observation["evidenceRefIds"].some(
          (id) => typeof id !== "string" || !refIds.has(id),
        ) ||
        !Array.isArray(observation["memberIds"]) ||
        observation["memberIds"].some((id) => !boundedString(id)) ||
        !["review-only", "not-evaluable"].includes(
          String(observation["confidence"]),
        ) ||
        (observation["taxonomyCode"] === "false-negative" &&
          observation["confidence"] !== "not-evaluable")
      )
        return false;
      observationIds.add(String(observation["id"]));
      return true;
    })
  )
    return false;
  const candidateIds = new Set<string>();
  if (
    !(value["candidates"] as unknown[]).every(
      (candidate) =>
        plain(candidate) &&
        exact(candidate, [
          "candidateId",
          "kind",
          "summary",
          "sourceObservationIds",
          "predecessorCandidateId",
          "executable",
        ]) &&
        /^retrospective-candidate:[a-f0-9]{64}$/.test(
          String(candidate["candidateId"]),
        ) &&
        !candidateIds.has(String(candidate["candidateId"])) &&
        ["data", "prompt", "strategy"].includes(String(candidate["kind"])) &&
        boundedString(candidate["summary"], 500) &&
        Array.isArray(candidate["sourceObservationIds"]) &&
        candidate["sourceObservationIds"].every(
          (id) => typeof id === "string" && observationIds.has(id),
        ) &&
        (candidate["predecessorCandidateId"] === null ||
          (typeof candidate["predecessorCandidateId"] === "string" &&
            /^retrospective-candidate:[a-f0-9]{64}$/.test(
              candidate["predecessorCandidateId"],
            ))) &&
        candidate["executable"] === false &&
        !!candidateIds.add(String(candidate["candidateId"])),
    )
  )
    return false;
  if (value["audit"] !== undefined) {
    const audit = value["audit"];
    if (
      !plain(audit) ||
      !exact(audit, [
        "items",
        ...(Object.hasOwn(audit, "nextCursor") ? ["nextCursor"] : []),
      ]) ||
      !Array.isArray(audit["items"]) ||
      (audit["nextCursor"] !== undefined &&
        !boundedString(audit["nextCursor"], 4096)) ||
      !audit["items"].every(
        (item) =>
          plain(item) &&
          exact(item, [
            "decisionId",
            "versionId",
            "fromState",
            "toState",
            "reasonCode",
            "decidedAt",
          ]) &&
          boundedString(item["decisionId"]) &&
          item["versionId"] === value["versionId"] &&
          ["draft", "changes-requested", "approved", "rejected"].includes(
            String(item["fromState"]),
          ) &&
          ["draft", "changes-requested", "approved", "rejected"].includes(
            String(item["toState"]),
          ) &&
          ["approve", "reject", "request-changes"].includes(
            String(item["reasonCode"]),
          ) &&
          iso(item["decidedAt"]),
      )
    )
      return false;
  }
  return (value["slices"] as unknown[]).every(
    (slice) =>
      plain(slice) &&
      exact(slice, [
        "dimension",
        "value",
        "memberCount",
        "wins",
        "losses",
        "pushes",
        "voids",
        "unresolved",
        "units",
        "roi",
      ]) &&
      ["outcome", "sport", "league", "market"].includes(
        String(slice["dimension"]),
      ) &&
      boundedString(slice["value"], 128) &&
      ["memberCount", "wins", "losses", "pushes", "voids", "unresolved"].every(
        (key) => Number.isSafeInteger(slice[key]) && Number(slice[key]) >= 0,
      ) &&
      nullableFinite(slice["units"]) &&
      nullableFinite(slice["roi"]),
  );
};
export interface PerformanceReportDto {
  readonly reportId: string;
  readonly cohortId: string;
  readonly cutoff: string;
  readonly facets: {
    readonly sports: readonly string[];
    readonly leagues: readonly string[];
    readonly markets: readonly string[];
    readonly oddsBands: readonly string[];
    readonly strategyVersions: readonly string[];
    readonly modelVersions: readonly string[];
  };
  readonly metrics: {
    readonly counts: {
      readonly source: number;
      readonly won: number;
      readonly lost: number;
      readonly push: number;
      readonly void: number;
      readonly unresolved: number;
      readonly decisions: number;
      readonly resolvedExposure: number;
    };
    readonly units: number;
    readonly roi: number | null;
    readonly roiInterval95: {
      readonly low: number;
      readonly high: number;
    } | null;
    readonly roiUnavailableReason: string | null;
    readonly winRate: number | null;
    readonly winRateInterval95: {
      readonly low: number;
      readonly high: number;
    } | null;
    readonly averageDecimalOdds: number | null;
    readonly breakEvenProbability: number | null;
    readonly estimatedEv: number | null;
    readonly brierScore: number | null;
    readonly expectedCalibrationError: number | null;
    readonly maximumDrawdown: number;
    readonly sampleCaution: "insufficient" | "limited" | "established";
    readonly clv: {
      readonly eligible: number;
      readonly unavailable: number;
      readonly averagePrice: number | null;
      readonly averageImpliedProbability: number | null;
      readonly unavailableReasons: Readonly<Record<string, number>>;
    };
    readonly calibration: readonly {
      readonly lower: number;
      readonly upper: number;
      readonly count: number;
      readonly meanForecast: number | null;
      readonly observedRate: number | null;
    }[];
    readonly cumulativeUnits: readonly {
      readonly id: string;
      readonly value: number;
    }[];
  };
}

const nullableFinite = (value: unknown): value is number | null =>
  value === null || (typeof value === "number" && Number.isFinite(value));
const probability = (value: unknown): value is number =>
  typeof value === "number" &&
  Number.isFinite(value) &&
  value >= 0 &&
  value <= 1;
const nullableProbability = (value: unknown): value is number | null =>
  value === null || probability(value);
const validPerformanceReport = (
  value: unknown,
): value is PerformanceReportDto => {
  if (
    !plain(value) ||
    !exact(value, [
      "reportId",
      "cohortId",
      "cutoff",
      "evidenceDigest",
      "revision",
      "createdAt",
      "facets",
      "metrics",
    ]) ||
    !/^performance-report:[a-f0-9]{64}$/.test(String(value["reportId"])) ||
    !/^cohort:[a-f0-9]{64}$/.test(String(value["cohortId"])) ||
    !iso(value["cutoff"]) ||
    !/^[a-f0-9]{64}$/.test(String(value["evidenceDigest"])) ||
    !Number.isSafeInteger(value["revision"]) ||
    Number(value["revision"]) < 1 ||
    !iso(value["createdAt"]) ||
    !plain(value["facets"]) ||
    !plain(value["metrics"])
  )
    return false;
  const facets = value["facets"];
  if (
    !exact(facets, [
      "sports",
      "leagues",
      "markets",
      "oddsBands",
      "strategyVersions",
      "modelVersions",
    ]) ||
    Object.values(facets).some(
      (items) =>
        !Array.isArray(items) ||
        items.some((item) => !boundedString(item, 128)),
    )
  )
    return false;
  const metrics = value["metrics"];
  if (
    !exact(metrics, [
      "counts",
      "units",
      "roi",
      "roiInterval95",
      "roiUnavailableReason",
      "winRate",
      "winRateInterval95",
      "averageDecimalOdds",
      "breakEvenProbability",
      "estimatedEv",
      "brierScore",
      "expectedCalibrationError",
      "calibration",
      "clv",
      "maximumDrawdown",
      "cumulativeUnits",
      "sampleCaution",
    ]) ||
    !plain(metrics["counts"]) ||
    !plain(metrics["clv"]) ||
    !Array.isArray(metrics["calibration"]) ||
    !Array.isArray(metrics["cumulativeUnits"])
  )
    return false;
  const counts = metrics["counts"];
  if (
    !exact(counts, [
      "source",
      "won",
      "lost",
      "push",
      "void",
      "unresolved",
      "decisions",
      "resolvedExposure",
    ]) ||
    Object.values(counts).some(
      (item) => !Number.isSafeInteger(item) || Number(item) < 0,
    )
  )
    return false;
  if (
    !["insufficient", "limited", "established"].includes(
      String(metrics["sampleCaution"]),
    ) ||
    typeof metrics["units"] !== "number" ||
    !Number.isFinite(metrics["units"]) ||
    !nullableFinite(metrics["roi"]) ||
    !(
      metrics["roiInterval95"] === null ||
      (plain(metrics["roiInterval95"]) &&
        exact(metrics["roiInterval95"], ["low", "high"]) &&
        typeof metrics["roiInterval95"]["low"] === "number" &&
        Number.isFinite(metrics["roiInterval95"]["low"]) &&
        typeof metrics["roiInterval95"]["high"] === "number" &&
        Number.isFinite(metrics["roiInterval95"]["high"]) &&
        metrics["roiInterval95"]["low"] <= metrics["roiInterval95"]["high"])
    ) ||
    !(
      metrics["roiUnavailableReason"] === null ||
      boundedString(metrics["roiUnavailableReason"], 128)
    ) ||
    !nullableProbability(metrics["winRate"]) ||
    !(
      metrics["winRateInterval95"] === null ||
      (plain(metrics["winRateInterval95"]) &&
        exact(metrics["winRateInterval95"], ["low", "high"]) &&
        probability(metrics["winRateInterval95"]["low"]) &&
        probability(metrics["winRateInterval95"]["high"]) &&
        metrics["winRateInterval95"]["low"] <=
          metrics["winRateInterval95"]["high"])
    ) ||
    !nullableFinite(metrics["averageDecimalOdds"]) ||
    !nullableProbability(metrics["breakEvenProbability"]) ||
    !nullableFinite(metrics["estimatedEv"]) ||
    !nullableFinite(metrics["brierScore"]) ||
    !nullableFinite(metrics["expectedCalibrationError"]) ||
    typeof metrics["maximumDrawdown"] !== "number" ||
    !Number.isFinite(metrics["maximumDrawdown"]) ||
    metrics["maximumDrawdown"] < 0
  )
    return false;
  const clv = metrics["clv"];
  if (
    !exact(clv, [
      "eligible",
      "unavailable",
      "averagePrice",
      "averageImpliedProbability",
      "unavailableReasons",
    ]) ||
    !Number.isSafeInteger(clv["eligible"]) ||
    Number(clv["eligible"]) < 0 ||
    !Number.isSafeInteger(clv["unavailable"]) ||
    Number(clv["unavailable"]) < 0 ||
    !nullableFinite(clv["averagePrice"]) ||
    !nullableFinite(clv["averageImpliedProbability"]) ||
    !plain(clv["unavailableReasons"]) ||
    Object.entries(clv["unavailableReasons"]).some(
      ([reason, count]) =>
        !boundedString(reason, 128) ||
        !Number.isSafeInteger(count) ||
        Number(count) < 0,
    )
  )
    return false;
  const cumulativeIds = new Set<string>();
  if (
    !metrics["cumulativeUnits"].every((point) => {
      if (
        !plain(point) ||
        !exact(point, ["id", "value"]) ||
        !boundedString(point["id"]) ||
        typeof point["value"] !== "number" ||
        !Number.isFinite(point["value"]) ||
        cumulativeIds.has(point["id"])
      )
        return false;
      cumulativeIds.add(point["id"]);
      return true;
    })
  )
    return false;
  return metrics["calibration"].every(
    (bucket) =>
      plain(bucket) &&
      exact(bucket, [
        "lower",
        "upper",
        "count",
        "meanForecast",
        "observedRate",
      ]) &&
      probability(bucket["lower"]) &&
      probability(bucket["upper"]) &&
      bucket["lower"] < bucket["upper"] &&
      Number.isSafeInteger(bucket["count"]) &&
      Number(bucket["count"]) >= 0 &&
      nullableProbability(bucket["meanForecast"]) &&
      nullableProbability(bucket["observedRate"]),
  );
};

export type GamesClientErrorCode =
  | "configuration"
  | "authentication"
  | "unauthorized"
  | "forbidden"
  | "request-failed"
  | "not-found"
  | "conflict"
  | "not-eligible"
  | "retry-limit"
  | "invalid-response";

export class GamesClientError extends Error {
  override readonly name = "GamesClientError";
  constructor(
    readonly code: GamesClientErrorCode,
    message: string,
  ) {
    super(message);
  }
}

const exact = (value: object, keys: readonly string[]) =>
  Reflect.ownKeys(value).every((key) => typeof key === "string") &&
  Object.keys(value).sort().join("|") === [...keys].sort().join("|");

const plain = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const prototype: unknown = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
};

const boundedString = (value: unknown, maximum = 512): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= maximum;

const iso = (value: unknown): value is string =>
  boundedString(value, 40) &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString() === value;

const SCOUTING_JOB_ID = /^scout-job:[a-f0-9]{64}$/;
const SCOUTING_IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{1,128}$/;

export const isScoutingJobId = (value: string): boolean =>
  SCOUTING_JOB_ID.test(value);

const isCanonicalScoutingEventId = (value: unknown): value is string => {
  if (typeof value !== "string" || value.length < 1 || value.length > 512)
    return false;
  return value.split(":").every((part) => {
    if (!/^(?:[a-z0-9.!'()*_~-]|%[0-9A-F]{2})+$/.test(part)) return false;
    try {
      const decoded = decodeURIComponent(part);
      return (
        decoded.length > 0 &&
        !["__proto__", "constructor", "prototype"].includes(decoded) &&
        decoded ===
          decoded.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ") &&
        encodeURIComponent(decoded) === part
      );
    } catch {
      return false;
    }
  });
};

export function parsePublicScoutingJob(value: unknown): PublicScoutingJob {
  if (
    !plain(value) ||
    !exact(value, [
      "schemaVersion",
      "jobId",
      "eventId",
      "eventVersion",
      "workflowIntent",
      "status",
      "stateVersion",
      "attemptNumber",
      "createdAt",
      "updatedAt",
      ...(Object.hasOwn(value, "failure") ? ["failure"] : []),
    ]) ||
    value["schemaVersion"] !== 1 ||
    typeof value["jobId"] !== "string" ||
    !isScoutingJobId(value["jobId"]) ||
    !isCanonicalScoutingEventId(value["eventId"]) ||
    !Number.isSafeInteger(value["eventVersion"]) ||
    Number(value["eventVersion"]) < 1 ||
    value["workflowIntent"] !== SCOUTING_WORKFLOW_INTENT ||
    !SCOUTING_JOB_STATUSES.includes(
      value["status"] as (typeof SCOUTING_JOB_STATUSES)[number],
    ) ||
    !Number.isSafeInteger(value["stateVersion"]) ||
    !Number.isSafeInteger(value["attemptNumber"]) ||
    Number(value["attemptNumber"]) < 1 ||
    Number(value["attemptNumber"]) > SCOUTING_MAX_ATTEMPTS ||
    !iso(value["createdAt"]) ||
    !iso(value["updatedAt"]) ||
    value["updatedAt"] < value["createdAt"]
  )
    throw new GamesClientError(
      "invalid-response",
      "The scouting response was invalid.",
    );

  const status = value["status"] as PublicScoutingJob["status"];
  const attemptNumber = Number(value["attemptNumber"]);
  const stateVersion = Number(value["stateVersion"]);
  const minimumStateVersion =
    status === "queued"
      ? 2 * attemptNumber - 1
      : status === "completed"
        ? 2 * attemptNumber + 1
        : 2 * attemptNumber;
  const maximumStateVersion =
    status === "queued"
      ? 3 * attemptNumber - 2
      : status === "in_progress"
        ? 3 * attemptNumber - 1
        : 3 * attemptNumber;
  const failed = status === "failed_retryable" || status === "failed_terminal";
  const failure = value["failure"];
  if (
    stateVersion < minimumStateVersion ||
    stateVersion > maximumStateVersion ||
    failed !== (failure !== undefined) ||
    (failure !== undefined &&
      (!plain(failure) ||
        !exact(failure, ["code", "retryable"]) ||
        !SCOUTING_FAILURE_CODES.includes(
          failure["code"] as (typeof SCOUTING_FAILURE_CODES)[number],
        ) ||
        typeof failure["retryable"] !== "boolean" ||
        (status === "failed_retryable") !==
          isRetryableScoutingFailure(
            failure["code"] as (typeof SCOUTING_FAILURE_CODES)[number],
          ) ||
        (failure["retryable"] !== true) !==
          (status !== "failed_retryable" ||
            attemptNumber >= SCOUTING_MAX_ATTEMPTS)))
  )
    throw new GamesClientError(
      "invalid-response",
      "The scouting response was invalid.",
    );
  return Object.freeze(value as unknown as PublicScoutingJob);
}

const validAmericanOdds = (value: unknown): value is number =>
  Number.isSafeInteger(value) &&
  Math.abs(Number(value)) >= 100 &&
  Math.abs(Number(value)) <= 100_000;

const opportunityEasternDay = (value: string): string => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(value));
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((candidate) => candidate.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
};

const invalidArbitragePage = () =>
  new GamesClientError(
    "invalid-response",
    "The arbitrage response was invalid.",
  );

/** Validates the display projection of a finding; the server stores far
 * richer evidence, so extra fields pass through unrendered. */
const parseArbitragePage = (value: unknown): ArbitragePageDto => {
  if (
    !plain(value) ||
    value["schemaVersion"] !== "arbitrage-page-v1" ||
    !Array.isArray(value["items"]) ||
    !Number.isSafeInteger(value["totalCount"]) ||
    (value["totalCount"] as number) < 0 ||
    (value["snapshotAt"] !== null && !iso(value["snapshotAt"]))
  )
    throw invalidArbitragePage();
  const seen = new Set<string>();
  const items = (value["items"] as unknown[]).map((item) => {
    if (!plain(item)) throw invalidArbitragePage();
    const isClassification = (
      candidate: unknown,
    ): candidate is "arbitrage" | "low-hold" =>
      candidate === "arbitrage" || candidate === "low-hold";
    const classification = item["classification"];
    if (!isClassification(classification)) throw invalidArbitragePage();
    if (
      !boundedString(item["findingId"], 128) ||
      seen.has(item["findingId"]) ||
      typeof item["holdPercentage"] !== "number" ||
      !Number.isFinite(item["holdPercentage"]) ||
      typeof item["sumInverseDecimal"] !== "number" ||
      !Number.isFinite(item["sumInverseDecimal"]) ||
      (classification === "arbitrage") !== item["sumInverseDecimal"] < 1 ||
      !boundedString(item["marketKey"], 64) ||
      !boundedString(item["canonicalEventId"], 256) ||
      !iso(item["startsAt"]) ||
      !iso(item["evaluatedAt"]) ||
      !iso(item["expiresAt"]) ||
      !Array.isArray(item["legs"]) ||
      (item["legs"] as unknown[]).length < 2 ||
      (item["legs"] as unknown[]).length > 3
    )
      throw invalidArbitragePage();
    seen.add(item["findingId"]);
    const legs = (item["legs"] as unknown[]).map((leg) => {
      if (
        !plain(leg) ||
        !boundedString(leg["selectionKey"], 64) ||
        (leg["point"] !== null &&
          (typeof leg["point"] !== "number" ||
            !Number.isFinite(leg["point"]))) ||
        !plain(leg["best"])
      )
        throw invalidArbitragePage();
      const best = leg["best"];
      if (
        !boundedString(best["sportsbookId"], 128) ||
        !Number.isInteger(best["americanOdds"]) ||
        Math.abs(best["americanOdds"] as number) < 100 ||
        Math.abs(best["americanOdds"] as number) > 100_000 ||
        !iso(best["observedAt"])
      )
        throw invalidArbitragePage();
      return {
        selectionKey: leg["selectionKey"],
        point: leg["point"],
        best: {
          sportsbookId: best["sportsbookId"],
          americanOdds: best["americanOdds"] as number,
          observedAt: best["observedAt"],
        },
      };
    });
    return {
      findingId: item["findingId"],
      classification,
      holdPercentage: item["holdPercentage"],
      sumInverseDecimal: item["sumInverseDecimal"],
      marketKey: item["marketKey"],
      canonicalEventId: item["canonicalEventId"],
      startsAt: item["startsAt"],
      evaluatedAt: item["evaluatedAt"],
      expiresAt: item["expiresAt"],
      legs,
    };
  });
  return {
    snapshotAt: value["snapshotAt"],
    totalCount: value["totalCount"] as number,
    items,
  };
};

const parseRankedOpportunityPage = (
  value: unknown,
  sportKey: GamesSport,
): RankedOpportunityPageDto => {
  if (
    !plain(value) ||
    !exact(value, [
      "schemaVersion",
      "rankingPolicy",
      "items",
      "nextCursor",
      "snapshotAt",
      "evaluationState",
      "hasMoreUnknown",
      "evaluatedCount",
      "filteredCount",
      "staleCount",
      "joinFailureCount",
    ]) ||
    value["schemaVersion"] !== "ranked-opportunity-page-v1" ||
    !plain(value["rankingPolicy"]) ||
    !exact(value["rankingPolicy"], ["id", "version"]) ||
    !boundedString(value["rankingPolicy"]["id"], 64) ||
    !/^\d+\.\d+\.\d+$/.test(String(value["rankingPolicy"]["version"])) ||
    !Array.isArray(value["items"]) ||
    value["items"].length > 20 ||
    (value["nextCursor"] !== null &&
      !boundedString(value["nextCursor"], 4096)) ||
    !iso(value["snapshotAt"]) ||
    !["complete", "partial"].includes(String(value["evaluationState"])) ||
    typeof value["hasMoreUnknown"] !== "boolean" ||
    (value["evaluationState"] === "partial") !== value["hasMoreUnknown"]
  )
    throw new GamesClientError(
      "invalid-response",
      "The opportunity response was invalid.",
    );
  const counts = [
    value["evaluatedCount"],
    value["filteredCount"],
    value["staleCount"],
    value["joinFailureCount"],
  ];
  if (
    counts.some((count) => !Number.isSafeInteger(count) || Number(count) < 0) ||
    Number(value["evaluatedCount"]) > 200 ||
    Number(value["filteredCount"]) +
      Number(value["staleCount"]) +
      Number(value["joinFailureCount"]) +
      value["items"].length >
      Number(value["evaluatedCount"])
  )
    throw new GamesClientError(
      "invalid-response",
      "The opportunity response was invalid.",
    );
  let items: RankedOpportunityDto[];
  try {
    items = value["items"].map((item) =>
      normalizeRankedOpportunityDto(item as RankedOpportunityDto),
    );
  } catch {
    throw new GamesClientError(
      "invalid-response",
      "The opportunity response was invalid.",
    );
  }
  const snapshotAt = String(value["snapshotAt"]);
  const policy = value["rankingPolicy"];
  const order = (left: RankedOpportunityDto, right: RankedOpportunityDto) =>
    right.expectedValue - left.expectedValue ||
    right.confidence.score - left.confidence.score ||
    right.confidence.components.freshness -
      left.confidence.components.freshness ||
    right.confidence.components.coverage -
      left.confidence.components.coverage ||
    left.opportunityId.localeCompare(right.opportunityId);
  if (
    new Set(items.map(({ opportunityId }) => opportunityId)).size !==
      items.length ||
    items.some(
      (item) =>
        item.sportKey !== sportKey ||
        item.versions.ranking.id !== policy["id"] ||
        item.versions.ranking.version !== policy["version"] ||
        !validAmericanOdds(item.target.americanOdds) ||
        !validAmericanOdds(item.consensus.fairAmericanOdds) ||
        (item.bestComparison !== null &&
          !validAmericanOdds(item.bestComparison.americanOdds)) ||
        item.event.eastern.calendarDay !==
          opportunityEasternDay(item.event.startsAt) ||
        item.event.eastern.display.length < 1 ||
        item.event.eastern.display.length > 160 ||
        Date.parse(item.liveFreshness.scoredAt) > Date.parse(snapshotAt) ||
        Date.parse(item.liveFreshness.expiresAt) <= Date.parse(snapshotAt) ||
        Date.parse(item.liveFreshness.expiresAt) >
          Math.min(
            Date.parse(item.event.startsAt),
            Math.floor(
              Date.parse(item.liveFreshness.oldestRequiredEvidenceAt) +
                item.liveFreshness.maximumAgeMinutes * 60_000,
            ) + 1,
          ) ||
        item.contributingBooks.includes(item.target.sportsbookId) ||
        (item.bestComparison !== null &&
          (item.bestComparison.sportsbookId === item.target.sportsbookId ||
            !item.contributingBooks.includes(
              item.bestComparison.sportsbookId,
            ))) ||
        [
          item.target,
          ...(item.bestComparison ? [item.bestComparison] : []),
        ].some(
          (evidence) =>
            Date.parse(evidence.observedAt) >
              Date.parse(evidence.retrievedAt) ||
            Date.parse(evidence.retrievedAt) >
              Date.parse(item.liveFreshness.scoredAt) ||
            Date.parse(evidence.retrievedAt) > Date.parse(snapshotAt),
        ) ||
        Math.abs(
          item.liveFreshness.ageMinutes -
            (Date.parse(snapshotAt) -
              Date.parse(item.liveFreshness.oldestRequiredEvidenceAt)) /
              60_000,
        ) > 1e-9,
    ) ||
    items.some((item, index) => index > 0 && order(items[index - 1]!, item) > 0)
  )
    throw new GamesClientError(
      "invalid-response",
      "The opportunity response was invalid.",
    );
  return Object.freeze({
    schemaVersion: "ranked-opportunity-page-v1" as const,
    rankingPolicy: Object.freeze({
      id: String(policy["id"]),
      version: String(policy["version"]),
    }),
    items: Object.freeze(items),
    nextCursor:
      value["nextCursor"] === null ? null : String(value["nextCursor"]),
    snapshotAt,
    evaluationState: value["evaluationState"] as "complete" | "partial",
    hasMoreUnknown: value["hasMoreUnknown"],
    evaluatedCount: Number(value["evaluatedCount"]),
    filteredCount: Number(value["filteredCount"]),
    staleCount: Number(value["staleCount"]),
    joinFailureCount: Number(value["joinFailureCount"]),
  });
};
const validOddsPoint = (value: unknown): value is number =>
  typeof value === "number" &&
  Number.isFinite(value) &&
  Math.abs(value) <= 10_000;

const validOddsComparisonCell = (value: unknown, requiresPoint: boolean) => {
  if (!plain(value) || typeof value["state"] !== "string") return false;
  if (value["state"] === "active")
    return (
      exact(value, [
        "state",
        "eligible",
        "americanOdds",
        "observedAt",
        "retrievedAt",
        ...(Object.hasOwn(value, "point") ? ["point"] : []),
      ]) &&
      value["eligible"] === true &&
      validAmericanOdds(value["americanOdds"]) &&
      iso(value["observedAt"]) &&
      iso(value["retrievedAt"]) &&
      (requiresPoint
        ? validOddsPoint(value["point"])
        : value["point"] === undefined || validOddsPoint(value["point"]))
    );
  if (
    !["stale", "suspended", "partial", "unavailable"].includes(value["state"])
  )
    return false;
  const optional = [
    "point",
    "americanOdds",
    "observedAt",
    "retrievedAt",
  ].filter((key) => Object.hasOwn(value, key));
  const hasPrice = Object.hasOwn(value, "americanOdds");
  const hasObservedAt = Object.hasOwn(value, "observedAt");
  const hasRetrievedAt = Object.hasOwn(value, "retrievedAt");
  const hasCompletePriceTuple = hasPrice && hasObservedAt && hasRetrievedAt;
  const hasNoPriceTuple = !hasPrice && !hasObservedAt && !hasRetrievedAt;
  return (
    exact(value, ["state", "eligible", "reason", "evidenceAt", ...optional]) &&
    value["eligible"] === false &&
    boundedString(value["reason"], 256) &&
    (value["evidenceAt"] === null || iso(value["evidenceAt"])) &&
    (hasCompletePriceTuple || hasNoPriceTuple) &&
    (!Object.hasOwn(value, "point") ||
      (hasPrice && validOddsPoint(value["point"]))) &&
    (!hasPrice || validAmericanOdds(value["americanOdds"])) &&
    (!hasObservedAt || iso(value["observedAt"])) &&
    (!hasRetrievedAt || iso(value["retrievedAt"]))
  );
};

const validOddsComparison = (
  value: unknown,
  sportKey: unknown,
  participants: unknown,
  status: unknown,
  metadata: unknown,
) => {
  if (
    !plain(value) ||
    !exact(value, [
      "targetSportsbookId",
      "targetQualified",
      "generatedAt",
      "sportsbooks",
      "markets",
    ]) ||
    !boundedString(value["targetSportsbookId"], 128) ||
    typeof value["targetQualified"] !== "boolean" ||
    !iso(value["generatedAt"]) ||
    !Array.isArray(value["sportsbooks"]) ||
    !Array.isArray(value["markets"]) ||
    !Array.isArray(participants) ||
    participants.length < 2 ||
    !participants
      .slice(0, 2)
      .every(
        (participant) =>
          plain(participant) && boundedString(participant["id"], 256),
      )
  )
    return false;
  const books = value["sportsbooks"];
  if (
    !books.length ||
    !books.every(
      (book) =>
        plain(book) &&
        exact(book, ["id", "label", "target"]) &&
        boundedString(book["id"], 128) &&
        boundedString(book["label"], 160) &&
        typeof book["target"] === "boolean",
    )
  )
    return false;
  const bookIds = books.map((book) =>
    String((book as Record<string, unknown>)["id"]),
  );
  if (new Set(bookIds).size !== bookIds.length) return false;
  const targetId = String(value["targetSportsbookId"]);
  if (
    books.filter(
      (book) =>
        (book as Record<string, unknown>)["target"] === true &&
        (book as Record<string, unknown>)["id"] === targetId,
    ).length !== 1 ||
    books.filter((book) => (book as Record<string, unknown>)["target"] === true)
      .length !== 1
  )
    return false;
  const sides = participants
    .slice(0, 2)
    .map((participant) =>
      participantSelectionKey(
        String((participant as Record<string, unknown>)["id"]) as EntityId,
      ),
    );
  const teamTotalSelections = participants
    .slice(0, 2)
    .flatMap((participant) => {
      const participantId = String(
        (participant as Record<string, unknown>)["id"],
      ) as EntityId;
      return [
        participantSelectionKey(participantId, "over"),
        participantSelectionKey(participantId, "under"),
      ];
    });
  const expected: Readonly<Record<string, readonly string[]>> = {
    moneyline: sportKey === "soccer" ? [sides[0]!, "draw", sides[1]!] : sides,
    spread: sides,
    total: ["over", "under"],
    ...(sportKey === "soccer" ? { btts: ["yes", "no"] } : {}),
    team_total: teamTotalSelections,
  };
  const markets = value["markets"];
  const marketKeys = markets.map((market) =>
    plain(market) ? market["marketKey"] : undefined,
  );
  if (
    marketKeys.length < 3 ||
    new Set(marketKeys).size !== marketKeys.length ||
    marketKeys.some(
      (marketKey) => typeof marketKey !== "string" || !expected[marketKey],
    ) ||
    !["moneyline", "spread", "total"].every((key) => marketKeys.includes(key))
  )
    return false;
  for (const market of markets) {
    if (
      !plain(market) ||
      !exact(market, ["marketKey", "selections"]) ||
      typeof market["marketKey"] !== "string" ||
      !Array.isArray(market["selections"])
    )
      return false;
    const expectedSelections = expected[market["marketKey"]];
    if (!expectedSelections) return false;
    const selectionKeys = market["selections"].map((selection) =>
      plain(selection) ? selection["selectionKey"] : undefined,
    );
    if (
      selectionKeys.length !== expectedSelections.length ||
      new Set(selectionKeys).size !== selectionKeys.length ||
      !expectedSelections.every((key) => selectionKeys.includes(key))
    )
      return false;
    for (const selection of market["selections"]) {
      if (
        !plain(selection) ||
        !exact(selection, ["selectionKey", "selectionLabel", "cells"]) ||
        !boundedString(selection["selectionKey"], 256) ||
        !boundedString(selection["selectionLabel"], 256) ||
        !plain(selection["cells"])
      )
        return false;
      const cellKeys = Object.keys(selection["cells"]).sort();
      if (
        cellKeys.join("|") !== [...bookIds].sort().join("|") ||
        !bookIds.every((id) =>
          validOddsComparisonCell(
            (selection["cells"] as Record<string, unknown>)[id],
            ["spread", "total", "team_total"].includes(
              String(market["marketKey"]),
            ),
          ),
        )
      )
        return false;
    }
  }
  const eventEligible =
    status === "scheduled" &&
    plain(metadata) &&
    metadata["availability"] === "complete" &&
    plain(metadata["lifecycle"]) &&
    metadata["lifecycle"]["state"] === "scheduled" &&
    plain(metadata["freshness"]) &&
    metadata["freshness"]["state"] === "current";
  const computedQualified =
    eventEligible &&
    markets.every((market) => {
      if (!plain(market) || !Array.isArray(market["selections"])) return false;
      const selections = market["selections"] as Record<string, unknown>[];
      const required = ["moneyline", "spread", "total"].includes(
        String(market["marketKey"]),
      );
      const applicable =
        required ||
        selections.some((selection) =>
          Object.values(selection["cells"] as Record<string, unknown>).some(
            (cell) => plain(cell) && cell["eligible"] === true,
          ),
        );
      return (
        !applicable ||
        selections.every(
          (selection) =>
            (
              (selection["cells"] as Record<string, unknown>)[
                targetId
              ] as Record<string, unknown>
            )["eligible"] === true,
        )
      );
    });
  return value["targetQualified"] === computedQualified;
};

const parseOddsHistory = (value: unknown, eventId: string): OddsHistoryDto => {
  if (
    !plain(value) ||
    !exact(value, [
      "eventId",
      "generatedAt",
      "markerScope",
      "series",
      "coverage",
      "nextCursor",
    ]) ||
    value["eventId"] !== eventId ||
    !iso(value["generatedAt"]) ||
    !Array.isArray(value["series"]) ||
    value["series"].length > 200 ||
    value["markerScope"] !== "page" ||
    (value["nextCursor"] !== null && !boundedString(value["nextCursor"], 4_096))
  )
    throw new GamesClientError(
      "invalid-response",
      "The odds history response was invalid.",
    );
  const series = value["series"].map((candidate) => {
    if (
      !plain(candidate) ||
      !exact(candidate, [
        "marketKey",
        "selectionKey",
        "selectionLabel",
        "sportsbookId",
        "sportsbookLabel",
        "points",
      ]) ||
      !["moneyline", "spread", "total"].includes(
        String(candidate["marketKey"]),
      ) ||
      !boundedString(candidate["selectionKey"], 256) ||
      !boundedString(candidate["selectionLabel"], 160) ||
      !boundedString(candidate["sportsbookId"], 128) ||
      !boundedString(candidate["sportsbookLabel"], 160) ||
      !Array.isArray(candidate["points"]) ||
      candidate["points"].length < 1 ||
      candidate["points"].length > 10_000
    )
      throw new GamesClientError(
        "invalid-response",
        "The odds history response was invalid.",
      );
    const points = candidate["points"].map((point) => {
      if (
        !plain(point) ||
        !exact(point, [
          "observationId",
          "state",
          "americanOdds",
          "impliedProbability",
          "observedAt",
          "retrievedAt",
          "isOpening",
          "isCurrent",
          ...(Object.hasOwn(point, "point") ? ["point"] : []),
        ]) ||
        !boundedString(point["observationId"], 256) ||
        !["active", "suspended", "unavailable"].includes(
          String(point["state"]),
        ) ||
        !validAmericanOdds(point["americanOdds"]) ||
        typeof point["impliedProbability"] !== "number" ||
        !Number.isFinite(point["impliedProbability"]) ||
        point["impliedProbability"] <= 0 ||
        point["impliedProbability"] >= 1 ||
        Math.abs(
          point["impliedProbability"] -
            impliedProbability(Number(point["americanOdds"])),
        ) > 1e-12 ||
        !iso(point["observedAt"]) ||
        !iso(point["retrievedAt"]) ||
        (point["point"] !== undefined &&
          (typeof point["point"] !== "number" ||
            !Number.isFinite(point["point"]))) ||
        (candidate["marketKey"] === "moneyline") ===
          (point["point"] !== undefined) ||
        typeof point["isOpening"] !== "boolean" ||
        typeof point["isCurrent"] !== "boolean" ||
        (point["state"] !== "active" &&
          (point["isOpening"] || point["isCurrent"]))
      )
        throw new GamesClientError(
          "invalid-response",
          "The odds history response was invalid.",
        );
      return point as unknown as OddsHistoryPointDto;
    });
    const pointOrder = (point: OddsHistoryPointDto) =>
      `${point.observedAt}|${point.retrievedAt}|${point.observationId}`;
    if (
      new Set(points.map((point) => point.observationId)).size !==
        points.length ||
      points.some(
        (point, index) =>
          index > 0 && pointOrder(point) < pointOrder(points[index - 1]!),
      )
    )
      throw new GamesClientError(
        "invalid-response",
        "The odds history response was invalid.",
      );
    return { ...candidate, points } as unknown as OddsHistorySeriesDto;
  });
  const identities = series.map(({ marketKey, selectionKey, sportsbookId }) =>
    JSON.stringify([marketKey, selectionKey, sportsbookId]),
  );
  if (new Set(identities).size !== identities.length)
    throw new GamesClientError(
      "invalid-response",
      "The odds history response was invalid.",
    );
  let coverage: OddsHistoryDto["coverage"];
  {
    if (!Array.isArray(value["coverage"]) || value["coverage"].length > 100)
      throw new GamesClientError(
        "invalid-response",
        "The odds history response was invalid.",
      );
    coverage = value["coverage"].map((item) => {
      if (
        !plain(item) ||
        !exact(item, ["sportsbookId", "sportsbookLabel", "status"]) ||
        !boundedString(item["sportsbookId"], 128) ||
        !boundedString(item["sportsbookLabel"], 160) ||
        !["available", "unavailable"].includes(String(item["status"]))
      )
        throw new GamesClientError(
          "invalid-response",
          "The odds history response was invalid.",
        );
      return item as unknown as NonNullable<OddsHistoryDto["coverage"]>[number];
    });
    if (
      new Set(coverage.map(({ sportsbookId }) => sportsbookId)).size !==
      coverage.length
    )
      throw new GamesClientError(
        "invalid-response",
        "The odds history response was invalid.",
      );
  }
  return {
    ...(value as unknown as OddsHistoryDto),
    coverage,
    series,
  };
};

const markActiveHistoryEndpoints = (
  item: OddsHistorySeriesDto,
): OddsHistorySeriesDto => {
  const activeIndexes = item.points.flatMap((point, index) =>
    point.state === "active" ? [index] : [],
  );
  const openingIndex = activeIndexes[0];
  const currentIndex = activeIndexes.at(-1);
  return {
    ...item,
    points: item.points.map((point, index) => ({
      ...point,
      isOpening: index === openingIndex,
      isCurrent: index === currentIndex,
    })),
  };
};

export const isCanonicalEventStatus = (value: unknown): value is EventStatus =>
  EVENT_LIFECYCLE_STATES.some((state) => state === value);

const easternDay = (value: string): string => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(value));
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((candidate) => candidate.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
};

const validSelection = (value: unknown): value is GameOddsSelectionDto => {
  if (!plain(value)) return false;
  const required = [
    "marketKey",
    "selectionKey",
    "sportsbookId",
    "americanOdds",
    "observedAt",
    "retrievedAt",
  ];
  const optional = [
    "selectionLabel",
    "sportsbookLabel",
    "point",
    "sharpAmericanOdds",
  ].filter((key) => key in value);
  if (!exact(value, [...required, ...optional])) return false;
  return (
    boundedString(value["marketKey"], 64) &&
    boundedString(value["selectionKey"], 64) &&
    boundedString(value["sportsbookId"], 128) &&
    (value["selectionLabel"] === undefined ||
      boundedString(value["selectionLabel"], 160)) &&
    (value["sportsbookLabel"] === undefined ||
      boundedString(value["sportsbookLabel"], 160)) &&
    (value["point"] === undefined ||
      (typeof value["point"] === "number" &&
        Number.isFinite(value["point"]) &&
        Math.abs(value["point"]) <= 10_000)) &&
    Number.isInteger(value["americanOdds"]) &&
    Math.abs(value["americanOdds"] as number) >= 100 &&
    Math.abs(value["americanOdds"] as number) <= 100_000 &&
    (value["sharpAmericanOdds"] === undefined ||
      (Number.isInteger(value["sharpAmericanOdds"]) &&
        Math.abs(value["sharpAmericanOdds"] as number) >= 100 &&
        Math.abs(value["sharpAmericanOdds"] as number) <= 100_000)) &&
    iso(value["observedAt"]) &&
    iso(value["retrievedAt"])
  );
};

const validGame = (
  value: unknown,
  filter: GamesFilter,
): value is GameDisplayDto => {
  if (!plain(value)) return false;
  if (
    !exact(value, [
      "id",
      "version",
      "sportKey",
      "leagueKey",
      "competition",
      "participants",
      "startsAt",
      "eastern",
      "status",
      "freshness",
      "metadata",
      "odds",
    ]) ||
    !boundedString(value["id"], 512) ||
    !Number.isSafeInteger(value["version"]) ||
    (value["version"] as number) < 1 ||
    value["sportKey"] !== filter.sport ||
    value["leagueKey"] !== (filter.sport === "mlb" ? "mlb" : "mls") ||
    !isCanonicalEventStatus(value["status"]) ||
    !iso(value["startsAt"]) ||
    easternDay(value["startsAt"]) !== filter.day ||
    (value["freshness"] !== null && !iso(value["freshness"]))
  )
    return false;
  const competition = value["competition"];
  const metadata = value["metadata"];
  if (
    !plain(metadata) ||
    !exact(metadata, [
      "policyVersion",
      "evaluatedAt",
      "lifecycle",
      "availability",
      "freshness",
      "reasonCodes",
    ]) ||
    metadata["policyVersion"] !== 1 ||
    !iso(metadata["evaluatedAt"]) ||
    !plain(metadata["lifecycle"]) ||
    !exact(metadata["lifecycle"], ["state", "known"]) ||
    metadata["lifecycle"]["state"] !== value["status"] ||
    typeof metadata["lifecycle"]["known"] !== "boolean" ||
    !plain(metadata["freshness"]) ||
    !Array.isArray(metadata["reasonCodes"])
  )
    return false;
  try {
    validateEventMetadataAssessment(
      metadata,
      value["status"],
      value["freshness"],
      metadata["evaluatedAt"],
    );
  } catch {
    return false;
  }
  if (
    !plain(competition) ||
    !exact(competition, ["key", "state"]) ||
    !boundedString(competition["key"], 128) ||
    competition["state"] !== "provisional"
  )
    return false;
  const eastern = value["eastern"];
  if (
    !plain(eastern) ||
    !exact(eastern, ["timeZone", "calendarDay", "display"]) ||
    eastern["timeZone"] !== "America/New_York" ||
    eastern["calendarDay"] !== filter.day ||
    !boundedString(eastern["display"], 160)
  )
    return false;
  const participants = value["participants"];
  if (!Array.isArray(participants) || participants.length !== 2) return false;
  const participantIds = new Set<string>();
  let awayLabel: string | undefined;
  let homeLabel: string | undefined;
  const orderedParticipantIds: string[] = [];
  for (const participant of participants) {
    if (
      !plain(participant) ||
      !exact(participant, ["id", "label"]) ||
      !boundedString(participant["id"], 512) ||
      !boundedString(participant["label"], 160) ||
      participantIds.has(participant["id"])
    )
      return false;
    if (participantIds.size === 0) awayLabel = participant["label"];
    if (participantIds.size === 1) homeLabel = participant["label"];
    participantIds.add(participant["id"]);
    orderedParticipantIds.push(participant["id"]);
  }
  if (!awayLabel || !homeLabel) return false;
  const odds = value["odds"];
  if (!plain(odds) || !boundedString(odds["state"], 16)) return false;
  if (odds["state"] === "unavailable") return exact(odds, ["state"]);
  if (
    odds["state"] !== "available" ||
    !exact(odds, ["state", "selections"]) ||
    !Array.isArray(odds["selections"]) ||
    odds["selections"].length < (filter.sport === "mlb" ? 2 : 3) ||
    odds["selections"].length > (filter.sport === "mlb" ? 6 : 7) ||
    !odds["selections"].every(validSelection)
  )
    return false;
  const expectedMarket = "moneyline";
  const expectedSelections =
    filter.sport === "mlb"
      ? ([
          [
            `participant:${encodeURIComponent(orderedParticipantIds[0]!)}`,
            awayLabel,
          ],
          [
            `participant:${encodeURIComponent(orderedParticipantIds[1]!)}`,
            homeLabel,
          ],
        ] as const)
      : ([
          [
            `participant:${encodeURIComponent(orderedParticipantIds[0]!)}`,
            awayLabel,
          ],
          ["draw", "Draw"],
          [
            `participant:${encodeURIComponent(orderedParticipantIds[1]!)}`,
            homeLabel,
          ],
        ] as const);
  const legacyExpectedSelectionKeys =
    filter.sport === "mlb"
      ? (["away", "home"] as const)
      : (["away", "draw", "home"] as const);
  const selections = odds["selections"];
  const sportsbookId = selections[0]?.sportsbookId;
  const observedAt = selections[0]?.observedAt;
  const retrievedAt = selections[0]?.retrievedAt;
  if (
    typeof sportsbookId !== "string" ||
    !selections.every(
      (selection) =>
        selection.sportsbookId === sportsbookId &&
        selection.observedAt === observedAt &&
        selection.retrievedAt === retrievedAt &&
        selection.observedAt <= selection.retrievedAt,
    )
  )
    return false;
  const grouped = new Map<string, GameOddsSelectionDto[]>();
  for (const selection of selections) {
    const group = grouped.get(selection.marketKey) ?? [];
    if (
      group.some(({ selectionKey }) => selectionKey === selection.selectionKey)
    )
      return false;
    group.push(selection);
    grouped.set(selection.marketKey, group);
  }
  if (
    [...grouped.keys()].some(
      (key) => ![expectedMarket, "spread", "total"].includes(key),
    )
  )
    return false;
  const moneyline = grouped.get(expectedMarket);
  if (
    !moneyline ||
    moneyline.length !== expectedSelections.length ||
    !moneyline.every(
      (selection, index) =>
        (selection.selectionKey === expectedSelections[index]![0] ||
          selection.selectionKey === legacyExpectedSelectionKeys[index]) &&
        selection.selectionLabel === expectedSelections[index]![1] &&
        selection.point === undefined,
    )
  )
    return false;
  const spread = grouped.get("spread");
  if (
    spread &&
    (spread.length !== 2 ||
      !spread.every(
        (selection, index) =>
          ([
            `participant:${encodeURIComponent(orderedParticipantIds[0]!)}`,
            `participant:${encodeURIComponent(orderedParticipantIds[1]!)}`,
          ][index] === selection.selectionKey ||
            ["away", "home"][index] === selection.selectionKey) &&
          selection.selectionLabel === [awayLabel, homeLabel][index] &&
          selection.point !== undefined,
      ))
  )
    return false;
  if (spread && spread[0]!.point !== -spread[1]!.point!) return false;
  const total = grouped.get("total");
  return !(
    total &&
    (total.length !== 2 ||
      !total.every(
        (selection, index) =>
          selection.selectionKey === ["over", "under"][index] &&
          selection.selectionLabel === ["Over", "Under"][index] &&
          selection.point !== undefined,
      ) ||
      total[0]!.point !== total[1]!.point ||
      total[0]!.point! < 0)
  );
};

function parsePage(
  value: unknown,
  filter: GamesFilter,
  responseName: "games" | "splits" = "games",
): GamesResponsePageDto {
  const invalid = () =>
    new GamesClientError(
      "invalid-response",
      `The ${responseName} response was invalid.`,
    );
  if (
    !plain(value) ||
    !exact(value, [
      "items",
      "nextCursor",
      "projectionState",
      "evaluationState",
      "hasMoreUnknown",
      "snapshotAt",
      "freshness",
      "unavailableReason",
    ]) ||
    !Array.isArray(value["items"]) ||
    value["items"].length > 50 ||
    !["ready", "uninitialized"].includes(String(value["projectionState"])) ||
    !(
      (value["evaluationState"] === "complete" &&
        value["hasMoreUnknown"] === false &&
        (value["nextCursor"] === null ||
          boundedString(value["nextCursor"], 4096))) ||
      (value["evaluationState"] === "partial" &&
        value["hasMoreUnknown"] === true &&
        boundedString(value["nextCursor"], 4096))
    ) ||
    (value["snapshotAt"] !== null && !iso(value["snapshotAt"])) ||
    (value["freshness"] !== null && !iso(value["freshness"])) ||
    !(
      (value["projectionState"] === "uninitialized" &&
        value["unavailableReason"] === "projection-uninitialized" &&
        value["nextCursor"] === null &&
        value["evaluationState"] === "complete" &&
        value["hasMoreUnknown"] === false &&
        value["snapshotAt"] === null &&
        value["freshness"] === null &&
        value["items"].length === 0) ||
      (value["projectionState"] === "ready" &&
        value["unavailableReason"] === null &&
        value["snapshotAt"] !== null)
    ) ||
    !value["items"].every((game) => validGame(game, filter))
  )
    throw invalid();
  const items = value["items"];
  const ids = new Set(items.map(({ id }) => id));
  if (
    ids.size !== items.length ||
    items.some(
      (game, index) => index > 0 && game.startsAt < items[index - 1]!.startsAt,
    )
  )
    throw invalid();
  const expectedStatus = filter.status ?? "scheduled";
  if (
    expectedStatus !== "all" &&
    items.some((game) => game.status !== expectedStatus)
  )
    throw invalid();
  const canonicalFreshness =
    items
      .flatMap((game) => (game.freshness === null ? [] : [game.freshness]))
      .sort()[0] ?? null;
  if (value["freshness"] !== canonicalFreshness) throw invalid();
  if (
    value["snapshotAt"] !== null &&
    items.some((game) => game.metadata.evaluatedAt !== value["snapshotAt"])
  )
    throw invalid();
  return value as unknown as GamesResponsePageDto;
}

type SplitsResponsePageDto = Omit<GamesResponsePageDto, "items"> & {
  readonly items: SplitsPageDto["items"];
};

function parseSplitsPage(
  value: unknown,
  filter: GamesFilter,
): SplitsResponsePageDto {
  if (!plain(value) || !Array.isArray(value["items"]))
    throw new GamesClientError(
      "invalid-response",
      "The splits response was invalid.",
    );
  const stripped = {
    ...value,
    items: value["items"].map((item) => {
      if (!plain(item) || !Array.isArray(item["splits"]))
        throw new GamesClientError(
          "invalid-response",
          "The splits response was invalid.",
        );
      return Object.fromEntries(
        Object.entries(item).filter(([key]) => key !== "splits"),
      );
    }),
  };
  const games = parsePage(stripped, filter, "splits");
  const items = value["items"].map((item, index) => {
    const raw = item as Record<string, unknown>;
    const splits = (raw["splits"] as unknown[]).map((split) => {
      if (!plain(split))
        throw new GamesClientError(
          "invalid-response",
          "The splits response was invalid.",
        );
      const required = [
        "id",
        "providerId",
        "providerEventId",
        "canonicalEventId",
        "canonicalEventVersion",
        "sportKey",
        "leagueKey",
        "marketKey",
        "selectionKey",
        "providerTimestamp",
        "retrievedAt",
      ];
      const optional = [
        "point",
        "americanOdds",
        "betPercent",
        "moneyPercent",
        "betCount",
        "moneyAmount",
        "scope",
      ].filter((key) => key in split);
      if (!exact(split, [...required, ...optional]))
        throw new GamesClientError(
          "invalid-response",
          "The splits response was invalid.",
        );
      for (const key of [
        "id",
        "providerId",
        "providerEventId",
        "canonicalEventId",
        "sportKey",
        "leagueKey",
        "marketKey",
        "selectionKey",
        "providerTimestamp",
        "retrievedAt",
      ])
        if (!boundedString(split[key]))
          throw new GamesClientError(
            "invalid-response",
            "The splits response was invalid.",
          );
      if (
        !Number.isSafeInteger(split["canonicalEventVersion"]) ||
        (split["canonicalEventVersion"] as number) < 1 ||
        split["canonicalEventId"] !== games.items[index]?.id ||
        (split["canonicalEventVersion"] as number) >
          (games.items[index]?.version ?? 0) ||
        split["sportKey"] !== games.items[index]?.sportKey ||
        split["leagueKey"] !== games.items[index]?.leagueKey ||
        !iso(split["providerTimestamp"]) ||
        !iso(split["retrievedAt"]) ||
        (split["point"] !== undefined &&
          (typeof split["point"] !== "number" ||
            !Number.isFinite(split["point"]) ||
            Math.abs(split["point"]) > 10_000)) ||
        (split["americanOdds"] !== undefined &&
          (!Number.isSafeInteger(split["americanOdds"]) ||
            split["americanOdds"] === 0 ||
            Math.abs(split["americanOdds"] as number) < 100 ||
            Math.abs(split["americanOdds"] as number) > 100_000)) ||
        (split["betCount"] !== undefined &&
          (!Number.isSafeInteger(split["betCount"]) ||
            (split["betCount"] as number) < 0)) ||
        (split["moneyAmount"] !== undefined &&
          (typeof split["moneyAmount"] !== "number" ||
            !Number.isFinite(split["moneyAmount"]) ||
            split["moneyAmount"] < 0 ||
            split["moneyAmount"] > Number.MAX_SAFE_INTEGER)) ||
        (split["scope"] !== undefined && !boundedString(split["scope"], 256))
      )
        throw new GamesClientError(
          "invalid-response",
          "The splits response was invalid.",
        );
      for (const key of ["betPercent", "moneyPercent"])
        if (
          split[key] !== undefined &&
          (typeof split[key] !== "number" ||
            !Number.isFinite(split[key]) ||
            split[key] < 0 ||
            split[key] > 100)
        )
          throw new GamesClientError(
            "invalid-response",
            "The splits response was invalid.",
          );
      return split as unknown as BettingSplitDto;
    });
    if (new Set(splits.map(({ id }) => id)).size !== splits.length)
      throw new GamesClientError(
        "invalid-response",
        "The splits response was invalid.",
      );
    return { ...games.items[index]!, splits };
  });
  return { ...games, items };
}

const MAX_PAGES = 100;
const ODDS_HISTORY_MAX_PAGES = 512;
const LIFECYCLE_REQUEST_TIMEOUT_MS = 10_000;
const OPPORTUNITY_REQUEST_TIMEOUT_MS = 10_000;

async function boundedOpportunityRequest<T>(
  signal: AbortSignal,
  request: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const abortFromParent = () => controller.abort(signal.reason);
  signal.addEventListener("abort", abortFromParent, { once: true });
  let timeout: ReturnType<typeof globalThis.setTimeout> | undefined;
  const timeoutFailure = new Promise<never>((_resolve, reject) => {
    timeout = globalThis.setTimeout(() => {
      controller.abort(new DOMException("Timed out", "TimeoutError"));
      reject(
        new GamesClientError(
          "request-failed",
          "Opportunities are temporarily unavailable.",
        ),
      );
    }, OPPORTUNITY_REQUEST_TIMEOUT_MS);
  });
  try {
    return await Promise.race([request(controller.signal), timeoutFailure]);
  } catch (error) {
    if (signal.aborted) throw error;
    if (controller.signal.aborted)
      throw new GamesClientError(
        "request-failed",
        "Opportunities are temporarily unavailable.",
      );
    throw error;
  } finally {
    if (timeout !== undefined) globalThis.clearTimeout(timeout);
    signal.removeEventListener("abort", abortFromParent);
  }
}

async function boundedLifecycleRequest<T>(
  signal: AbortSignal,
  request: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const abortFromParent = () => controller.abort(signal.reason);
  signal.addEventListener("abort", abortFromParent, { once: true });
  let timeout: ReturnType<typeof globalThis.setTimeout> | undefined;
  const timeoutFailure = new Promise<never>((_resolve, reject) => {
    timeout = globalThis.setTimeout(() => {
      controller.abort(new DOMException("Timed out", "TimeoutError"));
      reject(
        new GamesClientError(
          "request-failed",
          "Games are temporarily unavailable.",
        ),
      );
    }, LIFECYCLE_REQUEST_TIMEOUT_MS);
  });
  try {
    return await Promise.race([request(controller.signal), timeoutFailure]);
  } catch (error) {
    if (signal.aborted) throw error;
    if (controller.signal.aborted)
      throw new GamesClientError(
        "request-failed",
        "Games are temporarily unavailable.",
      );
    throw error;
  } finally {
    if (timeout !== undefined) globalThis.clearTimeout(timeout);
    signal.removeEventListener("abort", abortFromParent);
  }
}

async function exhaustPages<T extends GameDisplayDto>(options: {
  readonly endpoint: "games" | "splits";
  readonly filter: GamesFilter;
  readonly signal: AbortSignal;
  readonly apiBase: string;
  readonly fetcher: typeof fetch;
  readonly parse: (
    value: unknown,
    filter: GamesFilter,
  ) => Omit<GamesResponsePageDto, "items"> & { readonly items: readonly T[] };
}): Promise<Omit<GamesPageDto, "items"> & { readonly items: readonly T[] }> {
  const { endpoint, filter, signal, apiBase, fetcher, parse } = options;
  const baseQuery = {
    sport: filter.sport,
    league: filter.sport === "mlb" ? "mlb" : "mls",
    // The games endpoint merges every lifecycle server-side; splits is
    // scheduled-only by contract.
    status:
      endpoint === "games"
        ? (filter.status ?? "scheduled")
        : filter.status && filter.status !== "all"
          ? filter.status
          : "scheduled",
    day: filter.day,
    limit: "50",
  };
  const pages: T[] = [];
  const ids = new Set<string>();
  const cursors = new Set<string>();
  let cursor: string | undefined;
  let snapshotAt: string | null | undefined;
  let projectionState: GamesPageDto["projectionState"] | undefined;
  let freshness: string | null = null;
  let unavailableReason: GamesPageDto["unavailableReason"] | undefined;

  for (let pageNumber = 0; pageNumber < MAX_PAGES; pageNumber += 1) {
    const query = new URLSearchParams(baseQuery);
    if (cursor !== undefined) query.set("cursor", cursor);
    let response: Response;
    try {
      response = await fetcher(`${apiBase}/${endpoint}?${query}`, { signal });
    } catch (error) {
      if (signal.aborted) throw error;
      throw new GamesClientError(
        "request-failed",
        endpoint === "games"
          ? "Games are temporarily unavailable."
          : "Splits are temporarily unavailable.",
      );
    }
    if (endpoint === "games" && response.status === 401)
      throw new GamesClientError(
        "unauthorized",
        "Games are temporarily unavailable.",
      );
    if (endpoint === "games" && response.status === 403)
      throw new GamesClientError(
        "forbidden",
        "Games are temporarily unavailable.",
      );
    if (!response.ok)
      throw new GamesClientError(
        "request-failed",
        endpoint === "games"
          ? "Games are temporarily unavailable."
          : "Splits are temporarily unavailable.",
      );
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new GamesClientError(
        "invalid-response",
        `The ${endpoint} response was invalid.`,
      );
    }
    const page = parse(body, filter);
    if (snapshotAt === undefined) snapshotAt = page.snapshotAt;
    else if (page.snapshotAt !== snapshotAt)
      throw new GamesClientError(
        "invalid-response",
        `The ${endpoint} response was invalid.`,
      );
    if (projectionState === undefined) projectionState = page.projectionState;
    else if (page.projectionState !== projectionState)
      throw new GamesClientError(
        "invalid-response",
        `The ${endpoint} response was invalid.`,
      );
    if (unavailableReason === undefined)
      unavailableReason = page.unavailableReason;
    else if (page.unavailableReason !== unavailableReason)
      throw new GamesClientError(
        "invalid-response",
        `The ${endpoint} response was invalid.`,
      );
    for (const item of page.items) {
      if (
        ids.has(item.id) ||
        (pages.length > 0 && item.startsAt < pages[pages.length - 1]!.startsAt)
      )
        throw new GamesClientError(
          "invalid-response",
          `The ${endpoint} response was invalid.`,
        );
      ids.add(item.id);
      pages.push(item);
    }
    if (
      page.freshness !== null &&
      (freshness === null || page.freshness < freshness)
    )
      freshness = page.freshness;
    if (page.nextCursor === null)
      return {
        items: pages,
        nextCursor: null,
        projectionState: projectionState ?? page.projectionState,
        evaluationState: "complete",
        hasMoreUnknown: false,
        snapshotAt: snapshotAt ?? null,
        freshness,
        unavailableReason: unavailableReason ?? page.unavailableReason,
      };
    const nextCursor = page.nextCursor;
    if (cursors.has(nextCursor))
      throw new GamesClientError(
        "invalid-response",
        `The ${endpoint} response was invalid.`,
      );
    cursors.add(nextCursor);
    cursor = nextCursor;
  }
  throw new GamesClientError(
    "invalid-response",
    `The ${endpoint} response was invalid.`,
  );
}

function bootstrapFailure(failure: RuntimeConfigError): GamesClientError {
  return new GamesClientError("configuration", failure.message);
}

const reviewerSession = async (providerKey: string | undefined) => {
  if (!providerKey) return null;
  const provider = (globalThis as Record<string, unknown>)[providerKey];
  if (!plain(provider) || typeof provider["getAccessToken"] !== "function")
    return null;
  const token = await (provider["getAccessToken"] as () => Promise<unknown>)();
  if (typeof token !== "string" || token.length < 10 || token.length > 16_384)
    return null;
  try {
    const payload = JSON.parse(
      atob(token.split(".")[1]!.replace(/-/g, "+").replace(/_/g, "/")),
    ) as unknown;
    if (!plain(payload)) return null;
    const scopes =
      typeof payload["scope"] === "string" ? payload["scope"].split(" ") : [];
    const groups = Array.isArray(payload["cognito:groups"])
      ? payload["cognito:groups"].filter(
          (item): item is string => typeof item === "string",
        )
      : [];
    return scopes.includes("events/retrospectives:approve") &&
      groups.includes("fte-retrospective-reviewers")
      ? { token }
      : null;
  } catch {
    return null;
  }
};
const promoterSession = async (
  providerKey: string | undefined,
): Promise<{ token: string } | null> => {
  if (!providerKey) return null;
  const provider = (globalThis as Record<string, unknown>)[providerKey];
  if (!plain(provider) || typeof provider["getAccessToken"] !== "function")
    return null;
  const token = await (provider["getAccessToken"] as () => Promise<unknown>)();
  if (typeof token !== "string" || token.length < 10 || token.length > 16_384)
    return null;
  try {
    const payload = JSON.parse(
      atob(token.split(".")[1]!.replace(/-/g, "+").replace(/_/g, "/")),
    ) as unknown;
    if (!plain(payload)) return null;
    const scopes =
      typeof payload["scope"] === "string" ? payload["scope"].split(" ") : [];
    const groups = Array.isArray(payload["cognito:groups"])
      ? payload["cognito:groups"].filter(
          (item): item is string => typeof item === "string",
        )
      : [];
    return scopes.includes("events/strategies:promote") &&
      groups.includes("fte-strategy-promoters")
      ? { token }
      : null;
  } catch {
    return null;
  }
};

const SCOUTING_SCOPES = [
  "events/events:read",
  "events/scouting:read",
  "events/scouting:write",
] as const;
const SCOUTING_REQUEST_TIMEOUT_MS = 10_000;

const awaitWithSignal = <T>(promise: Promise<T>, signal: AbortSignal) =>
  new Promise<T>((resolve, reject) => {
    const abortError = () =>
      signal.reason instanceof Error
        ? signal.reason
        : new DOMException("Aborted", "AbortError");
    if (signal.aborted) {
      reject(abortError());
      return;
    }
    const aborted = () => reject(abortError());
    signal.addEventListener("abort", aborted, { once: true });
    promise.then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", aborted);
    });
  });

const invalidateScoutingSession = (providerKey: string | undefined): void => {
  if (!providerKey) return;
  const registry = (globalThis as Record<string, unknown>)[
    "__FTE_TOKEN_INVALIDATORS__"
  ];
  const invalidate = plain(registry) ? registry[providerKey] : undefined;
  if (typeof invalidate !== "function") return;
  try {
    (invalidate as () => void)();
  } catch {
    // A failed local cleanup must not hide the authoritative 401.
  }
};

const scoutingSession = async (
  providerKey: string | undefined,
  expectedIssuer: string | undefined,
  expectedClientId: string | undefined,
): Promise<{ readonly token: string }> => {
  if (!providerKey || !expectedIssuer || !expectedClientId)
    throw new GamesClientError(
      "authentication",
      "Sign in is required to use scouting.",
    );
  const registry = (globalThis as Record<string, unknown>)[
    "__FTE_TOKEN_PROVIDERS__"
  ];
  const provider = plain(registry) ? registry[providerKey] : undefined;
  if (typeof provider !== "function")
    throw new GamesClientError(
      "authentication",
      "Sign in is required to use scouting.",
    );
  let token: unknown;
  try {
    token = await (provider as () => Promise<unknown>)();
  } catch {
    throw new GamesClientError(
      "authentication",
      "Sign in could not be completed.",
    );
  }
  if (typeof token !== "string" || token.length < 10 || token.length > 16_384)
    throw new GamesClientError(
      "authentication",
      "Sign in could not be completed.",
    );
  try {
    const tokenParts = token.split(".");
    if (tokenParts.length !== 3) throw new Error();
    const segment = tokenParts[1];
    if (!segment || !/^[A-Za-z0-9_-]+$/.test(segment)) throw new Error();
    const payload = JSON.parse(
      atob(
        segment
          .replace(/-/g, "+")
          .replace(/_/g, "/")
          .padEnd(Math.ceil(segment.length / 4) * 4, "="),
      ),
    ) as unknown;
    const scopes =
      plain(payload) && typeof payload["scope"] === "string"
        ? payload["scope"].split(" ")
        : [];
    if (
      !plain(payload) ||
      payload["iss"] !== expectedIssuer ||
      payload["client_id"] !== expectedClientId ||
      payload["token_use"] !== "access" ||
      typeof payload["exp"] !== "number" ||
      !Number.isFinite(payload["exp"]) ||
      payload["exp"] <= Date.now() / 1000 + 30 ||
      !SCOUTING_SCOPES.every((scope) => scopes.includes(scope))
    )
      throw new GamesClientError(
        "forbidden",
        "This session does not have scouting access.",
      );
  } catch (error) {
    if (error instanceof GamesClientError) throw error;
    throw new GamesClientError(
      "authentication",
      "Sign in could not be completed.",
    );
  }
  return { token };
};

const scoutingHttpError = (
  response: Response,
  operation: "create" | "status" | "retry",
): GamesClientError => {
  if (response.status === 401)
    return new GamesClientError(
      "authentication",
      "Sign in is required to use scouting.",
    );
  if (response.status === 403)
    return new GamesClientError(
      "forbidden",
      "This session does not have scouting access.",
    );
  if (response.status === 404)
    return new GamesClientError(
      "not-found",
      operation === "status"
        ? "This scouting job is unavailable."
        : "This event is unavailable.",
    );
  if (response.status === 409)
    return new GamesClientError(
      "conflict",
      "Scouting changed while this request was being handled.",
    );
  if (response.status === 422)
    return new GamesClientError(
      operation === "retry" ? "retry-limit" : "not-eligible",
      operation === "retry"
        ? "This scouting job cannot be retried."
        : "This event is not eligible for scouting.",
    );
  return new GamesClientError(
    "request-failed",
    operation === "status"
      ? "Scouting progress is temporarily unavailable."
      : "The scouting request could not be completed.",
  );
};

const scoutingJobRequest = async ({
  apiBase,
  providerKey,
  expectedIssuer,
  expectedClientId,
  fetcher,
  operation,
  path,
  signal,
  idempotencyKey,
  body,
  expectedJobId,
  expectedEventId,
}: {
  readonly apiBase: string;
  readonly providerKey: string | undefined;
  readonly expectedIssuer: string | undefined;
  readonly expectedClientId: string | undefined;
  readonly fetcher: typeof fetch;
  readonly operation: "create" | "status" | "retry";
  readonly path: string;
  readonly signal: AbortSignal;
  readonly idempotencyKey?: string;
  readonly body?: Readonly<Record<string, unknown>>;
  readonly expectedJobId?: string;
  readonly expectedEventId?: string;
}): Promise<PublicScoutingJob> => {
  const timeoutSignal = AbortSignal.timeout(SCOUTING_REQUEST_TIMEOUT_MS);
  const requestSignal = AbortSignal.any([signal, timeoutSignal]);
  let token: string;
  try {
    ({ token } = await awaitWithSignal(
      scoutingSession(providerKey, expectedIssuer, expectedClientId),
      requestSignal,
    ));
  } catch (error) {
    if (signal.aborted) throw error;
    if (timeoutSignal.aborted)
      throw new GamesClientError(
        "request-failed",
        operation === "status"
          ? "Scouting progress is temporarily unavailable."
          : "The scouting request could not be completed.",
      );
    throw error;
  }
  let response: Response;
  try {
    response = await awaitWithSignal(
      fetcher(`${apiBase}${path}`, {
        method: operation === "status" ? "GET" : "POST",
        credentials: "omit",
        cache: "no-store",
        signal: requestSignal,
        headers: {
          authorization: `Bearer ${token}`,
          ...(operation === "status"
            ? {}
            : {
                "content-type": "application/json",
                "idempotency-key": idempotencyKey!,
              }),
        },
        ...(operation === "status" ? {} : { body: JSON.stringify(body) }),
      }),
      requestSignal,
    );
  } catch (error) {
    if (signal.aborted) throw error;
    throw new GamesClientError(
      "request-failed",
      operation === "status"
        ? "Scouting progress is temporarily unavailable."
        : "The scouting request could not be completed.",
    );
  }
  const accepted =
    operation === "status"
      ? response.status === 200
      : response.status === 200 || response.status === 202;
  if (!accepted) {
    if (response.status === 401) invalidateScoutingSession(providerKey);
    throw scoutingHttpError(response, operation);
  }
  const job = parsePublicScoutingJob(await response.json().catch(() => null));
  if (
    (expectedJobId !== undefined && job.jobId !== expectedJobId) ||
    (expectedEventId !== undefined && job.eventId !== expectedEventId)
  )
    throw new GamesClientError(
      "invalid-response",
      "The scouting response was invalid.",
    );
  if (operation !== "status") {
    const expectedLocation = `/scout-jobs/${job.jobId}`;
    if (response.headers.get("location") !== expectedLocation)
      throw new GamesClientError(
        "invalid-response",
        "The scouting response was invalid.",
      );
  }
  return job;
};

export function createGamesClient(
  bootstrap: Result<RuntimeBootstrap, RuntimeConfigError>,
  fetcher: typeof fetch = fetch,
): Result<GamesClient, GamesClientError> {
  if (!bootstrap.ok)
    return { ok: false, error: bootstrapFailure(bootstrap.error) };
  const scoutingAuth =
    bootstrap.value.config.tokenProviderKey &&
    bootstrap.value.config.cognitoIssuer &&
    bootstrap.value.config.cognitoClientId
      ? {
          providerKey: bootstrap.value.config.tokenProviderKey,
          issuer: bootstrap.value.config.cognitoIssuer,
          clientId: bootstrap.value.config.cognitoClientId,
        }
      : null;
  return {
    ok: true,
    value: {
      ...(scoutingAuth
        ? {
            async createScoutingJob(eventId, idempotencyKey, signal) {
              if (
                !isCanonicalScoutingEventId(eventId) ||
                !SCOUTING_IDEMPOTENCY_KEY.test(idempotencyKey)
              )
                throw new GamesClientError(
                  "invalid-response",
                  "The scouting request was invalid.",
                );
              return scoutingJobRequest({
                apiBase: bootstrap.value.config.apiBase,
                providerKey: scoutingAuth.providerKey,
                expectedIssuer: scoutingAuth.issuer,
                expectedClientId: scoutingAuth.clientId,
                fetcher,
                operation: "create",
                path: `/events/${encodeCanonicalEventPathSegment(eventId)}/scout`,
                signal,
                idempotencyKey,
                body: {},
                expectedEventId: eventId,
              });
            },
            async getScoutingJob(jobId, signal) {
              if (!isScoutingJobId(jobId))
                throw new GamesClientError(
                  "invalid-response",
                  "The scouting job address was invalid.",
                );
              return scoutingJobRequest({
                apiBase: bootstrap.value.config.apiBase,
                providerKey: scoutingAuth.providerKey,
                expectedIssuer: scoutingAuth.issuer,
                expectedClientId: scoutingAuth.clientId,
                fetcher,
                operation: "status",
                path: `/scout-jobs/${encodeURIComponent(jobId)}`,
                signal,
                expectedJobId: jobId,
              });
            },
            async retryScoutingJob(
              jobId,
              expectedStateVersion,
              idempotencyKey,
              signal,
            ) {
              if (
                !isScoutingJobId(jobId) ||
                !Number.isSafeInteger(expectedStateVersion) ||
                expectedStateVersion < 1 ||
                !SCOUTING_IDEMPOTENCY_KEY.test(idempotencyKey)
              )
                throw new GamesClientError(
                  "invalid-response",
                  "The scouting retry was invalid.",
                );
              return scoutingJobRequest({
                apiBase: bootstrap.value.config.apiBase,
                providerKey: scoutingAuth.providerKey,
                expectedIssuer: scoutingAuth.issuer,
                expectedClientId: scoutingAuth.clientId,
                fetcher,
                operation: "retry",
                path: `/scout-jobs/${encodeURIComponent(jobId)}/retry`,
                signal,
                idempotencyKey,
                body: { expectedStateVersion },
                expectedJobId: jobId,
              });
            },
          }
        : {}),
      async providerStatus(signal) {
        const timeoutSignal = AbortSignal.timeout(8_000);
        const requestSignal = AbortSignal.any([signal, timeoutSignal]);
        let response: Response;
        try {
          response = await fetcher(
            `${bootstrap.value.config.apiBase}/providers/status`,
            { credentials: "omit", signal: requestSignal },
          );
        } catch (error) {
          if (signal.aborted) throw error;
          throw new GamesClientError(
            "request-failed",
            "Provider status is temporarily unavailable.",
          );
        }
        if (!response.ok)
          throw new GamesClientError(
            "request-failed",
            "Provider status is temporarily unavailable.",
          );
        try {
          return normalizeProviderStatusPageDto(await response.json());
        } catch {
          throw new GamesClientError(
            "invalid-response",
            "The provider status response was invalid.",
          );
        }
      },
      async listOpportunities(sportKey, signal) {
        if (sportKey !== "mlb" && sportKey !== "soccer")
          throw new GamesClientError(
            "invalid-response",
            "The opportunity sport was invalid.",
          );
        return boundedOpportunityRequest(signal, async (boundedSignal) => {
          let response: Response;
          try {
            response = await fetcher(
              `${bootstrap.value.config.apiBase}/sports/${encodeURIComponent(sportKey)}/opportunities?limit=20`,
              { signal: boundedSignal },
            );
          } catch (error) {
            if (boundedSignal.aborted) throw error;
            throw new GamesClientError(
              "request-failed",
              "Opportunities are temporarily unavailable.",
            );
          }
          if (!response.ok)
            throw new GamesClientError(
              "request-failed",
              response.status === 503
                ? "Opportunity evidence is temporarily unavailable."
                : "Opportunities are temporarily unavailable.",
            );
          const body: unknown = await response.json().catch(() => null);
          return parseRankedOpportunityPage(body, sportKey);
        });
      },
      async listArbitrage(sportKey, signal) {
        if (sportKey !== "mlb" && sportKey !== "soccer")
          throw new GamesClientError(
            "invalid-response",
            "The arbitrage sport was invalid.",
          );
        return boundedOpportunityRequest(signal, async (boundedSignal) => {
          let response: Response;
          try {
            response = await fetcher(
              `${bootstrap.value.config.apiBase}/sports/${encodeURIComponent(sportKey)}/arbitrage?limit=20`,
              { signal: boundedSignal },
            );
          } catch (error) {
            if (boundedSignal.aborted) throw error;
            throw new GamesClientError(
              "request-failed",
              "Arbitrage findings are temporarily unavailable.",
            );
          }
          if (!response.ok)
            throw new GamesClientError(
              "request-failed",
              "Arbitrage findings are temporarily unavailable.",
            );
          const body: unknown = await response.json().catch(() => null);
          return parseArbitragePage(body);
        });
      },
      async listExperiments(signal: AbortSignal) {
        const response = await fetcher(
          `${bootstrap.value.config.apiBase}/strategy-experiments?limit=50`,
          { signal },
        );
        if (!response.ok)
          throw new GamesClientError(
            "request-failed",
            "Strategy experiments are unavailable.",
          );
        const body: unknown = await response.json();
        if (!plain(body) || !Array.isArray(body["items"]))
          throw new GamesClientError(
            "invalid-response",
            "The strategy experiment response was invalid.",
          );
        return body["items"] as never;
      },
      async getExperiment(id: string, signal: AbortSignal) {
        if (!/^strategy-experiment:[a-f0-9]{64}$/.test(id))
          throw new GamesClientError(
            "invalid-response",
            "The experiment ID is invalid.",
          );
        const response = await fetcher(
          `${bootstrap.value.config.apiBase}/strategy-experiments/${encodeURIComponent(id)}`,
          { signal },
        );
        if (!response.ok)
          throw new GamesClientError(
            "request-failed",
            "Strategy experiment detail is unavailable.",
          );
        const body: unknown = await response.json();
        if (
          !plain(body) ||
          body["experimentId"] !== id ||
          !Array.isArray(body["gates"]) ||
          !Array.isArray(body["audit"])
        )
          throw new GamesClientError(
            "invalid-response",
            "The strategy experiment response was invalid.",
          );
        return body;
      },
      async canManageExperiments() {
        return (
          (await promoterSession(bootstrap.value.config.tokenProviderKey)) !==
          null
        );
      },
      async manageExperiment(id, action, body, signal) {
        const session = await promoterSession(
          bootstrap.value.config.tokenProviderKey,
        );
        if (!session)
          throw new GamesClientError(
            "forbidden",
            "A strategy promoter session is required.",
          );
        const response = await fetcher(
          `${bootstrap.value.config.apiBase}/strategy-experiments/${encodeURIComponent(id)}/${action}`,
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${session.token}`,
              "content-type": "application/json",
            },
            body: JSON.stringify(body),
            signal,
          },
        );
        if (response.status === 409)
          throw new GamesClientError(
            "conflict",
            "The experiment changed. Reloading current evidence.",
          );
        if (!response.ok)
          throw new GamesClientError(
            response.status === 403 ? "forbidden" : "request-failed",
            "The strategy action could not be saved.",
          );
        return response.json() as Promise<unknown>;
      },
      async list(filter, signal) {
        // Every lifecycle arrives in one server-merged request; the previous
        // client-side fan-out issued six.
        const requested =
          filter.status === "all"
            ? [...EVENT_LIFECYCLE_STATES]
            : [filter.status ?? "scheduled"];
        const page = await boundedLifecycleRequest(signal, (boundedSignal) =>
          exhaustPages({
            endpoint: "games",
            filter,
            signal: boundedSignal,
            apiBase: bootstrap.value.config.apiBase,
            fetcher,
            parse: parsePage,
          }),
        );
        const ready = page.projectionState === "ready";
        const ordered = [...collapseNearDuplicateGames([...page.items])].sort(
          (a, b) =>
            a.startsAt.localeCompare(b.startsAt) || a.id.localeCompare(b.id),
        );
        return {
          items: ordered,
          nextCursor: null,
          projectionState: page.projectionState,
          evaluationState: page.evaluationState,
          hasMoreUnknown: page.hasMoreUnknown,
          snapshotAt: page.snapshotAt,
          freshness: page.freshness,
          unavailableReason: page.unavailableReason,
          lifecycleCoverage: {
            requested,
            loaded: ready ? requested : [],
            unavailable: ready ? [] : requested,
          },
        };
      },
      async detail(eventId, signal) {
        let response: Response;
        try {
          response = await fetcher(
            `${bootstrap.value.config.apiBase}/events/${encodeCanonicalEventPathSegment(eventId)}`,
            { signal },
          );
        } catch (error) {
          if (signal.aborted) throw error;
          throw new GamesClientError(
            "request-failed",
            "Game details are temporarily unavailable.",
          );
        }
        if (response.status === 404)
          throw new GamesClientError("not-found", "This game was not found.");
        if (!response.ok)
          throw new GamesClientError(
            "request-failed",
            "Game details are temporarily unavailable.",
          );
        const body: unknown = await response.json().catch(() => null);
        if (
          !plain(body) ||
          !exact(body, ["projectionState", "item", "unavailableReason"]) ||
          body["projectionState"] !== "ready" ||
          body["unavailableReason"] !== null ||
          !plain(body["item"])
        )
          throw new GamesClientError(
            "invalid-response",
            "The game details response was invalid.",
          );
        const item = body["item"];
        const comparison = item["oddsComparison"];
        const eventFields = { ...item };
        delete eventFields["oddsComparison"];
        if (
          (item["sportKey"] !== "mlb" && item["sportKey"] !== "soccer") ||
          typeof item["startsAt"] !== "string" ||
          !plain(item["eastern"]) ||
          typeof item["eastern"]["calendarDay"] !== "string" ||
          !validOddsComparison(
            comparison,
            item["sportKey"],
            item["participants"],
            item["status"],
            item["metadata"],
          ) ||
          !validGame(
            { ...eventFields, odds: { state: "unavailable" } },
            {
              sport: item["sportKey"],
              day: item["eastern"]["calendarDay"],
              status: item["status"] as EventStatus,
            },
          ) ||
          item["id"] !== eventId
        )
          throw new GamesClientError(
            "invalid-response",
            "The game details response was invalid.",
          );
        return item as unknown as GameOddsComparisonDto;
      },
      async oddsHistory(eventId, signal) {
        const series = new Map<string, OddsHistorySeriesDto>();
        const coverage = new Map<
          string,
          NonNullable<OddsHistoryDto["coverage"]>[number]
        >();
        const cursors = new Set<string>();
        let cursor: string | undefined;
        let generatedAt: string | undefined;
        const to = new Date();
        const from = new Date(to.getTime() - 31 * 24 * 60 * 60 * 1_000);
        for (
          let pageNumber = 0;
          pageNumber < ODDS_HISTORY_MAX_PAGES;
          pageNumber += 1
        ) {
          const query = new URLSearchParams({
            from: from.toISOString(),
            to: to.toISOString(),
            limit: "200",
          });
          if (cursor) query.set("cursor", cursor);
          let response: Response;
          try {
            response = await fetcher(
              `${bootstrap.value.config.apiBase}/games/${encodeCanonicalEventPathSegment(eventId)}/odds-history?${query}`,
              { signal },
            );
          } catch (error) {
            if (signal.aborted) throw error;
            throw new GamesClientError(
              "request-failed",
              "Line movement is temporarily unavailable.",
            );
          }
          if (response.status === 404)
            throw new GamesClientError("not-found", "This game was not found.");
          if (!response.ok)
            throw new GamesClientError(
              "request-failed",
              "Line movement is temporarily unavailable.",
            );
          const page = parseOddsHistory(
            await response.json().catch(() => null),
            eventId,
          );
          if (generatedAt === undefined) generatedAt = page.generatedAt;
          else if (page.generatedAt !== generatedAt)
            throw new GamesClientError(
              "invalid-response",
              "The odds history pagination fence changed.",
            );
          for (const item of page.coverage ?? []) {
            const existing = coverage.get(item.sportsbookId);
            if (existing && existing.sportsbookLabel !== item.sportsbookLabel)
              throw new GamesClientError(
                "invalid-response",
                "The odds history coverage identity changed during pagination.",
              );
            coverage.set(item.sportsbookId, {
              ...item,
              status:
                existing?.status === "available" || item.status === "available"
                  ? "available"
                  : "unavailable",
            });
          }
          for (const item of page.series) {
            const key = JSON.stringify([
              item.marketKey,
              item.selectionKey,
              item.sportsbookId,
            ]);
            const existing = series.get(key);
            if (!existing) series.set(key, item);
            else {
              if (existing.sportsbookLabel !== item.sportsbookLabel)
                throw new GamesClientError(
                  "invalid-response",
                  "The odds history sportsbook identity changed during pagination.",
                );
              const points = [...existing.points, ...item.points];
              const identities = new Set<string>();
              if (
                points.some((point) => {
                  const identity =
                    point.observationId ??
                    JSON.stringify([
                      point.point ?? null,
                      point.americanOdds,
                      point.observedAt,
                      point.retrievedAt,
                    ]);
                  if (identities.has(identity)) return true;
                  identities.add(identity);
                  return false;
                })
              )
                throw new GamesClientError(
                  "invalid-response",
                  "The odds history response repeated an observation.",
                );
              const pointOrder = (point: OddsHistoryPointDto) =>
                `${point.observedAt}|${point.retrievedAt}|${point.observationId}`;
              if (
                points.some(
                  (point, index) =>
                    index > 0 &&
                    pointOrder(point) < pointOrder(points[index - 1]!),
                )
              )
                throw new GamesClientError(
                  "invalid-response",
                  "The odds history response was out of order.",
                );
              series.set(key, { ...item, points });
            }
          }
          if (page.nextCursor === null)
            return {
              eventId,
              generatedAt: generatedAt ?? new Date(0).toISOString(),
              markerScope: "loaded",
              coverage: [...coverage.values()],
              series: [...series.values()].map(markActiveHistoryEndpoints),
              nextCursor: null,
            };
          if (cursors.has(page.nextCursor))
            throw new GamesClientError(
              "invalid-response",
              "The odds history cursor repeated.",
            );
          cursors.add(page.nextCursor);
          cursor = page.nextCursor;
        }
        return {
          eventId,
          generatedAt: generatedAt ?? new Date(0).toISOString(),
          markerScope: "loaded",
          coverage: [...coverage.values()],
          series: [...series.values()].map(markActiveHistoryEndpoints),
          nextCursor: cursor ?? null,
        };
      },
      async listSplits(filter, signal) {
        return exhaustPages({
          endpoint: "splits",
          filter,
          signal,
          apiBase: bootstrap.value.config.apiBase,
          fetcher,
          parse: parseSplitsPage,
        });
      },
      async listPerformance(signal) {
        let response: Response;
        try {
          response = await fetcher(
            `${bootstrap.value.config.apiBase}/performance/reports?limit=1`,
            { signal },
          );
        } catch (error) {
          if (signal.aborted) throw error;
          throw new GamesClientError(
            "request-failed",
            "Performance is temporarily unavailable.",
          );
        }
        if (!response.ok)
          throw new GamesClientError(
            "request-failed",
            "Performance is temporarily unavailable.",
          );
        let body: unknown;
        try {
          body = await response.json();
        } catch {
          throw new GamesClientError(
            "invalid-response",
            "The performance response was invalid.",
          );
        }
        if (
          !plain(body) ||
          !Array.isArray(body["items"]) ||
          body["items"].length > 1
        )
          throw new GamesClientError(
            "invalid-response",
            "The performance response was invalid.",
          );
        const report: unknown = (body["items"] as unknown[])[0];
        if (report === undefined) return null;
        if (!validPerformanceReport(report))
          throw new GamesClientError(
            "invalid-response",
            "The performance response was invalid.",
          );
        return report;
      },
      async listRetrospectives(signal) {
        const items: RetrospectiveDto[] = [],
          seenCursors = new Set<string>(),
          seenIds = new Set<string>();
        let cursor: string | undefined;
        for (let pageNumber = 0; pageNumber < 100; pageNumber += 1) {
          let response: Response;
          try {
            const query = new URLSearchParams({ limit: "50" });
            if (cursor) query.set("cursor", cursor);
            response = await fetcher(
              `${bootstrap.value.config.apiBase}/retrospectives?${query.toString()}`,
              { signal },
            );
          } catch (error) {
            if (signal.aborted) throw error;
            throw new GamesClientError(
              "request-failed",
              "Retrospectives are temporarily unavailable.",
            );
          }
          if (!response.ok)
            throw new GamesClientError(
              "request-failed",
              "Retrospectives are temporarily unavailable.",
            );
          const body: unknown = await response.json();
          if (
            !plain(body) ||
            !exact(body, [
              "items",
              ...(Object.hasOwn(body, "nextCursor") ? ["nextCursor"] : []),
            ]) ||
            !Array.isArray(body["items"]) ||
            !(body["items"] as unknown[]).every(validRetrospective) ||
            (body["nextCursor"] !== undefined &&
              !boundedString(body["nextCursor"], 4096))
          )
            throw new GamesClientError(
              "invalid-response",
              "The retrospectives response was invalid.",
            );
          for (const item of body["items"] as RetrospectiveDto[]) {
            if (seenIds.has(item.versionId))
              throw new GamesClientError(
                "invalid-response",
                "The retrospectives response was invalid.",
              );
            seenIds.add(item.versionId);
            items.push(item);
          }
          if (body["nextCursor"] === undefined) return items;
          cursor = String(body["nextCursor"]);
          if (seenCursors.has(cursor))
            throw new GamesClientError(
              "invalid-response",
              "The retrospectives response was invalid.",
            );
          seenCursors.add(cursor);
        }
        throw new GamesClientError(
          "invalid-response",
          "The retrospectives response was invalid.",
        );
      },
      async getRetrospective(versionId, signal) {
        if (!/^retrospective-version:[a-f0-9]{64}$/.test(versionId))
          throw new GamesClientError(
            "invalid-response",
            "The retrospective ID was invalid.",
          );
        let response: Response;
        try {
          response = await fetcher(
            `${bootstrap.value.config.apiBase}/retrospectives/${encodeURIComponent(versionId)}`,
            { signal },
          );
        } catch (error) {
          if (signal.aborted) throw error;
          throw new GamesClientError(
            "request-failed",
            "This retrospective is temporarily unavailable.",
          );
        }
        if (!response.ok)
          throw new GamesClientError(
            "request-failed",
            response.status === 404
              ? "This retrospective was not found."
              : "This retrospective is temporarily unavailable.",
          );
        const body: unknown = await response.json();
        if (!validRetrospective(body))
          throw new GamesClientError(
            "invalid-response",
            "The retrospective response was invalid.",
          );
        const auditItems = [...(body.audit?.items ?? [])];
        const decisionIds = new Set(auditItems.map((item) => item.decisionId));
        const seenCursors = new Set<string>();
        let auditCursor = body.audit?.nextCursor;
        for (
          let pageNumber = 1;
          auditCursor && pageNumber < 100;
          pageNumber += 1
        ) {
          if (seenCursors.has(auditCursor))
            throw new GamesClientError(
              "invalid-response",
              "The retrospective audit response was invalid.",
            );
          seenCursors.add(auditCursor);
          const query = new URLSearchParams({
            limit: "50",
            cursor: auditCursor,
          });
          const nextResponse = await fetcher(
            `${bootstrap.value.config.apiBase}/retrospectives/${encodeURIComponent(versionId)}?${query.toString()}`,
            { signal },
          );
          if (!nextResponse.ok)
            throw new GamesClientError(
              "request-failed",
              "The retrospective audit is temporarily unavailable.",
            );
          const nextBody: unknown = await nextResponse.json();
          if (
            !validRetrospective(nextBody) ||
            nextBody.versionId !== body.versionId ||
            nextBody.contentDigest !== body.contentDigest ||
            nextBody.state !== body.state ||
            nextBody.stateVersion !== body.stateVersion ||
            !nextBody.audit
          )
            throw new GamesClientError(
              "invalid-response",
              "The retrospective audit response was invalid.",
            );
          for (const decision of nextBody.audit.items) {
            if (decisionIds.has(decision.decisionId))
              throw new GamesClientError(
                "invalid-response",
                "The retrospective audit response was invalid.",
              );
            decisionIds.add(decision.decisionId);
            auditItems.push(decision);
          }
          auditCursor = nextBody.audit.nextCursor;
        }
        if (auditCursor)
          throw new GamesClientError(
            "invalid-response",
            "The retrospective audit response was invalid.",
          );
        return body.audit ? { ...body, audit: { items: auditItems } } : body;
      },
      async listRetrospectiveVersions(retrospectiveId, signal) {
        if (!/^retrospective:[a-f0-9]{64}$/.test(retrospectiveId))
          throw new GamesClientError(
            "invalid-response",
            "The retrospective ID was invalid.",
          );
        const items: RetrospectiveDto[] = [],
          seenCursors = new Set<string>(),
          seenIds = new Set<string>();
        let cursor: string | undefined;
        for (let pageNumber = 0; pageNumber < 100; pageNumber += 1) {
          const query = new URLSearchParams({ limit: "50" });
          if (cursor) query.set("cursor", cursor);
          let response: Response;
          try {
            response = await fetcher(
              `${bootstrap.value.config.apiBase}/retrospectives/${encodeURIComponent(retrospectiveId)}/versions?${query.toString()}`,
              { signal },
            );
          } catch (error) {
            if (signal.aborted) throw error;
            throw new GamesClientError(
              "request-failed",
              "Version history is temporarily unavailable.",
            );
          }
          if (!response.ok)
            throw new GamesClientError(
              "request-failed",
              "Version history is temporarily unavailable.",
            );
          const body: unknown = await response.json();
          if (
            !plain(body) ||
            !exact(body, [
              "items",
              ...(Object.hasOwn(body, "nextCursor") ? ["nextCursor"] : []),
            ]) ||
            !Array.isArray(body["items"]) ||
            !(body["items"] as unknown[]).every(validRetrospective) ||
            (body["nextCursor"] !== undefined &&
              !boundedString(body["nextCursor"], 4096))
          )
            throw new GamesClientError(
              "invalid-response",
              "The version history response was invalid.",
            );
          for (const item of body["items"] as RetrospectiveDto[]) {
            if (
              item.retrospectiveId !== retrospectiveId ||
              seenIds.has(item.versionId)
            )
              throw new GamesClientError(
                "invalid-response",
                "The version history response was invalid.",
              );
            seenIds.add(item.versionId);
            items.push(item);
          }
          if (body["nextCursor"] === undefined) return items;
          cursor = String(body["nextCursor"]);
          if (seenCursors.has(cursor))
            throw new GamesClientError(
              "invalid-response",
              "The version history response was invalid.",
            );
          seenCursors.add(cursor);
        }
        throw new GamesClientError(
          "invalid-response",
          "The version history response was invalid.",
        );
      },
      async canReviewRetrospectives() {
        return (
          (await reviewerSession(bootstrap.value.config.tokenProviderKey)) !==
          null
        );
      },
      async reviewRetrospective(version, input, signal) {
        const session = await reviewerSession(
          bootstrap.value.config.tokenProviderKey,
        );
        if (!session)
          throw new GamesClientError(
            "forbidden",
            "Reviewer access is required.",
          );
        let response: Response;
        try {
          response = await fetcher(
            `${bootstrap.value.config.apiBase}/retrospectives/${encodeURIComponent(version.versionId)}/review`,
            {
              method: "POST",
              signal,
              headers: {
                authorization: `Bearer ${session.token}`,
                "content-type": "application/json",
              },
              body: JSON.stringify({
                reasonCode: input.reasonCode,
                note: input.note || null,
                idempotencyKey: input.idempotencyKey,
                expectedState: version.state,
                expectedStateVersion: version.stateVersion,
              }),
            },
          );
        } catch (error) {
          if (signal.aborted) throw error;
          throw new GamesClientError(
            "request-failed",
            "The review could not be saved.",
          );
        }
        if (response.status === 409)
          throw new GamesClientError(
            "conflict",
            "This retrospective changed while you were reviewing it.",
          );
        if (!response.ok)
          throw new GamesClientError(
            response.status === 403 ? "forbidden" : "request-failed",
            "The review could not be saved.",
          );
        const body: unknown = await response.json();
        if (
          !plain(body) ||
          !exact(body, ["version", "decision"]) ||
          !validRetrospective(body["version"]) ||
          !plain(body["decision"])
        )
          throw new GamesClientError(
            "invalid-response",
            "The review response was invalid.",
          );
        const reviewed = body["version"],
          decision = body["decision"];
        const expectedState =
          input.reasonCode === "approve"
            ? "approved"
            : input.reasonCode === "reject"
              ? "rejected"
              : "changes-requested";
        if (
          !exact(decision, [
            "decisionId",
            "versionId",
            "fromState",
            "toState",
            "reasonCode",
            "decidedAt",
          ]) ||
          !/^retrospective-decision:[a-f0-9]{64}$/.test(
            String(decision["decisionId"]),
          ) ||
          decision["versionId"] !== version.versionId ||
          decision["versionId"] !== reviewed.versionId ||
          decision["fromState"] !== version.state ||
          decision["toState"] !== expectedState ||
          decision["toState"] !== reviewed.state ||
          decision["reasonCode"] !== input.reasonCode ||
          !iso(decision["decidedAt"]) ||
          reviewed.stateVersion !== version.stateVersion + 1
        )
          throw new GamesClientError(
            "invalid-response",
            "The review response was invalid.",
          );
        return reviewed;
      },
    },
  };
}
