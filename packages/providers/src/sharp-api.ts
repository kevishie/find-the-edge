import type { IsoTimestamp, SportKey } from "@find-the-edge/domain";

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
  readonly leagueKey: "mlb" | "mls";
  readonly providerLeague: "MLB" | "MLS";
  readonly moneylineMarket: "moneyline" | "three_way_moneyline";
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
    moneylineMarket: "three_way_moneyline",
  },
];

export interface SharpApiAccount {
  readonly tier: string;
  readonly features: readonly string[];
  readonly requestsPerMinute: number;
  readonly maxBooks: number;
  readonly streamingEnabled: boolean;
}

export interface SharpApiPrice {
  readonly providerPriceId: string;
  readonly marketKey: "moneyline" | "three_way_moneyline" | "spread" | "total";
  readonly providerMarketType: string;
  readonly providerMarketId: string;
  readonly selectionKey: "away" | "draw" | "home" | "over" | "under";
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
  readonly observedAt: IsoTimestamp;
}

export interface SharpApiBookmaker {
  readonly id: string;
  readonly label: string;
  readonly prices: readonly SharpApiPrice[];
}

export interface SharpApiEvent {
  readonly providerEventId: string;
  readonly providerEventUuid: string;
  readonly awayTeam: string;
  readonly homeTeam: string;
  readonly startsAt: IsoTimestamp;
  readonly bookmakers: readonly SharpApiBookmaker[];
}

export interface SharpApiOddsPage {
  readonly events: readonly SharpApiEvent[];
  readonly hasMore: boolean;
  readonly nextCursor?: string;
  readonly retrievedAt: IsoTimestamp;
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
}

export class SharpApiError extends Error {
  override readonly name = "SharpApiError";
  constructor(
    readonly code:
      | "configuration"
      | "unauthorized"
      | "not-entitled"
      | "rate-limited"
      | "provider-unavailable"
      | "invalid-response",
    readonly retryable = false,
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

const boundedJson = async (response: Response): Promise<unknown> => {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES)
    throw new SharpApiError("invalid-response");
  const raw = await response.text();
  if (new TextEncoder().encode(raw).byteLength > MAX_RESPONSE_BYTES)
    throw new SharpApiError("invalid-response");
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new SharpApiError("invalid-response");
  }
};

const request = async (
  path: string,
  apiKey: string,
  fetcher: typeof fetch,
): Promise<unknown> => {
  if (!canonical(apiKey, 512)) throw new SharpApiError("configuration");
  let response: Response;
  try {
    response = await fetcher(`${SHARP_API_BASE_URL}${path}`, {
      signal: AbortSignal.timeout(10_000),
      headers: { accept: "application/json", "X-API-Key": apiKey },
    });
  } catch {
    throw new SharpApiError("provider-unavailable", true);
  }
  if (!response.ok) {
    if ([401, 403].includes(response.status)) {
      const body = await boundedJson(response);
      const error = record(body) && record(body["error"]) ? body["error"] : {};
      if (error["code"] === "tier_restricted")
        throw new SharpApiError("not-entitled");
      throw new SharpApiError("unauthorized");
    }
    if (response.status === 429) throw new SharpApiError("rate-limited", true);
    throw new SharpApiError(
      response.status >= 500 ? "provider-unavailable" : "invalid-response",
      response.status >= 500,
    );
  }
  return boundedJson(response);
};

