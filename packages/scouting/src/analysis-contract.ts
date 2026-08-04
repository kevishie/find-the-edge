import { createHash } from "node:crypto";

export type AnalysisStatus = "complete" | "reduced" | "abstain";
export type EvidenceStatus =
  "verified" | "stale" | "conflicting" | "unavailable" | "inference";

type PromptSectionKind = "shared" | "sport" | "strategy" | "analysis";

export interface AnalysisPolicyLike {
  readonly enabled: boolean;
  readonly sportKey: string;
  readonly leagueKeys: readonly string[];
  readonly plannedReason?: "planned-module-disabled";
  readonly markets: readonly {
    readonly marketKey: "moneyline" | "spread";
    readonly outcomeStructure: "two-way" | "three-way";
    readonly selectionKinds: readonly ("participant" | "draw")[];
    readonly requiresPoint: boolean;
    readonly pointPolicy?: {
      readonly minimum: number;
      readonly maximum: number;
      readonly increment: number;
      readonly precision: number;
    };
    readonly legacyMarketAliases: readonly string[];
  }[];
  readonly evidenceRequirements: readonly {
    readonly category: string;
    readonly level: "hard" | "conditional" | "optional";
    readonly enforceWithinMinutes?: number;
    readonly maximumAgeMinutes: number;
  }[];
  readonly probability: {
    readonly minimum: number;
    readonly maximum: number;
    readonly maximumRangeWidth: number;
    readonly maximumUncertainty: number;
  };
  readonly contraindications: readonly {
    readonly code: string;
    readonly evidenceCategory: string;
    readonly statuses: readonly ("stale" | "conflicting" | "unavailable")[];
  }[];
  readonly allowedAbstentionCodes?: readonly string[];
  readonly prohibitedClaims: readonly string[];
  readonly versions: {
    readonly contractVersion: string;
    readonly promptBundleId: string;
    readonly promptBundleVersion: string;
    readonly promptSections: Readonly<
      Record<
        PromptSectionKind,
        { readonly id: string; readonly version: string }
      >
    >;
    readonly inputSchemaId: string;
    readonly inputSchemaVersion: string;
    readonly outputSchemaId: string;
    readonly outputSchemaVersion: string;
    readonly modelId: string;
    readonly modelVersion: string;
  };
}

export interface AnalysisStrategyLike {
  readonly id: string;
  readonly version: string;
  readonly prohibitedMarketKeys: readonly string[];
}

export interface NormalizedAnalysisEvidence {
  readonly id: string;
  readonly category: string;
  readonly status: EvidenceStatus;
  readonly observedAt: string;
  readonly facts: Readonly<Record<string, string | number | boolean | null>>;
}

export interface NormalizedAnalysisCandidate {
  readonly marketKey: "moneyline" | "spread";
  readonly outcomeStructure: "two-way" | "three-way";
  readonly selection: Readonly<{
    kind: "participant" | "draw";
    participantId?: string;
  }>;
  readonly point?: number;
}

export interface NormalizedAnalysisRequest {
  readonly sportKey: string;
  readonly leagueKey: string;
  readonly eventId: string;
  readonly participantIds: readonly [string, string];
  readonly startsAt: string;
  readonly asOf: string;
  readonly candidate: NormalizedAnalysisCandidate;
  readonly evidence: readonly NormalizedAnalysisEvidence[];
  readonly derivedStatus: AnalysisStatus;
  readonly missingEvidenceCodes: readonly string[];
  readonly derivedReasonCodes: readonly string[];
  readonly strategy?: Readonly<{
    id: string;
    version: string;
    prohibitedMarketKeys: readonly string[];
  }>;
  readonly versions: Readonly<AnalysisPolicyLike["versions"]>;
  readonly inputHash: string;
}

