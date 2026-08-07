import {
  canonicalMlbParticipantLabel,
  resolveMlbParticipantKey,
  type IsoTimestamp,
  type OddsNormalizationReason,
  type SportKey,
} from "@find-the-edge/domain";
import { normalizeSportsbook } from "@find-the-edge/config";

import type { ProviderCapability, ProviderDescriptor } from "./index";

export const SHARP_API_PROVIDER_ID = "sharpapi";
export const SHARP_API_BASE_URL = "https://api.sharpapi.io/api/v1";
export const SHARP_API_SECRET_NAME_SUFFIX = "sharpapi";

export type SharpApiDisabledReason =
  | "contract-unverified"
  | "not-entitled"
  | "coverage-unverified"
  | "operator-disabled";

export interface SharpApiCoverageDecision {
  readonly sportKey: SportKey;
  readonly leagueKey: string;
  readonly capability: Extract<ProviderCapability, "odds" | "public-betting">;
  readonly enabled: boolean;
  readonly marketKeys: readonly string[];
  readonly reason?: SharpApiDisabledReason;
}

export interface SharpApiActivationConfig {
  readonly enabled: boolean;
  readonly contractVerified: boolean;
  readonly licensingVerified: boolean;
  readonly coverage: readonly SharpApiCoverageDecision[];
  readonly splitFreshnessSeconds: number;
  readonly quotaReserve: number;
  readonly cooldownSeconds: number;
  readonly recoverySuccesses: number;
}

export interface SharpApiLeague {
  readonly sportKey: SportKey;
  readonly leagueKey:
    "mlb" | "mls" | "epl" | "liga-mx" | "uefa-champions-league";
  /** Exact, catalog-verified SharpAPI league identity. Never fuzzy matched. */
  readonly providerLeague: string;
  readonly moneylineMarket: "moneyline";
}

export const sharpApiLeagues: readonly SharpApiLeague[] = [
  {
    sportKey: "mlb" as SportKey,
    leagueKey: "mlb",
    providerLeague: "MLB",
    moneylineMarket: "moneyline",
  },
  {
    sportKey: "soccer" as SportKey,
    leagueKey: "mls",
    providerLeague: "MLS",
    moneylineMarket: "moneyline",
  },
  {
    sportKey: "soccer" as SportKey,
    leagueKey: "epl",
    providerLeague: "england_-_premier_league",
    moneylineMarket: "moneyline",
  },
  {
    sportKey: "soccer" as SportKey,
    leagueKey: "liga-mx",
    providerLeague: "mexico_-_liga_mx",
    moneylineMarket: "moneyline",
  },
  {
    sportKey: "soccer" as SportKey,
    leagueKey: "uefa-champions-league",
    providerLeague: "uefa_-_champions_league",
    moneylineMarket: "moneyline",
  },
];

export const sharpApiLeagueByKey = (leagueKey: string): SharpApiLeague => {
  const league = sharpApiLeagues.find((entry) => entry.leagueKey === leagueKey);
  if (!league) throw new SharpApiError("configuration");
  return league;
};

export interface SharpApiAccount {
  readonly tier: string;
  readonly features: readonly string[];
  readonly requestsPerMinute: number;
  readonly maxBooks: number;
  readonly streamingEnabled: boolean;
  readonly responseMetadata?: SharpApiResponseMetadata;
}

/** Provider-enforced request window. This is deliberately not the customer's
 * subscription quota: SharpAPI's account response currently exposes RPM, not
 * durable monthly credits. Missing headers remain unknown. */
export interface SharpApiRateWindow {
  readonly limit?: number;
  readonly remaining?: number;
  readonly resetsAt?: IsoTimestamp;
}

export interface SharpApiResponseMetadata {
  readonly rateWindow: SharpApiRateWindow;
  readonly retryAt?: IsoTimestamp;
}

