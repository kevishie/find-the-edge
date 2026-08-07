import { describe, expect, it } from "vitest";
import { createEventHandler } from "@find-the-edge/api";
import {
  productionOddsCollectionPolicies,
  type OddsBookRole,
} from "@find-the-edge/config";
import {
  DynamoFixtureOddsAdapter,
  EventCursorCodec,
  FixtureOddsTransactionCanceledError,
  MemoryBettingSplitRepository,
  MemoryEventIngestionStore,
  MemoryEventRepository,
  MemoryGamesRepository,
  type BettingSplitPersistResult,
  type BettingSplitRepository,
  type FixtureOddsCurrentWrite,
  type FixtureOddsDynamoGateway,
  type FixtureOddsItem,
  type FixtureOddsSnapshotTransaction,
} from "@find-the-edge/database";
import type {
  BettingSplitObservation,
  FixtureOddsAvailabilityEvidence,
  IsoTimestamp,
} from "@find-the-edge/domain";
import {
  SHARP_API_PROVIDER_ID,
  sharpApiLeagueByKey,
  type SharpApiBookmaker,
  type SharpApiEvent,
  type SharpApiLeague,
  type SharpApiOddsPage,
  type SharpApiSplitPage,
} from "@find-the-edge/providers";

import {
  ingestSharpApi,
  persistSharpApiOddsPage,
  persistSharpApiSplitPage,
} from "./sharp-api-ingestion";

const STARTS_AT = "2026-08-05T18:00:00.000Z" as IsoTimestamp;
const SCHEDULED_ONLY_STARTS_AT = "2026-08-05T20:00:00.000Z" as IsoTimestamp;
const NEW_OBSERVED_AT = "2026-08-05T12:00:00.000Z" as IsoTimestamp;
const NEW_RETRIEVED_AT = "2026-08-05T12:00:01.000Z" as IsoTimestamp;
const OLD_OBSERVED_AT = "2026-08-05T11:00:00.000Z" as IsoTimestamp;
const OLD_RETRIEVED_AT = "2026-08-05T11:00:01.000Z" as IsoTimestamp;

const games = {
  scheduled: {
    providerEventId: "mlb-white-sox-red-sox_2026-08-05_b3",
    awayTeam: "Chicago White Sox",
    homeTeam: "Boston Red Sox",
    awayClubKey: "whitesox",
    homeClubKey: "redsox",
    startsAt: STARTS_AT,
  },
  oddsOnly: {
    providerEventId: "mlb-marlins-braves_2026-08-05_b3",
    awayTeam: "Miami Marlins",
    homeTeam: "Atlanta Braves",
    awayClubKey: "marlins",
    homeClubKey: "braves",
    startsAt: "2026-08-05T19:00:00.000Z" as IsoTimestamp,
  },
  scheduleOnly: {
    providerEventId: "mlb-mets-tigers_2026-08-05_b3",
    awayTeam: "New York Mets",
    homeTeam: "Detroit Tigers",
    awayClubKey: "mets",
    homeClubKey: "tigers",
    startsAt: SCHEDULED_ONLY_STARTS_AT,
  },
} as const;

const moneylineBook = (
  event: (typeof games)[keyof typeof games],
  id: string,
  observedAt: IsoTimestamp,
  awayOdds: number,
  homeOdds: number,
): SharpApiBookmaker => ({
  id,
  label: id,
  prices: [
    {
      providerPriceId: `${event.providerEventId}:${id}:away:${observedAt}`,
      marketKey: "moneyline",
      outcomeStructure: "two-way",
      providerMarketType: "moneyline",
      providerMarketId: `${event.providerEventId}:${id}:moneyline`,
      selectionKey: "away",
      selectionLabel: event.awayTeam,
      providerSelectionId: `${event.providerEventId}:${id}:away`,
      americanOdds: awayOdds,
      decimalOdds: awayOdds > 0 ? 1 + awayOdds / 100 : 1 + 100 / -awayOdds,
      impliedProbability:
        awayOdds > 0 ? 100 / (awayOdds + 100) : -awayOdds / (-awayOdds + 100),
      isLive: false,
      isMainLine: true,
      isAlternateLine: false,
      isPlayerProp: false,
      isStalePregamePrice: false,
      isActive: true,
      isSuspended: false,
      observedAt,
    },
    {
      providerPriceId: `${event.providerEventId}:${id}:home:${observedAt}`,
      marketKey: "moneyline",
      outcomeStructure: "two-way",
      providerMarketType: "moneyline",
      providerMarketId: `${event.providerEventId}:${id}:moneyline`,
      selectionKey: "home",
      selectionLabel: event.homeTeam,
      providerSelectionId: `${event.providerEventId}:${id}:home`,
      americanOdds: homeOdds,
      decimalOdds: homeOdds > 0 ? 1 + homeOdds / 100 : 1 + 100 / -homeOdds,
      impliedProbability:
        homeOdds > 0 ? 100 / (homeOdds + 100) : -homeOdds / (-homeOdds + 100),
      isLive: false,
      isMainLine: true,
      isAlternateLine: false,
      isPlayerProp: false,
      isStalePregamePrice: false,
      isActive: true,
      isSuspended: false,
      observedAt,
    },
  ],
});