export interface ValidatedAnalysisOutput {
  readonly candidate: NormalizedAnalysisCandidate;
  readonly versions: Readonly<AnalysisPolicyLike["versions"]>;
  readonly probability: Readonly<{
    estimate: number;
    low: number;
    high: number;
    uncertainty: number;
  }>;
  readonly status: AnalysisStatus;
  readonly abstentionCodes: readonly string[];
  readonly summary: string;
  readonly assertions: readonly Readonly<{
    text: string;
    classification:
      "factual" | "inference" | "stale" | "conflicting" | "unavailable";
    citationIds: readonly string[];
  }>[];
}

export class AnalysisContractError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "AnalysisContractError";
  }
}

type UnknownRecord = Record<string, unknown>;
const evidenceStatuses: readonly EvidenceStatus[] = [
  "verified",
  "stale",
  "conflicting",
  "unavailable",
  "inference",
];

function fail(code: string, message: string): never {
  throw new AnalysisContractError(code, message);
}

export function assertAcyclic(value: unknown): void {
  const active = new WeakSet<object>();
  const complete = new WeakSet<object>();
  const visit = (item: unknown): void => {
    if (item === null || typeof item !== "object") return;
    if (active.has(item)) fail("CYCLIC_INPUT", "cyclic input is not allowed");
    if (complete.has(item)) return;
    active.add(item);
    for (const child of Array.isArray(item)
      ? item
      : Object.values(item as UnknownRecord)) {
      visit(child);
    }
    active.delete(item);
    complete.add(item);
  };
  visit(value);
}