const boundedHeaderInteger = (value: string | null) => {
  if (value === null || !/^\d{1,16}$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
};

export const parseSharpApiResponseMetadata = (
  headers: Headers,
  now = new Date(),
): SharpApiResponseMetadata => {
  const limit = boundedHeaderInteger(
    headers.get("x-ratelimit-limit") ?? headers.get("ratelimit-limit"),
  );
  const remaining = boundedHeaderInteger(
    headers.get("x-ratelimit-remaining") ?? headers.get("ratelimit-remaining"),
  );
  const rawReset =
    headers.get("x-ratelimit-reset") ?? headers.get("ratelimit-reset");
  const resetNumber = boundedHeaderInteger(rawReset);
  const resetMs =
    resetNumber === undefined
      ? rawReset
        ? Date.parse(rawReset)
        : Number.NaN
      : resetNumber > 10_000_000_000
        ? resetNumber
        : resetNumber > now.getTime() / 2_000
          ? resetNumber * 1_000
          : now.getTime() + resetNumber * 1_000;
  const retryAfter = headers.get("retry-after");
  const retrySeconds = boundedHeaderInteger(retryAfter);
  const retryMs =
    retrySeconds !== undefined
      ? now.getTime() + retrySeconds * 1_000
      : retryAfter
        ? Date.parse(retryAfter)
        : Number.NaN;
  return {
    rateWindow: {
      ...(limit === undefined ? {} : { limit }),
      ...(remaining === undefined ? {} : { remaining }),
      ...(Number.isFinite(resetMs)
        ? { resetsAt: new Date(resetMs).toISOString() as IsoTimestamp }
        : {}),
    },
    ...(Number.isFinite(retryMs)
      ? { retryAt: new Date(retryMs).toISOString() as IsoTimestamp }
      : {}),
  };
};

export interface SharpApiPrice {
  readonly providerPriceId: string;
  readonly marketKey: "moneyline" | "spread" | "total" | "btts" | "team_total";
  readonly providerMarketType: string;
  readonly providerMarketId: string;
  readonly selectionKey:
    "away" | "draw" | "home" | "over" | "under" | "yes" | "no";
  readonly participantSide?: "away" | "home";
  readonly outcomeStructure?: "two-way" | "three-way";
  readonly selectionLabel: string;
  readonly providerSelectionId: string;
  readonly point?: number;
  readonly americanOdds: number;
  readonly decimalOdds: number;
  readonly impliedProbability: number;
  readonly publicBetPercent?: number;
  readonly deepLink?: string;
  readonly isLive: boolean;
  readonly isMainLine: boolean;
  readonly isAlternateLine: boolean;
  readonly isPlayerProp: boolean;
  readonly isStalePregamePrice: boolean;
  readonly isActive?: boolean;
  readonly isSuspended?: boolean;
  readonly observedAt: IsoTimestamp;
  /** Local retrieval boundary for durable replay; never sourced from provider input. */
  readonly retrievedAt?: IsoTimestamp;
}

export interface SharpApiBookmaker {
  readonly id: string;
  readonly label: string;
  /** Bounded provider wire identifiers retained for contract verification. */
  readonly providerSportsbookIds?: readonly string[];
  readonly prices: readonly SharpApiPrice[];
}

export interface SharpApiEvent {
  readonly providerEventId: string;
  readonly providerEventUuid: string;
  readonly awayTeam: string;
  readonly homeTeam: string;
  readonly awayClubKey?: string;
  readonly homeClubKey?: string;
  readonly startsAt: IsoTimestamp;
  readonly bookmakers: readonly SharpApiBookmaker[];
}

export interface SharpApiOddsPage {
  readonly events: readonly SharpApiEvent[];
  readonly rejections?: readonly SharpApiNormalizationRejection[];
  readonly hasMore: boolean;
  readonly nextCursor?: string;
  readonly retrievedAt: IsoTimestamp;
  readonly eventRetrievedAt?: Readonly<Record<string, IsoTimestamp>>;
  readonly responseMetadata?: SharpApiResponseMetadata;
}

export interface SharpApiNormalizationRejection {
  readonly providerId: typeof SHARP_API_PROVIDER_ID;
  readonly reason: OddsNormalizationReason;
  readonly auditId: string;
  readonly providerEventId?: string;
  readonly sportsbookId?: string;
  readonly participantBoundaryReason?:
    "participant-out-of-scope" | "same-club-matchup";
}

export interface SharpApiScheduleEvent {
  readonly providerEventId: string;
  readonly awayTeam: string;
  readonly homeTeam: string;
  readonly awayClubKey?: string;
  readonly homeClubKey?: string;
  readonly startsAt: IsoTimestamp;
  readonly status: "scheduled";
}
export interface SharpApiSchedulePage {
  readonly events: readonly SharpApiScheduleEvent[];
  readonly exclusions?: readonly SharpApiScheduleExclusion[];
  readonly hasMore: boolean;
  readonly nextOffset?: number;
  readonly retrievedAt: IsoTimestamp;
  readonly responseMetadata?: SharpApiResponseMetadata;
}

export interface SharpApiScheduleExclusion {
  readonly providerEventId: string;
  readonly reason:
    "participant-out-of-scope" | "same-club-matchup" | "catalogue-derivative";
  readonly auditId: string;
}

const derivativeLabelKind = (value: string) => {
  const label = value.normalize("NFKC").trim().replace(/\s+/g, " ");
  if (/(?:\s-\s|:\s*)player props?$/i.test(label)) return "player-props";
  if (
    /(?:\s-\s|:\s*)(?:first|last|extra|(?:\d+(?:st|nd|rd|th)))(?:\s+(?:one|two|three|four|five|six|seven|eight|nine|\d+))?\s+innings?$/i.test(
      label,
    )
  )
    return "period";
  if (/\b(?:team )?total (?:runs?|goals?|points?)$/i.test(label))
    return "team-total";
  if (
    /^(?:american|national|eastern|western|world)?\s*(?:league|conference|division|series|championship)\s+(?:winner|champion)$/i.test(
      label,
    )
  )
    return "award";
  return null;
};

/** Only paired, recognizable catalogue labels are excluded. A single unusual
 * but legitimate team name is never enough to classify a matchup. */
export const isSharpDerivativeMatchup = (
  awayTeam: string,
  homeTeam: string,
) => {
  const awayKind = derivativeLabelKind(awayTeam);
  return awayKind !== null && derivativeLabelKind(homeTeam) !== null;
};

const canonicalSharpParticipants = (
  league: SharpApiLeague,
  awayTeam: string,
  homeTeam: string,
) => {
  if (league.leagueKey !== "mlb")
    return { kind: "accepted" as const, awayTeam, homeTeam };
  const awayClubKey = resolveMlbParticipantKey(awayTeam);
  const homeClubKey = resolveMlbParticipantKey(homeTeam);
  if (!awayClubKey || !homeClubKey)
    return {
      kind: "rejected" as const,
      reason: "participant-out-of-scope" as const,
    };
  if (awayClubKey === homeClubKey)
    return {
      kind: "rejected" as const,
      reason: "same-club-matchup" as const,
    };
  return {
    kind: "accepted" as const,
    awayTeam: canonicalMlbParticipantLabel(awayClubKey),
    homeTeam: canonicalMlbParticipantLabel(homeClubKey),
    awayClubKey,
    homeClubKey,
  };
};

/** Cursor identity is carried separately so durable orchestration never guesses page progress. */
export interface SharpApiControlPlanePage extends SharpApiOddsPage {
  readonly pageToken: string;
}

export interface SharpApiSplitSelection {
  readonly selectionKey: "away" | "home" | "over" | "under";
  readonly point?: number;
  readonly americanOdds?: number;
  readonly betPercent?: number;
  readonly moneyPercent?: number;
}

export interface SharpApiSplitMarket {
  readonly marketKey: "spread" | "total" | "moneyline";
  readonly selections: readonly SharpApiSplitSelection[];
}

export interface SharpApiSplitEvent {
  readonly providerEventId: string;
  readonly sport: string;
  readonly league: string;
  readonly sportsbookId: string;
  readonly awayTeam: string;
  readonly homeTeam: string;
  readonly providerTimestamp: IsoTimestamp;
  readonly markets: readonly SharpApiSplitMarket[];
}

export interface SharpApiSplitPage {
  readonly items: readonly SharpApiSplitEvent[];
  readonly hasMore: boolean;
  readonly nextOffset?: number;
  readonly retrievedAt: IsoTimestamp;
  readonly responseMetadata?: SharpApiResponseMetadata;
}

export interface SharpApiSplitHistoryPage {
  readonly items: readonly SharpApiSplitEvent[];
  readonly retrievedAt: IsoTimestamp;
  readonly responseMetadata?: SharpApiResponseMetadata;
}

export class SharpApiError extends Error {
  override readonly name = "SharpApiError";
  constructor(
    readonly code:
      | "configuration"
      | "unauthorized"
      | "not-entitled"
      | "rate-limited"
      | "provider-request-ambiguous"
      | "provider-unavailable"
      | "provider-rejected"
      | "invalid-response",
    readonly retryable = false,
    readonly retryAt?: IsoTimestamp,
    readonly stage?: string,
  ) {
    super(code);
  }
}

const canonical = (value: unknown, maximum = 256): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= maximum &&
  value === value.trim();
const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);
const integer = (value: unknown): value is number =>
  finite(value) && Number.isInteger(value);
const instant = (value: unknown): value is IsoTimestamp =>
  canonical(value, 40) && Number.isFinite(Date.parse(value));
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const iso = (value: string) => new Date(value).toISOString() as IsoTimestamp;
const MAX_RESPONSE_BYTES = 10_000_000;

type SharpApiEndpoint =
  | "account"
  | "odds"
  | "focused-odds"
  | "schedule"
  | "splits"
  | "splits-history";

const invalidResponse = (endpoint: SharpApiEndpoint, stage: string) =>
  new SharpApiError(
    "invalid-response",
    false,
    undefined,
    `${endpoint}:${stage}`,
  );

const rethrowInvalidResponseAt = (
  error: unknown,
  endpoint: SharpApiEndpoint,
): never => {
  if (
    error instanceof SharpApiError &&
    error.code === "invalid-response" &&
    !error.stage
  )
    throw invalidResponse(endpoint, "unknown");
  throw error;
};

const isEmptyProviderErrorSentinel = (value: unknown) =>
  value === null ||
  value === undefined ||
  value === false ||
  value === "" ||
  (Array.isArray(value) && value.length === 0) ||
  (record(value) && Object.keys(value).length === 0);

const providerEnvelopeIssue = (
  payload: Record<string, unknown>,
): "declared-error" | "malformed" | undefined => {
  if (
    Object.prototype.hasOwnProperty.call(payload, "success") &&
    typeof payload["success"] !== "boolean"
  )
    return "malformed";
  if (payload["success"] === false) return "declared-error";
  return ["error", "errors"].some(
    (key) =>
      Object.prototype.hasOwnProperty.call(payload, key) &&
      !isEmptyProviderErrorSentinel(payload[key]),
  )
    ? "declared-error"
    : undefined;
};

const assertProviderEnvelope = (
  payload: Record<string, unknown>,
  endpoint: SharpApiEndpoint,
) => {
  const issue = providerEnvelopeIssue(payload);
  if (issue === "declared-error")
    throw new SharpApiError(
      "provider-rejected",
      false,
      undefined,
      `${endpoint}:provider-error`,
    );
  if (issue === "malformed") throw invalidResponse(endpoint, "envelope");
};

const boundedJson = async (
  response: Response,
  endpoint: SharpApiEndpoint,
): Promise<unknown> => {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES)
    throw invalidResponse(endpoint, "content-length");
  const raw = await response.text();
  if (new TextEncoder().encode(raw).byteLength > MAX_RESPONSE_BYTES)
    throw invalidResponse(endpoint, "body-size");
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw invalidResponse(endpoint, "json");
  }
};

