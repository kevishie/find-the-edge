import type { IsoTimestamp, SportKey } from "@find-the-edge/domain";
import type { ProviderDescriptor } from "./index";

export const THE_ODDS_API_PROVIDER_ID = "the-odds-api";
export const theOddsApiDescriptor: ProviderDescriptor = {
  id: THE_ODDS_API_PROVIDER_ID,
  displayName: "The Odds API",
  capabilities: ["schedule", "odds", "results"],
  coverage: {
    leagues: [
      {
        sportKey: "mlb" as SportKey,
        leagueKey: "mlb",
        capabilities: ["schedule", "odds", "results"],
        marketKeys: ["moneyline", "spread", "total"],
      },
      {
        sportKey: "soccer" as SportKey,
        leagueKey: "mls",
        capabilities: ["schedule", "odds", "results"],
        marketKeys: ["three_way_moneyline", "spread", "total"],
      },
    ],
  },
  expectedFreshnessSeconds: 3600,
  qualityTier: "standard",
};

export interface TheOddsApiLeague {
  readonly sportKey: SportKey;
  readonly leagueKey: "mlb" | "mls";
  readonly providerSportKey: "baseball_mlb" | "soccer_usa_mls";
  readonly marketKey: "moneyline" | "three_way_moneyline";
}
export const theOddsApiLeagues: readonly TheOddsApiLeague[] = [
  {
    sportKey: "mlb" as SportKey,
    leagueKey: "mlb",
    providerSportKey: "baseball_mlb",
    marketKey: "moneyline",
  },
  {
    sportKey: "soccer" as SportKey,
    leagueKey: "mls",
    providerSportKey: "soccer_usa_mls",
    marketKey: "three_way_moneyline",
  },
];

export interface TheOddsApiBookmaker {
  readonly id: string;
  readonly label: string;
  readonly updatedAt: IsoTimestamp;
  readonly prices: readonly {
    readonly marketKey:
      "moneyline" | "three_way_moneyline" | "spread" | "total";
    readonly selectionKey: "away" | "draw" | "home" | "over" | "under";
    readonly selectionLabel: string;
    readonly point?: number;
    readonly americanOdds: number;
  }[];
}
export interface TheOddsApiEvent {
  readonly providerEventId: string;
  readonly awayTeam: string;
  readonly homeTeam: string;
  readonly startsAt: IsoTimestamp;
  readonly bookmakers: readonly TheOddsApiBookmaker[];
}
export interface TheOddsApiQuota {
  readonly used?: number;
  readonly remaining?: number;
  readonly last?: number;
}
export interface TheOddsApiResult {
  readonly events: readonly TheOddsApiEvent[];
  readonly quota: TheOddsApiQuota;
  readonly retrievedAt: IsoTimestamp;
}

/** Normalized control-plane page metadata. The endpoint is currently single-page. */
export interface TheOddsApiControlPlanePage extends TheOddsApiResult {
  readonly pageToken: "single";
  readonly nextPageToken?: never;
}

export class TheOddsApiError extends Error {
  override readonly name = "TheOddsApiError";
  constructor(
    readonly code:
      | "configuration"
      | "unauthorized"
      | "rate-limited"
      | "provider-unavailable"
      | "invalid-response",
  ) {
    super(code);
  }
}

const text = (value: unknown, max = 128) =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= max &&
  value === value.trim();
const instant = (value: unknown): value is IsoTimestamp =>
  text(value) && Number.isFinite(Date.parse(value as string));
const countHeader = (headers: Headers, name: string) => {
  const value = headers.get(name);
  if (value === null) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
};
const MAX_RESPONSE_BYTES = 5_000_000;
const boundedJson = async (response: Response): Promise<unknown> => {
  const declared = response.headers.get("content-length");
  if (declared !== null && Number(declared) > MAX_RESPONSE_BYTES)
    throw new TheOddsApiError("invalid-response");
  let raw: string;
  try {
    raw = await response.text();
  } catch {
    throw new TheOddsApiError("invalid-response");
  }
  if (new TextEncoder().encode(raw).byteLength > MAX_RESPONSE_BYTES)
    throw new TheOddsApiError("invalid-response");
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new TheOddsApiError("invalid-response");
  }
};

