import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Every fixture in this file lives on 2026-08-01. The repository treats a
// long-started scheduled game without odds evidence as a withdrawn listing,
// so the clock must sit inside the fixtures' day.
beforeAll(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(new Date("2026-08-01T12:31:00.000Z"));
});
afterAll(() => {
  vi.useRealTimers();
});
import {
  normalizeFixtureOddsObservation,
  assessEventMetadata,
  participantSelectionKey,
  fixtureOddsGroupAvailabilityIdentity,
  CLOSING_BOOK_SCHEMA_VERSION,
  type EventDisplayDto,
  type EntityId,
} from "@find-the-edge/domain";
import { EventStorageError } from "./event-errors";
import type { EventRepository } from "./event-repository";
import { DynamoGamesRepository } from "./dynamodb-games-repository";
import { JoinedGamesRepository } from "./games-repository";
import { MemoryGamesRepository } from "./memory-games-repository";
import { MemoryClosingLinesRepository } from "./closing-lines-repository";

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
const participantKey = (id: string, outcome?: "over" | "under") =>
  participantSelectionKey(id as EntityId, outcome);
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
  americanOdds?: number,
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
    americanOdds: americanOdds ?? (selectionKey === "home" ? -135 : 120),
    observedAt,
    retrievedAt: "2026-08-01T12:00:00.000Z",
  });
};
const row = (value: ReturnType<typeof current>) => ({
  pk: value.partitionKey,
  sk: "CURRENT",
  value,
});
const recordClosingBookForTest = (source: EventDisplayDto) => ({
  schemaVersion: CLOSING_BOOK_SCHEMA_VERSION,
  canonicalEventId: source.id,
  canonicalEventVersion: source.version,
  providerId: "sharpapi" as const,
  providerEventId: "provider-event-1",
  sportKey: source.sportKey,
  leagueKey: source.leagueKey,
  startsAt: source.startsAt,
  sportsbookId: "hardrock",
  providerSportsbookId: "hardrock",
  capturedAt: source.startsAt,
  retrievedAt: "2026-08-01T12:20:00.000Z",
  captureTrigger: "kickoff" as const,
  isFinal: true as const,
  selections: [
    {
      marketKey: "moneyline",
      selectionKey: participantKey(source.participants[0]!.id),
      sportsbookId: "hardrock",
      americanOdds: 130,
      observedAt: "2026-08-01T11:59:00.000Z",
      retrievedAt: "2026-08-01T12:20:00.000Z",
    },
    {
      marketKey: "moneyline",
      selectionKey: participantKey(source.participants[1]!.id),
      sportsbookId: "hardrock",
      americanOdds: -145,
      observedAt: "2026-08-01T11:59:00.000Z",
      retrievedAt: "2026-08-01T12:20:00.000Z",
    },
  ],
});
const activeEvidence = (prices: readonly ReturnType<typeof current>[]) => {
  const evidence: {
    pk: string;
    sk: string;
    value: {
      identity: string;
      state: "active";
      observedAt: string;
      evidenceId: string;
      reason: string;
    };
  }[] = prices.map((price) => ({
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
  for (const marketKey of [
    ...new Set(prices.map((price) => price.marketKey)),
  ]) {
    const price = prices.find(
      (candidate) => candidate.marketKey === marketKey,
    )!;
    const identity = fixtureOddsGroupAvailabilityIdentity(price);
    evidence.push({
      pk: identity,
      sk: "AVAILABILITY",
      value: {
        identity,
        state: "active",
        observedAt: price.observedAt,
        evidenceId: `group-${marketKey}`,
        reason: "market-complete",
      },
    });
  }
  return evidence;
};
const completeDetailPrices = (
  source: EventDisplayDto,
  sportsbookId = "hardrock",
) => [
  current(source, "away", "Boston", "moneyline", sportsbookId),
  ...(source.sportKey === "soccer"
    ? [current(source, "draw", "Draw", "moneyline", sportsbookId)]
    : []),
  current(source, "home", "New York", "moneyline", sportsbookId),
  current(source, "away", "Boston", "spread", sportsbookId, undefined, 1.5),
  current(source, "home", "New York", "spread", sportsbookId, undefined, -1.5),
  current(source, "over", "Over", "total", sportsbookId, undefined, 8.5),
  current(source, "under", "Under", "total", sportsbookId, undefined, 8.5),
  ...(source.sportKey === "soccer"
    ? [
        current(source, "yes", "Yes", "btts", sportsbookId),
        current(source, "no", "No", "btts", sportsbookId),
      ]
    : []),
  current(
    source,
    participantKey(source.participants[0]!.id, "over"),
    "Boston Over",
    "team_total",
    sportsbookId,
    undefined,
    4.5,
  ),
  current(
    source,
    participantKey(source.participants[0]!.id, "under"),
    "Boston Under",
    "team_total",
    sportsbookId,
    undefined,
    4.5,
  ),
  current(
    source,
    participantKey(source.participants[1]!.id, "over"),
    "New York Over",
    "team_total",
    sportsbookId,
    undefined,
    4.5,
  ),
  current(
    source,
    participantKey(source.participants[1]!.id, "under"),
    "New York Under",
    "team_total",
    sportsbookId,
    undefined,
    4.5,
  ),
];

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

  it("renders a corrupt legacy detail price as unavailable", async () => {
    const eventRepository = events();
    eventRepository.detail = () =>
      Promise.resolve({
        projectionState: "ready",
        item: event,
        unavailableReason: null,
      });
    const away = current(
      event,
      "away",
      "Boston Red Sox",
      "moneyline",
      "hardrock",
    );
    const detail = await new JoinedGamesRepository(
      eventRepository,
      {
        batchGet: () =>
          Promise.resolve([
            { pk: away.partitionKey, sk: "CURRENT", value: null },
          ]),
      },
      ["hardrock"],
    ).detail(event.id);
    expect(
      detail.item?.oddsComparison.markets[0]?.selections[0]?.cells.hardrock,
    ).toEqual({
      state: "unavailable",
      eligible: false,
      reason: "price-unavailable",
      evidenceAt: null,
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
      observedAt: "2026-08-01T11:00:00.000Z",
      evidenceId: "older-blocker",
      reason: "market-suspended",
    };
    const groupIdentity = fixtureOddsGroupAvailabilityIdentity(away);
    const group = {
      identity: groupIdentity,
      state: "active" as const,
      observedAt: "2026-08-01T12:05:00.000Z",
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
    const prices = completeDetailPrices(event);
    const evidence = activeEvidence(prices);
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
    expect(
      detail.item?.oddsComparison.markets.map(({ marketKey }) => marketKey),
    ).toEqual(["moneyline", "spread", "total", "team_total"]);
    expect(detail.item?.oddsComparison.markets[3]?.selections).toMatchObject([
      {
        selectionKey: participantKey("bos", "over"),
        selectionLabel: "Boston Red Sox Over",
      },
      {
        selectionKey: participantKey("bos", "under"),
        selectionLabel: "Boston Red Sox Under",
      },
      {
        selectionKey: participantKey("nyy", "over"),
        selectionLabel: "New York Yankees Over",
      },
      {
        selectionKey: participantKey("nyy", "under"),
        selectionLabel: "New York Yankees Under",
      },
    ]);
  });

  it("adds BTTS only to soccer detail while retaining participant team totals", async () => {
    const soccer = {
      ...event,
      id: "event-soccer-detail",
      sportKey: "soccer",
      leagueKey: "mls",
      participants: [
        { id: "mia", label: "Miami" },
        { id: "atl", label: "Atlanta" },
      ],
    } as EventDisplayDto;
    const prices = completeDetailPrices(soccer);
    const eventRepository = events();
    eventRepository.detail = () =>
      Promise.resolve({
        projectionState: "ready",
        item: soccer,
        unavailableReason: null,
      });
    const detail = await new JoinedGamesRepository(
      eventRepository,
      {
        batchGet: () =>
          Promise.resolve([...prices.map(row), ...activeEvidence(prices)]),
      },
      ["hardrock"],
      () => new Date("2026-08-01T12:30:00.000Z"),
    ).detail(soccer.id);
    expect(
      detail.item?.oddsComparison.markets.map(({ marketKey }) => marketKey),
    ).toEqual(["moneyline", "spread", "total", "btts", "team_total"]);
    expect(detail.item?.oddsComparison.targetQualified).toBe(true);
  });

  it("lets blocking availability explain a cell even when CURRENT is absent", async () => {
    const absent = current(event, "away", "Boston", "moneyline", "hardrock");
    const groupIdentity = fixtureOddsGroupAvailabilityIdentity(absent);
    const rows = [
      {
        pk: absent.partitionKey,
        sk: "AVAILABILITY",
        value: {
          identity: absent.partitionKey,
          state: "active",
          observedAt: "2026-08-01T12:00:00.000Z",
          evidenceId: "selection-active",
          reason: "active-price",
        },
      },
      {
        pk: groupIdentity,
        sk: "AVAILABILITY",
        value: {
          identity: groupIdentity,
          state: "suspended",
          observedAt: "2026-08-01T12:05:00.000Z",
          evidenceId: "group-suspended",
          reason: "market-suspended",
        },
      },
    ];
    const eventRepository = events();
    eventRepository.detail = () =>
      Promise.resolve({
        projectionState: "ready",
        item: event,
        unavailableReason: null,
      });
    const detail = await new JoinedGamesRepository(
      eventRepository,
      { batchGet: () => Promise.resolve(rows) },
      ["hardrock"],
      () => new Date("2026-08-01T12:30:00.000Z"),
    ).detail(event.id);
    expect(
      detail.item?.oddsComparison.markets[0]?.selections[0]?.cells.hardrock,
    ).toEqual({
      state: "suspended",
      eligible: false,
      reason: "market-suspended",
      evidenceAt: "2026-08-01T12:05:00.000Z",
    });
  });

  it("attributes a stale availability binding to the record that failed", async () => {
    const away = current(event, "away", "Boston", "moneyline", "hardrock");
    const groupIdentity = fixtureOddsGroupAvailabilityIdentity(away);
    const rows = [
      row(away),
      {
        pk: away.partitionKey,
        sk: "AVAILABILITY",
        value: {
          identity: away.partitionKey,
          state: "active",
          observedAt: "2026-08-01T11:59:00.000Z",
          evidenceId: "stale-selection-binding",
          reason: "selection-binding-stale",
        },
      },
      {
        pk: groupIdentity,
        sk: "AVAILABILITY",
        value: {
          identity: groupIdentity,
          state: "active",
          observedAt: "2026-08-01T12:05:00.000Z",
          evidenceId: "current-group-binding",
          reason: "market-complete",
        },
      },
    ];
    const eventRepository = events();
    eventRepository.detail = () =>
      Promise.resolve({
        projectionState: "ready",
        item: event,
        unavailableReason: null,
      });
    const detail = await new JoinedGamesRepository(
      eventRepository,
      { batchGet: () => Promise.resolve(rows) },
      ["hardrock"],
      () => new Date("2026-08-01T12:30:00.000Z"),
    ).detail(event.id);
    expect(
      detail.item?.oddsComparison.markets[0]?.selections[0]?.cells.hardrock,
    ).toMatchObject({
      state: "unavailable",
      reason: "selection-binding-stale",
      evidenceAt: "2026-08-01T11:59:00.000Z",
    });
  });

  it("does not make spread, total, or team-total markets active without a point", async () => {
    const eventRepository = events();
    eventRepository.detail = () =>
      Promise.resolve({
        projectionState: "ready",
        item: event,
        unavailableReason: null,
      });
    for (const price of [
      current(event, "away", "Boston", "spread", "hardrock"),
      current(event, "over", "Over", "total", "hardrock"),
      current(
        event,
        participantKey("bos", "over"),
        "Boston Over",
        "team_total",
        "hardrock",
      ),
    ]) {
      const rows = [row(price), ...activeEvidence([price])];
      const detail = await new JoinedGamesRepository(
        eventRepository,
        { batchGet: () => Promise.resolve(rows) },
        ["hardrock"],
        () => new Date("2026-08-01T12:30:00.000Z"),
      ).detail(event.id);
      const selection = detail.item?.oddsComparison.markets
        .find(({ marketKey }) => marketKey === price.marketKey)
        ?.selections.find(
          ({ selectionKey }) => selectionKey === price.selectionKey,
        );
      expect(selection?.cells.hardrock).toMatchObject({
        state: "unavailable",
        eligible: false,
        reason: "point-required",
        evidenceAt: price.observedAt,
        americanOdds: price.americanOdds,
      });
    }
  });

  it("captures one validated clock instant for generation and freshness", async () => {
    const eventRepository = events();
    eventRepository.detail = () =>
      Promise.resolve({
        projectionState: "ready",
        item: event,
        unavailableReason: null,
      });
    let calls = 0;
    const detail = await new JoinedGamesRepository(
      eventRepository,
      { batchGet: () => Promise.resolve([]) },
      ["hardrock"],
      () => {
        calls += 1;
        return new Date("2026-08-01T12:30:00.000Z");
      },
    ).detail(event.id);
    expect(calls).toBe(1);
    expect(detail.item?.oddsComparison.generatedAt).toBe(
      "2026-08-01T12:30:00.000Z",
    );
  });

  it("rejects invalid detail timing configuration", async () => {
    const eventRepository = events();
    eventRepository.detail = () =>
      Promise.resolve({
        projectionState: "ready",
        item: event,
        unavailableReason: null,
      });
    for (const freshnessWindowMs of [Number.NaN, -1])
      expect(
        () =>
          new JoinedGamesRepository(
            eventRepository,
            { batchGet: () => Promise.resolve([]) },
            ["hardrock"],
            undefined,
            freshnessWindowMs,
          ),
      ).toThrow("invalid-detail-freshness-window");
    for (const clockSkewToleranceMs of [Number.POSITIVE_INFINITY, -1])
      expect(
        () =>
          new JoinedGamesRepository(
            eventRepository,
            { batchGet: () => Promise.resolve([]) },
            ["hardrock"],
            undefined,
            undefined,
            "hardrock",
            clockSkewToleranceMs,
          ),
      ).toThrow("invalid-detail-clock-skew-tolerance");
    await expect(
      new JoinedGamesRepository(
        eventRepository,
        { batchGet: () => Promise.resolve([]) },
        ["hardrock"],
        () => new Date(Number.NaN),
      ).detail(event.id),
    ).rejects.toThrow("invalid-detail-clock");
  });

  it("fails closed when the bounded stability reread observes drift", async () => {
    const away = current(event, "away", "Boston", "moneyline", "hardrock");
    const eventRepository = events();
    eventRepository.detail = () =>
      Promise.resolve({
        projectionState: "ready",
        item: event,
        unavailableReason: null,
      });
    let reads = 0;
    await expect(
      new JoinedGamesRepository(
        eventRepository,
        {
          batchGet: () => Promise.resolve(++reads === 1 ? [] : [row(away)]),
        },
        ["hardrock"],
      ).detail(event.id),
    ).rejects.toThrow("detail-odds-snapshot-unstable");
    expect(reads).toBe(2);
  });

  it("requires a scheduled, complete event for target qualification", async () => {
    const prices = completeDetailPrices(event);
    const rows = [...prices.map(row), ...activeEvidence(prices)];
    const qualify = async (
      item: typeof event,
      readAt = "2026-08-01T12:30:00.000Z",
    ) => {
      const eventRepository = events();
      eventRepository.detail = () =>
        Promise.resolve({
          projectionState: "ready",
          item,
          unavailableReason: null,
        });
      const detail = await new JoinedGamesRepository(
        eventRepository,
        { batchGet: () => Promise.resolve(rows) },
        ["hardrock"],
        () => new Date(readAt),
      ).detail(event.id);
      return detail.item?.oddsComparison.targetQualified;
    };

    // A started game is never a qualified comparison.
    expect(
      await qualify({
        ...event,
        status: "started" as const,
        metadata: assessEventMetadata(
          "started",
          "2026-08-01T12:00:00.000Z",
          "2026-08-01T12:30:00.000Z",
        ),
      }),
    ).toBe(false);

    // Stale event METADATA no longer disqualifies. It measures how long since
    // the provider revised the schedule listing, which for an uncorrected
    // game only ever grows — it said nothing about these prices, which are
    // current. This assertion was inverted on 2026-08-13, when every MLB game
    // on staging read "coverage is incomplete" on a 2.2-day metadata age.
    expect(
      await qualify({
        ...event,
        metadata: assessEventMetadata(
          "scheduled",
          "2026-08-01T09:00:00.000Z",
          "2026-08-01T12:30:00.000Z",
        ),
      }),
    ).toBe(true);

    // Stale PRICES still disqualify, per cell, which is where the real
    // freshness rule lives: read four hours past a two-hour window.
    expect(await qualify(event, "2026-08-01T16:30:00.000Z")).toBe(false);
  });

  it("gives the memory repository a valid default target sportsbook", async () => {
    const eventRepository = events();
    eventRepository.detail = () =>
      Promise.resolve({
        projectionState: "ready",
        item: event,
        unavailableReason: null,
      });
    const detail = await new MemoryGamesRepository(eventRepository, {
      batchGet: () => Promise.resolve([]),
    }).detail(event.id);
    expect(detail.item?.oddsComparison).toMatchObject({
      targetSportsbookId: "fixture-book",
      targetQualified: false,
      sportsbooks: [
        { id: "fixture-book", label: "fixture-book", target: true },
      ],
    });
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

  it.each([
    ["noncanonical timestamp", "2026-08-01T08:00:00-04:00", "active-price"],
    ["empty reason", "2026-08-01T12:00:00.000Z", ""],
    ["oversized reason", "2026-08-01T12:00:00.000Z", "x".repeat(257)],
  ])("rejects availability with %s", async (_label, observedAt, reason) => {
    const eventRepository = events();
    eventRepository.detail = () =>
      Promise.resolve({
        projectionState: "ready",
        item: event,
        unavailableReason: null,
      });
    const price = current(event, "away", "Boston", "moneyline", "hardrock");
    await expect(
      new JoinedGamesRepository(
        eventRepository,
        {
          batchGet: () =>
            Promise.resolve([
              {
                pk: price.partitionKey,
                sk: "AVAILABILITY",
                value: {
                  identity: price.partitionKey,
                  state: "active",
                  observedAt,
                  evidenceId: "availability-evidence",
                  reason,
                },
              },
            ]),
        },
        ["hardrock"],
        () => new Date("2026-08-01T12:30:00.000Z"),
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
    // Version-tolerant reads request the prior version's keys as well.
    expect(seen.keys).toHaveLength(60);
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

  it("uses every configured approved sportsbook in the Dynamo list projection", async () => {
    const requested: { readonly pk: string; readonly sk: string }[] = [];
    const away = current(
      event,
      "away",
      "Boston Red Sox",
      "moneyline",
      "pinnacle",
    );
    const home = current(
      event,
      "home",
      "New York Yankees",
      "moneyline",
      "pinnacle",
    );
    const page = await new DynamoGamesRepository(
      events(),
      {
        batchGet: (keys) => {
          requested.push(...keys);
          return Promise.resolve([row(home), row(away)]);
        },
      },
      [
        { id: "hardrock", label: "Hard Rock Bet" },
        { id: "draftkings", label: "DraftKings" },
        { id: "pinnacle", label: "Pinnacle" },
      ],
    ).list({ sportKey: "mlb", status: "scheduled", day: "2026-08-01" }, 1);

    expect(requested).toContainEqual({
      pk: away.partitionKey,
      sk: "CURRENT",
    });
    expect(requested).toContainEqual({
      pk: home.partitionKey,
      sk: "CURRENT",
    });
    // Version-tolerant reads request the prior version's keys as well.
    expect(requested).toHaveLength(36);
    expect(page.items[0]?.odds).toMatchObject({
      state: "available",
      selections: [
        { sportsbookId: "pinnacle", selectionKey: participantKey("bos") },
        { sportsbookId: "pinnacle", selectionKey: participantKey("nyy") },
      ],
    });
  });

  it("prefers a coherent canonical close only after the event starts", async () => {
    const closingLines = new MemoryClosingLinesRepository();
    const started = {
      ...event,
      startsAt: "2026-08-01T12:00:00.000Z",
      status: "started" as const,
      metadata: assessEventMetadata(
        "started",
        "2026-08-01T12:00:00.000Z",
        "2026-08-01T12:30:00.000Z",
      ),
    };
    await closingLines.finalizeBook({
      schemaVersion: CLOSING_BOOK_SCHEMA_VERSION,
      canonicalEventId: started.id,
      canonicalEventVersion: started.version,
      providerId: "sharpapi",
      providerEventId: "provider-event-1",
      sportKey: "mlb",
      leagueKey: "mlb",
      startsAt: started.startsAt,
      sportsbookId: "hardrock",
      providerSportsbookId: "hardrock",
      capturedAt: "2026-08-01T12:00:00.000Z",
      retrievedAt: "2026-08-01T12:20:00.000Z",
      captureTrigger: "kickoff",
      isFinal: true,
      selections: [
        {
          marketKey: "moneyline",
          selectionKey: participantKey("bos"),
          sportsbookId: "hardrock",
          americanOdds: 130,
          observedAt: "2026-08-01T11:59:00.000Z",
          retrievedAt: "2026-08-01T12:20:00.000Z",
        },
        {
          marketKey: "moneyline",
          selectionKey: participantKey("nyy"),
          sportsbookId: "hardrock",
          americanOdds: -145,
          observedAt: "2026-08-01T11:59:00.000Z",
          retrievedAt: "2026-08-01T12:20:00.000Z",
        },
      ],
    });
    const page = await new DynamoGamesRepository(
      events([started]),
      { batchGet: () => Promise.resolve([]) },
      [{ id: "hardrock", label: "Hard Rock Bet" }],
      closingLines,
    ).list({ sportKey: "mlb", status: "started", day: "2026-08-01" }, 1);
    expect(page.items[0]?.odds).toMatchObject({
      state: "available",
      source: "canonical-closing",
      selections: [{ americanOdds: 130 }, { americanOdds: -145 }],
    });

    const scheduled = await new DynamoGamesRepository(
      events([event]),
      { batchGet: () => Promise.resolve([]) },
      [{ id: "hardrock", label: "Hard Rock Bet" }],
      closingLines,
    ).list({ sportKey: "mlb", status: "scheduled", day: "2026-08-01" }, 1);
    expect(scheduled.items[0]?.odds).toEqual({ state: "unavailable" });
  });

  it("falls back to current odds when closing storage is unavailable", async () => {
    const started = {
      ...event,
      startsAt: "2026-08-01T12:00:00.000Z",
      status: "started" as const,
    };
    const prices = [
      current(started, "away", "Boston Red Sox"),
      current(started, "home", "New York Yankees"),
    ];
    const page = await new DynamoGamesRepository(
      events([started]),
      { batchGet: () => Promise.resolve(prices.map(row)) },
      [{ id: "draftkings", label: "DraftKings" }],
      {
        listFinalized: () => Promise.reject(new Error("closing-read-failed")),
      },
    ).list({ sportKey: "mlb", status: "started", day: "2026-08-01" }, 1);

    expect(page.items[0]?.odds).toMatchObject({
      state: "available",
      source: "pregame-snapshot",
      selections: [{ americanOdds: 120 }, { americanOdds: -135 }],
    });
  });

  it("ignores closing books whose canonical event binding is stale", async () => {
    const closingLines = new MemoryClosingLinesRepository();
    const started = {
      ...event,
      startsAt: "2026-08-01T12:00:00.000Z",
      status: "started" as const,
    };
    await closingLines.finalizeBook({
      ...recordClosingBookForTest(started),
      canonicalEventVersion: started.version - 1,
    });
    const prices = [
      current(started, "away", "Boston Red Sox"),
      current(started, "home", "New York Yankees"),
    ];
    const page = await new DynamoGamesRepository(
      events([started]),
      { batchGet: () => Promise.resolve(prices.map(row)) },
      [{ id: "draftkings", label: "DraftKings" }],
      closingLines,
    ).list({ sportKey: "mlb", status: "started", day: "2026-08-01" }, 1);

    expect(page.items[0]?.odds.state).toBe("available");
    expect(
      page.items[0]?.odds.state === "available"
        ? page.items[0].odds.selections.map(({ sportsbookId }) => sportsbookId)
        : [],
    ).toEqual(["draftkings", "draftkings"]);
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

  it("reports no freshness when its own filtering empties the page", async () => {
    // Page freshness is the oldest ITEM freshness. This method spread the
    // inner event page and then replaced its items, so a page emptied by the
    // participant boundary went out as zero items still carrying the event
    // repository's freshness. That contradicts the definition, and the browser
    // client rejects the whole response rather than rendering an empty board —
    // which is how a reader got "The games response was invalid." instead of a
    // day with no games. Observed on staging 2026-08-13: items 0 with
    // freshness 2026-08-13T03:59:51.249Z.
    const unresolvable = {
      ...event,
      id: "event-unresolvable",
      participants: [
        { id: "ghost-a", label: "Ghost A" },
        { id: "ghost-b", label: "Ghost B" },
      ],
    };
    const page = await new JoinedGamesRepository(
      events([unresolvable], { cursor: undefined }, null),
      { batchGet: () => Promise.resolve([]) },
    ).list({ sportKey: "mlb", status: "scheduled", day: "2026-08-01" }, 50);

    expect(page.items).toEqual([]);
    expect(page.freshness).toBeNull();
  });

  it("reports no freshness when the phantom cutoff empties the page after the join", async () => {
    // The first fix recomputed freshness before the odds join, which covered
    // a page emptied by the participant boundary but NOT one emptied after
    // it. The phantom cutoff drops a long-started scheduled game with no odds
    // evidence, and the final return spread the pre-join page — so the board
    // went out as zero items still carrying a non-null freshness. Staging kept
    // serving exactly that after the first fix shipped, which is how the gap
    // surfaced.
    const longStarted = {
      ...event,
      id: "event-phantom",
      startsAt: "2026-07-01T00:00:00.000Z",
      eastern: { ...event.eastern, calendarDay: "2026-07-01" },
    };
    const page = await new JoinedGamesRepository(
      events([longStarted], { cursor: undefined }, null),
      { batchGet: () => Promise.resolve([]) },
      ["hardrock"],
      () => new Date("2026-08-01T12:30:00.000Z"),
    ).list({ sportKey: "mlb", status: "scheduled", day: "2026-07-01" }, 50);

    expect(page.items).toEqual([]);
    expect(page.freshness).toBeNull();
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

  it("quarantines corrupt legacy values while rejecting duplicate and unexpected rows", async () => {
    const away = current(event, "away", "Boston Red Sox");
    const home = current(event, "home", "New York Yankees");
    const corruptCases: readonly (readonly unknown[])[] = [
      [
        {
          pk: away.partitionKey,
          sk: "CURRENT",
          value: { ...away, canonicalEventVersion: 1 },
        },
        row(home),
      ],
      [{ pk: away.partitionKey, sk: "CURRENT", value: null }, row(home)],
    ];
    for (const rows of corruptCases) {
      const page = await new JoinedGamesRepository(events(), {
        batchGet: () => Promise.resolve(rows),
      }).list({ sportKey: "mlb", status: "scheduled", day: "2026-08-01" }, 1);
      expect(page.items[0]?.odds).toEqual({ state: "unavailable" });
    }
    const rejectedCases: readonly (readonly unknown[])[] = [
      [row(away), row(away), row(home)],
      [row(away), row(home), { pk: "unexpected", sk: "CURRENT", value: away }],
    ];
    for (const rows of rejectedCases) {
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
    // Version-tolerant reads double the key set for versioned events.
    expect(requested).toBe(3_500);
  });

  it("anchors served selections to the sharp book's prices", async () => {
    // Pinnacle's candidate is fetched alongside the display books; each
    // served hardrock price carries the pinnacle price for the same
    // proposition so fair lines de-vig the sharp market, not the display
    // book's own vig. A spread quoted at a different point is a different
    // proposition and must not anchor.
    const books = ["hardrock", "pinnacle"];
    const rows = [
      current(event, "away", "Boston", "moneyline", "hardrock"),
      current(event, "home", "New York", "moneyline", "hardrock"),
      current(
        event,
        "away",
        "Boston",
        "spread",
        "hardrock",
        undefined,
        1.5,
        130,
      ),
      current(
        event,
        "home",
        "New York",
        "spread",
        "hardrock",
        undefined,
        -1.5,
        -150,
      ),
      current(
        event,
        "away",
        "Boston",
        "moneyline",
        "pinnacle",
        undefined,
        undefined,
        112,
      ),
      current(
        event,
        "home",
        "New York",
        "moneyline",
        "pinnacle",
        undefined,
        undefined,
        -124,
      ),
      // Different point: same market, different proposition.
      current(
        event,
        "away",
        "Boston",
        "spread",
        "pinnacle",
        undefined,
        2.5,
        105,
      ),
      current(
        event,
        "home",
        "New York",
        "spread",
        "pinnacle",
        undefined,
        -2.5,
        -117,
      ),
    ];
    const page = await new JoinedGamesRepository(
      events(),
      { batchGet: () => Promise.resolve(rows.map(row)) },
      books,
    ).list({ sportKey: "mlb", status: "scheduled", day: "2026-08-01" }, 1);
    expect(page.items[0]?.odds).toMatchObject({
      state: "available",
      selections: [
        {
          marketKey: "moneyline",
          selectionKey: participantKey("bos"),
          sportsbookId: "hardrock",
          americanOdds: 120,
          sharpAmericanOdds: 112,
        },
        {
          marketKey: "moneyline",
          selectionKey: participantKey("nyy"),
          sportsbookId: "hardrock",
          americanOdds: -135,
          sharpAmericanOdds: -124,
        },
        { marketKey: "spread", selectionKey: participantKey("bos") },
        { marketKey: "spread", selectionKey: participantKey("nyy") },
      ],
    });
    const selections =
      page.items[0]?.odds.state === "available"
        ? page.items[0].odds.selections
        : [];
    for (const selection of selections.filter(
      ({ marketKey }) => marketKey === "spread",
    ))
      expect(selection.sharpAmericanOdds).toBeUndefined();
  });

  it("serves a market whose sides last moved at different times", async () => {
    // Prices are only rewritten when they actually move, so the two sides of a
    // market normally carry different observation times. Requiring identical
    // timestamps dropped whole markets from the board; the rule is one book
    // and one bounded window.
    const away = current(event, "away", "Boston", "moneyline", "hardrock");
    const home = current(
      event,
      "home",
      "New York",
      "moneyline",
      "hardrock",
      "2026-08-01T11:52:00.000Z",
    );
    const page = await new JoinedGamesRepository(
      events(),
      { batchGet: () => Promise.resolve([row(away), row(home)]) },
      ["hardrock"],
    ).list({ sportKey: "mlb", status: "scheduled", day: "2026-08-01" }, 1);
    expect(page.items[0]?.odds).toMatchObject({ state: "available" });

    // A market mixing observation moments is still refused outright.
    const ancient = current(
      event,
      "home",
      "New York",
      "moneyline",
      "hardrock",
      "2026-08-01T09:00:00.000Z",
    );
    const mixed = await new JoinedGamesRepository(
      events(),
      { batchGet: () => Promise.resolve([row(away), row(ancient)]) },
      ["hardrock"],
    ).list({ sportKey: "mlb", status: "scheduled", day: "2026-08-01" }, 1);
    expect(mixed.items[0]?.odds).toEqual({ state: "unavailable" });
  });

  it("serves detail cells persisted one version behind the event", async () => {
    // Same churn as the list path: the canonical version advanced but the
    // odds persist path still writes at the prior version's keys. The
    // drill-in must serve those cells instead of a blank comparison grid.
    const priorVersion = { ...event, version: event.version - 1 };
    const prices = completeDetailPrices(priorVersion);
    const rows = [...prices.map(row), ...activeEvidence(prices)];
    const eventRepository = events();
    eventRepository.detail = () =>
      Promise.resolve({
        projectionState: "ready",
        item: event,
        unavailableReason: null,
      });
    const detail = await new JoinedGamesRepository(
      eventRepository,
      { batchGet: () => Promise.resolve(rows) },
      ["hardrock"],
      () => new Date("2026-08-01T12:30:00.000Z"),
    ).detail("event-1");
    const moneyline = detail.item?.oddsComparison.markets.find(
      ({ marketKey }) => marketKey === "moneyline",
    );
    expect(moneyline?.selections[0]?.cells).toMatchObject({
      hardrock: { state: "active", eligible: true, americanOdds: 120 },
    });
    expect(moneyline?.selections[1]?.cells).toMatchObject({
      hardrock: { state: "active", eligible: true, americanOdds: -135 },
    });
  });

  it("serves fresh odds persisted one version behind the event", async () => {
    // Provider id churn advances the canonical version faster than the odds
    // persist path; the newest row across the current and prior versions
    // must win so lines never vanish on a version tick.
    const priorVersion = { ...event, version: event.version - 1 };
    const freshAway = current(priorVersion, "away", "Boston");
    const freshHome = current(priorVersion, "home", "New York");
    const rows = [
      ...[freshAway, freshHome].map(row),
      ...activeEvidence([freshAway, freshHome]),
    ];
    const page = await new JoinedGamesRepository(events([event]), {
      batchGet: (keys) =>
        Promise.resolve(
          rows.filter((item) =>
            keys.some(({ pk, sk }) => pk === item.pk && sk === item.sk),
          ),
        ),
    }).list({ sportKey: "mlb", status: "scheduled", day: "2026-08-01" }, 50);
    expect(page.items[0]?.odds).toMatchObject({ state: "available" });
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

describe("withdrawn phantom listings", () => {
  const at = (startsAt: string, id: string): EventDisplayDto => ({
    ...event,
    id,
    startsAt,
  });

  it("hides a long-started scheduled game with no odds evidence", async () => {
    // 02:50 ET start probed at 12:31Z (08:31 ET): far past the grace window.
    const phantom = at("2026-08-01T06:50:00.000Z", "event-phantom");
    const fresh = at("2026-08-01T20:10:00.000Z", "event-real-upcoming");
    const page = await new JoinedGamesRepository(
      events([phantom, fresh], { cursor: undefined }, null),
      { batchGet: () => Promise.resolve([]) },
    ).list({ sportKey: "mlb", status: "scheduled", day: "2026-08-01" }, 10);

    expect(page.items.map(({ id }) => id)).toEqual(["event-real-upcoming"]);
  });

  it("keeps an upcoming game while its evidence has not arrived yet", async () => {
    const soon = at("2026-08-01T13:00:00.000Z", "event-soon");
    const page = await new JoinedGamesRepository(
      events([soon], { cursor: undefined }, null),
      { batchGet: () => Promise.resolve([]) },
    ).list({ sportKey: "mlb", status: "scheduled", day: "2026-08-01" }, 10);

    expect(page.items.map(({ id }) => id)).toEqual(["event-soon"]);
    expect(page.items[0]?.odds).toEqual({ state: "unavailable" });
  });
});