const request = async (
  path: string,
  endpoint: SharpApiEndpoint,
  apiKey: string,
  fetcher: typeof fetch,
): Promise<{
  readonly payload: unknown;
  readonly metadata: SharpApiResponseMetadata;
}> => {
  if (!canonical(apiKey, 512)) throw new SharpApiError("configuration");
  let response: Response;
  try {
    response = await fetcher(`${SHARP_API_BASE_URL}${path}`, {
      signal: AbortSignal.timeout(10_000),
      headers: { accept: "application/json", "X-API-Key": apiKey },
    });
  } catch {
    // A transport failure after dispatch has unknown provider-side outcome. It
    // must be reconciled rather than blindly repeated.
    throw new SharpApiError("provider-request-ambiguous", false);
  }
  if (!response.ok) {
    if ([401, 403].includes(response.status)) {
      let body: unknown;
      try {
        body = await boundedJson(response, endpoint);
      } catch {
        throw new SharpApiError("unauthorized");
      }
      const error = record(body) && record(body["error"]) ? body["error"] : {};
      if (error["code"] === "tier_restricted")
        throw new SharpApiError("not-entitled");
      throw new SharpApiError("unauthorized");
    }
    if (response.status === 429) {
      const retryAt = parseSharpApiResponseMetadata(response.headers).retryAt;
      throw new SharpApiError("rate-limited", true, retryAt);
    }
    throw new SharpApiError(
      response.status >= 500 ? "provider-unavailable" : "provider-rejected",
      response.status >= 500,
    );
  }
  return {
    payload: await boundedJson(response, endpoint),
    metadata: parseSharpApiResponseMetadata(response.headers),
  };
};

export function parseSharpApiAccount(input: unknown): SharpApiAccount {
  if (!record(input)) throw invalidResponse("account", "envelope");
  assertProviderEnvelope(input, "account");
  if (!record(input["data"])) throw invalidResponse("account", "envelope");
  const data = input["data"];
  const rate = data["rate_limit"];
  const streaming = data["streaming"];
  if (
    !canonical(data["tier"], 32) ||
    !Array.isArray(data["features"]) ||
    !data["features"].every((feature) => canonical(feature, 64)) ||
    !record(rate) ||
    !integer(rate["requests_per_minute"]) ||
    !integer(rate["max_books"]) ||
    !record(streaming) ||
    typeof streaming["enabled"] !== "boolean"
  )
    throw invalidResponse("account", "data");
  return {
    tier: data["tier"],
    features: [...data["features"]] as string[],
    requestsPerMinute: rate["requests_per_minute"],
    maxBooks: rate["max_books"],
    streamingEnabled: streaming["enabled"],
  };
}

const selection = (
  raw: Record<string, unknown>,
  league: SharpApiLeague,
): SharpApiPrice["selectionKey"] | undefined => {
  const type =
    typeof raw["selection_type"] === "string"
      ? raw["selection_type"].toLowerCase()
      : "";
  const label = typeof raw["selection"] === "string" ? raw["selection"] : "";
  if (["away", "home", "draw", "over", "under", "yes", "no"].includes(type))
    return type as SharpApiPrice["selectionKey"];
  if (label === raw["away_team"]) return "away";
  if (label === raw["home_team"]) return "home";
  if (/^draw$/i.test(label) && String(league.sportKey) === "soccer")
    return "draw";
  if (/^over\b/i.test(label)) return "over";
  if (/^under\b/i.test(label)) return "under";
  if (/^yes$/i.test(label)) return "yes";
  if (/^no$/i.test(label)) return "no";
  return undefined;
};

const market = (
  raw: Record<string, unknown>,
  league: SharpApiLeague,
): SharpApiPrice["marketKey"] | undefined => {
  const value =
    typeof raw["market_type"] === "string"
      ? raw["market_type"].toLowerCase()
      : "";
  if (value === "moneyline" || value === "moneyline_3-way")
    return league.moneylineMarket;
  if (["point_spread", "run_line", "puck_line"].includes(value))
    return "spread";
  if (["total_points", "total_goals", "total_runs"].includes(value))
    return "total";
  if (["both_teams_to_score", "btts"].includes(value)) return "btts";
  if (
    ["team_total_points", "team_total_goals", "team_total_runs"].includes(value)
  )
    return "team_total";
  return undefined;
};

const auditId = (value: unknown) =>
  (typeof value === "string" ? value : "unknown")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "")
    .slice(0, 64) || "unknown";

const providerInstant = (value: unknown): value is IsoTimestamp => {
  if (typeof value !== "string") return false;
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/.exec(
      value,
    );
  if (!match) return false;
  const [, year, month, day, hour, minute, second, zoneHour, zoneMinute] =
    match;
  const y = Number(year);
  const m = Number(month);
  const d = Number(day);
  return (
    m >= 1 &&
    m <= 12 &&
    d >= 1 &&
    d <= new Date(Date.UTC(y, m, 0)).getUTCDate() &&
    Number(hour) <= 23 &&
    Number(minute) <= 59 &&
    Number(second) <= 59 &&
    (zoneHour === undefined || Number(zoneHour) <= 23) &&
    (zoneMinute === undefined || Number(zoneMinute) <= 59) &&
    Number.isFinite(Date.parse(value))
  );
};

const teamName = (raw: Record<string, unknown>, side: "away" | "home") => {
  const reference = raw[side];
  if (record(reference) && canonical(reference["name"]))
    return reference["name"];
  const flat = raw[`${side}_team`];
  return canonical(flat) ? flat : undefined;
};