const oddsEvent = (
  event: (typeof games)[keyof typeof games],
  bookmakers: readonly SharpApiBookmaker[],
): SharpApiEvent => ({
  ...event,
  providerEventUuid: `${event.providerEventId}:uuid`,
  bookmakers,
});

class LocalFixtureOddsGateway implements FixtureOddsDynamoGateway {
  readonly items = new Map<string, FixtureOddsItem>();
  readonly availability = new Map<string, FixtureOddsAvailabilityEvidence>();

  constructor(readonly events: MemoryEventIngestionStore) {}

  private key(pk: string, sk: string) {
    return `${pk}\u0000${sk}`;
  }

  getExact(pk: string, sk: string) {
    return Promise.resolve(this.items.get(this.key(pk, sk)) ?? null);
  }

  transactSnapshot(request: FixtureOddsSnapshotTransaction) {
    const mappingId = String(request.mapping.expected["id"]);
    const canonicalEventId = String(request.canonicalEvent.expected["id"]);
    const mapping = this.events.mappings.get(mappingId);
    const event = this.events.events.get(canonicalEventId);
    const matches = (
      actual: object | undefined,
      expected: Readonly<Record<string, string | number>>,
    ) =>
      actual !== undefined &&
      Object.entries(expected).every(
        ([key, value]) =>
          (actual as unknown as Record<string, unknown>)[key] === value,
      );
    const reasons = [
      matches(mapping, request.mapping.expected)
        ? "None"
        : "ConditionalCheckFailed",
      matches(event, request.canonicalEvent.expected)
        ? "None"
        : "ConditionalCheckFailed",
      this.items.has(this.key(request.snapshot.pk, request.snapshot.sk))
        ? "ConditionalCheckFailed"
        : "None",
    ] as const;
    if (reasons.some((reason) => reason !== "None"))
      throw new FixtureOddsTransactionCanceledError(
        reasons.map((code) => ({ code })),
      );
    this.items.set(
      this.key(request.snapshot.pk, request.snapshot.sk),
      structuredClone(request.snapshot),
    );
    return Promise.resolve();
  }

  putCurrent(request: FixtureOddsCurrentWrite) {
    const key = this.key(request.item.pk, request.item.sk);
    const existing = this.items.get(key)?.value;
    if (
      existing &&
      !(
        existing.observedAt < request.advanceAfter.observedAt ||
        (existing.observedAt === request.advanceAfter.observedAt &&
          existing.snapshotId < request.advanceAfter.snapshotId)
      )
    )
      throw new FixtureOddsTransactionCanceledError([
        { code: "ConditionalCheckFailed" },
      ]);
    this.items.set(key, structuredClone(request.item));
    return Promise.resolve();
  }

  getAvailability(partitionKey: string) {
    return Promise.resolve(this.availability.get(partitionKey) ?? null);
  }

  putAvailability(value: FixtureOddsAvailabilityEvidence) {
    this.availability.set(value.identity, structuredClone(value));
    return Promise.resolve();
  }

  batchGet(
    keys: readonly {
      readonly pk: string;
      readonly sk: "CURRENT" | "AVAILABILITY";
    }[],
  ): Promise<readonly unknown[]> {
    return Promise.resolve(
      keys.flatMap<unknown>(({ pk, sk }) => {
        if (sk === "AVAILABILITY") {
          const value = this.availability.get(pk);
          return value ? [{ pk, sk, value: structuredClone(value) }] : [];
        }
        const item = this.items.get(this.key(pk, sk));
        return item ? [structuredClone(item)] : [];
      }),
    );
  }

  snapshots() {
    return [...this.items.values()]
      .filter(({ sk }) => sk !== "CURRENT")
      .map(({ value }) => value);
  }

