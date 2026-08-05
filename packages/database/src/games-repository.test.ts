import { describe, expect, it } from "vitest";
import {
  normalizeFixtureOddsObservation,
  assessEventMetadata,
  participantSelectionKey,
  fixtureOddsGroupAvailabilityIdentity,
  type EventDisplayDto,
  type EntityId,
} from "@find-the-edge/domain";
import { EventStorageError } from "./event-errors";
import type { EventRepository } from "./event-repository";
import { JoinedGamesRepository } from "./games-repository";

const event: EventDisplayDto = {
  id: "event-1",
  version: 2,
  sportKey: "mlb",
  leagueKey: "mlb",
  competition: { key: "mlb", state: "provisional" },
  participants: [
    { id: "bos", label: "Boston Red Sox" },
    { id: "nyy", label: "New York Yankees" },
  ],
  startsAt: "2026-08-01T17:00:00.000Z",
  eastern: {
    timeZone: "America/New_York",
    calendarDay: "2026-08-01",
    display: "Aug 1, 2026",
  },
  status: "scheduled",
  freshness: "2026-08-01T12:00:00.000Z",
  metadata: assessEventMetadata(
    "scheduled",
    "2026-08-01T12:00:00.000Z",
    "2026-08-01T12:30:00.000Z",
  ),
};
const participantKey = (id: string) => participantSelectionKey(id as EntityId);
const events = (
  items: readonly EventDisplayDto[] = [event],
  seen: { cursor: string | undefined } = { cursor: undefined },
  nextCursor: string | null = "next",
): EventRepository => ({
  list: async (_filter, _limit, cursor) => {
    await Promise.resolve();
    seen.cursor = cursor;
    return {
      items,
      nextCursor,
      projectionState: "ready",
      evaluationState: "complete",
      hasMoreUnknown: false,
      snapshotAt: "2026-08-01T12:00:00.000Z",
      freshness: event.freshness,
      unavailableReason: null,
    };
  },
  detail: () =>
    Promise.resolve({
      projectionState: "ready",
      item: null,
      unavailableReason: null,
    }),
});
const current = (
  source: EventDisplayDto,
  selectionKey: string,
  selectionLabel: string,
  marketKey = "moneyline",
  sportsbookId = "draftkings",
  observedAt = "2026-08-01T12:00:00.000Z",
  point?: number,
) => {
  const canonicalSelectionKey =
    selectionKey === "away"
      ? participantKey(source.participants[0]!.id)
      : selectionKey === "home"
        ? participantKey(source.participants[1]!.id)
        : selectionKey;
  return normalizeFixtureOddsObservation({
    canonicalEventId: source.id,
    canonicalEventVersion: source.version,
    sportKey: source.sportKey,
    marketKey,
    selectionKey: canonicalSelectionKey,
    selectionLabel,
    sportsbookId,
    sportsbookLabel: sportsbookId === "draftkings" ? "DraftKings" : "FanDuel",
    ...(point === undefined ? {} : { point }),
    americanOdds: selectionKey === "home" ? -135 : 120,
    observedAt,
    retrievedAt: "2026-08-01T12:00:00.000Z",
  });
};
const row = (value: ReturnType<typeof current>) => ({
  pk: value.partitionKey,
  sk: "CURRENT",
  value,
});