export function parseSharpApiOddsPage(
  input: unknown,
  league: SharpApiLeague,
  retrievedAt: IsoTimestamp,
  maximumRows = 200,
  requestKind: "initial" | "cursor" | "focused" = "initial",
): SharpApiOddsPage {
  const endpoint: SharpApiEndpoint =
    requestKind === "focused" ? "focused-odds" : "odds";
  const payload = record(input) ? input : undefined;
  if (payload) assertProviderEnvelope(payload, endpoint);
  const pagination = payload?.["pagination"];
  const terminalCount = record(pagination) ? pagination["count"] : undefined;
  const terminalTotal = record(pagination) ? pagination["total"] : undefined;
  const commonTerminalPagination =
    record(pagination) &&
    pagination["has_more"] === false &&
    (pagination["next_cursor"] === null ||
      pagination["next_cursor"] === undefined);
  const initialZeroEvidence = terminalCount === 0 && terminalTotal === 0;
  const cursorZeroEvidence =
    (terminalCount === null ||
      terminalCount === undefined ||
      terminalCount === 0) &&
    (terminalTotal === null ||
      terminalTotal === undefined ||
      (integer(terminalTotal) && terminalTotal >= 0)) &&
    (terminalCount === 0 || (integer(terminalTotal) && terminalTotal >= 0));
  const terminalPagination =
    commonTerminalPagination &&
    (requestKind === "initial" || requestKind === "focused"
      ? initialZeroEvidence
      : requestKind === "cursor"
        ? cursorZeroEvidence
        : false);
  const explicitlyEmpty =
    payload?.["data"] === null && terminalPagination && payload !== undefined;
  if (
    !payload ||
    (!explicitlyEmpty && !Array.isArray(payload["data"])) ||
    (Array.isArray(payload["data"]) && payload["data"].length > maximumRows)
  )
    throw invalidResponse(endpoint, "page-envelope");
  const data = explicitlyEmpty ? [] : (payload["data"] as unknown[]);
  if (record(pagination) && Array.isArray(payload["data"])) {
    const count = pagination["count"];
    const total = pagination["total"];
    if (
      (count !== null &&
        count !== undefined &&
        (!integer(count) || count < 0 || count !== data.length)) ||
      (total !== null &&
        total !== undefined &&
        (!integer(total) || total < data.length)) ||
      (integer(count) && integer(total) && count > total) ||
      (requestKind !== "cursor" &&
        pagination["has_more"] === false &&
        integer(total) &&
        total !== data.length) ||
      (pagination["has_more"] === false &&
        pagination["next_cursor"] !== null &&
        pagination["next_cursor"] !== undefined)
    )
      throw invalidResponse(endpoint, "pagination-coherence");
  }
  const deduplicatedRows: (Record<string, unknown> | null)[] = [];
  const rejections: SharpApiNormalizationRejection[] = [];
  const priceIdentities = new Map<
    string,
    { readonly signature: string; readonly index: number }
  >();
  for (const candidate of data) {
    if (!record(candidate)) {
      rejections.push({
        providerId: SHARP_API_PROVIDER_ID,
        reason: "incomplete-market",
        auditId: "non-record-row",
      });
      continue;
    }
    let value: Record<string, unknown> = candidate;
    const providerSportsbookId =
      typeof value["sportsbook"] === "string" ? value["sportsbook"] : "";
    const bookResult = normalizeSportsbook(providerSportsbookId);
    if (bookResult.kind === "rejected") {
      rejections.push({
        providerId: SHARP_API_PROVIDER_ID,
        reason: bookResult.reason,
        auditId: bookResult.auditId,
        ...(canonical(value["event_id"])
          ? { providerEventId: value["event_id"] }
          : {}),
      });
      continue;
    }
    value = {
      ...value,
      provider_sportsbook_id: providerSportsbookId,
      sportsbook: bookResult.sportsbook.id,
    };
    const marketKey = market(value, league);
    if (!marketKey) {
      rejections.push({
        providerId: SHARP_API_PROVIDER_ID,
        reason: "unsupported-market",
        auditId: auditId(value["market_type"]),
        sportsbookId: bookResult.sportsbook.id,
        ...(canonical(value["event_id"])
          ? { providerEventId: value["event_id"] }
          : {}),
      });
      continue;
    }
    const selectionKey = selection(value, league);
    if (!selectionKey) {
      rejections.push({
        providerId: SHARP_API_PROVIDER_ID,
        reason: "unsupported-selection",
        auditId: auditId(value["selection_type"] ?? value["selection"]),
        sportsbookId: bookResult.sportsbook.id,
        ...(canonical(value["event_id"])
          ? { providerEventId: value["event_id"] }
          : {}),
      });
      continue;
    }
    const compatible =
      (marketKey === "moneyline" &&
        ["away", "home", "draw"].includes(selectionKey)) ||
      (marketKey === "spread" && ["away", "home"].includes(selectionKey)) ||
      (marketKey === "total" && ["over", "under"].includes(selectionKey)) ||
      (marketKey === "btts" && ["yes", "no"].includes(selectionKey)) ||
      (marketKey === "team_total" && ["over", "under"].includes(selectionKey));
    if (!compatible) {
      rejections.push({
        providerId: SHARP_API_PROVIDER_ID,
        reason: "unsupported-selection",
        auditId: auditId(value["selection_type"] ?? value["selection"]),
        sportsbookId: bookResult.sportsbook.id,
        ...(canonical(value["event_id"])
          ? { providerEventId: value["event_id"] }
          : {}),
      });
      continue;
    }
    if (typeof value["is_active"] !== "boolean") {
      rejections.push({
        providerId: SHARP_API_PROVIDER_ID,
        reason: "incomplete-market",
        auditId: auditId(value["id"]),
        sportsbookId: bookResult.sportsbook.id,
        ...(canonical(value["event_id"])
          ? { providerEventId: value["event_id"] }
          : {}),
      });
      continue;
    }
    if (marketKey === "btts" && !["yes", "no"].includes(selectionKey)) {
      rejections.push({
        providerId: SHARP_API_PROVIDER_ID,
        reason: "unsupported-selection",
        auditId: auditId(value["selection_type"] ?? value["selection"]),
        sportsbookId: bookResult.sportsbook.id,
        ...(canonical(value["event_id"])
          ? { providerEventId: value["event_id"] }
          : {}),
      });
      continue;
    }
    if (
      marketKey === "team_total" &&
      !["over", "under"].includes(selectionKey)
    ) {
      rejections.push({
        providerId: SHARP_API_PROVIDER_ID,
        reason: "unsupported-selection",
        auditId: auditId(value["selection_type"] ?? value["selection"]),
        sportsbookId: bookResult.sportsbook.id,
        ...(canonical(value["event_id"])
          ? { providerEventId: value["event_id"] }
          : {}),
      });
      continue;
    }
    if (!providerInstant(value["timestamp"])) {
      rejections.push({
        providerId: SHARP_API_PROVIDER_ID,
        reason: "missing-provider-timestamp",
        auditId: auditId(value["id"]),
        sportsbookId: bookResult.sportsbook.id,
        ...(canonical(value["event_id"])
          ? { providerEventId: value["event_id"] }
          : {}),
      });
      if (canonical(value["id"])) {
        const previous = priceIdentities.get(value["id"]);
        if (previous) deduplicatedRows[previous.index] = null;
      }
      continue;
    }
    if (
      marketKey === "team_total" &&
      value["participant_side"] !== "away" &&
      value["participant_side"] !== "home"
    ) {
      rejections.push({
        providerId: SHARP_API_PROVIDER_ID,
        reason: "participant-unavailable",
        auditId: auditId(value["selection_id"]),
        sportsbookId: bookResult.sportsbook.id,
        ...(canonical(value["event_id"])
          ? { providerEventId: value["event_id"] }
          : {}),
      });
      continue;
    }
    const awayTeam = teamName(value, "away");
    const homeTeam = teamName(value, "home");
    if (
      !canonical(value["id"]) ||
      !canonical(value["event_id"]) ||
      !canonical(value["event_uuid"]) ||
      !awayTeam ||
      !homeTeam ||
      !instant(value["event_start_time"]) ||
      !canonical(value["sportsbook"], 128) ||
      !canonical(value["market_type"], 128) ||
      !canonical(value["market_id"]) ||
      !canonical(value["selection"]) ||
      !canonical(value["selection_id"])
    ) {
      rejections.push({
        providerId: SHARP_API_PROVIDER_ID,
        reason: "incomplete-market",
        auditId: auditId(value["id"]),
        ...(canonical(value["sportsbook"], 128)
          ? { sportsbookId: value["sportsbook"] }
          : {}),
        ...(canonical(value["event_id"])
          ? { providerEventId: value["event_id"] }
          : {}),
      });
      continue;
    }
    const participants = canonicalSharpParticipants(league, awayTeam, homeTeam);
    if (participants.kind === "rejected") {
      rejections.push({
        providerId: SHARP_API_PROVIDER_ID,
        reason: "participant-unavailable",
        auditId: auditId(value["id"]),
        providerEventId: value["event_id"],
        sportsbookId: value["sportsbook"],
        participantBoundaryReason: participants.reason,
      });
      continue;
    }
    const signature = JSON.stringify([
      value["event_id"],
      value["event_uuid"],
      participants.awayTeam,
      participants.homeTeam,
      Date.parse(value["event_start_time"]),
      value["sportsbook"],
      value["market_type"],
      value["market_id"],
      value["selection"],
      value["selection_id"],
    ]);
    const previous = priceIdentities.get(value["id"]);
    if (previous) {
      if (previous.signature !== signature) {
        deduplicatedRows[previous.index] = null;
        rejections.push({
          providerId: SHARP_API_PROVIDER_ID,
          reason: "incomplete-market",
          auditId: auditId(value["id"]),
          providerEventId: value["event_id"],
          sportsbookId: value["sportsbook"],
        });
        continue;
      }
      // SharpAPI snapshots can repeat a stable price id after repricing it.
      // Provider order is authoritative when timestamps have only coarse precision.
      deduplicatedRows[previous.index] = value;
      continue;
    }
    priceIdentities.set(value["id"], {
      signature,
      index: deduplicatedRows.length,
    });
    deduplicatedRows.push(value);
  }
  const grouped = new Map<string, Map<string, SharpApiPrice[]>>();
  const providerSportsbookIds = new Map<string, Map<string, Set<string>>>();
  const identities = new Map<string, Omit<SharpApiEvent, "bookmakers">>();
  for (const value of deduplicatedRows) {
    if (!value) continue;
    const marketKey = market(value, league);
    const selectionKey = selection(value, league);
    if (!marketKey || !selectionKey) continue;
    const awayTeam = teamName(value, "away");
    const homeTeam = teamName(value, "home");
    if (
      !canonical(value["id"]) ||
      !canonical(value["event_id"]) ||
      !canonical(value["event_uuid"]) ||
      !awayTeam ||
      !homeTeam ||
      awayTeam === homeTeam ||
      !instant(value["event_start_time"]) ||
      !canonical(value["sportsbook"], 128) ||
      !canonical(value["market_type"], 128) ||
      !canonical(value["market_id"]) ||
      !canonical(value["selection"]) ||
      !canonical(value["selection_id"]) ||
      !integer(value["odds_american"]) ||
      Math.abs(value["odds_american"]) < 100 ||
      !finite(value["odds_decimal"]) ||
      value["odds_decimal"] <= 1 ||
      !finite(value["odds_probability"]) ||
      value["odds_probability"] < 0 ||
      value["odds_probability"] > 1 ||
      !instant(value["timestamp"])
    ) {
      rejections.push({
        providerId: SHARP_API_PROVIDER_ID,
        reason: "incomplete-market",
        auditId: auditId(value["id"]),
        ...(canonical(value["event_id"])
          ? { providerEventId: value["event_id"] }
          : {}),
        ...(canonical(value["sportsbook"], 128)
          ? { sportsbookId: value["sportsbook"] }
          : {}),
      });
      continue;
    }
    const participants = canonicalSharpParticipants(league, awayTeam, homeTeam);
    if (participants.kind === "rejected") continue;
    const eventId = value["event_id"];
    const existing = identities.get(eventId);
    let identity: Omit<SharpApiEvent, "bookmakers"> = {
      providerEventId: eventId,
      providerEventUuid: value["event_uuid"],
      awayTeam: participants.awayTeam,
      homeTeam: participants.homeTeam,
      ...(participants.awayClubKey
        ? {
            awayClubKey: participants.awayClubKey,
            homeClubKey: participants.homeClubKey,
          }
        : {}),
      startsAt: iso(value["event_start_time"]),
    };
    if (existing) {
      const sameOrientation =
        existing.awayTeam === identity.awayTeam &&
        existing.homeTeam === identity.homeTeam;
      const reversedOrientation =
        existing.awayTeam === identity.homeTeam &&
        existing.homeTeam === identity.awayTeam;
      if (
        existing.providerEventUuid !== identity.providerEventUuid ||
        (!sameOrientation && !reversedOrientation)
      )
        continue;
      // The schedule endpoint is authoritative for event time. Sportsbook rows
      // for the same exact event UUID can retain an older pre-delay start.
      // Keep the first normalized identity and merge only its compatible books.
      // A minority of SharpAPI sportsbook rows reverse soccer participants.
      // Dropping the outlier is safer than assigning its prices to the wrong side.
      if (reversedOrientation) continue;
      identity = existing;
    }
    identities.set(eventId, identity);
    const books = grouped.get(eventId) ?? new Map<string, SharpApiPrice[]>();
    const book = value["sportsbook"];
    const prices = books.get(book) ?? [];
    const line = value["line"];
    if ((marketKey === "spread" || marketKey === "total") && !finite(line)) {
      rejections.push({
        providerId: SHARP_API_PROVIDER_ID,
        reason: "incomplete-market",
        auditId: auditId(value["id"]),
        providerEventId: value["event_id"],
        sportsbookId: value["sportsbook"],
      });
      continue;
    }
    const publicPct = value["public_bet_pct"];
    if (
      publicPct !== undefined &&
      publicPct !== null &&
      (!finite(publicPct) || publicPct < 0 || publicPct > 1)
    ) {
      rejections.push({
        providerId: SHARP_API_PROVIDER_ID,
        reason: "incomplete-market",
        auditId: auditId(value["id"]),
        providerEventId: value["event_id"],
        sportsbookId: value["sportsbook"],
      });
      continue;
    }
    prices.push({
      providerPriceId: value["id"],
      marketKey,
      providerMarketType: value["market_type"],
      providerMarketId: value["market_id"],
      selectionKey,
      ...(marketKey === "moneyline"
        ? {
            outcomeStructure:
              value["market_type"] === "moneyline_3-way"
                ? ("three-way" as const)
                : ("two-way" as const),
          }
        : {}),
      ...(marketKey === "team_total" &&
      (value["participant_side"] === "away" ||
        value["participant_side"] === "home")
        ? { participantSide: value["participant_side"] }
        : {}),
      selectionLabel: value["selection"],
      providerSelectionId: value["selection_id"],
      ...(finite(line) ? { point: line } : {}),
      americanOdds: value["odds_american"],
      decimalOdds: value["odds_decimal"],
      impliedProbability: value["odds_probability"],
      ...(publicPct === undefined || publicPct === null
        ? {}
        : { publicBetPercent: publicPct * 100 }),
      ...(canonical(value["deep_link"], 2048)
        ? { deepLink: value["deep_link"] }
        : {}),
      isLive: value["is_live"] === true,
      isMainLine: value["is_main_line"] === true,
      isAlternateLine: value["is_alternate_line"] === true,
      isPlayerProp: value["is_player_prop"] === true,
      isStalePregamePrice: value["is_stale_pregame_price"] === true,
      isActive: value["is_active"] !== false,
      isSuspended: value["is_active"] === false,
      observedAt: iso(value["timestamp"]),
      retrievedAt,
    });
    books.set(book, prices);
    grouped.set(eventId, books);
    const eventProviderIds =
      providerSportsbookIds.get(eventId) ?? new Map<string, Set<string>>();
    const bookProviderIds = eventProviderIds.get(book) ?? new Set<string>();
    if (canonical(value["provider_sportsbook_id"], 128))
      bookProviderIds.add(value["provider_sportsbook_id"]);
    eventProviderIds.set(book, bookProviderIds);
    providerSportsbookIds.set(eventId, eventProviderIds);
  }
  if (!record(pagination) || typeof pagination["has_more"] !== "boolean")
    throw invalidResponse(endpoint, "pagination-envelope");
  const nextCursor = pagination["next_cursor"];
  if (pagination["has_more"] && !canonical(nextCursor, 4096))
    throw invalidResponse(endpoint, "pagination-cursor");
  return {
    events: [...identities].map(([eventId, identity]) => ({
      ...identity,
      bookmakers: [...(grouped.get(eventId) ?? [])].map(([id, prices]) => ({
        id,
        label: id,
        providerSportsbookIds: [
          ...(providerSportsbookIds.get(eventId)?.get(id) ?? []),
        ]
          .sort()
          .slice(0, 16),
        prices,
      })),
    })),
    rejections,
    hasMore: pagination["has_more"],
    ...(canonical(nextCursor, 4096) ? { nextCursor } : {}),
    retrievedAt,
  };
}