export function parseSharpApiAccount(input: unknown): SharpApiAccount {
  if (!record(input) || !record(input["data"]))
    throw new SharpApiError("invalid-response");
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
    throw new SharpApiError("invalid-response");
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
  if (["away", "home", "draw", "over", "under"].includes(type))
    return type as SharpApiPrice["selectionKey"];
  if (label === raw["away_team"]) return "away";
  if (label === raw["home_team"]) return "home";
  if (/^draw$/i.test(label) && league.leagueKey === "mls") return "draw";
  if (/^over\b/i.test(label)) return "over";
  if (/^under\b/i.test(label)) return "under";
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
  return undefined;
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
): SharpApiOddsPage {
  if (
    !record(input) ||
    !Array.isArray(input["data"]) ||
    input["data"].length > 200
  )
    throw new SharpApiError("invalid-response");
  const grouped = new Map<string, Map<string, SharpApiPrice[]>>();
  const identities = new Map<string, Omit<SharpApiEvent, "bookmakers">>();
  const priceIds = new Set<string>();
  for (const value of input["data"]) {
    if (!record(value)) throw new SharpApiError("invalid-response");
    const marketKey = market(value, league);
    const selectionKey = selection(value, league);
    if (!marketKey || !selectionKey) continue;
    const awayTeam = teamName(value, "away");
    const homeTeam = teamName(value, "home");
    if (
      !canonical(value["id"]) ||
      priceIds.has(value["id"]) ||
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
    )
      throw new SharpApiError("invalid-response");
    priceIds.add(value["id"]);
    const eventId = value["event_id"];
    const existing = identities.get(eventId);
    let identity = {
      providerEventId: eventId,
      providerEventUuid: value["event_uuid"],
      awayTeam,
      homeTeam,
      startsAt: iso(value["event_start_time"]),
    };
    if (existing) {
      const sameOrientation =
        existing.awayTeam === identity.awayTeam &&
        existing.homeTeam === identity.homeTeam;
      const reversedOrientation =
        existing.awayTeam === identity.homeTeam &&
        existing.homeTeam === identity.awayTeam;
      const startDelta = Math.abs(
        Date.parse(existing.startsAt) - Date.parse(identity.startsAt),
      );
      if (
        existing.providerEventUuid !== identity.providerEventUuid ||
        (!sameOrientation && !reversedOrientation) ||
        startDelta > 120_000
      )
        continue;
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
    if ((marketKey === "spread" || marketKey === "total") && !finite(line))
      throw new SharpApiError("invalid-response");
    const publicPct = value["public_bet_pct"];
    if (
      publicPct !== undefined &&
      (!finite(publicPct) || publicPct < 0 || publicPct > 1)
    )
      throw new SharpApiError("invalid-response");
    prices.push({
      providerPriceId: value["id"],
      marketKey,
      providerMarketType: value["market_type"],
      providerMarketId: value["market_id"],
      selectionKey,
      selectionLabel: value["selection"],
      providerSelectionId: value["selection_id"],
      ...(finite(line) ? { point: line } : {}),
      americanOdds: value["odds_american"],
      decimalOdds: value["odds_decimal"],
      impliedProbability: value["odds_probability"],
      ...(publicPct === undefined ? {} : { publicBetPercent: publicPct * 100 }),
      ...(canonical(value["deep_link"], 2048)
        ? { deepLink: value["deep_link"] }
        : {}),
      isLive: value["is_live"] === true,
      isMainLine: value["is_main_line"] === true,
      isAlternateLine: value["is_alternate_line"] === true,
      isPlayerProp: value["is_player_prop"] === true,
      isStalePregamePrice: value["is_stale_pregame_price"] === true,
      observedAt: iso(value["timestamp"]),
    });
    books.set(book, prices);
    grouped.set(eventId, books);
  }
  const pagination = input["pagination"];
  if (!record(pagination) || typeof pagination["has_more"] !== "boolean")
    throw new SharpApiError("invalid-response");
  const nextCursor = pagination["next_cursor"];
  if (pagination["has_more"] && !canonical(nextCursor, 4096))
    throw new SharpApiError("invalid-response");
  return {
    events: [...identities].map(([eventId, identity]) => ({
      ...identity,
      bookmakers: [...(grouped.get(eventId) ?? [])].map(([id, prices]) => ({
        id,
        label: id,
        prices,
      })),
    })),
    hasMore: pagination["has_more"],
    ...(canonical(nextCursor, 4096) ? { nextCursor } : {}),
    retrievedAt,
  };
}

const splitPercent = (value: unknown) => {
  if (!finite(value) || value < 0 || value > 1)
    throw new SharpApiError("invalid-response");
  return Math.round(value * 10_000) / 100;
};

export function parseSharpApiSplitPage(
  input: unknown,
  retrievedAt: IsoTimestamp,
): SharpApiSplitPage {
  if (!record(input)) throw new SharpApiError("invalid-response");
  const pagination = input["pagination"];
  if (!record(pagination) || typeof pagination["has_more"] !== "boolean")
    throw new SharpApiError("invalid-response");
  const emptyPage =
    input["data"] === null &&
    pagination["has_more"] === false &&
    pagination["count"] === 0 &&
    pagination["total"] === 0;
  if (
    (!emptyPage && !Array.isArray(input["data"])) ||
    (Array.isArray(input["data"]) && input["data"].length > 200)
  )
    throw new SharpApiError("invalid-response");
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
      throw new SharpApiError("invalid-response");
    const markets: SharpApiSplitMarket[] = [];
    const add = (
      marketKey: SharpApiSplitMarket["marketKey"],
      sides: readonly SharpApiSplitSelection["selectionKey"][],
      pointField: "line" | "odds",
    ) => {
      const raw = value[marketKey];
      if (raw === null || raw === undefined) return;
      if (!record(raw)) throw new SharpApiError("invalid-response");
      const handle = record(raw["handle_pct"]) ? raw["handle_pct"] : undefined;
      const bets = record(raw["bets_pct"]) ? raw["bets_pct"] : undefined;
      if (!handle && !bets) throw new SharpApiError("invalid-response");
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
    throw new SharpApiError("invalid-response");
  return {
    items,
    hasMore: pagination["has_more"],
    ...(integer(nextOffset) ? { nextOffset } : {}),
    retrievedAt,
  };
}

export async function fetchSharpApiAccount(
  apiKey: string,
  fetcher: typeof fetch = fetch,
) {
  return parseSharpApiAccount(await request("/account", apiKey, fetcher));
}

export async function fetchSharpApiOddsPage(
  league: SharpApiLeague,
  apiKey: string,
  cursor?: string,
  fetcher: typeof fetch = fetch,
) {
  const query = new URLSearchParams({
    league: league.providerLeague,
    market: "main",
    limit: "200",
  });
  if (cursor) query.set("cursor", cursor);
  const retrievedAt = new Date().toISOString() as IsoTimestamp;
  return parseSharpApiOddsPage(
    await request(`/odds?${query.toString()}`, apiKey, fetcher),
    league,
    retrievedAt,
  );
}

export async function fetchSharpApiSplitsPage(
  league: SharpApiLeague,
  apiKey: string,
  offset = 0,
  fetcher: typeof fetch = fetch,
) {
  const query = new URLSearchParams({
    league: league.providerLeague.toLowerCase(),
    limit: "200",
    offset: String(offset),
  });
  const retrievedAt = new Date().toISOString() as IsoTimestamp;
  return parseSharpApiSplitPage(
    await request(`/splits?${query.toString()}`, apiKey, fetcher),
    retrievedAt,
  );
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