describe("joined games repository", () => {
  it("builds authoritative multi-book detail and fails target qualification when Hard Rock is blocked", async () => {
    const hardrockAway = current(
      event,
      "away",
      "Incorrect provider label",
      "moneyline",
      "hardrock",
    );
    const hardrockHome = current(
      event,
      "home",
      "New York Yankees",
      "moneyline",
      "hardrock",
    );
    const dkAway = current(event, "away", "Boston Red Sox");
    const dkHome = current(event, "home", "New York Yankees");
    const prices = [hardrockAway, hardrockHome, dkAway, dkHome];
    const evidence = prices.map((price) => ({
      pk: price.partitionKey,
      sk: "AVAILABILITY",
      value: {
        identity: price.partitionKey,
        state: price.sportsbookId === "hardrock" ? "suspended" : "active",
        observedAt: "2026-08-01T12:05:00.000Z",
        evidenceId: `e-${price.selectionKey}-${price.sportsbookId}`,
        reason:
          price.sportsbookId === "hardrock"
            ? "market-suspended"
            : "active-price",
      },
    }));
    for (const sportsbookId of ["hardrock", "draftkings"])
      evidence.push({
        pk: fixtureOddsGroupAvailabilityIdentity({
          canonicalEventId: event.id,
          canonicalEventVersion: event.version,
          sportKey: event.sportKey,
          marketKey: "moneyline",
          sportsbookId,
        }),
        sk: "AVAILABILITY",
        value: {
          identity: fixtureOddsGroupAvailabilityIdentity({
            canonicalEventId: event.id,
            canonicalEventVersion: event.version,
            sportKey: event.sportKey,
            marketKey: "moneyline",
            sportsbookId,
          }),
          state: sportsbookId === "hardrock" ? "suspended" : "active",
          observedAt: "2026-08-01T12:05:00.000Z",
          evidenceId: `group-${sportsbookId}`,
          reason:
            sportsbookId === "hardrock"
              ? "market-suspended"
              : "market-complete",
        },
      });
    const eventRepository = events();
    eventRepository.detail = () =>
      Promise.resolve({
        projectionState: "ready",
        item: event,
        unavailableReason: null,
      });
    const detail = await new JoinedGamesRepository(
      eventRepository,
      { batchGet: () => Promise.resolve([...prices.map(row), ...evidence]) },
      ["hardrock", "draftkings"],
      () => new Date("2026-08-01T13:00:00.000Z"),
    ).detail("event-1");
    expect(detail.item?.oddsComparison).toMatchObject({
      targetSportsbookId: "hardrock",
      targetQualified: false,
    });
    expect(
      detail.item?.oddsComparison.markets[0]?.selections[0]?.cells,
    ).toMatchObject({
      hardrock: { state: "suspended", eligible: false, americanOdds: 120 },
      draftkings: { state: "active", eligible: true, americanOdds: 120 },
    });
    expect(
      detail.item?.oddsComparison.markets[0]?.selections[0]?.selectionLabel,
    ).toBe("Boston Red Sox");
  });

  it("renders every configured book as unavailable without inventing evidence", async () => {
    const eventRepository = events();
    eventRepository.detail = () =>
      Promise.resolve({
        projectionState: "ready",
        item: event,
        unavailableReason: null,
      });
    const detail = await new JoinedGamesRepository(
      eventRepository,
      { batchGet: () => Promise.resolve([]) },
      ["hardrock", "draftkings"],
    ).detail("event-1");
    expect(
      detail.item?.oddsComparison.markets[0]?.selections[0]?.cells,
    ).toEqual({
      hardrock: {
        state: "unavailable",
        eligible: false,
        reason: "price-unavailable",
        evidenceAt: null,
      },
      draftkings: {
        state: "unavailable",
        eligible: false,
        reason: "price-unavailable",
        evidenceAt: null,
      },
    });
  });

  it("keeps missing availability unavailable before staleness and lets retained blockers win", async () => {
    const away = current(
      event,
      "away",
      "Boston Red Sox",
      "moneyline",
      "hardrock",
      "2026-08-01T12:00:00.000Z",
    );
    const eventRepository = events();
    eventRepository.detail = () =>
      Promise.resolve({
        projectionState: "ready",
        item: event,
        unavailableReason: null,
      });
    const blocked = {
      identity: away.partitionKey,
      state: "suspended" as const,
      observedAt: "2026-08-01T07:00:00-04:00",
      evidenceId: "older-blocker",
      reason: "market-suspended",
    };
    const groupIdentity = fixtureOddsGroupAvailabilityIdentity(away);
    const group = {
      identity: groupIdentity,
      state: "active" as const,
      observedAt: "2026-08-01T08:05:00-04:00",
      evidenceId: "group-active",
      reason: "market-complete",
    };
    const blockedDetail = await new JoinedGamesRepository(
      eventRepository,
      {
        batchGet: () =>
          Promise.resolve([
            row(away),
            { pk: away.partitionKey, sk: "AVAILABILITY", value: blocked },
            { pk: groupIdentity, sk: "AVAILABILITY", value: group },
          ]),
      },
      ["hardrock"],
      () => new Date("2026-08-01T12:30:00.000Z"),
    ).detail(event.id);
    expect(
      blockedDetail.item?.oddsComparison.markets[0]?.selections[0]?.cells
        .hardrock,
    ).toMatchObject({ state: "suspended", reason: "market-suspended" });
    const missingDetail = await new JoinedGamesRepository(
      eventRepository,
      { batchGet: () => Promise.resolve([row(away)]) },
      ["hardrock"],
      () => new Date("2026-08-02T12:30:00.000Z"),
    ).detail(event.id);
    expect(
      missingDetail.item?.oddsComparison.markets[0]?.selections[0]?.cells
        .hardrock,
    ).toMatchObject({
      state: "unavailable",
      reason: "availability-evidence-missing",
    });
  });

  it("uses an explicit target independent of sportsbook roster order", async () => {
    const eventRepository = events();
    eventRepository.detail = () =>
      Promise.resolve({
        projectionState: "ready",
        item: event,
        unavailableReason: null,
      });
    const detail = await new JoinedGamesRepository(
      eventRepository,
      { batchGet: () => Promise.resolve([]) },
      ["draftkings", "hardrock"],
      () => new Date("2026-08-01T12:30:00.000Z"),
      7_200_000,
      "hardrock",
      undefined,
      [
        { id: "hardrock", label: "Hard Rock Bet" },
        { id: "draftkings", label: "DraftKings" },
        { id: "pinnacle", label: "Pinnacle" },
      ],
    ).detail(event.id);
    expect(detail.item?.oddsComparison).toMatchObject({
      targetSportsbookId: "hardrock",
      targetQualified: false,
      sportsbooks: [
        { id: "hardrock", label: "Hard Rock Bet", target: true },
        { id: "draftkings", label: "DraftKings", target: false },
        { id: "pinnacle", label: "Pinnacle", target: false },
      ],
    });
  });

  it("qualifies the explicit target only when every expected market cell is eligible", async () => {
    const prices = [
      current(event, "away", "Boston", "moneyline", "hardrock"),
      current(event, "home", "New York", "moneyline", "hardrock"),
      current(event, "away", "Boston", "spread", "hardrock", undefined, 1.5),
      current(event, "home", "New York", "spread", "hardrock", undefined, -1.5),
      current(event, "over", "Over", "total", "hardrock", undefined, 8.5),
      current(event, "under", "Under", "total", "hardrock", undefined, 8.5),
    ];
    const evidence = prices.map((price) => ({
      pk: price.partitionKey,
      sk: "AVAILABILITY",
      value: {
        identity: price.partitionKey,
        state: "active",
        observedAt: price.observedAt,
        evidenceId: price.snapshotId,
        reason: "active-price",
      },
    }));
    for (const marketKey of ["moneyline", "spread", "total"]) {
      const identity = fixtureOddsGroupAvailabilityIdentity({
        canonicalEventId: event.id,
        canonicalEventVersion: event.version,
        sportKey: event.sportKey,
        marketKey,
        sportsbookId: "hardrock",
      });
      evidence.push({
        pk: identity,
        sk: "AVAILABILITY",
        value: {
          identity,
          state: "active",
          observedAt: "2026-08-01T12:00:00.000Z",
          evidenceId: `group-${marketKey}`,
          reason: "market-complete",
        },
      });
    }
    const eventRepository = events();
    eventRepository.detail = () =>
      Promise.resolve({
        projectionState: "ready",
        item: event,
        unavailableReason: null,
      });
    const detail = await new JoinedGamesRepository(
      eventRepository,
      { batchGet: () => Promise.resolve([...prices.map(row), ...evidence]) },
      ["hardrock"],
      () => new Date("2026-08-01T12:30:00.000Z"),
    ).detail(event.id);
    expect(detail.item?.oddsComparison.targetQualified).toBe(true);
  });

  it("rejects a missing or duplicated explicit target", async () => {
    const eventRepository = events();
    eventRepository.detail = () =>
      Promise.resolve({
        projectionState: "ready",
        item: event,
        unavailableReason: null,
      });
    for (const books of [["draftkings"], ["hardrock", "hardrock"]])
      await expect(
        new JoinedGamesRepository(
          eventRepository,
          { batchGet: () => Promise.resolve([]) },
          books,
          undefined,
          undefined,
          "hardrock",
        ).detail(event.id),
      ).rejects.toThrow("invalid-detail-sportsbook-roster");
  });

  it("fails closed for price or availability evidence beyond clock-skew tolerance", async () => {
    const eventRepository = events();
    eventRepository.detail = () =>
      Promise.resolve({
        projectionState: "ready",
        item: event,
        unavailableReason: null,
      });
    const futurePrice = current(
      event,
      "away",
      "Boston",
      "moneyline",
      "hardrock",
      "2026-08-01T12:06:00.000Z",
    );
    await expect(
      new JoinedGamesRepository(
        eventRepository,
        { batchGet: () => Promise.resolve([row(futurePrice)]) },
        ["hardrock"],
        () => new Date("2026-08-01T12:00:00.000Z"),
      ).detail(event.id),
    ).rejects.toThrow("future-detail-odds-evidence");
    const key = futurePrice.partitionKey;
    await expect(
      new JoinedGamesRepository(
        eventRepository,
        {
          batchGet: () =>
            Promise.resolve([
              {
                pk: key,
                sk: "AVAILABILITY",
                value: {
                  identity: key,
                  state: "active",
                  observedAt: "2026-08-01T12:05:00.001Z",
                  evidenceId: "future",
                  reason: "active-price",
                },
              },
            ]),
        },
        ["hardrock"],
        () => new Date("2026-08-01T12:00:00.000Z"),
      ).detail(event.id),
    ).rejects.toThrow("invalid-detail-availability-row");
  });
  it("preserves page metadata and rebuilds MLB away/home order independently of response order", async () => {
    const seen: {
      cursor: string | undefined;
      keys?: readonly unknown[];
    } = { cursor: undefined };
    const away = current(event, "away", "Boston Red Sox");
    const home = current(event, "home", "New York Yankees");
    const page = await new JoinedGamesRepository(events([event], seen), {
      batchGet: (keys) => {
        seen.keys = keys;
        return Promise.resolve([row(home), row(away)]);
      },
    }).list(
      { sportKey: "mlb", status: "scheduled", day: "2026-08-01" },
      50,
      "cursor",
    );
    expect(seen.cursor).toBe("cursor");
    expect(seen.keys).toEqual(
      expect.arrayContaining([
        { pk: away.partitionKey, sk: "CURRENT" },
        { pk: home.partitionKey, sk: "CURRENT" },
      ]),
    );
    expect(seen.keys).toHaveLength(30);
    expect(page).toMatchObject({
      nextCursor: "next",
      snapshotAt: "2026-08-01T12:00:00.000Z",
    });
    expect(page.items[0]?.odds).toMatchObject({
      state: "available",
      selections: [
        { selectionKey: participantKey("bos"), americanOdds: 120 },
        { selectionKey: participantKey("nyy"), americanOdds: -135 },
      ],
    });
  });

  it("rebuilds soccer away/draw/home order", async () => {
    const soccer = {
      ...event,
      id: "event-mls",
      sportKey: "soccer",
      leagueKey: "mls",
      participants: [
        { id: "mia", label: "Miami" },
        { id: "atl", label: "Atlanta" },
      ],
    } as EventDisplayDto;
    const selections = [
      current(soccer, "away", "Miami"),
      current(soccer, "draw", "Draw"),
      current(soccer, "home", "Atlanta"),
    ];
    const page = await new JoinedGamesRepository(events([soccer]), {
      batchGet: () => Promise.resolve([...selections].reverse().map(row)),
    }).list({ sportKey: "soccer", status: "scheduled", day: "2026-08-01" }, 1);
    expect(page.items[0]?.odds).toMatchObject({
      state: "available",
      selections: [
        { selectionKey: participantKey("mia") },
        { selectionKey: "draw" },
        { selectionKey: participantKey("atl") },
      ],
    });
  });

  it("returns coherent spread and total markets beside moneyline", async () => {
    const selections = [
      current(event, "away", "Boston Red Sox"),
      current(event, "home", "New York Yankees"),
      current(
        event,
        "away",
        "Boston Red Sox",
        "spread",
        "draftkings",
        undefined,
        1.5,
      ),
      current(
        event,
        "home",
        "New York Yankees",
        "spread",
        "draftkings",
        undefined,
        -1.5,
      ),
      current(event, "over", "Over", "total", "draftkings", undefined, 8.5),
      current(event, "under", "Under", "total", "draftkings", undefined, 8.5),
    ];
    const page = await new JoinedGamesRepository(events(), {
      batchGet: () => Promise.resolve(selections.map(row).reverse()),
    }).list({ sportKey: "mlb", status: "scheduled", day: "2026-08-01" }, 1);
    expect(page.items[0]?.odds).toMatchObject({
      state: "available",
      selections: [
        { marketKey: "moneyline", selectionKey: participantKey("bos") },
        { marketKey: "moneyline", selectionKey: participantKey("nyy") },
        {
          marketKey: "spread",
          selectionKey: participantKey("bos"),
          point: 1.5,
        },
        {
          marketKey: "spread",
          selectionKey: participantKey("nyy"),
          point: -1.5,
        },
        { marketKey: "total", selectionKey: "over", point: 8.5 },
        { marketKey: "total", selectionKey: "under", point: 8.5 },
      ],
    });
  });

  it("uses unavailable only when the whole market is absent", async () => {
    const page = await new JoinedGamesRepository(events(), {
      batchGet: () => Promise.resolve([]),
    }).list({ sportKey: "mlb", status: "scheduled", day: "2026-08-01" }, 1);
    expect(page.items[0]?.odds).toEqual({ state: "unavailable" });
  });

  it("falls back to the next complete sportsbook market", async () => {
    const away = current(
      event,
      "away",
      "Boston Red Sox",
      "moneyline",
      "fanduel",
    );
    const home = current(
      event,
      "home",
      "New York Yankees",
      "moneyline",
      "fanduel",
    );
    const page = await new JoinedGamesRepository(events(), {
      batchGet: () => Promise.resolve([row(home), row(away)]),
    }).list({ sportKey: "mlb", status: "scheduled", day: "2026-08-01" }, 1);
    expect(page.items[0]?.odds).toMatchObject({
      state: "available",
      selections: [
        { selectionKey: participantKey("bos"), sportsbookId: "fanduel" },
        { selectionKey: participantKey("nyy"), sportsbookId: "fanduel" },
      ],
    });
  });

  it("fails closed for partial, malformed, mismatched, duplicate, and unexpected rows", async () => {
    const away = current(event, "away", "Boston Red Sox");
    const home = current(event, "home", "New York Yankees");
    const cases: readonly (readonly unknown[])[] = [
      [
        {
          pk: away.partitionKey,
          sk: "CURRENT",
          value: { ...away, canonicalEventVersion: 1 },
        },
        row(home),
      ],
      [row(away), row(away), row(home)],
      [row(away), row(home), { pk: "unexpected", sk: "CURRENT", value: away }],
      [{ pk: away.partitionKey, sk: "CURRENT", value: null }, row(home)],
    ];
    for (const rows of cases) {
      await expect(
        new JoinedGamesRepository(events(), {
          batchGet: () => Promise.resolve(rows),
        }).list({ sportKey: "mlb", status: "scheduled", day: "2026-08-01" }, 1),
      ).rejects.toBeInstanceOf(EventStorageError);
    }
  });

  it("hides partial and mixed-timestamp markets during ingestion", async () => {
    const away = current(event, "away", "Boston Red Sox");
    for (const rows of [
      [row(away)],
      [
        row(away),
        row(
          current(
            event,
            "home",
            "New York Yankees",
            "moneyline",
            "draftkings",
            "2026-08-01T12:01:00.000Z",
          ),
        ),
      ],
    ]) {
      const page = await new JoinedGamesRepository(events(), {
        batchGet: () => Promise.resolve(rows),
      }).list({ sportKey: "mlb", status: "scheduled", day: "2026-08-01" }, 1);
      expect(page.items[0]?.odds).toEqual({ state: "unavailable" });
    }
  });

  it("requests exact keys for four preferred books on a maximum soccer page", async () => {
    const soccerEvents = Array.from({ length: 50 }, (_, index) => ({
      ...event,
      id: `event-${index}`,
      sportKey: "soccer",
      leagueKey: "mls",
    })) as EventDisplayDto[];
    let requested = 0;
    await new JoinedGamesRepository(events(soccerEvents, undefined, null), {
      batchGet: (keys) => {
        requested = keys.length;
        return Promise.resolve([]);
      },
    }).list({ sportKey: "soccer", status: "scheduled", day: "2026-08-01" }, 50);
    expect(requested).toBe(1_750);
  });

  it("never returns legacy provider duplicates within the schedule tolerance", async () => {
    const canonical = {
      ...event,
      id: "event-sharp",
      version: 23,
      participants: [
        { id: "cws", label: "Chicago White Sox" },
        { id: "bos", label: "Boston Red Sox" },
      ],
      startsAt: "2026-08-01T23:10:00.000Z",
    } as EventDisplayDto;
    const legacyAlias = {
      ...canonical,
      id: "event-fallback",
      version: 1,
      participants: [
        { id: "cws-2", label: "Chicago WS" },
        { id: "bos-2", label: "Boston Red Sox" },
      ],
      startsAt: "2026-08-01T23:11:00.000Z",
    } as EventDisplayDto;
    const doubleheader = {
      ...canonical,
      id: "event-doubleheader",
      startsAt: "2026-08-01T23:12:01.000Z",
    } as EventDisplayDto;
    const selections = [
      current(canonical, "away", "Chicago White Sox"),
      current(canonical, "home", "Boston Red Sox"),
    ];

    const page = await new JoinedGamesRepository(
      events([legacyAlias, canonical, doubleheader], undefined, null),
      { batchGet: () => Promise.resolve(selections.map(row)) },
    ).list({ sportKey: "mlb", status: "scheduled", day: "2026-08-01" }, 50);

    expect(page.items.map(({ id }) => id)).toEqual([
      "event-sharp",
      "event-doubleheader",
    ]);
    expect(page.items[0]?.odds.state).toBe("available");
  });

  it("backfills a contaminated MLB page with the next valid game", async () => {
    const foreign = {
      ...event,
      id: "foreign",
      participants: [
        { id: "y", label: "Yomiuri Giants" },
        { id: "h", label: "Hanshin Tigers" },
      ],
    } as EventDisplayDto;
    const repository = events([foreign]);
    repository.list = (_filter, _limit, cursor) =>
      Promise.resolve({
        items: cursor ? [event] : [foreign],
        nextCursor: cursor ? null : "valid",
        projectionState: "ready",
        evaluationState: "complete",
        hasMoreUnknown: false,
        snapshotAt: event.freshness,
        freshness: event.freshness,
        unavailableReason: null,
      });
    const page = await new JoinedGamesRepository(repository, {
      batchGet: () => Promise.resolve([]),
    }).list({ sportKey: "mlb", status: "scheduled", day: "2026-08-01" }, 1);
    expect(page.items.map(({ id }) => id)).toEqual(["event-1"]);
  });

  it("fails loudly on a backfill cursor cycle", async () => {
    const foreign = {
      ...event,
      participants: [
        { id: "y", label: "Yomiuri Giants" },
        { id: "h", label: "Hanshin Tigers" },
      ],
    } as EventDisplayDto;
    await expect(
      new JoinedGamesRepository(events([foreign]), {
        batchGet: () => Promise.resolve([]),
      }).list({ sportKey: "mlb", status: "scheduled", day: "2026-08-01" }, 1),
    ).rejects.toThrow("games-cursor-cycle");
  });

  it("bounds an all-contaminated backfill", async () => {
    const foreign = {
      ...event,
      participants: [
        { id: "y", label: "Yomiuri Giants" },
        { id: "h", label: "Hanshin Tigers" },
      ],
    } as EventDisplayDto;
    let calls = 0;
    const repository = events([foreign]);
    repository.list = () => {
      calls += 1;
      return Promise.resolve({
        items: [foreign],
        nextCursor: `cursor-${calls}`,
        projectionState: "ready",
        evaluationState: "complete",
        hasMoreUnknown: false,
        snapshotAt: event.freshness,
        freshness: event.freshness,
        unavailableReason: null,
      });
    };
    await expect(
      new JoinedGamesRepository(repository, {
        batchGet: () => Promise.resolve([]),
      }).list({ sportKey: "mlb", status: "scheduled", day: "2026-08-01" }, 1),
    ).rejects.toThrow("games-backfill-limit");
    expect(calls).toBe(50);
  });

  it("continues backfill after collapsing a legacy duplicate", async () => {
    const alias = {
      ...event,
      id: "alias",
      participants: [
        { id: "bos-2", label: "Red Sox" },
        { id: "nyy-2", label: "Yankees" },
      ],
      startsAt: "2026-08-01T17:01:00.000Z",
    } as EventDisplayDto;
    const later = {
      ...event,
      id: "later",
      participants: [
        { id: "lad", label: "Los Angeles Dodgers" },
        { id: "sf", label: "San Francisco Giants" },
      ],
    } as EventDisplayDto;
    const repository = events([event, alias]);
    repository.list = (_filter, _limit, cursor) =>
      Promise.resolve({
        items: cursor ? [later] : [event, alias],
        nextCursor: cursor ? null : "later",
        projectionState: "ready",
        evaluationState: "complete",
        hasMoreUnknown: false,
        snapshotAt: event.freshness,
        freshness: event.freshness,
        unavailableReason: null,
      });
    const page = await new JoinedGamesRepository(repository, {
      batchGet: () => Promise.resolve([]),
    }).list({ sportKey: "mlb", status: "scheduled", day: "2026-08-01" }, 2);
    expect(page.items).toHaveLength(2);
    expect(page.items.map(({ id }) => id)).toContain("later");
    expect(
      page.items.filter(({ id }) => id === "event-1" || id === "alias"),
    ).toHaveLength(1);
  });
});