export function parseSharpApiSchedulePage(
  input: unknown,
  league: SharpApiLeague,
  retrievedAt: IsoTimestamp,
): SharpApiSchedulePage {
  const invalid = (stage: string) => invalidResponse("schedule", stage);
  if (!record(input)) throw invalid("page-envelope");
  assertProviderEnvelope(input, "schedule");
  if (
    !Array.isArray(input["data"]) ||
    input["data"].length > 200 ||
    !record(input["pagination"]) ||
    typeof input["pagination"]["has_more"] !== "boolean"
  )
    throw invalid("page-envelope");
  const events: SharpApiScheduleEvent[] = [];
  const exclusions: SharpApiScheduleExclusion[] = [];
  const ids = new Set<string>();
  for (const value of input["data"]) {
    if (
      !record(value) ||
      !canonical(value["id"]) ||
      !canonical(value["league"], 64)
    )
      throw invalid("event-identity");
    // The endpoint can include valid but differently shaped rows from related
    // catalogues despite an exact filter. League identity is the only field we
    // need in order to exclude those rows safely.
    if (
      ![league.leagueKey, league.providerLeague.toLowerCase()].includes(
        value["league"].toLowerCase(),
      )
    )
      continue;
    if (
      !instant(value["start_time"]) ||
      value["status"] !== "upcoming" ||
      value["is_live"] !== false ||
      (value["away_team"] !== null &&
        !["string", "undefined"].includes(typeof value["away_team"])) ||
      (value["home_team"] !== null &&
        !["string", "undefined"].includes(typeof value["home_team"])) ||
      (typeof value["away_team"] === "string" &&
        value["away_team"].length > 512) ||
      (typeof value["home_team"] === "string" &&
        value["home_team"].length > 512)
    )
      throw invalid("event-shape");
    const awayTeam = value["away_team"];
    const homeTeam = value["home_team"];
    if (ids.has(value["id"])) throw invalid("duplicate-event");
    ids.add(value["id"]);
    // Sharp includes futures/binary propositions in this catalogue. Those
    // records intentionally have a missing participant and are not games.
    if (
      typeof awayTeam !== "string" ||
      awayTeam.length === 0 ||
      typeof homeTeam !== "string" ||
      homeTeam.length === 0
    )
      continue;
    if (!canonical(awayTeam) || !canonical(homeTeam))
      throw invalid("participants");
    // Sharp's MLB event catalogue can contain thin, book-specific derivative
    // rows whose participant labels happen to be real clubs. A lone run-line
    // record is not a scheduled game and has previously created phantom games
    // with provider-generated timestamps. Full-game MLB events expose at least
    // one unambiguous primary market in the catalogue metadata.
    const markets = value["markets"];
    if (
      league.leagueKey === "mlb" &&
      Array.isArray(markets) &&
      !markets.includes("moneyline") &&
      !markets.includes("total_runs")
    ) {
      exclusions.push({
        providerEventId: value["id"],
        reason: "catalogue-derivative",
        auditId: auditId(value["id"]),
      });
      continue;
    }
    if (awayTeam === homeTeam) {
      exclusions.push({
        providerEventId: value["id"],
        reason: "same-club-matchup",
        auditId: auditId(value["id"]),
      });
      continue;
    }
    const participants = canonicalSharpParticipants(league, awayTeam, homeTeam);
    if (participants.kind === "rejected") {
      exclusions.push({
        providerEventId: value["id"],
        reason: participants.reason,
        auditId: auditId(value["id"]),
      });
      continue;
    }
    if (
      league.leagueKey !== "mlb" &&
      isSharpDerivativeMatchup(awayTeam, homeTeam)
    )
      continue;
    events.push({
      providerEventId: value["id"],
      awayTeam: participants.awayTeam,
      homeTeam: participants.homeTeam,
      ...(participants.awayClubKey
        ? {
            awayClubKey: participants.awayClubKey,
            homeClubKey: participants.homeClubKey,
          }
        : {}),
      startsAt: iso(value["start_time"]),
      status: "scheduled",
    });
  }
  const next = input["pagination"]["next_offset"];
  if (next !== null && next !== undefined && (!integer(next) || next < 0))
    throw invalid("pagination-offset");
  return {
    events,
    ...(exclusions.length > 0 ? { exclusions } : {}),
    hasMore: input["pagination"]["has_more"],
    ...(integer(next) ? { nextOffset: next } : {}),
    retrievedAt,
  };
}