export function parseTheOddsApiEvents(
  input: unknown,
  league: TheOddsApiLeague,
): readonly TheOddsApiEvent[] {
  if (!Array.isArray(input) || input.length > 500)
    throw new TheOddsApiError("invalid-response");
  const ids = new Set<string>();
  return input.map((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
      throw new TheOddsApiError("invalid-response");
    const event = raw as Record<string, unknown>;
    if (
      !text(event["id"]) ||
      ids.has(event["id"] as string) ||
      !text(event["away_team"]) ||
      !text(event["home_team"]) ||
      event["away_team"] === event["home_team"] ||
      !instant(event["commence_time"]) ||
      !Array.isArray(event["bookmakers"]) ||
      event["bookmakers"].length > 50
    )
      throw new TheOddsApiError("invalid-response");
    ids.add(event["id"] as string);
    const bookmakers = (event["bookmakers"] as unknown[]).map((rawBook) => {
      if (!rawBook || typeof rawBook !== "object" || Array.isArray(rawBook))
        throw new TheOddsApiError("invalid-response");
      const book = rawBook as Record<string, unknown>;
      if (
        !text(book["key"], 64) ||
        !text(book["title"]) ||
        !instant(book["last_update"]) ||
        !Array.isArray(book["markets"])
      )
        throw new TheOddsApiError("invalid-response");
      const supported = new Map<string, Record<string, unknown>>();
      for (const rawMarket of book["markets"] as unknown[]) {
        if (
          !rawMarket ||
          typeof rawMarket !== "object" ||
          Array.isArray(rawMarket)
        )
          throw new TheOddsApiError("invalid-response");
        const market = rawMarket as Record<string, unknown>;
        if (!["h2h", "spreads", "totals"].includes(String(market["key"])))
          continue;
        const key = market["key"] as string;
        if (supported.has(key)) throw new TheOddsApiError("invalid-response");
        supported.set(key, market);
      }
      if (!supported.has("h2h")) throw new TheOddsApiError("invalid-response");
      const prices: TheOddsApiBookmaker["prices"][number][] = [];
      for (const [providerMarket, market] of supported) {
        try {
          const outcomes = market["outcomes"];
          if (!Array.isArray(outcomes))
            throw new TheOddsApiError("invalid-response");
          const expected =
            providerMarket === "h2h" && league.leagueKey === "mls" ? 3 : 2;
          if (outcomes.length !== expected)
            throw new TheOddsApiError("invalid-response");
          const marketPrices: TheOddsApiBookmaker["prices"][number][] = [];
          for (const rawOutcome of outcomes) {
            if (
              !rawOutcome ||
              typeof rawOutcome !== "object" ||
              Array.isArray(rawOutcome)
            )
              throw new TheOddsApiError("invalid-response");
            const outcome = rawOutcome as Record<string, unknown>;
            if (
              !text(outcome["name"]) ||
              typeof outcome["price"] !== "number" ||
              !Number.isInteger(outcome["price"]) ||
              Math.abs(outcome["price"]) < 100 ||
              Math.abs(outcome["price"]) > 100000
            )
              throw new TheOddsApiError("invalid-response");
            const name = outcome["name"] as string;
            const teamSelection =
              name === event["away_team"]
                ? "away"
                : name === event["home_team"]
                  ? "home"
                  : undefined;
            const selectionKey =
              providerMarket === "totals"
                ? name === "Over"
                  ? "over"
                  : name === "Under"
                    ? "under"
                    : undefined
                : (teamSelection ??
                  (providerMarket === "h2h" &&
                  league.leagueKey === "mls" &&
                  name === "Draw"
                    ? "draw"
                    : undefined));
            const point = outcome["point"];
            if (
              !selectionKey ||
              (providerMarket !== "h2h" &&
                (typeof point !== "number" ||
                  !Number.isFinite(point) ||
                  Math.abs(point) > 10_000))
            )
              throw new TheOddsApiError("invalid-response");
            marketPrices.push({
              marketKey:
                providerMarket === "h2h"
                  ? league.marketKey
                  : providerMarket === "spreads"
                    ? "spread"
                    : "total",
              selectionKey,
              selectionLabel: name,
              ...(providerMarket === "h2h" ? {} : { point: point as number }),
              americanOdds: outcome["price"],
            });
          }
          if (
            new Set(marketPrices.map(({ selectionKey }) => selectionKey))
              .size !== expected
          )
            throw new TheOddsApiError("invalid-response");
          const away = marketPrices.find(
            ({ selectionKey }) => selectionKey === "away",
          );
          const home = marketPrices.find(
            ({ selectionKey }) => selectionKey === "home",
          );
          const over = marketPrices.find(
            ({ selectionKey }) => selectionKey === "over",
          );
          const under = marketPrices.find(
            ({ selectionKey }) => selectionKey === "under",
          );
          if (
            (providerMarket === "spreads" &&
              away?.point !== -(home?.point ?? NaN)) ||
            (providerMarket === "totals" &&
              (over?.point !== under?.point || (over?.point ?? -1) < 0))
          )
            throw new TheOddsApiError("invalid-response");
          prices.push(...marketPrices);
        } catch (error) {
          if (providerMarket === "h2h") throw error;
        }
      }
      return {
        id: book["key"] as string,
        label: book["title"] as string,
        updatedAt: new Date(book["last_update"]).toISOString() as IsoTimestamp,
        prices,
      };
    });
    if (new Set(bookmakers.map(({ id }) => id)).size !== bookmakers.length)
      throw new TheOddsApiError("invalid-response");
    return {
      providerEventId: event["id"] as string,
      awayTeam: event["away_team"] as string,
      homeTeam: event["home_team"] as string,
      startsAt: new Date(event["commence_time"]).toISOString() as IsoTimestamp,
      bookmakers,
    };
  });
}

