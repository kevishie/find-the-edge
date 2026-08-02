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
        marketKeys: ["moneyline"],
      },
      {
        sportKey: "soccer" as SportKey,
        leagueKey: "mls",
        capabilities: ["schedule", "odds", "results"],
        marketKeys: ["three_way_moneyline"],
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
    readonly selectionKey: "away" | "draw" | "home";
    readonly selectionLabel: string;
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
      const h2h = (book["markets"] as unknown[]).filter(
        (market) =>
          market &&
          typeof market === "object" &&
          !Array.isArray(market) &&
          (market as Record<string, unknown>)["key"] === "h2h",
      );
      if (h2h.length !== 1) throw new TheOddsApiError("invalid-response");
      const outcomes = (h2h[0] as Record<string, unknown>)["outcomes"];
      if (!Array.isArray(outcomes))
        throw new TheOddsApiError("invalid-response");
      const expected = league.leagueKey === "mls" ? 3 : 2;
      if (outcomes.length !== expected)
        throw new TheOddsApiError("invalid-response");
      const prices = outcomes.map((rawOutcome) => {
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
          outcome["price"] === 0 ||
          Math.abs(outcome["price"]) > 100000
        )
          throw new TheOddsApiError("invalid-response");
        const name = outcome["name"] as string;
        const selectionKey: "away" | "draw" | "home" | undefined =
          name === event["away_team"]
            ? "away"
            : name === event["home_team"]
              ? "home"
              : league.leagueKey === "mls" && name === "Draw"
                ? "draw"
                : undefined;
        if (!selectionKey) throw new TheOddsApiError("invalid-response");
        return {
          selectionKey,
          selectionLabel: name,
          americanOdds: outcome["price"],
        };
      });
      if (
        new Set(prices.map(({ selectionKey }) => selectionKey)).size !==
        expected
      )
        throw new TheOddsApiError("invalid-response");
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
  url.searchParams.set("markets", "h2h");
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
