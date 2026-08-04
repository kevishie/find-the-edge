import type {
  GameDisplayDto,
  GameOddsSelectionDto,
} from "@find-the-edge/domain";

import type {
  Result,
  RuntimeBootstrap,
  RuntimeConfigError,
} from "./runtime-config";

export type GamesSport = "mlb" | "soccer";

export interface GamesFilter {
  readonly sport: GamesSport;
  readonly day: string;
}

export interface GamesPageDto {
  readonly items: readonly GameDisplayDto[];
  readonly nextCursor: null;
  readonly projectionState: "ready" | "uninitialized";
  readonly evaluationState: "complete";
  readonly hasMoreUnknown: false;
  readonly snapshotAt: string | null;
  readonly freshness: string | null;
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

export interface GamesClient {
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
  list(filter: GamesFilter, signal: AbortSignal): Promise<GamesPageDto>;
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
  | "conflict"
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
  const optional = ["selectionLabel", "sportsbookLabel", "point"].filter(
    (key) => key in value,
  );
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
      "odds",
    ]) ||
    !boundedString(value["id"], 512) ||
    !Number.isSafeInteger(value["version"]) ||
    (value["version"] as number) < 1 ||
    value["sportKey"] !== filter.sport ||
    value["leagueKey"] !== (filter.sport === "mlb" ? "mlb" : "mls") ||
    value["status"] !== "scheduled" ||
    !iso(value["startsAt"]) ||
    easternDay(value["startsAt"]) !== filter.day ||
    (value["freshness"] !== null && !iso(value["freshness"]))
  )
    return false;
  const competition = value["competition"];
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
          ["away", awayLabel],
          ["home", homeLabel],
        ] as const)
      : ([
          ["away", awayLabel],
          ["draw", "Draw"],
          ["home", homeLabel],
        ] as const);
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
        selection.selectionKey === expectedSelections[index]![0] &&
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
          selection.selectionKey === ["away", "home"][index] &&
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
    status: "scheduled",
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

export function createGamesClient(
  bootstrap: Result<RuntimeBootstrap, RuntimeConfigError>,
  fetcher: typeof fetch = fetch,
): Result<GamesClient, GamesClientError> {
  if (!bootstrap.ok)
    return { ok: false, error: bootstrapFailure(bootstrap.error) };
  return {
    ok: true,
    value: {
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
        return exhaustPages({
          endpoint: "games",
          filter,
          signal,
          apiBase: bootstrap.value.config.apiBase,
          fetcher,
          parse: parsePage,
        });
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