const splitPercent = (value: unknown) => {
  if (!finite(value) || value < 0 || value > 1)
    throw invalidResponse("splits", "percentage");
  return Math.round(value * 10_000) / 100;
};

export function parseSharpApiSplitPage(
  input: unknown,
  retrievedAt: IsoTimestamp,
): SharpApiSplitPage {
  const invalid = (stage: string) => invalidResponse("splits", stage);
  if (!record(input)) throw invalid("page-envelope");
  assertProviderEnvelope(input, "splits");
  const pagination = input["pagination"];
  if (!record(pagination) || typeof pagination["has_more"] !== "boolean")
    throw invalid("pagination-envelope");
  const emptyPage =
    input["data"] === null &&
    pagination["has_more"] === false &&
    pagination["count"] === 0 &&
    pagination["total"] === 0;
  if (
    (!emptyPage && !Array.isArray(input["data"])) ||
    (Array.isArray(input["data"]) && input["data"].length > 200)
  )
    throw invalid("data-envelope");
  const data = emptyPage ? [] : (input["data"] as unknown[]);
  const items = data.map((value): SharpApiSplitEvent => {
    if (
      !record(value) ||
      !canonical(value["event_id"]) ||
      !canonical(value["sport"]) ||
      !canonical(value["league"]) ||
      !canonical(value["sportsbook"], 128) ||
      !canonical(value["away_team"]) ||
      !canonical(value["home_team"]) ||
      !instant(value["fetched_at"])
    )
      throw invalid("event-shape");
    const markets: SharpApiSplitMarket[] = [];
    const add = (
      marketKey: SharpApiSplitMarket["marketKey"],
      sides: readonly SharpApiSplitSelection["selectionKey"][],
      pointField: "line" | "odds",
    ) => {
      const raw = value[marketKey];
      if (raw === null || raw === undefined) return;
      if (!record(raw)) throw invalid("market-shape");
      const handle = record(raw["handle_pct"]) ? raw["handle_pct"] : undefined;
      const bets = record(raw["bets_pct"]) ? raw["bets_pct"] : undefined;
      if (!handle && !bets) throw invalid("market-percentages");
      const selections = sides.flatMap((side) => {
        const pointValue =
          marketKey === "total" ? raw["line"] : raw[`${side}_${pointField}`];
        const rawBetPercent = bets?.[side] ?? undefined;
        const rawMoneyPercent = handle?.[side] ?? undefined;
        const betPercent =
          rawBetPercent === undefined ? undefined : splitPercent(rawBetPercent);
        const moneyPercent =
          rawMoneyPercent === undefined
            ? undefined
            : splitPercent(rawMoneyPercent);
        if (betPercent === undefined && moneyPercent === undefined) return [];
        return [
          {
            selectionKey: side,
            ...(finite(pointValue)
              ? marketKey === "moneyline"
                ? { americanOdds: pointValue }
                : { point: pointValue }
              : {}),
            ...(betPercent === undefined ? {} : { betPercent }),
            ...(moneyPercent === undefined ? {} : { moneyPercent }),
          },
        ];
      });
      if (selections.length > 0) markets.push({ marketKey, selections });
    };
    add("spread", ["away", "home"], "odds");
    add("total", ["over", "under"], "odds");
    add("moneyline", ["away", "home"], "odds");
    return {
      providerEventId: value["event_id"],
      sport: value["sport"],
      league: value["league"],
      sportsbookId: value["sportsbook"],
      awayTeam: value["away_team"],
      homeTeam: value["home_team"],
      providerTimestamp: iso(value["fetched_at"]),
      markets,
    };
  });
  const nextOffset = pagination["next_offset"];
  if (nextOffset !== null && nextOffset !== undefined && !integer(nextOffset))
    throw invalid("pagination-offset");
  return {
    items,
    hasMore: pagination["has_more"],
    ...(integer(nextOffset) ? { nextOffset } : {}),
    retrievedAt,
  };
}