  currents() {
    return [...this.items.values()]
      .filter(({ sk }) => sk === "CURRENT")
      .map(({ value }) => value);
  }
}

class RecordingSplitRepository implements BettingSplitRepository {
  readonly memory = new MemoryBettingSplitRepository();
  readonly decisions: BettingSplitPersistResult[] = [];

  async persist(
    input: Omit<BettingSplitObservation, "id"> & { readonly id?: string },
  ) {
    const result = await this.memory.persist(input);
    this.decisions.push(result);
    return result;
  }

  current(...args: Parameters<BettingSplitRepository["current"]>) {
    return this.memory.current(...args);
  }

  listCurrent(...args: Parameters<BettingSplitRepository["listCurrent"]>) {
    return this.memory.listCurrent(...args);
  }

  persistGap(...args: Parameters<BettingSplitRepository["persistGap"]>) {
    return this.memory.persistGap(...args);
  }
}

const splitPage = (
  event: (typeof games)["scheduled"] | (typeof games)["oddsOnly"],
  scope: "draftkings" | "circa",
  providerTimestamp: IsoTimestamp,
  retrievedAt: IsoTimestamp,
  awayBetPercent: number,
): SharpApiSplitPage => ({
  items: [
    {
      providerEventId: event.providerEventId,
      sport: "baseball",
      league: "mlb",
      sportsbookId: scope,
      awayTeam: event.awayTeam,
      homeTeam: event.homeTeam,
      providerTimestamp,
      markets: [
        {
          marketKey: "moneyline",
          selections: [
            {
              selectionKey: "away",
              betPercent: awayBetPercent,
              moneyPercent: awayBetPercent + 10,
            },
            {
              selectionKey: "home",
              betPercent: 100 - awayBetPercent,
              moneyPercent: 90 - awayBetPercent,
            },
          ],
        },
      ],
    },
  ],
  hasMore: false,
  retrievedAt,
});

const sharpApiCollectionPolicy = (league: SharpApiLeague) => {
  const policy = productionOddsCollectionPolicies
    .find(({ leagueKey }) => leagueKey === league.leagueKey)
    ?.providers.find(({ providerId }) => providerId === SHARP_API_PROVIDER_ID);
  if (!policy) throw new Error("test collection policy missing");
  return policy as {
    readonly books: Readonly<Record<string, OddsBookRole>>;
    readonly expectedBooks?: Readonly<Record<string, readonly string[]>>;
  };
};