function record(value: unknown, field: string): UnknownRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("INVALID_OBJECT", `${field} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {
    fail("INVALID_OBJECT", `${field} must be a plain object`);
  }
  return value as UnknownRecord;
}

function exactKeys(
  value: UnknownRecord,
  allowed: readonly string[],
  field: string,
) {
  const extra = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extra.length)
    fail("UNKNOWN_FIELD", `${field}.${extra[0]} is not allowed`);
}

function hasDisallowedControl(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return (
      (code < 32 && code !== 9 && code !== 10 && code !== 13) || code === 127
    );
  });
}

function text(value: unknown, field: string, maximum = 256): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximum ||
    value !== value.trim() ||
    hasDisallowedControl(value)
  )
    fail("INVALID_TEXT", `${field} must be bounded, trimmed, printable text`);
  return value;
}

function timestamp(value: unknown, field: string): string {
  const result = text(value, field, 64);
  const time = Date.parse(result);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== result) {
    fail("INVALID_TIMESTAMP", `${field} must be canonical ISO-8601`);
  }
  return result;
}

function finite(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail("INVALID_NUMBER", `${field} must be finite`);
  }
  return Object.is(value, -0) ? 0 : value;
}

export function canonicalAnalysisJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value))
    return `[${value.map(canonicalAnalysisJson).join(",")}]`;
  const object = value as UnknownRecord;
  return `{${Object.keys(object)
    .sort()
    .map(
      (key) => `${JSON.stringify(key)}:${canonicalAnalysisJson(object[key])}`,
    )
    .join(",")}}`;
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function normalizeCandidate(
  input: unknown,
  policy: AnalysisPolicyLike,
  participants: readonly string[],
): NormalizedAnalysisCandidate {
  const candidate = record(input, "candidate");
  exactKeys(
    candidate,
    ["marketKey", "outcomeStructure", "selection", "point"],
    "candidate",
  );
  const rawMarket = text(candidate["marketKey"], "candidate.marketKey", 64);
  const structure = candidate["outcomeStructure"];
  if (structure !== "two-way" && structure !== "three-way") {
    fail("ILLEGAL_OUTCOME_STRUCTURE", "candidate outcome structure is illegal");
  }
  const market = policy.markets.find(
    (item) =>
      item.outcomeStructure === structure &&
      (item.marketKey === rawMarket ||
        item.legacyMarketAliases.includes(rawMarket)),
  );
  if (!market)
    fail(
      "UNSUPPORTED_MARKET",
      "candidate market is not enabled by this policy",
    );
  const selection = record(candidate["selection"], "candidate.selection");
  exactKeys(selection, ["kind", "participantId"], "candidate.selection");
  const kind = selection["kind"];
  if (kind !== "participant" && kind !== "draw")
    fail("INVENTED_SELECTION", "selection kind is illegal");
  if (!market.selectionKinds.includes(kind))
    fail("INVENTED_SELECTION", "selection is not legal for this market");
  let participantId: string | undefined;
  if (kind === "participant") {
    participantId = text(
      selection["participantId"],
      "candidate.selection.participantId",
    );
    if (!participants.includes(participantId))
      fail("INVENTED_SELECTION", "selection participant is not in the event");
  } else if (selection["participantId"] !== undefined) {
    fail("INVENTED_SELECTION", "draw cannot identify a participant");
  }
  let point: number | undefined;
  if (market.requiresPoint) {
    point = finite(candidate["point"], "candidate.point");
    const pointPolicy =
      market.pointPolicy ??
      fail("INVALID_POINT_POLICY", "spread point policy is required");
    const scaled = point * 10 ** pointPolicy.precision;
    const incrementScaled = pointPolicy.increment * 10 ** pointPolicy.precision;
    if (
      point < pointPolicy.minimum ||
      point > pointPolicy.maximum ||
      !Number.isSafeInteger(scaled) ||
      !Number.isSafeInteger(incrementScaled) ||
      Math.abs(
        scaled / incrementScaled - Math.round(scaled / incrementScaled),
      ) > 1e-9
    )
      fail(
        "INVALID_SPREAD_POINT",
        "spread point violates range, increment, or precision policy",
      );
  } else if (candidate["point"] !== undefined) {
    fail("INVALID_SPREAD_POINT", "non-spread candidate cannot include a point");
  }
  return {
    marketKey: market.marketKey,
    outcomeStructure: structure,
    selection: { kind, ...(participantId ? { participantId } : {}) },
    ...(point !== undefined ? { point } : {}),
  };
}

function normalizeEvidence(
  input: unknown,
  policy: AnalysisPolicyLike,
): NormalizedAnalysisEvidence[] {
  if (!Array.isArray(input) || input.length > 128) {
    fail("INVALID_EVIDENCE", "evidence must be an array of at most 128 items");
  }
  const allowedCategories = new Set(
    policy.evidenceRequirements.map((item) => item.category),
  );
  const ids = new Set<string>();
  return input
    .map((item, index) => {
      const evidence = record(item, `evidence[${index}]`);
      exactKeys(
        evidence,
        ["id", "category", "status", "observedAt", "facts"],
        `evidence[${index}]`,
      );
      const id = text(evidence["id"], `evidence[${index}].id`, 128);
      if (ids.has(id))
        fail("DUPLICATE_EVIDENCE_ID", `duplicate evidence id ${id}`);
      ids.add(id);
      const category = text(
        evidence["category"],
        `evidence[${index}].category`,
        128,
      );
      if (!allowedCategories.has(category))
        fail(
          "UNKNOWN_EVIDENCE_CATEGORY",
          `evidence category ${category} is not declared`,
        );
      const status = evidence["status"];
      if (!evidenceStatuses.includes(status as EvidenceStatus))
        fail("INVALID_EVIDENCE_STATUS", `evidence[${index}].status is invalid`);
      const facts = record(evidence["facts"], `evidence[${index}].facts`);
      if (Object.keys(facts).length > 64)
        fail("INVALID_EVIDENCE", "too many facts");
      const normalizedFacts: Record<string, string | number | boolean | null> =
        {};
      for (const key of Object.keys(facts).sort()) {
        text(key, `evidence[${index}].facts key`, 64);
        if (
          /(?:api[-_]?key|authorization|bearer|cookie|credential|password|secret|token|raw[-_]?(?:payload|response|wrapper))/iu.test(
            key,
          )
        ) {
          fail("UNSAFE_EVIDENCE_FIELD", `evidence field ${key} is prohibited`);
        }
        const value = facts[key];
        if (
          value !== null &&
          typeof value !== "string" &&
          typeof value !== "number" &&
          typeof value !== "boolean"
        ) {
          fail(
            "UNSAFE_EVIDENCE_VALUE",
            "evidence facts must contain only scalar data",
          );
        }
        if (typeof value === "string") {
          const normalized = text(
            value,
            `evidence[${index}].facts.${key}`,
            2048,
          );
          if (
            /(?:bearer\s+[a-z0-9._~+/=-]{12,}|(?:sk|api)[-_][a-z0-9]{12,})/iu.test(
              normalized,
            )
          ) {
            fail(
              "UNSAFE_EVIDENCE_VALUE",
              "evidence contains secret-like material",
            );
          }
          normalizedFacts[key] = normalized;
        } else if (typeof value === "number") {
          normalizedFacts[key] = finite(
            value,
            `evidence[${index}].facts.${key}`,
          );
        } else normalizedFacts[key] = value;
      }
      return {
        id,
        category,
        status: status as EvidenceStatus,
        observedAt: timestamp(
          evidence["observedAt"],
          `evidence[${index}].observedAt`,
        ),
        facts: normalizedFacts,
      };
    })
    .sort((left, right) =>
      left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
    );
}

function evidenceRequirement(policy: AnalysisPolicyLike, category: string) {
  return (
    policy.evidenceRequirements.find((item) => item.category === category) ??
    fail(
      "UNKNOWN_EVIDENCE_CATEGORY",
      `evidence category ${category} is not declared`,
    )
  );
}

function effectiveEvidenceStatus(
  item: NormalizedAnalysisEvidence,
  categoryEvidence: readonly NormalizedAnalysisEvidence[],
  asOf: string,
  policy: AnalysisPolicyLike,
): EvidenceStatus {
  if (
    categoryEvidence.some(
      (candidate) =>
        candidate.status === "conflicting" ||
        candidate.status === "unavailable",
    )
  ) {
    return categoryEvidence.some(
      (candidate) => candidate.status === "conflicting",
    )
      ? "conflicting"
      : "unavailable";
  }
  if (
    item.status === "verified" &&
    (Date.parse(asOf) - Date.parse(item.observedAt)) / 60_000 >
      evidenceRequirement(policy, item.category).maximumAgeMinutes
  ) {
    return "stale";
  }
  return item.status;
}

export function normalizeAnalysisRequest(
  input: unknown,
  policy: AnalysisPolicyLike,
  strategy?: AnalysisStrategyLike,
): NormalizedAnalysisRequest {
  assertAcyclic(input);
  const request = record(input, "request");
  exactKeys(
    request,
    [
      "sportKey",
      "leagueKey",
      "eventId",
      "participantIds",
      "startsAt",
      "asOf",
      "candidate",
      "evidence",
    ],
    "request",
  );
  if (!policy.enabled)
    fail(
      "PLANNED_MODULE_DISABLED",
      policy.plannedReason ?? "planned-module-disabled",
    );
  const sportKey = text(request["sportKey"], "sportKey");
  const leagueKey = text(request["leagueKey"], "leagueKey");
  if (sportKey !== policy.sportKey)
    fail("SPORT_POLICY_MISMATCH", "request sport does not match policy");
  if (!policy.leagueKeys.includes(leagueKey))
    fail("LEAGUE_POLICY_MISMATCH", "request league does not match policy");
  if (
    !Array.isArray(request["participantIds"]) ||
    request["participantIds"].length !== 2
  ) {
    fail("INVALID_PARTICIPANTS", "exactly two participants are required");
  }
  const participantIds = request["participantIds"].map((item, index) =>
    text(item, `participantIds[${index}]`),
  );
  if (participantIds[0] === participantIds[1])
    fail("INVALID_PARTICIPANTS", "participants must be distinct");
  const startsAt = timestamp(request["startsAt"], "startsAt");
  const asOf = timestamp(request["asOf"], "asOf");
  if (Date.parse(asOf) >= Date.parse(startsAt))
    fail(
      "ANALYSIS_NOT_PREGAME",
      "analysis boundary must be strictly before event start",
    );
  const evidence = normalizeEvidence(request["evidence"], policy);
  if (evidence.some((item) => Date.parse(item.observedAt) > Date.parse(asOf))) {
    fail(
      "EVIDENCE_FROM_FUTURE",
      "evidence cannot postdate the analysis boundary",
    );
  }
  const candidate = normalizeCandidate(
    request["candidate"],
    policy,
    participantIds,
  );
  const missing = new Set<string>();
  const reasons = new Set<string>();
  let derivedStatus: AnalysisStatus = "complete";
  const minutesToStart = (Date.parse(startsAt) - Date.parse(asOf)) / 60_000;
  for (const requirement of policy.evidenceRequirements) {
    const matching = evidence.filter(
      (item) => item.category === requirement.category,
    );
    const verified = matching.some(
      (item) =>
        effectiveEvidenceStatus(item, matching, asOf, policy) === "verified" &&
        Object.keys(item.facts).length > 0 &&
        (Date.parse(asOf) - Date.parse(item.observedAt)) / 60_000 <=
          requirement.maximumAgeMinutes,
    );
    if (verified || requirement.level === "optional") continue;
    const missingCode = `missing-evidence:${requirement.category}`;
    missing.add(missingCode);
    reasons.add(missingCode);
    if (
      matching.some(
        (item) =>
          item.status === "verified" &&
          (Date.parse(asOf) - Date.parse(item.observedAt)) / 60_000 >
            requirement.maximumAgeMinutes,
      )
    )
      reasons.add(`stale-evidence:${requirement.category}`);
    if (matching.some((item) => item.status === "conflicting"))
      reasons.add(`conflicting-evidence:${requirement.category}`);
    if (matching.some((item) => item.status === "unavailable"))
      reasons.add(`unavailable-evidence:${requirement.category}`);
    if (
      requirement.level === "hard" ||
      minutesToStart <= (requirement.enforceWithinMinutes ?? 0)
    ) {
      derivedStatus = "abstain";
    } else if (derivedStatus === "complete") derivedStatus = "reduced";
  }
  for (const rule of policy.contraindications) {
    if (
      evidence.some(
        (item) =>
          item.category === rule.evidenceCategory &&
          rule.statuses.includes(item.status as never),
      )
    ) {
      reasons.add(rule.code);
      derivedStatus = "abstain";
    }
  }
  if (strategy?.prohibitedMarketKeys.includes(candidate.marketKey)) {
    reasons.add(`strategy-prohibited-market:${candidate.marketKey}`);
    derivedStatus = "abstain";
  }
  const normalizedWithoutHash = {
    sportKey,
    leagueKey,
    eventId: text(request["eventId"], "eventId"),
    participantIds: participantIds as [string, string],
    startsAt,
    asOf,
    candidate,
    evidence,
    derivedStatus,
    missingEvidenceCodes: [...missing].sort(),
    derivedReasonCodes: [...reasons].sort(),
    ...(strategy
      ? {
          strategy: {
            id: text(strategy.id, "strategy.id"),
            version: text(strategy.version, "strategy.version"),
            prohibitedMarketKeys: [
              ...new Set(
                strategy.prohibitedMarketKeys.map((marketKey, index) =>
                  text(
                    marketKey,
                    `strategy.prohibitedMarketKeys[${index}]`,
                    64,
                  ),
                ),
              ),
            ].sort(),
          },
        }
      : {}),
    versions: structuredClone(policy.versions),
  };
  return deepFreeze({
    ...normalizedWithoutHash,
    inputHash: createHash("sha256")
      .update(canonicalAnalysisJson(normalizedWithoutHash))
      .digest("hex"),
  });
}

function normalizeVersions(input: unknown): AnalysisPolicyLike["versions"] {
  const versions = record(input, "output.versions");
  exactKeys(
    versions,
    [
      "contractVersion",
      "promptBundleId",
      "promptBundleVersion",
      "promptSections",
      "inputSchemaId",
      "inputSchemaVersion",
      "outputSchemaId",
      "outputSchemaVersion",
      "modelId",
      "modelVersion",
    ],
    "output.versions",
  );
  const promptSections = record(
    versions["promptSections"],
    "output.versions.promptSections",
  );
  exactKeys(
    promptSections,
    ["shared", "sport", "strategy", "analysis"],
    "output.versions.promptSections",
  );
  const normalizedSections = Object.fromEntries(
    (["shared", "sport", "strategy", "analysis"] as const).map((kind) => {
      const section = record(
        promptSections[kind],
        `output.versions.promptSections.${kind}`,
      );
      exactKeys(
        section,
        ["id", "version"],
        `output.versions.promptSections.${kind}`,
      );
      return [
        kind,
        {
          id: text(section["id"], `${kind}.id`),
          version: text(section["version"], `${kind}.version`),
        },
      ];
    }),
  ) as AnalysisPolicyLike["versions"]["promptSections"];
  return {
    contractVersion: text(versions["contractVersion"], "contractVersion"),
    promptBundleId: text(versions["promptBundleId"], "promptBundleId"),
    promptBundleVersion: text(
      versions["promptBundleVersion"],
      "promptBundleVersion",
    ),
    promptSections: normalizedSections,
    inputSchemaId: text(versions["inputSchemaId"], "inputSchemaId"),
    inputSchemaVersion: text(
      versions["inputSchemaVersion"],
      "inputSchemaVersion",
    ),
    outputSchemaId: text(versions["outputSchemaId"], "outputSchemaId"),
    outputSchemaVersion: text(
      versions["outputSchemaVersion"],
      "outputSchemaVersion",
    ),
    modelId: text(versions["modelId"], "modelId"),
    modelVersion: text(versions["modelVersion"], "modelVersion"),
  };
}

const prohibitedPatterns: readonly RegExp[] = [
  /\b(?:lock|locked|sure[ -]?thing|can't lose|cannot lose|certain winner)\b/iu,
  /\bguarantee(?:d|s)?\b/iu,
  /\brisk[ -]?free\b/iu,
  /\b(?:proof|proves|confirmed)\b.{0,40}\bsharp action\b/iu,
  /\bsharp action\b.{0,40}\b(?:proof|proven|confirmed)\b/iu,
];

export function validateAnalysisOutput(
  input: unknown,
  request: NormalizedAnalysisRequest,
  policy: AnalysisPolicyLike,
): ValidatedAnalysisOutput {
  assertAcyclic(input);
  if (!policy.enabled)
    fail(
      "PLANNED_MODULE_DISABLED",
      policy.plannedReason ?? "planned-module-disabled",
    );
  if (
    request.sportKey !== policy.sportKey ||
    !policy.leagueKeys.includes(request.leagueKey)
  ) {
    fail(
      "POLICY_REQUEST_MISMATCH",
      "normalized request does not belong to policy",
    );
  }
  if (
    canonicalAnalysisJson(request.versions) !==
    canonicalAnalysisJson(policy.versions)
  ) {
    fail("POLICY_VERSION_MISMATCH", "request versions do not match policy");
  }
  const output = record(input, "output");
  exactKeys(
    output,
    [
      "candidate",
      "versions",
      "probability",
      "status",
      "abstentionCodes",
      "summary",
      "assertions",
    ],
    "output",
  );
  const versions = normalizeVersions(output["versions"]);
  if (
    canonicalAnalysisJson(versions) !== canonicalAnalysisJson(request.versions)
  ) {
    fail(
      "OUTPUT_VERSION_MISMATCH",
      "output versions must exactly echo request versions",
    );
  }
  const rawCandidate = record(output["candidate"], "output.candidate");
  if (rawCandidate["marketKey"] !== request.candidate.marketKey)
    fail("CANDIDATE_MISMATCH", "output must echo canonical market exactly");
  const candidate = normalizeCandidate(
    output["candidate"],
    policy,
    request.participantIds,
  );
  if (
    canonicalAnalysisJson(candidate) !==
    canonicalAnalysisJson(request.candidate)
  )
    fail(
      "CANDIDATE_MISMATCH",
      "output candidate must exactly echo request candidate",
    );
  const probability = record(output["probability"], "output.probability");
  exactKeys(
    probability,
    ["estimate", "low", "high", "uncertainty"],
    "output.probability",
  );
  const estimate = finite(probability["estimate"], "probability.estimate");
  const low = finite(probability["low"], "probability.low");
  const high = finite(probability["high"], "probability.high");
  const uncertainty = finite(
    probability["uncertainty"],
    "probability.uncertainty",
  );
  if (
    low < policy.probability.minimum ||
    high > policy.probability.maximum ||
    estimate < low ||
    estimate > high ||
    low > high
  ) {
    fail(
      "PROBABILITY_OUT_OF_BOUNDS",
      "probability estimate and interval are invalid",
    );
  }
  const width = high - low;
  if (
    width > policy.probability.maximumRangeWidth ||
    uncertainty < 0 ||
    uncertainty > policy.probability.maximumUncertainty
  ) {
    fail(
      "UNCERTAINTY_OUT_OF_BOUNDS",
      "probability range or uncertainty is too wide",
    );
  }
  if (Math.abs(uncertainty - width / 2) > 1e-9) {
    fail(
      "UNCERTAINTY_INCOHERENT",
      "uncertainty must equal half the probability interval width",
    );
  }
  const status = output["status"];
  if (status !== "complete" && status !== "reduced" && status !== "abstain")
    fail("INVALID_OUTPUT_STATUS", "output status is invalid");
  if (request.derivedStatus === "abstain" && status !== "abstain")
    fail("EVIDENCE_REQUIRES_ABSTENTION", "derived rules require abstention");
  if (request.derivedStatus === "reduced" && status === "complete")
    fail(
      "EVIDENCE_REQUIRES_REDUCED_MATURITY",
      "conditional evidence gap prevents complete analysis",
    );
  if (
    !Array.isArray(output["abstentionCodes"]) ||
    output["abstentionCodes"].length > 32
  )
    fail("INVALID_ABSTENTION_CODES", "abstentionCodes must be bounded array");
  const abstentionCodes = [
    ...new Set(
      output["abstentionCodes"].map((item, index) =>
        text(item, `abstentionCodes[${index}]`, 128),
      ),
    ),
  ].sort();
  const allowedAbstentionCodes = new Set([
    ...request.derivedReasonCodes,
    ...(policy.allowedAbstentionCodes ?? []),
    ...policy.contraindications.map(({ code }) => code),
  ]);
  if (abstentionCodes.some((code) => !allowedAbstentionCodes.has(code)))
    fail(
      "INVENTED_ABSTENTION_CODE",
      "abstention codes must be request-derived or contract-declared",
    );
  if (status === "abstain" && abstentionCodes.length === 0)
    fail("MISSING_ABSTENTION_CODE", "abstention requires a reason code");
  if (status !== "abstain" && abstentionCodes.length > 0)
    fail(
      "INVALID_ABSTENTION_CODES",
      "non-abstention cannot include abstention codes",
    );
  if (
    status === "abstain" &&
    request.derivedReasonCodes.some((code) => !abstentionCodes.includes(code))
  ) {
    fail(
      "INCOMPLETE_ABSTENTION_CODES",
      "abstention must preserve every derived reason code",
    );
  }
  if (
    !Array.isArray(output["assertions"]) ||
    output["assertions"].length < 1 ||
    output["assertions"].length > 64
  ) {
    fail("INVALID_ASSERTIONS", "assertions must contain 1 to 64 items");
  }
  const evidenceById = new Map(request.evidence.map((item) => [item.id, item]));
  const assertions = output["assertions"].map((item, index) => {
    const assertion = record(item, `assertions[${index}]`);
    exactKeys(
      assertion,
      ["text", "classification", "citationIds"],
      `assertions[${index}]`,
    );
    const assertionText = text(
      assertion["text"],
      `assertions[${index}].text`,
      2000,
    );
    const classification = assertion["classification"];
    if (
      !["factual", "inference", "stale", "conflicting", "unavailable"].includes(
        classification as string,
      )
    )
      fail(
        "INVALID_ASSERTION_CLASSIFICATION",
        "assertion classification is invalid",
      );
    if (
      !Array.isArray(assertion["citationIds"]) ||
      assertion["citationIds"].length > 16
    )
      fail("INVALID_CITATIONS", "citationIds must be bounded array");
    const citationIds = [
      ...new Set(
        assertion["citationIds"].map((citation, citationIndex) =>
          text(
            citation,
            `assertions[${index}].citationIds[${citationIndex}]`,
            128,
          ),
        ),
      ),
    ].sort();
    const cited = citationIds.map(
      (id) =>
        evidenceById.get(id) ??
        fail("UNKNOWN_CITATION", `citation ${id} is unknown`),
    );
    const citedStatuses = cited.map((evidence) =>
      effectiveEvidenceStatus(
        evidence,
        request.evidence.filter(
          (candidate) => candidate.category === evidence.category,
        ),
        request.asOf,
        policy,
      ),
    );
    if (
      classification === "factual" &&
      (cited.length === 0 ||
        cited.some(
          (evidence, citationIndex) =>
            citedStatuses[citationIndex] !== "verified" ||
            Object.keys(evidence.facts).length === 0,
        ))
    ) {
      fail(
        "UNVERIFIED_FACTUAL_ASSERTION",
        "factual assertions require nonempty verified citations",
      );
    }
    if (
      classification !== "factual" &&
      classification !== "inference" &&
      citedStatuses.some((status) => status !== classification)
    ) {
      fail(
        "CITATION_CLASSIFICATION_MISMATCH",
        "citation status does not match assertion classification",
      );
    }
    return {
      text: assertionText,
      classification:
        classification as ValidatedAnalysisOutput["assertions"][number]["classification"],
      citationIds,
    };
  });
  const summary = text(output["summary"], "output.summary", 4000);
  const canonicalSummary = assertions.map((item) => item.text).join(" ");
  if (summary !== canonicalSummary)
    fail(
      "SUMMARY_ASSERTION_MISMATCH",
      "summary must be the canonical composition of assertion texts",
    );
  if (
    policy.prohibitedClaims.length > 0 &&
    prohibitedPatterns.some((pattern) => pattern.test(summary))
  ) {
    fail(
      "PROHIBITED_CLAIM",
      "output includes a prohibited guarantee, lock, or sharp-proof claim",
    );
  }
  return deepFreeze({
    candidate,
    versions,
    probability: { estimate, low, high, uncertainty },
    status,
    abstentionCodes,
    summary,
    assertions,
  });
}

export function plannedAnalysisAbstention(policy: AnalysisPolicyLike) {
  if (policy.enabled)
    fail(
      "MODULE_ENABLED",
      "planned abstention only applies to disabled modules",
    );
  return deepFreeze({
    status: "abstain" as const,
    reasonCode: policy.plannedReason ?? "planned-module-disabled",
    invokeModel: false as const,
  });
}