export function parseSharpApiSplitHistoryPage(
  input: unknown,
  sourceEvent: SharpApiSplitEvent,
  retrievedAt: IsoTimestamp,
  startTime: IsoTimestamp,
  endTime: IsoTimestamp,
): SharpApiSplitHistoryPage {
  const invalid = (stage: string) => invalidResponse("splits-history", stage);
  if (!record(input)) throw invalid("page-envelope");
  assertProviderEnvelope(input, "splits-history");
  const meta = input["meta"];
  const data = input["data"];
  // This endpoint has no cursor. A full page could be the oldest 200 rows of
  // a truncated result, so fail closed instead of treating it as the latest.
  if (!record(meta) || !Array.isArray(data) || data.length >= 200)
    throw invalid("data-envelope");
  if (
    meta["event_id"] !== sourceEvent.providerEventId ||
    !integer(meta["total"]) ||
    meta["total"] !== data.length ||
    !instant(meta["updated_at"])
  )
    throw invalid("metadata");
  const metaBookValues = meta["books"];
  if (
    data.length === 0
      ? metaBookValues !== undefined &&
        (!Array.isArray(metaBookValues) || metaBookValues.length > 0)
      : !Array.isArray(metaBookValues) ||
        metaBookValues.some((book) => !canonical(book, 128))
  )
    throw invalid("metadata-books");
  if (!instant(startTime) || !instant(endTime)) throw invalid("window");
  const startMs = Date.parse(startTime);
  const endMs = Date.parse(endTime);
  if (startMs > endMs) throw invalid("window");

  const items = data.map((value): SharpApiSplitEvent => {
    if (
      !record(value) ||
      !canonical(value["book"], 128) ||
      !instant(value["ts"]) ||
      !finite(value["timestamp"])
    )
      throw invalid("event-shape");
    const providerTimestamp = iso(value["ts"]);
    const providerMs = Date.parse(providerTimestamp);
    if (
      providerMs < startMs ||
      providerMs > endMs ||
      Math.abs(providerMs - value["timestamp"] * 1_000) > 2_000
    )
      throw invalid("event-timestamp");
    const markets: SharpApiSplitMarket[] = [];
    const add = (
      marketKey: SharpApiSplitMarket["marketKey"],
      sides: readonly SharpApiSplitSelection["selectionKey"][],
      pointField: "line" | "odds",
    ) => {
      const raw = value[marketKey];
      if (raw === null || raw === undefined) return;
      if (!record(raw)) throw invalid("market-shape");
      const handle = record(raw["handle_pct"]) ? raw["handle_pct"] : undefined;
      const bets = record(raw["bets_pct"]) ? raw["bets_pct"] : undefined;
      if (!handle && !bets) throw invalid("market-percentages");
      const selections = sides.flatMap((side) => {
        const pointValue =
          marketKey === "total" ? raw["line"] : raw[`${side}_${pointField}`];
        const rawBetPercent = bets?.[side] ?? undefined;
        const rawMoneyPercent = handle?.[side] ?? undefined;
        const betPercent =
          rawBetPercent === undefined ? undefined : splitPercent(rawBetPercent);
        const moneyPercent =
          rawMoneyPercent === undefined
            ? undefined
            : splitPercent(rawMoneyPercent);
        if (betPercent === undefined && moneyPercent === undefined) return [];
        return [
          {
            selectionKey: side,
            ...(finite(pointValue)
              ? marketKey === "moneyline"
                ? { americanOdds: pointValue }
                : { point: pointValue }
              : {}),
            ...(betPercent === undefined ? {} : { betPercent }),
            ...(moneyPercent === undefined ? {} : { moneyPercent }),
          },
        ];
      });
      if (selections.length > 0) markets.push({ marketKey, selections });
    };
    add("spread", ["away", "home"], "line");
    add("total", ["over", "under"], "odds");
    add("moneyline", ["away", "home"], "odds");
    return {
      ...sourceEvent,
      sportsbookId: value["book"],
      providerTimestamp,
      markets,
    };
  });
  const rowBooks = new Set(items.map(({ sportsbookId }) => sportsbookId));
  const metaBooks = new Set(
    (Array.isArray(metaBookValues) ? metaBookValues : []) as string[],
  );
  if (
    rowBooks.size !== metaBooks.size ||
    [...rowBooks].some((book) => !metaBooks.has(book))
  )
    throw invalid("book-set");
  if (items.length === 0) {
    if (
      (meta["oldest"] !== null && meta["oldest"] !== undefined) ||
      (meta["newest"] !== null && meta["newest"] !== undefined)
    )
      throw invalid("empty-range");
  } else {
    if (!instant(meta["oldest"]) || !instant(meta["newest"]))
      throw invalid("range");
    const timestamps = items.map(({ providerTimestamp }) =>
      Date.parse(providerTimestamp),
    );
    if (
      Math.abs(Math.min(...timestamps) - Date.parse(meta["oldest"])) > 2_000 ||
      Math.abs(Math.max(...timestamps) - Date.parse(meta["newest"])) > 2_000
    )
      throw invalid("range");
  }
  return { items, retrievedAt };
}

export const latestSharpApiSplitHistoryByBook = (
  items: readonly SharpApiSplitEvent[],
  books: readonly string[] = ["draftkings", "circa"],
) => {
  const accepted = new Set(books.map((book) => book.toLowerCase()));
  const latest = new Map<string, SharpApiSplitEvent>();
  for (const item of items) {
    const sportsbookId = item.sportsbookId.toLowerCase();
    if (!accepted.has(sportsbookId)) continue;
    const previous = latest.get(sportsbookId);
    if (
      !previous ||
      Date.parse(item.providerTimestamp) >
        Date.parse(previous.providerTimestamp)
    )
      latest.set(sportsbookId, item);
  }
  return [...latest.values()].sort((left, right) =>
    left.sportsbookId.localeCompare(right.sportsbookId),
  );
};

export async function fetchSharpApiAccount(
  apiKey: string,
  fetcher: typeof fetch = fetch,
): Promise<SharpApiAccount> {
  try {
    const { payload, metadata } = await request(
      "/account",
      "account",
      apiKey,
      fetcher,
    );
    return { ...parseSharpApiAccount(payload), responseMetadata: metadata };
  } catch (error) {
    return rethrowInvalidResponseAt(error, "account");
  }
}

export async function fetchSharpApiOddsPage(
  league: SharpApiLeague,
  apiKey: string,
  cursor?: string,
  fetcher: typeof fetch = fetch,
): Promise<SharpApiOddsPage> {
  const query = new URLSearchParams({
    league: league.providerLeague,
    market: "main",
    is_live: "false",
    limit: "200",
  });
  if (cursor) query.set("cursor", cursor);
  const retrievedAt = new Date().toISOString() as IsoTimestamp;
  try {
    const { payload, metadata } = await request(
      `/odds?${query.toString()}`,
      "odds",
      apiKey,
      fetcher,
    );
    return {
      ...parseSharpApiOddsPage(
        payload,
        league,
        retrievedAt,
        200,
        cursor ? "cursor" : "initial",
      ),
      responseMetadata: metadata,
    };
  } catch (error) {
    return rethrowInvalidResponseAt(error, "odds");
  }
}

export interface SharpApiOddsRequestMetadata {
  readonly endpointMode: "featured" | "focused";
  readonly leagueKey: SharpApiLeague["leagueKey"];
  readonly providerLeague: string;
  readonly marketSet: readonly ["main"];
  readonly providerEventId?: string;
}

export interface SharpApiOddsOperation {
  readonly page: SharpApiOddsPage;
  readonly request: SharpApiOddsRequestMetadata;
}

export async function fetchSharpApiFeaturedOdds(
  league: SharpApiLeague,
  apiKey: string,
  cursor?: string,
  fetcher: typeof fetch = fetch,
): Promise<SharpApiOddsOperation> {
  return {
    page: await fetchSharpApiOddsPage(league, apiKey, cursor, fetcher),
    request: {
      endpointMode: "featured",
      leagueKey: league.leagueKey,
      providerLeague: league.providerLeague,
      marketSet: ["main"],
    },
  };
}