describe("local SharpAPI ingestion end to end", () => {
  it("preserves schedule-classified games, Pinnacle odds, immutable history, current winners, and paginated splits", async () => {
    const eventStore = new MemoryEventIngestionStore();
    const oddsGateway = new LocalFixtureOddsGateway(eventStore);
    const odds = new DynamoFixtureOddsAdapter(oddsGateway);
    const splits = new RecordingSplitRepository();
    const scheduleRequests: string[] = [];
    const oddsRequests: string[] = [];
    const splitRequests: string[] = [];

    const summary = await ingestSharpApi(
      eventStore,
      odds,
      splits,
      "synthetic-local-key",
      {
        fetchAccount: () =>
          Promise.resolve({
            tier: "sharp",
            features: ["odds", "schedule", "splits"],
            requestsPerMinute: 300,
            maxBooks: 25,
            streamingEnabled: false,
          }),
        fetchSchedulePage: (league, _key, offset = 0) => {
          scheduleRequests.push(`${league.leagueKey}:${offset}`);
          if (league.leagueKey !== "mlb")
            return Promise.resolve({
              events: [],
              hasMore: false,
              retrievedAt: "2026-08-05T11:50:00.000Z" as IsoTimestamp,
            });
          return Promise.resolve(
            offset === 0
              ? {
                  events: [
                    { ...games.scheduled, status: "scheduled" as const },
                  ],
                  hasMore: true,
                  nextOffset: 1,
                  retrievedAt: "2026-08-05T11:50:00.000Z" as IsoTimestamp,
                }
              : {
                  events: [
                    { ...games.scheduleOnly, status: "scheduled" as const },
                  ],
                  hasMore: false,
                  retrievedAt: "2026-08-05T11:50:01.000Z" as IsoTimestamp,
                },
          );
        },
        fetchOddsPage: (league, _key, cursor) => {
          oddsRequests.push(`${league.leagueKey}:${cursor ?? "first"}`);
          if (league.leagueKey !== "mlb")
            return Promise.resolve({
              events: [],
              hasMore: false,
              retrievedAt: NEW_RETRIEVED_AT,
            });
          return Promise.resolve(
            cursor === undefined
              ? {
                  events: [
                    oddsEvent(games.scheduled, [
                      moneylineBook(
                        games.scheduled,
                        "hardrock",
                        NEW_OBSERVED_AT,
                        115,
                        -125,
                      ),
                      moneylineBook(
                        games.scheduled,
                        "draftkings",
                        NEW_OBSERVED_AT,
                        110,
                        -120,
                      ),
                    ]),
                  ],
                  hasMore: true,
                  nextCursor: "odds-next",
                  retrievedAt: NEW_RETRIEVED_AT,
                }
              : {
                  events: [
                    oddsEvent(games.scheduled, [
                      moneylineBook(
                        games.scheduled,
                        "Pinnacle Sports",
                        NEW_OBSERVED_AT,
                        108,
                        -118,
                      ),
                    ]),
                    oddsEvent(games.oddsOnly, [
                      moneylineBook(
                        games.oddsOnly,
                        "hardrock",
                        NEW_OBSERVED_AT,
                        125,
                        -135,
                      ),
                      moneylineBook(
                        games.oddsOnly,
                        "draftkings",
                        NEW_OBSERVED_AT,
                        120,
                        -130,
                      ),
                      moneylineBook(
                        games.oddsOnly,
                        "pinnacle",
                        NEW_OBSERVED_AT,
                        118,
                        -128,
                      ),
                    ]),
                  ],
                  hasMore: false,
                  retrievedAt: NEW_RETRIEVED_AT,
                },
          );
        },
        fetchSplitsPage: (league, _key, offset = 0) => {
          splitRequests.push(`${league.leagueKey}:${offset}`);
          if (league.leagueKey !== "mlb")
            return Promise.resolve({
              items: [],
              hasMore: false,
              retrievedAt: NEW_RETRIEVED_AT,
            });
          if (offset === 0)
            return Promise.resolve({
              ...splitPage(
                games.scheduled,
                "draftkings",
                NEW_OBSERVED_AT,
                NEW_RETRIEVED_AT,
                55,
              ),
              hasMore: true,
              nextOffset: 1,
            });
          return Promise.resolve(
            splitPage(
              games.oddsOnly,
              "circa",
              NEW_OBSERVED_AT,
              NEW_RETRIEVED_AT,
              48,
            ),
          );
        },
      },
    );

    expect(summary).toMatchObject({
      leagues: 5,
      events: 1,
      observations: 6,
      splits: 2,
      splitsEntitled: true,
    });
    expect(scheduleRequests).toEqual([
      "mlb:0",
      "mlb:1",
      "mls:0",
      "epl:0",
      "liga-mx:0",
      "uefa-champions-league:0",
    ]);
    expect(oddsRequests).toEqual([
      "mlb:first",
      "mlb:odds-next",
      "mls:first",
      "epl:first",
      "liga-mx:first",
      "uefa-champions-league:first",
    ]);
    expect(splitRequests).toEqual([
      "mlb:0",
      "mlb:1",
      "mls:0",
      "epl:0",
      "liga-mx:0",
      "uefa-champions-league:0",
    ]);
    expect(eventStore.events).toHaveLength(2);
    expect(
      oddsGateway
        .currents()
        .filter(({ sportsbookId }) =>
          ["hardrock", "draftkings", "pinnacle"].includes(sportsbookId),
        ),
    ).toHaveLength(6);
    expect(
      oddsGateway
        .currents()
        .filter(({ sportsbookId }) => sportsbookId === "pinnacle"),
    ).toHaveLength(2);

    const mlb = sharpApiLeagueByKey("mlb");
    const policy = sharpApiCollectionPolicy(mlb);
    const olderPinnaclePage: Pick<SharpApiOddsPage, "events" | "retrievedAt"> =
      {
        events: [
          oddsEvent(games.scheduled, [
            moneylineBook(
              games.scheduled,
              "pinnacle",
              OLD_OBSERVED_AT,
              130,
              -140,
            ),
          ]),
        ],
        retrievedAt: OLD_RETRIEVED_AT,
      };
    const snapshotsBeforeOlderEvidence = oddsGateway.snapshots().length;
    const older = await persistSharpApiOddsPage(
      eventStore,
      odds,
      mlb,
      olderPinnaclePage,
      policy.books,
      undefined,
      policy.expectedBooks,
    );
    expect(older).toMatchObject({
      observations: 2,
      snapshotsCreated: 2,
      currentRetained: 2,
    });
    expect(oddsGateway.snapshots()).toHaveLength(
      snapshotsBeforeOlderEvidence + 2,
    );
    const replay = await persistSharpApiOddsPage(
      eventStore,
      odds,
      mlb,
      olderPinnaclePage,
      policy.books,
      undefined,
      policy.expectedBooks,
    );
    expect(replay).toMatchObject({
      observations: 2,
      snapshotsExisting: 2,
      currentRetained: 2,
    });
    expect(oddsGateway.snapshots()).toHaveLength(
      snapshotsBeforeOlderEvidence + 2,
    );
    expect(
      oddsGateway
        .currents()
        .find(
          ({ sportsbookId, selectionLabel }) =>
            sportsbookId === "pinnacle" &&
            selectionLabel === games.scheduled.awayTeam,
        )?.americanOdds,
    ).toBe(108);

    const splitDecisionsBeforeOlderEvidence = splits.decisions.length;
    await persistSharpApiSplitPage(
      eventStore,
      splits,
      mlb,
      splitPage(
        games.scheduled,
        "draftkings",
        OLD_OBSERVED_AT,
        OLD_RETRIEVED_AT,
        30,
      ),
    );
    expect(splits.decisions.slice(splitDecisionsBeforeOlderEvidence)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ history: "inserted", current: "retained" }),
      ]),
    );
    const decisionsBeforeSplitReplay = splits.decisions.length;
    await persistSharpApiSplitPage(
      eventStore,
      splits,
      mlb,
      splitPage(
        games.scheduled,
        "draftkings",
        OLD_OBSERVED_AT,
        OLD_RETRIEVED_AT,
        30,
      ),
    );
    expect(splits.decisions.slice(decisionsBeforeSplitReplay)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ history: "duplicate", current: "retained" }),
      ]),
    );

    const events = new MemoryEventRepository(
      eventStore,
      new EventCursorCodec({
        current: { id: "local-e2e", secret: Buffer.alloc(32, 17) },
      }),
      () => new Date("2026-08-05T12:05:00.000Z"),
    );
    const gameRepository = new MemoryGamesRepository(
      events,
      oddsGateway,
      ["hardrock", "draftkings", "pinnacle"],
      () => new Date("2026-08-05T12:05:00.000Z"),
    );
    const handler = createEventHandler(
      events,
      gameRepository,
      () => undefined,
      splits,
    );
    const gamesResponse = await handler({
      route: "games",
      query: {
        sport: "mlb",
        league: "mlb",
        status: "scheduled",
        day: "2026-08-05",
        limit: "50",
      },
    });
    expect(gamesResponse.statusCode).toBe(200);
    const gamesBody = JSON.parse(gamesResponse.body) as {
      readonly items: readonly {
        readonly id: string;
        readonly participants: readonly { readonly label: string }[];
        readonly odds: { readonly state: string };
      }[];
    };
    expect(gamesBody.items).toHaveLength(2);
    expect(new Set(gamesBody.items.map(({ id }) => id))).toHaveLength(2);
    expect(
      gamesBody.items.map(({ participants }) =>
        participants.map(({ label }) => label).join(" vs "),
      ),
    ).toEqual([
      "Chicago White Sox vs Boston Red Sox",
      "New York Mets vs Detroit Tigers",
    ]);
    expect(gamesBody.items.map(({ odds: { state } }) => state)).toEqual([
      "available",
      "unavailable",
    ]);

    const splitsResponse = await handler({
      route: "splits",
      query: {
        sport: "mlb",
        league: "mlb",
        status: "scheduled",
        day: "2026-08-05",
        limit: "50",
      },
    });
    expect(splitsResponse.statusCode).toBe(200);
    const splitsBody = JSON.parse(splitsResponse.body) as {
      readonly items: readonly {
        readonly participants: readonly { readonly label: string }[];
        readonly splits: readonly BettingSplitObservation[];
      }[];
    };
    expect(splitsBody.items.map(({ splits: values }) => values.length)).toEqual(
      [2, 0],
    );
    const scheduledSplits = splitsBody.items[0]!.splits;
    expect(scheduledSplits).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          scope: "draftkings",
          selectionKey: "away",
          betPercent: 55,
          moneyPercent: 65,
          providerTimestamp: NEW_OBSERVED_AT,
        }),
      ]),
    );
  });
});