export async function fetchTheOddsApi(
  league: TheOddsApiLeague,
  apiKey: string,
  fetcher: typeof fetch = fetch,
): Promise<TheOddsApiResult> {
  if (!text(apiKey, 512)) throw new TheOddsApiError("configuration");
  const url = new URL(
    `https://api.the-odds-api.com/v4/sports/${league.providerSportKey}/odds`,
  );
  url.searchParams.set("apiKey", apiKey);
  url.searchParams.set("regions", "us");
  url.searchParams.set("markets", "h2h,spreads,totals");
  url.searchParams.set("oddsFormat", "american");
  url.searchParams.set("dateFormat", "iso");
  let response: Response;
  try {
    response = await fetcher(url, {
      signal: AbortSignal.timeout(10000),
      headers: { accept: "application/json" },
    });
  } catch {
    throw new TheOddsApiError("provider-unavailable");
  }
  if (!response.ok) {
    if (response.status === 401 || response.status === 403)
      throw new TheOddsApiError("unauthorized");
    if (response.status === 429) throw new TheOddsApiError("rate-limited");
    throw new TheOddsApiError(
      response.status >= 500 ? "provider-unavailable" : "invalid-response",
    );
  }
  const body = await boundedJson(response);
  const used = countHeader(response.headers, "x-requests-used"),
    remaining = countHeader(response.headers, "x-requests-remaining"),
    last = countHeader(response.headers, "x-requests-last");
  return {
    events: parseTheOddsApiEvents(body, league),
    retrievedAt: new Date().toISOString() as IsoTimestamp,
    quota: {
      ...(used === undefined ? {} : { used }),
      ...(remaining === undefined ? {} : { remaining }),
      ...(last === undefined ? {} : { last }),
    },
  };
}

export async function fetchTheOddsApiEvents(
  league: TheOddsApiLeague,
  apiKey: string,
  fetcher: typeof fetch = fetch,
): Promise<TheOddsApiResult> {
  if (!text(apiKey, 512)) throw new TheOddsApiError("configuration");
  const url = new URL(
    `https://api.the-odds-api.com/v4/sports/${league.providerSportKey}/events`,
  );
  url.searchParams.set("apiKey", apiKey);
  url.searchParams.set("dateFormat", "iso");
  let response: Response;
  try {
    response = await fetcher(url, {
      signal: AbortSignal.timeout(10000),
      headers: { accept: "application/json" },
    });
  } catch {
    throw new TheOddsApiError("provider-unavailable");
  }
  if (!response.ok) {
    if (response.status === 401 || response.status === 403)
      throw new TheOddsApiError("unauthorized");
    if (response.status === 429) throw new TheOddsApiError("rate-limited");
    throw new TheOddsApiError(
      response.status >= 500 ? "provider-unavailable" : "invalid-response",
    );
  }
  const body = await boundedJson(response);
  if (!Array.isArray(body)) throw new TheOddsApiError("invalid-response");
  const withoutBooks = body.map((event) => ({
    ...(event as object),
    bookmakers: [],
  }));
  const used = countHeader(response.headers, "x-requests-used"),
    remaining = countHeader(response.headers, "x-requests-remaining"),
    last = countHeader(response.headers, "x-requests-last");
  return {
    events: parseTheOddsApiEvents(withoutBooks, league),
    retrievedAt: new Date().toISOString() as IsoTimestamp,
    quota: {
      ...(used === undefined ? {} : { used }),
      ...(remaining === undefined ? {} : { remaining }),
      ...(last === undefined ? {} : { last }),
    },
  };
}