export async function fetchSharpApiEventOdds(
  league: SharpApiLeague,
  providerEventId: string,
  apiKey: string,
  fetcher: typeof fetch = fetch,
): Promise<SharpApiOddsOperation> {
  if (!canonical(providerEventId, 256))
    throw new SharpApiError("configuration");
  const retrievedAt = new Date().toISOString() as IsoTimestamp;
  try {
    const response = await request(
      `/events/${encodeURIComponent(providerEventId)}/odds`,
      "focused-odds",
      apiKey,
      fetcher,
    );
    const payload = response.payload;
    if (!record(payload)) throw invalidResponse("focused-odds", "envelope");
    assertProviderEnvelope(payload, "focused-odds");
    if (!Array.isArray(payload["data"]) && payload["data"] !== null)
      throw invalidResponse("focused-odds", "envelope");
    if (Array.isArray(payload["data"]) && payload["data"].length > 5_000)
      throw invalidResponse("focused-odds", "envelope");
    if (record(payload["pagination"])) {
      const hasMore = payload["pagination"]["has_more"];
      if (
        (hasMore !== undefined && typeof hasMore !== "boolean") ||
        hasMore === true
      )
        throw invalidResponse("focused-odds", "pagination-envelope");
    }
    for (const row of Array.isArray(payload["data"]) ? payload["data"] : []) {
      if (
        !record(row) ||
        row["event_id"] !== providerEventId ||
        !canonical(row["league"], 128) ||
        ![league.leagueKey, league.providerLeague.toLowerCase()].includes(
          row["league"].toLowerCase(),
        )
      )
        throw invalidResponse("focused-odds", "identity");
    }
    const page = {
      ...parseSharpApiOddsPage(
        record(payload["pagination"])
          ? payload
          : {
              ...payload,
              pagination: {
                has_more: false,
                next_cursor: null,
                count: Array.isArray(payload["data"])
                  ? payload["data"].length
                  : 0,
                total: Array.isArray(payload["data"])
                  ? payload["data"].length
                  : 0,
              },
            },
        league,
        retrievedAt,
        5_000,
        "focused",
      ),
      responseMetadata: response.metadata,
    };
    if (page.events.some((event) => event.providerEventId !== providerEventId))
      throw invalidResponse("focused-odds", "identity");
    return {
      page,
      request: {
        endpointMode: "focused",
        leagueKey: league.leagueKey,
        providerLeague: league.providerLeague,
        marketSet: ["main"],
        providerEventId,
      },
    };
  } catch (error) {
    return rethrowInvalidResponseAt(error, "focused-odds");
  }
}

export async function fetchSharpApiSchedulePage(
  league: SharpApiLeague,
  apiKey: string,
  offset = 0,
  fetcher: typeof fetch = fetch,
): Promise<SharpApiSchedulePage> {
  const query = new URLSearchParams({
    league: league.providerLeague.toLowerCase(),
    live: "false",
    limit: "200",
    offset: String(offset),
  });
  const retrievedAt = new Date().toISOString() as IsoTimestamp;
  try {
    const { payload, metadata } = await request(
      `/events?${query.toString()}`,
      "schedule",
      apiKey,
      fetcher,
    );
    return {
      ...parseSharpApiSchedulePage(payload, league, retrievedAt),
      responseMetadata: metadata,
    };
  } catch (error) {
    return rethrowInvalidResponseAt(error, "schedule");
  }
}

export async function fetchSharpApiSplitsPage(
  league: SharpApiLeague,
  apiKey: string,
  offset = 0,
  fetcher: typeof fetch = fetch,
): Promise<SharpApiSplitPage> {
  const query = new URLSearchParams({
    league: league.providerLeague.toLowerCase(),
    limit: "200",
    offset: String(offset),
  });
  const retrievedAt = new Date().toISOString() as IsoTimestamp;
  try {
    const { payload, metadata } = await request(
      `/splits?${query.toString()}`,
      "splits",
      apiKey,
      fetcher,
    );
    return {
      ...parseSharpApiSplitPage(payload, retrievedAt),
      responseMetadata: metadata,
    };
  } catch (error) {
    return rethrowInvalidResponseAt(error, "splits");
  }
}

export async function fetchSharpApiSplitHistory(
  sourceEvent: SharpApiSplitEvent,
  startTime: IsoTimestamp,
  endTime: IsoTimestamp,
  apiKey: string,
  fetcher: typeof fetch = fetch,
): Promise<SharpApiSplitHistoryPage> {
  const query = new URLSearchParams({
    event_id: sourceEvent.providerEventId,
    start_time: startTime,
    end_time: endTime,
    limit: "200",
  });
  const retrievedAt = new Date().toISOString() as IsoTimestamp;
  try {
    const { payload, metadata } = await request(
      `/splits/history?${query.toString()}`,
      "splits-history",
      apiKey,
      fetcher,
    );
    return {
      ...parseSharpApiSplitHistoryPage(
        payload,
        sourceEvent,
        retrievedAt,
        startTime,
        endTime,
      ),
      responseMetadata: metadata,
    };
  } catch (error) {
    return rethrowInvalidResponseAt(error, "splits-history");
  }
}

export function validateSharpApiActivation(value: SharpApiActivationConfig) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("sharpapi-config-invalid");
  for (const [field, minimum] of [
    ["splitFreshnessSeconds", 1],
    ["quotaReserve", 0],
    ["cooldownSeconds", 1],
    ["recoverySuccesses", 1],
  ] as const) {
    const number = value[field];
    if (!Number.isSafeInteger(number) || number < minimum)
      throw new Error("sharpapi-config-invalid");
  }
  if (value.enabled && (!value.contractVerified || !value.licensingVerified))
    throw new Error("sharpapi-activation-unverified");
  const identities = new Set<string>();
  for (const entry of value.coverage) {
    if (
      !canonical(entry.sportKey) ||
      !canonical(entry.leagueKey) ||
      !["odds", "public-betting"].includes(entry.capability) ||
      !Array.isArray(entry.marketKeys) ||
      entry.marketKeys.some((marketKey) => !canonical(marketKey)) ||
      new Set(entry.marketKeys).size !== entry.marketKeys.length
    )
      throw new Error("sharpapi-coverage-invalid");
    const identity = `${entry.sportKey}\u0000${entry.leagueKey}\u0000${entry.capability}`;
    if (identities.has(identity))
      throw new Error("sharpapi-coverage-duplicate");
    identities.add(identity);
    if (entry.enabled) {
      if (
        !value.contractVerified ||
        entry.reason !== undefined ||
        entry.marketKeys.length === 0
      )
        throw new Error("sharpapi-coverage-unverified");
    } else if (!entry.reason || entry.marketKeys.length > 0) {
      throw new Error("sharpapi-disabled-reason-required");
    }
  }
  return structuredClone(value);
}

export function sharpApiDescriptor(
  config: SharpApiActivationConfig,
): ProviderDescriptor | null {
  const validated = validateSharpApiActivation(config);
  if (!validated.enabled) return null;
  const enabled = validated.coverage.filter((entry) => entry.enabled);
  const grouped = new Map<string, typeof enabled>();
  for (const entry of enabled) {
    const key = `${entry.sportKey}\u0000${entry.leagueKey}`;
    grouped.set(key, [...(grouped.get(key) ?? []), entry]);
  }
  if (grouped.size === 0) throw new Error("sharpapi-coverage-empty");
  return {
    id: SHARP_API_PROVIDER_ID,
    displayName: "SharpAPI",
    capabilities: [...new Set(enabled.map(({ capability }) => capability))],
    coverage: {
      leagues: [...grouped.values()].map((entries) => ({
        sportKey: entries[0]!.sportKey,
        leagueKey: entries[0]!.leagueKey,
        capabilities: entries.map(({ capability }) => capability),
        marketKeys: [
          ...new Set(entries.flatMap(({ marketKeys }) => marketKeys)),
        ],
      })),
    },
    expectedFreshnessSeconds: validated.splitFreshnessSeconds,
    qualityTier: "premium",
  };
}
