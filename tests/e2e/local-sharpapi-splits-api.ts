import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { createEventHandler } from "../../apps/api/src/index.js";
import {
  ingestSharpApi,
  type SharpApiOddsPersister,
} from "../../apps/workers/src/index.js";
import {
  EventCursorCodec,
  MemoryBettingSplitRepository,
  MemoryEventIngestionStore,
  MemoryEventRepository,
  MemoryGamesRepository,
} from "../../packages/database/src/index.js";
import {
  normalizeFixtureOddsObservation,
  type IsoTimestamp,
} from "../../packages/domain/src/index.js";
import type {
  SharpApiEvent,
  SharpApiLeague,
  SharpApiSplitPage,
} from "../../packages/providers/src/index.js";
import {
  fetchSharpApiSplitHistory,
  latestSharpApiSplitHistoryByBook,
} from "../../packages/providers/src/index.js";

const easternDay = (value: string) => {
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

const mlbTeams = [
  ["Chicago White Sox", "Boston Red Sox", "whitesox", "redsox"],
  ["New York Mets", "Detroit Tigers", "mets", "tigers"],
  ["Miami Marlins", "Atlanta Braves", "marlins", "braves"],
  ["Chicago Cubs", "Milwaukee Brewers", "cubs", "brewers"],
  ["Seattle Mariners", "Texas Rangers", "mariners", "rangers"],
  ["Minnesota Twins", "Cleveland Guardians", "twins", "guardians"],
  ["Baltimore Orioles", "Toronto Blue Jays", "orioles", "bluejays"],
  ["Los Angeles Dodgers", "San Diego Padres", "dodgers", "padres"],
] as const;

export interface LocalSharpApiSplitsApi {
  readonly apiBase: string;
  readonly day: string;
  readonly expectedGameCount: number;
  readonly coveredMatchup: string;
  close(): Promise<void>;
}

export async function startLocalSharpApiSplitsApi(): Promise<LocalSharpApiSplitsApi> {
  const retrievedAt = new Date().toISOString() as IsoTimestamp;
  const startsAt = new Date(
    Date.now() + 48 * 60 * 60 * 1_000,
  ).toISOString() as IsoTimestamp;
  const day = easternDay(startsAt);
  const schedule = mlbTeams.map(
    ([awayTeam, homeTeam, awayClubKey, homeClubKey]) => ({
      providerEventId: `mlb-${awayClubKey}-${homeClubKey}_${day}_b3`,
      awayTeam,
      homeTeam,
      awayClubKey,
      homeClubKey,
      startsAt,
      status: "scheduled" as const,
    }),
  );
  const covered = schedule[0]!;
  const suffixlessProviderEventId = covered.providerEventId.replace(/_b3$/, "");
  const oddsEvent: SharpApiEvent = {
    ...covered,
    providerEventUuid: `${covered.providerEventId}:uuid`,
    bookmakers: [
      {
        id: "draftkings",
        label: "DraftKings",
        prices: [
          {
            providerPriceId: `${covered.providerEventId}:away`,
            marketKey: "moneyline",
            outcomeStructure: "two-way",
            providerMarketType: "moneyline",
            providerMarketId: `${covered.providerEventId}:moneyline`,
            selectionKey: "away",
            selectionLabel: covered.awayTeam,
            providerSelectionId: `${covered.providerEventId}:away`,
            americanOdds: 115,
            decimalOdds: 2.15,
            impliedProbability: 100 / 215,
            isLive: false,
            isMainLine: true,
            isAlternateLine: false,
            isPlayerProp: false,
            isStalePregamePrice: false,
            isActive: true,
            isSuspended: false,
            observedAt: retrievedAt,
          },
          {
            providerPriceId: `${covered.providerEventId}:home`,
            marketKey: "moneyline",
            outcomeStructure: "two-way",
            providerMarketType: "moneyline",
            providerMarketId: `${covered.providerEventId}:moneyline`,
            selectionKey: "home",
            selectionLabel: covered.homeTeam,
            providerSelectionId: `${covered.providerEventId}:home`,
            americanOdds: -125,
            decimalOdds: 1.8,
            impliedProbability: 125 / 225,
            isLive: false,
            isMainLine: true,
            isAlternateLine: false,
            isPlayerProp: false,
            isStalePregamePrice: false,
            isActive: true,
            isSuspended: false,
            observedAt: retrievedAt,
          },
        ],
      },
    ],
  };
  const sourceSplitEvent = {
    providerEventId: suffixlessProviderEventId,
    sport: "baseball",
    league: "mlb",
    sportsbookId: "consensus",
    awayTeam: covered.awayTeam,
    homeTeam: covered.homeTeam,
    providerTimestamp: retrievedAt,
    markets: [],
  } as const;
  const historyStart = new Date(
    Date.parse(retrievedAt) - 60 * 60 * 1_000,
  ).toISOString() as IsoTimestamp;
  const olderTimestamp = new Date(
    Date.parse(retrievedAt) - 20 * 60 * 1_000,
  ).toISOString() as IsoTimestamp;
  const historyFetcher: typeof fetch = (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (
      url.pathname !== "/api/v1/splits/history" ||
      url.searchParams.get("event_id") !== suffixlessProviderEventId ||
      url.searchParams.get("start_time") !== historyStart ||
      url.searchParams.get("end_time") !== retrievedAt ||
      url.searchParams.get("limit") !== "200" ||
      request.headers.get("X-API-Key") !== "local-sharpapi-key"
    )
      return Promise.resolve(
        new Response(JSON.stringify({ error: "unexpected-request" }), {
          status: 400,
        }),
      );
    const historyRow = (
      book: "draftkings" | "circa",
      timestamp: IsoTimestamp,
      awayBetShare: number,
    ) => ({
      book,
      timestamp: Date.parse(timestamp) / 1_000,
      ts: timestamp,
      spread: null,
      total: null,
      moneyline: {
        away_odds: 115,
        home_odds: -125,
        bets_pct: { away: awayBetShare, home: 1 - awayBetShare },
        handle_pct: {
          away: awayBetShare + 0.1,
          home: 0.9 - awayBetShare,
        },
      },
    });
    return Promise.resolve(
      new Response(
        JSON.stringify({
          success: true,
          meta: {
            event_id: suffixlessProviderEventId,
            total: 4,
            updated_at: retrievedAt,
            books: ["draftkings", "circa"],
            oldest: olderTimestamp,
            newest: retrievedAt,
          },
          data: [
            historyRow("draftkings", olderTimestamp, 0.51),
            historyRow("circa", olderTimestamp, 0.44),
            historyRow("draftkings", retrievedAt, 0.55),
            historyRow("circa", retrievedAt, 0.48),
          ],
        }),
        { headers: { "content-type": "application/json" } },
      ),
    );
  };
  const history = await fetchSharpApiSplitHistory(
    sourceSplitEvent,
    historyStart,
    retrievedAt,
    "local-sharpapi-key",
    historyFetcher,
  );
  const recoveredPages = latestSharpApiSplitHistoryByBook(history.items).map(
    (item): SharpApiSplitPage => ({
      items: [item],
      hasMore: false,
      retrievedAt: history.retrievedAt,
    }),
  );

  const store = new MemoryEventIngestionStore();
  const splits = new MemoryBettingSplitRepository();
  const odds: SharpApiOddsPersister = {
    persist: ({ observation }) =>
      Promise.resolve({
        snapshot: "created",
        current: "advanced",
        value: normalizeFixtureOddsObservation(observation),
      }),
  };
  await ingestSharpApi(store, odds, splits, "local-sharpapi-key", {
    fetchAccount: () =>
      Promise.resolve({
        tier: "sharp",
        features: ["odds", "schedule", "splits"],
        requestsPerMinute: 300,
        maxBooks: 25,
        streamingEnabled: false,
      }),
    fetchSchedulePage: (league: SharpApiLeague) =>
      Promise.resolve({
        events: league.leagueKey === "mlb" ? schedule : [],
        hasMore: false,
        retrievedAt,
      }),
    fetchOddsPage: (league: SharpApiLeague) =>
      Promise.resolve({
        events: league.leagueKey === "mlb" ? [oddsEvent] : [],
        hasMore: false,
        retrievedAt,
      }),
    fetchSplitsPage: (league: SharpApiLeague, _apiKey: string, offset = 0) =>
      Promise.resolve(
        league.leagueKey !== "mlb"
          ? { items: [], hasMore: false, retrievedAt }
          : offset === 0
            ? {
                ...recoveredPages[0]!,
                hasMore: true,
                nextOffset: 1,
              }
            : recoveredPages[1]!,
      ),
  });

  const events = new MemoryEventRepository(
    store,
    new EventCursorCodec({
      current: { id: "sharpapi-splits-e2e", secret: Buffer.alloc(32, 23) },
    }),
    () => new Date(retrievedAt),
  );
  const games = new MemoryGamesRepository(
    events,
    { batchGet: () => Promise.resolve([]) },
    ["draftkings"],
    () => new Date(retrievedAt),
  );
  const handler = createEventHandler(events, games, () => undefined, splits);
  const server = createServer((request, response) => {
    void respond(request, response, handler).catch(() => {
      if (!response.headersSent)
        response
          .writeHead(500, { "content-type": "application/json" })
          .end(JSON.stringify({ error: "internal-error" }));
      else response.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onError);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    await close(server);
    throw new Error("local SharpAPI splits API did not bind a TCP port");
  }
  return {
    apiBase: `http://127.0.0.1:${String(address.port)}`,
    day,
    expectedGameCount: schedule.length,
    coveredMatchup: `${covered.awayTeam} vs ${covered.homeTeam}`,
    close: () => close(server),
  };
}

async function respond(
  request: IncomingMessage,
  response: ServerResponse,
  handler: ReturnType<typeof createEventHandler>,
) {
  const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
  const headers = {
    "access-control-allow-origin": "http://127.0.0.1:4173",
    "access-control-allow-headers": "content-type",
    "content-type": "application/json",
    "cache-control": "no-store",
  };
  if (request.method === "OPTIONS") {
    response.writeHead(204, headers).end();
    return;
  }
  if (request.method !== "GET" || requestUrl.pathname !== "/splits") {
    response
      .writeHead(404, headers)
      .end(JSON.stringify({ error: "not-found" }));
    return;
  }
  const result = await handler({
    route: "splits",
    query: Object.fromEntries(requestUrl.searchParams),
  });
  response.writeHead(result.statusCode, { ...headers, ...result.headers });
  response.end(result.body);
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
