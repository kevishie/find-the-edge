import { describe, expect, it, vi } from "vitest";
import {
  DynamoConditionalConflict,
  DynamoEventIngestionStore,
  FixtureOddsBindingConflictError,
  type BettingSplitRepository,
  type DynamoGateway,
  type DynamoItem,
  type EventIngestionStore,
} from "@find-the-edge/database";
import type {
  CanonicalEvent,
  CanonicalEventBootstrap,
  FixtureOddsAvailabilityEvidence,
  IsoTimestamp,
  SportKey,
} from "@find-the-edge/domain";
import { FixtureOddsStateCorruptionError } from "@find-the-edge/domain";
import type {
  SharpApiLeague,
  SharpApiOddsPage,
} from "@find-the-edge/providers";

import {
  ingestSharpApi,
  persistSharpApiOddsPage,
  persistSharpApiSplitPage,
  type SharpApiOddsPersister,
} from "./sharp-api-ingestion";

class InMemoryDynamoGateway implements DynamoGateway {
  readonly items = new Map<string, DynamoItem>();
  readonly commits: string[][] = [];

  private key(pk: string, sk: string) {
    return JSON.stringify([pk, sk]);
  }

  get(pk: string, sk: string) {
    return Promise.resolve(this.items.get(this.key(pk, sk)) ?? null);
  }

  batchGet(keys: readonly { readonly pk: string; readonly sk: string }[]) {
    return Promise.resolve(
      keys.flatMap(({ pk, sk }) => {
        const item = this.items.get(this.key(pk, sk));
        return item ? [item] : [];
      }),
    );
  }

  queryUpTo(pk: string, limit: number) {
    return Promise.resolve(
      [...this.items.values()]
        .filter((item) => item.pk === pk)
        .sort((left, right) => left.sk.localeCompare(right.sk))
        .slice(0, limit),
    );
  }

  queryPage(pk: string, startSk: string | undefined, limit: number) {
    const all = [...this.items.values()]
      .filter((item) => item.pk === pk && (!startSk || item.sk > startSk))
      .sort((left, right) => left.sk.localeCompare(right.sk));
    const items = all.slice(0, limit);
    return Promise.resolve({
      items,
      ...(all.length > limit && items.length
        ? { lastEvaluatedSk: items.at(-1)!.sk }
        : {}),
    });
  }

  transactGet(keys: readonly { readonly pk: string; readonly sk: string }[]) {
    return Promise.resolve(
      keys.map(({ pk, sk }) => this.items.get(this.key(pk, sk)) ?? null),
    );
  }

  queryAll(pk: string) {
    return Promise.resolve(
      [...this.items.values()].filter((item) => item.pk === pk),
    );
  }

  insert(item: DynamoItem) {
    const key = this.key(item.pk, item.sk);
    if (this.items.has(key)) return Promise.resolve("exists" as const);
    this.items.set(key, item);
    return Promise.resolve("inserted" as const);
  }

  deleteOwnedReconciliationLock(
    pk: string,
    expectedEventId: string,
    expectedLeaseUntil?: string,
  ) {
    const key = this.key(pk, "CURRENT");
    const item = this.items.get(key);
    const value = item?.value as
      { readonly eventId?: string; readonly leaseUntil?: string } | undefined;
    if (
      !item ||
      value?.eventId !== expectedEventId ||
      (expectedLeaseUntil !== undefined &&
        value.leaseUntil !== expectedLeaseUntil)
    )
      return Promise.reject(new DynamoConditionalConflict());
    this.items.delete(key);
    return Promise.resolve();
  }

  transact(writes: Parameters<DynamoGateway["transact"]>[0]) {
    const snapshot = new Map(this.items);
    const targets = new Set<string>();
    const commitKinds: string[] = [];
    for (const write of writes) {
      const target =
        "item" in write
          ? this.key(write.item.pk, write.item.sk)
          : this.key(write.pk, write.sk);
      if (targets.has(target)) throw new Error("duplicate-transaction-target");
      targets.add(target);
      commitKinds.push(`${write.kind}:${target}`);

      if (write.kind === "check-identity-absent") {
        if (snapshot.has(target)) throw new DynamoConditionalConflict();
        continue;
      }
      if (write.kind === "check-identity") {
        const current = snapshot.get(target)?.value as
          | {
              readonly version?: number;
              readonly candidateEventIds?: readonly string[];
            }
          | undefined;
        if (
          current?.version !== write.expectedVersion ||
          JSON.stringify(current.candidateEventIds) !==
            JSON.stringify(write.expectedCandidateEventIds)
        )
          throw new DynamoConditionalConflict();
        continue;
      }
      if (write.kind === "check-event") {
        const current = snapshot.get(target)?.value as
          | { readonly version?: number; readonly candidateIdentity?: string }
          | undefined;
        if (
          current?.version !== write.expectedVersion ||
          current.candidateIdentity !== write.expectedIdentity ||
          (write.expectedSnapshot !== undefined &&
            JSON.stringify(current) !== JSON.stringify(write.expectedSnapshot))
        )
          throw new DynamoConditionalConflict();
        continue;
      }
      if (write.kind === "check-reconciliation-lock") {
        const current = snapshot.get(target)?.value as
          | { readonly eventId?: string; readonly leaseUntil?: string }
          | undefined;
        if (
          current?.eventId !== write.expectedToken ||
          !current.leaseUntil ||
          current.leaseUntil <= write.leaseAfter
        )
          throw new DynamoConditionalConflict();
        continue;
      }
      if (write.kind === "delete") {
        snapshot.delete(target);
        continue;
      }
      if (write.kind === "renew-reconciliation-lock") {
        const current = snapshot.get(target)?.value as
          { readonly eventId?: string } | undefined;
        if (current?.eventId !== write.expectedToken)
          throw new DynamoConditionalConflict();
        snapshot.set(target, write.item);
        continue;
      }
      if (
        write.kind === "put-provider-event-fence" ||
        write.kind === "put-bootstrap-marker"
      ) {
        const current = snapshot.get(target)?.value as
          { readonly pagePositionDigest?: string } | undefined;
        if (
          current &&
          current.pagePositionDigest !== write.expectedPagePositionDigest
        )
          throw new DynamoConditionalConflict();
        snapshot.set(target, write.item);
        continue;
      }
      if (
        write.kind === "put-projection" &&
        write.expectedValue !== undefined &&
        JSON.stringify(snapshot.get(target)?.value) !==
          JSON.stringify(write.expectedValue)
      )
        throw new DynamoConditionalConflict();
      if (
        write.kind === "put-projection" &&
        write.requireAbsent &&
        snapshot.has(target)
      )
        throw new DynamoConditionalConflict();
      if (
        (write.kind === "insert" || write.kind === "claim-identity") &&
        snapshot.has(target)
      )
        throw new DynamoConditionalConflict();
      if (write.kind === "replace") {
        const current = snapshot.get(target)?.value as
          { readonly version?: number } | undefined;
        if (current?.version !== write.expectedVersion)
          throw new DynamoConditionalConflict();
      }
      snapshot.set(target, write.item);
    }
    this.items.clear();
    for (const [key, value] of snapshot) this.items.set(key, value);
    this.commits.push(commitKinds);
    return Promise.resolve();
  }

  compareAndSetCheckpoint(): Promise<boolean> {
    return Promise.reject(new Error("unused-test-operation"));
  }

  transactCheckpoint(): Promise<boolean> {
    return Promise.reject(new Error("unused-test-operation"));
  }

  put(item: DynamoItem) {
    this.items.set(this.key(item.pk, item.sk), item);
    return Promise.resolve();
  }
}

describe("SharpAPI primary ingestion", () => {
  it("bootstraps an odds-only featured MLB event into an empty Dynamo store before persisting observations", async () => {
    const gateway = new InMemoryDynamoGateway();
    const store = new DynamoEventIngestionStore(gateway);
    const league = { sportKey: "mlb", leagueKey: "mlb" } as SharpApiLeague;
    const binding = {
      providerId: "sharpapi",
      providerEventId: "mlb-marlins-braves_2026-08-05_b3",
      sportKey: "mlb" as SportKey,
      leagueKey: "mlb",
    };
    const persist = vi.fn(
      async (input: Parameters<SharpApiOddsPersister["persist"]>[0]) => {
        const canonical = await store.resolveExactCanonicalBinding(binding);
        expect(canonical).toMatchObject({
          id: input.observation.canonicalEventId,
          participantLabels: ["Miami Marlins", "Atlanta Braves"],
        });
        return {
          snapshot: "created" as const,
          current: "advanced" as const,
          value: input.observation as never,
        };
      },
    );

    // The schedule inventory is empty: this exact featured event has no
    // canonical row or provider mapping before its odds page arrives.
    await expect(
      store.resolveExactCanonicalBinding(binding),
    ).resolves.toBeNull();
    const oddsPage: SharpApiOddsPage = {
      retrievedAt: "2026-08-05T12:00:01.000Z" as IsoTimestamp,
      hasMore: false,
      events: [
        {
          providerEventId: binding.providerEventId,
          providerEventUuid: `${binding.providerEventId}:uuid`,
          awayTeam: "Miami Marlins",
          homeTeam: "Atlanta Braves",
          awayClubKey: "marlins",
          homeClubKey: "braves",
          startsAt: "2026-08-05T19:00:00.000Z" as IsoTimestamp,
          bookmakers: [
            {
              id: "pinnacle",
              label: "Pinnacle",
              prices: [
                {
                  providerPriceId: "odds-only-away",
                  marketKey: "moneyline",
                  outcomeStructure: "two-way",
                  providerMarketType: "moneyline",
                  providerMarketId: "odds-only-moneyline",
                  selectionKey: "away",
                  selectionLabel: "Miami Marlins",
                  providerSelectionId: "marlins",
                  americanOdds: 118,
                  decimalOdds: 2.18,
                  impliedProbability: 0.4587,
                  isLive: false,
                  isMainLine: true,
                  isAlternateLine: false,
                  isPlayerProp: false,
                  isStalePregamePrice: false,
                  observedAt: "2026-08-05T12:00:00.000Z" as IsoTimestamp,
                },
                {
                  providerPriceId: "odds-only-home",
                  marketKey: "moneyline",
                  outcomeStructure: "two-way",
                  providerMarketType: "moneyline",
                  providerMarketId: "odds-only-moneyline",
                  selectionKey: "home",
                  selectionLabel: "Atlanta Braves",
                  providerSelectionId: "braves",
                  americanOdds: -128,
                  decimalOdds: 1.78125,
                  impliedProbability: 0.5614,
                  isLive: false,
                  isMainLine: true,
                  isAlternateLine: false,
                  isPlayerProp: false,
                  isStalePregamePrice: false,
                  observedAt: "2026-08-05T12:00:00.000Z" as IsoTimestamp,
                },
              ],
            },
          ],
        },
      ],
    };
    const phantomBinding = {
      ...binding,
      providerEventId: "mlb_brewers_pirates_2026-08-05_b1",
    };
    const phantomResult = await persistSharpApiOddsPage(
      store,
      { persist },
      league,
      {
        ...oddsPage,
        events: oddsPage.events.map((event) => ({
          ...event,
          providerEventId: phantomBinding.providerEventId,
          providerEventUuid: `${phantomBinding.providerEventId}:uuid`,
          awayTeam: "Pittsburgh Pirates",
          homeTeam: "Milwaukee Brewers",
          awayClubKey: "pirates",
          homeClubKey: "brewers",
          bookmakers: event.bookmakers.map((book) => ({
            ...book,
            id: "bet365 us",
            label: "Bet365 US",
          })),
        })),
      },
      { pinnacle: "collected" },
      undefined,
      undefined,
      new Set([binding.providerEventId]),
    );
    expect(phantomResult).toMatchObject({ events: 0, observations: 0 });
    await expect(
      store.resolveExactCanonicalBinding(phantomBinding),
    ).resolves.toBeNull();

    const unlistedFeaturedBinding = {
      ...binding,
      providerEventId: "mlb_marlins_braves_2026-08-06_b3",
    };
    const unlistedFeatured = await persistSharpApiOddsPage(
      store,
      { persist },
      league,
      {
        ...oddsPage,
        events: oddsPage.events.map((featured) => ({
          ...featured,
          providerEventId: unlistedFeaturedBinding.providerEventId,
          providerEventUuid: `${unlistedFeaturedBinding.providerEventId}:uuid`,
          bookmakers: [
            ...featured.bookmakers,
            ...featured.bookmakers.map((book) => ({
              ...book,
              id: "draftkings",
              label: "DraftKings",
            })),
          ],
        })),
      },
      { pinnacle: "collected", draftkings: "offered" },
      undefined,
      undefined,
      new Set([binding.providerEventId]),
    );
    expect(unlistedFeatured).toMatchObject({ events: 0, observations: 0 });
    await expect(
      store.resolveExactCanonicalBinding(unlistedFeaturedBinding),
    ).resolves.toBeNull();

    const result = await persistSharpApiOddsPage(
      store,
      { persist },
      league,
      oddsPage,
      { pinnacle: "collected" },
      undefined,
      undefined,
      new Set([binding.providerEventId]),
    );

    const canonical = await store.resolveExactCanonicalBinding(binding);
    expect(canonical).toMatchObject({
      sportKey: "mlb",
      leagueKey: "mlb",
      startsAt: "2026-08-05T19:00:00.000Z",
      participantLabels: ["Miami Marlins", "Atlanta Braves"],
    });
    expect(result).toMatchObject({ events: 1, observations: 2 });
    const correctedPage: SharpApiOddsPage = {
      ...oddsPage,
      retrievedAt: "2026-08-05T12:05:01.000Z" as IsoTimestamp,
      events: oddsPage.events.map((event) => ({
        ...event,
        startsAt: "2026-08-05T19:30:00.000Z" as IsoTimestamp,
      })),
    };
    await expect(
      persistSharpApiOddsPage(store, { persist }, league, correctedPage, {
        pinnacle: "collected",
      }),
    ).resolves.toMatchObject({ events: 1, observations: 2 });
    await expect(
      store.resolveExactCanonicalBinding(binding),
    ).resolves.toMatchObject({ startsAt: "2026-08-05T19:00:00.000Z" });

    await expect(
      persistSharpApiOddsPage(
        store,
        { persist },
        league,
        {
          ...correctedPage,
          retrievedAt: "2026-08-05T12:10:01.000Z" as IsoTimestamp,
          events: correctedPage.events.map((event) => ({
            ...event,
            awayTeam: "Unrelated Away",
            homeTeam: "Unrelated Home",
            startsAt: "2026-08-05T20:00:00.000Z" as IsoTimestamp,
          })),
        },
        { pinnacle: "collected" },
      ),
    ).rejects.toThrow("sharpapi-odds-mapping-participant-mismatch");
    await expect(
      store.resolveExactCanonicalBinding(binding),
    ).resolves.toMatchObject({ startsAt: "2026-08-05T19:00:00.000Z" });

    await expect(
      persistSharpApiOddsPage(
        store,
        { persist },
        league,
        {
          ...oddsPage,
          retrievedAt: "2026-08-05T19:00:00.000Z" as IsoTimestamp,
          events: oddsPage.events.map((event) => ({
            ...event,
            bookmakers: event.bookmakers.map((book) => ({
              ...book,
              prices: book.prices.map((price) => ({
                ...price,
                observedAt: "2026-08-05T18:59:59.000Z" as IsoTimestamp,
              })),
            })),
          })),
        },
        { pinnacle: "collected" },
      ),
    ).resolves.toMatchObject({
      events: 0,
      observations: 0,
      canonicalOddsEvents: [],
    });
    expect(persist).toHaveBeenCalledTimes(4);
    expect(
      gateway.commits.some((writes) =>
        writes.some((write) => write.includes('insert:["EVENT#')),
      ),
    ).toBe(true);
    expect(
      gateway.commits.some(
        (writes) =>
          writes.some((write) => write.includes('insert:["MAPPING#')) &&
          writes.some(
            (write) =>
              write.includes('check-event:["EVENT#') ||
              write.includes('replace:["EVENT#'),
          ),
      ),
    ).toBe(true);
  });

  it("quarantines a stale event binding without aborting valid sibling odds", async () => {
    const canonical = (id: string): CanonicalEvent =>
      ({
        id,
        version: 1,
        sportKey: "mlb",
        leagueKey: "mlb",
        status: "scheduled",
        startsAt: "2026-08-06T00:00:00.000Z",
        participantIds: [`${id}-away`, `${id}-home`],
        participantLabels: ["Boston Red Sox", "New York Yankees"],
      }) as unknown as CanonicalEvent;
    const store = {
      getExactMapping: vi.fn().mockResolvedValue({ bindingKind: "source" }),
      resolveExactCanonicalBinding: vi.fn(
        (binding: { readonly providerEventId: string }) =>
          Promise.resolve(canonical(binding.providerEventId)),
      ),
    } as unknown as EventIngestionStore;
    const price = (id: string, selectionKey: "away" | "home") => ({
      providerPriceId: id,
      marketKey: "moneyline" as const,
      outcomeStructure: "two-way" as const,
      providerMarketType: "moneyline",
      providerMarketId: `${id}-market`,
      selectionKey,
      selectionLabel:
        selectionKey === "away" ? "Boston Red Sox" : "New York Yankees",
      providerSelectionId: `${id}-selection`,
      americanOdds: selectionKey === "away" ? 110 : -120,
      decimalOdds: selectionKey === "away" ? 2.1 : 1.83,
      impliedProbability: selectionKey === "away" ? 0.476 : 0.545,
      isLive: false,
      isMainLine: true,
      isAlternateLine: false,
      isPlayerProp: false,
      isStalePregamePrice: false,
      observedAt: "2026-08-05T20:00:00.000Z" as IsoTimestamp,
    });
    const rawEvent = (providerEventId: string) => ({
      providerEventId,
      providerEventUuid: `${providerEventId}-uuid`,
      awayTeam: "Boston Red Sox",
      homeTeam: "New York Yankees",
      startsAt: "2026-08-06T00:00:00.000Z" as IsoTimestamp,
      bookmakers: [
        {
          id: "draftkings",
          label: "DraftKings",
          prices: [
            price(`${providerEventId}-away`, "away"),
            price(`${providerEventId}-home`, "home"),
          ],
        },
      ],
    });
    const persist = vi.fn(
      (input: Parameters<SharpApiOddsPersister["persist"]>[0]) =>
        input.providerEventId === "stale"
          ? Promise.reject(
              new FixtureOddsBindingConflictError("binding changed"),
            )
          : input.providerEventId === "corrupt"
            ? Promise.reject(
                new FixtureOddsStateCorruptionError("stored row forged"),
              )
            : Promise.resolve({
                snapshot: "created" as const,
                current: "advanced" as const,
                value: input.observation as never,
              }),
    );

    await expect(
      persistSharpApiOddsPage(
        store,
        { persist },
        { sportKey: "mlb", leagueKey: "mlb" } as SharpApiLeague,
        {
          retrievedAt: "2026-08-05T20:00:01.000Z" as IsoTimestamp,
          events: [rawEvent("stale"), rawEvent("corrupt"), rawEvent("current")],
        },
        { draftkings: "offered" },
      ),
    ).resolves.toMatchObject({
      events: 1,
      observations: 2,
      rejectionCounts: { "participant-unavailable": 4 },
    });
  });

  it("reports completed persistence decisions before a later write fails", async () => {
    const canonical = {
      id: "event-1",
      version: 1,
      sportKey: "mlb",
      startsAt: "2026-08-04T01:00:00.000Z",
      participantIds: ["away-id", "home-id"],
      participantLabels: ["Away", "Home"],
    } as unknown as CanonicalEvent;
    const ingestEvent = vi.fn().mockResolvedValue({
      kind: "unresolved",
      reason: "no-candidate",
    });
    const reconcileScheduledEvent = vi
      .fn()
      .mockResolvedValue({ kind: "updated", eventId: canonical.id });
    const store = {
      ingestEvent,
      reconcileScheduledEvent,
      getExactMapping: vi.fn().mockResolvedValue(null),
      resolveExactCanonicalBinding: vi.fn().mockResolvedValue(canonical),
    } as unknown as EventIngestionStore;
    const persist = vi
      .fn()
      .mockResolvedValueOnce({ snapshot: "created", current: "advanced" })
      .mockRejectedValueOnce(new Error("later-page-write-failed"));
    const outcomes: unknown[] = [];
    const persistAvailability = vi.fn().mockResolvedValue(undefined);
    const base = {
      marketKey: "moneyline" as const,
      outcomeStructure: "two-way" as const,
      providerMarketType: "moneyline",
      providerMarketId: "market-1",
      americanOdds: -110,
      decimalOdds: 1.91,
      impliedProbability: 0.524,
      isLive: false,
      isMainLine: true,
      isAlternateLine: false,
      isPlayerProp: false,
      isStalePregamePrice: false,
      observedAt: "2026-08-03T23:00:00.000Z" as IsoTimestamp,
    };
    await expect(
      persistSharpApiOddsPage(
        store,
        { persist, persistAvailability },
        { sportKey: "mlb", leagueKey: "mlb" } as SharpApiLeague,
        {
          retrievedAt: "2026-08-03T23:00:01.000Z" as IsoTimestamp,
          events: [
            {
              providerEventId: "event-1",
              providerEventUuid: "event-uuid-1",
              awayTeam: "Away",
              homeTeam: "Home",
              awayClubKey: "redsox",
              homeClubKey: "yankees",
              startsAt: canonical.startsAt,
              bookmakers: [
                {
                  id: "pinnacle",
                  label: "Pinnacle",
                  prices: [
                    {
                      ...base,
                      providerPriceId: "away-price",
                      selectionKey: "away",
                      selectionLabel: "Away",
                      providerSelectionId: "away-selection",
                    },
                    {
                      ...base,
                      providerPriceId: "home-price",
                      selectionKey: "home",
                      selectionLabel: "Home",
                      providerSelectionId: "home-selection",
                    },
                    {
                      ...base,
                      providerPriceId: "away-suspended-price",
                      selectionKey: "away",
                      selectionLabel: "Away",
                      providerSelectionId: "away-suspended-selection",
                      isActive: false,
                      isSuspended: true,
                      observedAt: "2026-08-03T23:00:02.000Z" as IsoTimestamp,
                    },
                  ],
                },
              ],
            },
          ],
        },
        { pinnacle: "collected" },
        (outcome) => outcomes.push(outcome),
      ),
    ).rejects.toThrow("later-page-write-failed");
    expect(reconcileScheduledEvent).toHaveBeenCalledTimes(1);
    const blocked = persistAvailability.mock.calls[0]?.[0] as unknown as {
      readonly identity: string;
      readonly state: string;
      readonly observedAt: string;
    };
    expect(blocked.identity).toMatch(/^FIXTURE_ODDS#/);
    expect(blocked).toMatchObject({
      state: "suspended",
      observedAt: "2026-08-03T23:00:02.000Z",
    });
    expect(outcomes).toEqual([{ snapshot: "created", current: "advanced" }]);
    expect(persist.mock.calls[0]?.[0]).toMatchObject({
      providerId: "sharpapi",
      observation: {
        sportsbookId: "pinnacle",
        sportsbookLabel: "Pinnacle",
        provenance: { bookRole: "collected" },
      },
    });
    const ingested = ingestEvent.mock.calls[0]?.[0] as unknown as {
      readonly participantIdentityKeys: readonly string[];
      readonly normalizedIdentity: string;
    };
    expect(ingested.participantIdentityKeys).toEqual(["redsox", "yankees"]);
    expect(ingested.normalizedIdentity).toContain("redsox");
  });

  it("uses an exact schedule binding when odds metadata uses team aliases", async () => {
    const canonical = {
      id: "event-uefa-1",
      version: 3,
      sportKey: "soccer",
      startsAt: "2026-08-11T18:00:00.000Z",
      participantIds: ["sabah-id", "agf-id"],
      participantLabels: ["Sabah Masazir", "AGF Aarhus"],
    } as unknown as CanonicalEvent;
    const ingestEvent = vi.fn(() => {
      throw new Error("exact binding must bypass identity reconciliation");
    });
    const persist = vi.fn(
      (input: Parameters<SharpApiOddsPersister["persist"]>[0]) => {
        void input;
        return Promise.resolve({}) as ReturnType<
          SharpApiOddsPersister["persist"]
        >;
      },
    );
    const base = {
      marketKey: "moneyline" as const,
      outcomeStructure: "three-way" as const,
      providerMarketType: "moneyline_3-way",
      providerMarketId: "market-uefa-1",
      americanOdds: 120,
      decimalOdds: 2.2,
      impliedProbability: 0.4545,
      isLive: false,
      isMainLine: true,
      isAlternateLine: false,
      isPlayerProp: false,
      isStalePregamePrice: false,
      observedAt: "2026-08-05T16:00:00.000Z" as IsoTimestamp,
    };
    const rawEvent = {
      providerEventId: "uefa-event-1",
      providerEventUuid: "uefa-event-uuid-1",
      awayTeam: "FC Sabah Masazir",
      homeTeam: "AGF Aarhus",
      startsAt: "2026-08-11T18:05:00.000Z" as IsoTimestamp,
      bookmakers: [
        {
          id: "pinnacle",
          label: "Pinnacle",
          prices: [
            {
              ...base,
              providerPriceId: "away-price",
              selectionKey: "away" as const,
              selectionLabel: "FC Sabah Masazir",
              providerSelectionId: "away-selection",
            },
            {
              ...base,
              providerPriceId: "home-price",
              selectionKey: "home" as const,
              selectionLabel: "AGF Aarhus",
              providerSelectionId: "home-selection",
            },
            {
              ...base,
              providerPriceId: "draw-price",
              selectionKey: "draw" as const,
              selectionLabel: "Draw",
              providerSelectionId: "draw-selection",
            },
          ],
        },
      ],
    };
    const store = {
      ingestEvent,
      getExactMapping: vi.fn().mockResolvedValue({ bindingKind: "alias" }),
      resolveExactCanonicalBinding: vi.fn().mockResolvedValue(canonical),
    } as unknown as EventIngestionStore;
    const league = {
      sportKey: "soccer",
      leagueKey: "uefa-champions-league",
    } as SharpApiLeague;
    const result = await persistSharpApiOddsPage(
      store,
      { persist },
      league,
      {
        retrievedAt: "2026-08-05T16:00:01.000Z" as IsoTimestamp,
        events: [rawEvent],
      },
      { pinnacle: "collected" },
    );

    expect(ingestEvent).not.toHaveBeenCalled();
    expect(result.observations).toBe(3);
    expect(persist.mock.calls.map(([input]) => input.observation)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          selectionKey: "participant:sabah-id",
          selectionLabel: "Sabah Masazir",
        }),
        expect.objectContaining({
          selectionKey: "participant:agf-id",
          selectionLabel: "AGF Aarhus",
        }),
        expect.objectContaining({ selectionKey: "draw" }),
      ]),
    );

    const reversedPersist = vi.fn(
      (input: Parameters<SharpApiOddsPersister["persist"]>[0]) => {
        void input;
        return Promise.resolve({}) as ReturnType<
          SharpApiOddsPersister["persist"]
        >;
      },
    );
    await persistSharpApiOddsPage(
      {
        ingestEvent,
        getExactMapping: vi.fn().mockResolvedValue({ bindingKind: "alias" }),
        resolveExactCanonicalBinding: vi.fn().mockResolvedValue({
          ...canonical,
          participantIds: ["agf-id", "sabah-id"],
          participantLabels: ["AGF Aarhus", "Sabah Masazir"],
        }),
      } as unknown as EventIngestionStore,
      { persist: reversedPersist },
      league,
      {
        retrievedAt: "2026-08-05T16:00:01.000Z" as IsoTimestamp,
        events: [rawEvent],
      },
      { pinnacle: "collected" },
    );
    expect(
      reversedPersist.mock.calls.map(
        ([input]) => input.observation.selectionKey,
      ),
    ).toEqual(
      expect.arrayContaining([
        "participant:sabah-id",
        "participant:agf-id",
        "draw",
      ]),
    );

    await expect(
      persistSharpApiOddsPage(
        {
          ingestEvent,
          getExactMapping: vi.fn().mockResolvedValue({ bindingKind: "alias" }),
          resolveExactCanonicalBinding: vi.fn().mockResolvedValue({
            ...canonical,
            participantIds: ["union-id", "bodo-id"],
            participantLabels: [
              "Royale Union Saint-Gilloise",
              "FK Bodø / Glimt",
            ],
          }),
        } as unknown as EventIngestionStore,
        { persist },
        league,
        {
          retrievedAt: "2026-08-05T16:00:01.000Z" as IsoTimestamp,
          events: [
            {
              ...rawEvent,
              awayTeam: "Union St.-Gilloise",
              homeTeam: "Bodo/Glimt",
            },
          ],
        },
        { pinnacle: "collected" },
      ),
    ).resolves.toMatchObject({ observations: 3 });

    await expect(
      persistSharpApiOddsPage(
        {
          ingestEvent,
          getExactMapping: vi.fn().mockResolvedValue({ bindingKind: "alias" }),
          resolveExactCanonicalBinding: vi.fn().mockResolvedValue({
            ...canonical,
            participantIds: ["ararat-id", "celje-id"],
            participantLabels: ["FC Ararat-Armenia", "NK Celje"],
          }),
        } as unknown as EventIngestionStore,
        { persist },
        league,
        {
          retrievedAt: "2026-08-05T16:00:01.000Z" as IsoTimestamp,
          events: [
            {
              ...rawEvent,
              awayTeam: "Ararat-Armenia FC",
              homeTeam: "NK Celje",
            },
          ],
        },
        { pinnacle: "collected" },
      ),
    ).resolves.toMatchObject({ observations: 3 });

    await expect(
      persistSharpApiOddsPage(
        {
          ingestEvent,
          getExactMapping: vi.fn().mockResolvedValue({ bindingKind: "alias" }),
          resolveExactCanonicalBinding: vi.fn().mockResolvedValue({
            ...canonical,
            participantIds: ["olympiacos-id", "nijmegen-id"],
            participantLabels: ["Olympiacos Piraeus", "NEC Nijmegen"],
          }),
        } as unknown as EventIngestionStore,
        { persist },
        league,
        {
          retrievedAt: "2026-08-05T16:00:01.000Z" as IsoTimestamp,
          events: [
            {
              ...rawEvent,
              awayTeam: "Olympiakos CFP",
              homeTeam: "Nijmegen Eendracht Combinatie",
            },
          ],
        },
        { pinnacle: "collected" },
      ),
    ).resolves.toMatchObject({ observations: 3 });

    // A start time past the tolerance omits the listing and counts it. It
    // used to throw, which aborted the whole league's run — see the
    // regression test below.
    await expect(
      persistSharpApiOddsPage(
        store,
        { persist },
        league,
        {
          retrievedAt: "2026-08-05T16:00:01.000Z" as IsoTimestamp,
          events: [
            {
              ...rawEvent,
              startsAt: "2026-08-12T18:05:00.000Z" as IsoTimestamp,
            },
          ],
        },
        { pinnacle: "collected" },
      ),
    ).resolves.toMatchObject({
      observations: 0,
      rejectionCounts: { "start-time-conflict": 1 },
    });
    await expect(
      persistSharpApiOddsPage(
        store,
        { persist },
        league,
        {
          retrievedAt: "2026-08-05T16:00:01.000Z" as IsoTimestamp,
          events: [
            {
              ...rawEvent,
              awayTeam: "Unrelated Away",
              homeTeam: "Unrelated Home",
            },
          ],
        },
        { pinnacle: "collected" },
      ),
    ).rejects.toThrow("sharpapi-odds-mapping-participant-mismatch");
    await expect(
      persistSharpApiOddsPage(
        {
          ingestEvent,
          getExactMapping: vi.fn().mockResolvedValue({ bindingKind: "alias" }),
          resolveExactCanonicalBinding: vi.fn().mockResolvedValue({
            ...canonical,
            participantIds: ["alpha-id", "beta-id"],
            participantLabels: ["Alpha United", "Beta City"],
          }),
        } as unknown as EventIngestionStore,
        { persist },
        league,
        {
          retrievedAt: "2026-08-05T16:00:01.000Z" as IsoTimestamp,
          events: [
            {
              ...rawEvent,
              awayTeam: "Gamma United",
              homeTeam: "Delta City",
            },
          ],
        },
        { pinnacle: "collected" },
      ),
    ).rejects.toThrow("sharpapi-odds-mapping-participant-mismatch");
  });

  /**
   * The 2026-08-12 MLS outage. One fixture whose odds-side start disagreed
   * with the schedule threw, which aborted the league's entire run. The run
   * had already committed evidence, and a committed run is exempt from the
   * staleness ceiling — so it was never abandoned, and every later pass
   * replayed the same failure. MLS odds froze for seven hours with a green
   * health row while every other league priced normally.
   */
  it("prices the rest of a page when one listing's start time disagrees", async () => {
    const canonical = {
      id: "event-mls-1",
      version: 2,
      sportKey: "soccer",
      startsAt: "2026-08-11T23:30:00.000Z",
      participantIds: ["charlotte-id", "pachuca-id"],
      participantLabels: ["Charlotte FC", "Pachuca"],
    } as unknown as CanonicalEvent;
    const persist = vi.fn(
      (input: Parameters<SharpApiOddsPersister["persist"]>[0]) => {
        void input;
        return Promise.resolve({}) as ReturnType<
          SharpApiOddsPersister["persist"]
        >;
      },
    );
    const base = {
      marketKey: "moneyline" as const,
      outcomeStructure: "three-way" as const,
      providerMarketType: "moneyline_3-way",
      providerMarketId: "market-mls-1",
      americanOdds: 120,
      decimalOdds: 2.2,
      impliedProbability: 0.4545,
      isLive: false,
      isMainLine: true,
      isAlternateLine: false,
      isPlayerProp: false,
      isStalePregamePrice: false,
      observedAt: "2026-08-11T22:00:00.000Z" as IsoTimestamp,
    };
    const priced = (providerEventId: string, startsAt: string) => ({
      providerEventId,
      providerEventUuid: `${providerEventId}-uuid`,
      awayTeam: "Charlotte FC",
      homeTeam: "Pachuca",
      startsAt: startsAt as IsoTimestamp,
      bookmakers: [
        {
          id: "pinnacle",
          label: "Pinnacle",
          prices: [
            {
              ...base,
              providerPriceId: `${providerEventId}-away`,
              selectionKey: "away" as const,
              selectionLabel: "Charlotte FC",
              providerSelectionId: "away-selection",
            },
            {
              ...base,
              providerPriceId: `${providerEventId}-home`,
              selectionKey: "home" as const,
              selectionLabel: "Pachuca",
              providerSelectionId: "home-selection",
            },
            {
              ...base,
              providerPriceId: `${providerEventId}-draw`,
              selectionKey: "draw" as const,
              selectionLabel: "Draw",
              providerSelectionId: "draw-selection",
            },
          ],
        },
      ],
    });
    const store = {
      ingestEvent: vi.fn(() => {
        throw new Error("exact binding must bypass identity reconciliation");
      }),
      getExactMapping: vi.fn().mockResolvedValue({ bindingKind: "alias" }),
      resolveExactCanonicalBinding: vi.fn().mockResolvedValue(canonical),
    } as unknown as EventIngestionStore;

    const result = await persistSharpApiOddsPage(
      store,
      { persist },
      { sportKey: "soccer", leagueKey: "mls" } as SharpApiLeague,
      {
        retrievedAt: "2026-08-11T22:00:01.000Z" as IsoTimestamp,
        events: [
          // Four hours adrift: unpriceable, and previously fatal to the page.
          priced("mls-drifted", "2026-08-12T03:30:00.000Z"),
          priced("mls-on-time", "2026-08-11T23:30:00.000Z"),
        ],
      },
      { pinnacle: "collected" },
    );

    // The sound listing is priced; the drifted one is counted, not silent.
    expect(result.observations).toBe(3);
    expect(result.rejectionCounts["start-time-conflict"]).toBe(1);
    // Persistence is per price, so assert on which events were reached at all.
    expect([
      ...new Set(persist.mock.calls.map(([input]) => input.providerEventId)),
    ]).toEqual(["mls-on-time"]);
  });

  it("preserves explicit expected-book states instead of downgrading them to missing", async () => {
    const canonical = {
      id: "event-state",
      version: 1,
      sportKey: "mlb",
      startsAt: "2026-08-06T01:00:00.000Z",
      participantIds: ["away-id", "home-id"],
      participantLabels: ["Boston Red Sox", "New York Yankees"],
    } as unknown as CanonicalEvent;
    const store = {
      getExactMapping: vi.fn().mockResolvedValue({ bindingKind: "source" }),
      resolveExactCanonicalBinding: vi.fn().mockResolvedValue(canonical),
    } as unknown as EventIngestionStore;
    const base = {
      marketKey: "moneyline" as const,
      outcomeStructure: "two-way" as const,
      providerMarketType: "moneyline",
      providerMarketId: "market-state",
      americanOdds: -110,
      decimalOdds: 1.91,
      impliedProbability: 0.524,
      isLive: false,
      isMainLine: true,
      isAlternateLine: false,
      isPlayerProp: false,
      observedAt: "2026-08-05T23:00:00.000Z" as IsoTimestamp,
    };
    for (const [expectedState, pricePatch, selections] of [
      [
        "suspended",
        { isSuspended: true, isActive: false, isStalePregamePrice: false },
        ["away", "home"],
      ],
      [
        "stale",
        { isSuspended: false, isActive: true, isStalePregamePrice: true },
        ["away", "home"],
      ],
      [
        "incomplete",
        { isSuspended: false, isActive: true, isStalePregamePrice: false },
        ["away"],
      ],
    ] as const) {
      const persistAvailability = vi
        .fn<(value: FixtureOddsAvailabilityEvidence) => Promise<void>>()
        .mockResolvedValue(undefined);
      await persistSharpApiOddsPage(
        store,
        { persist: vi.fn(), persistAvailability },
        { sportKey: "mlb", leagueKey: "mlb" } as SharpApiLeague,
        {
          retrievedAt: "2026-08-05T23:00:01.000Z" as IsoTimestamp,
          events: [
            {
              providerEventId: "event-state",
              providerEventUuid: "event-state-uuid",
              awayTeam: "Boston Red Sox",
              homeTeam: "New York Yankees",
              startsAt: canonical.startsAt,
              bookmakers: [
                {
                  id: "pinnacle",
                  label: "Pinnacle",
                  prices: selections.map((selectionKey) => ({
                    ...base,
                    ...pricePatch,
                    providerPriceId: `${expectedState}-${selectionKey}`,
                    selectionKey,
                    selectionLabel:
                      selectionKey === "away"
                        ? "Boston Red Sox"
                        : "New York Yankees",
                    providerSelectionId: `${expectedState}-${selectionKey}`,
                  })),
                },
              ],
            },
          ],
        },
        { pinnacle: "collected" },
        undefined,
        { pinnacle: ["moneyline"] },
      );
      expect(
        persistAvailability.mock.calls
          .map(([value]) => value)
          .filter((value) => value.identity.startsWith("FIXTURE_ODDS_GROUP#"))
          .at(-1),
      ).toMatchObject({ state: expectedState });
      expect(
        persistAvailability.mock.calls.some(
          ([value]) => value.state === "missing",
        ),
      ).toBe(false);
    }
  });

  it("binds suffixless consensus splits to the exact suffixed MLB event", async () => {
    const canonical = {
      id: "event:mlb:cardinals-yankees",
      version: 4,
      sportKey: "mlb",
      startsAt: "2026-08-04T20:00:00.000Z",
      participantLabels: ["St. Louis Cardinals", "New York Yankees"],
    } as unknown as CanonicalEvent;
    const resolveExactCanonicalBinding = vi.fn(
      ({ providerEventId }: { readonly providerEventId: string }) =>
        Promise.resolve(
          providerEventId === "mlb_cardinals_yankees_2026-08-04_b1"
            ? { ...canonical, version: 3 }
            : providerEventId === "mlb_cardinals_yankees_2026-08-04_b3"
              ? canonical
              : null,
        ),
    );
    const persist = vi.fn(() =>
      Promise.resolve({ history: "inserted", current: "advanced" }),
    );
    const persisted = await persistSharpApiSplitPage(
      { resolveExactCanonicalBinding } as unknown as EventIngestionStore,
      {
        persist,
        persistGap: vi.fn(),
      } as unknown as BettingSplitRepository,
      {
        sportKey: "mlb",
        leagueKey: "mlb",
      } as SharpApiLeague,
      {
        retrievedAt: "2026-08-04T12:00:01.000Z" as IsoTimestamp,
        items: [
          {
            providerEventId: "mlb_cardinals_yankees_2026-08-04",
            sport: "baseball",
            league: "mlb",
            sportsbookId: "consensus",
            awayTeam: "ST Louis Cardinals",
            homeTeam: "New York Yankees",
            providerTimestamp: "2026-08-04T12:00:00.000Z" as IsoTimestamp,
            markets: [
              {
                marketKey: "moneyline",
                selections: [
                  {
                    selectionKey: "away",
                    americanOdds: 145,
                    betPercent: 42,
                  },
                  { selectionKey: "home", betPercent: 58 },
                ],
              },
            ],
          },
        ],
      },
    );

    expect(persisted).toBe(2);
    expect(resolveExactCanonicalBinding).toHaveBeenCalledWith(
      expect.objectContaining({
        providerEventId: "mlb_cardinals_yankees_2026-08-04_b3",
      }),
    );
    expect(persist).toHaveBeenCalledWith(
      expect.objectContaining({
        canonicalEventId: canonical.id,
        canonicalEventVersion: 4,
        americanOdds: 145,
        scope: "consensus",
      }),
    );
  });

  it("does not attach a series split to the previous day's late game", async () => {
    // Both provider feeds date an id by its Eastern day. A split dated
    // 2026-08-08 belongs to that day's game, never to the 8:15pm Eastern game
    // on 2026-08-07 that happens to start at 00:15Z on 2026-08-08.
    const previousNight = {
      id: "event:mlb:orioles-rangers-aug7",
      version: 1,
      sportKey: "mlb",
      startsAt: "2026-08-08T00:15:00.000Z",
      participantLabels: ["Baltimore Orioles", "Texas Rangers"],
    } as unknown as CanonicalEvent;
    const persist = vi.fn();
    const persistGap = vi.fn();

    const persisted = await persistSharpApiSplitPage(
      {
        resolveExactCanonicalBinding: vi.fn(() =>
          Promise.resolve(previousNight),
        ),
      } as unknown as EventIngestionStore,
      { persist, persistGap } as unknown as BettingSplitRepository,
      { sportKey: "mlb", leagueKey: "mlb" } as SharpApiLeague,
      {
        retrievedAt: "2026-08-08T02:00:01.000Z" as IsoTimestamp,
        items: [
          {
            providerEventId: "mlb_orioles_rangers_2026-08-08",
            sport: "baseball",
            league: "mlb",
            sportsbookId: "consensus",
            awayTeam: "Baltimore Orioles",
            homeTeam: "Texas Rangers",
            providerTimestamp: "2026-08-08T02:00:00.000Z" as IsoTimestamp,
            markets: [
              {
                marketKey: "moneyline",
                selections: [{ selectionKey: "away", betPercent: 40 }],
              },
            ],
          },
        ],
      },
    );

    expect(persisted).toBe(0);
    expect(persist).not.toHaveBeenCalled();
  });

  it("aliases a secondary-catalogue event and never bootstraps one", async () => {
    // Leagues Cup: our canonical event comes from the MLS listing, whose only
    // book we do not approve. The liquidity is in a leagues_cup listing with
    // a different provider id and a different uuid — the catalogues share no
    // identity at all, so the participant pair is the only way across.
    const canonical = {
      id: "event:soccer%3Amls:usa_-_major_league_soccer_charlotte_pachuca_2026-08-11_b3",
      version: 1,
      sportKey: "soccer",
      leagueKey: "mls",
      status: "scheduled",
      startsAt: "2026-08-11T23:30:00.000Z",
      participantLabels: ["Charlotte FC", "Pachuca"],
      candidateIdentity: "charlotte-pachuca",
    } as unknown as CanonicalEvent;
    const onSecondaryGap = vi.fn();
    let bound = false;
    const ingestEvent = vi.fn(() => {
      bound = true;
      return Promise.resolve({ kind: "exact" as const });
    });

    const persisted = await persistSharpApiOddsPage(
      {
        getExactMapping: vi.fn(() => Promise.resolve(null)),
        resolveExactCanonicalBinding: vi.fn(() =>
          Promise.resolve(bound ? canonical : null),
        ),
        ingestEvent,
        // If this is ever reached the fix has failed: bootstrapping from the
        // secondary catalogue is what puts one fixture on the board twice.
        reconcileScheduledEvent: vi.fn(() => {
          throw new Error("secondary catalogue must never bootstrap");
        }),
      } as unknown as EventIngestionStore,
      {
        persist: vi.fn(() => Promise.resolve({ history: "inserted" })),
      } as never,
      {
        sportKey: "soccer",
        leagueKey: "mls",
        providerLeague: "MLS",
        secondaryOddsProviderLeagues: ["leagues_cup"],
        moneylineMarket: "moneyline",
      } as unknown as SharpApiLeague,
      {
        retrievedAt: "2026-08-11T22:00:00.000Z" as IsoTimestamp,
        events: [
          {
            providerEventId: "leagues_cup_charlotte_pachuca_2026-08-11_b3",
            providerEventUuid: "b4389ac7b0149f8c",
            awayTeam: "Pachuca",
            homeTeam: "Charlotte FC",
            startsAt: "2026-08-11T23:30:00.000Z" as IsoTimestamp,
            bookmakers: [],
          },
        ],
      },
      {},
      undefined,
      undefined,
      undefined,
      "leagues_cup",
      [{ canonical }],
      onSecondaryGap,
    );

    // It bound as an ALIAS onto the event MLS already had.
    expect(ingestEvent).toHaveBeenCalledWith(
      expect.objectContaining({ mappingKind: "alias" }),
    );
    expect(onSecondaryGap).not.toHaveBeenCalled();
    // The binding is the point; this fixture carries no books, so there is
    // nothing to observe and nothing to assert about observations.
    expect(persisted.events).toBe(0);
  });

  /**
   * The 2026-08-13 unpriced-soccer case, exactly as the feed published it.
   * SharpAPI listed Necaxa v NYCFC twice: `..._necaxa_nycfc` at 23:00Z with a
   * complete three-way market from circa and draftkings, and
   * `..._necaxa_newyorkcity` at 23:30Z carrying only two of the three
   * selections. Our schedule says 23:30, so the primary 15-minute tolerance
   * dropped the only listing that could price the fixture and kept the one
   * that could not — nine soccer games, no lines, odds sitting in the table.
   *
   * A secondary row is aliased by participants, not by time, so it gets the
   * wider bound and this listing survives.
   */
  it("keeps a secondary listing whose start disagrees by half an hour", async () => {
    const canonical = {
      id: "event:soccer%3Amls:usa_-_major_league_soccer_necaxa_newyorkcity_2026-08-13_b3",
      version: 2,
      sportKey: "soccer",
      leagueKey: "mls",
      status: "scheduled",
      startsAt: "2026-08-13T23:30:00.000Z",
      participantLabels: ["Necaxa", "New York City FC"],
      candidateIdentity: "necaxa-nycfc",
    } as unknown as CanonicalEvent;
    let bound = false;
    const ingestEvent = vi.fn(() => {
      bound = true;
      return Promise.resolve({ kind: "exact" as const });
    });
    const onSecondaryGap = vi.fn();

    const persisted = await persistSharpApiOddsPage(
      {
        getExactMapping: vi.fn(() => Promise.resolve(null)),
        resolveExactCanonicalBinding: vi.fn(() =>
          Promise.resolve(bound ? canonical : null),
        ),
        ingestEvent,
        reconcileScheduledEvent: vi.fn(() => {
          throw new Error("secondary catalogue must never bootstrap");
        }),
      } as unknown as EventIngestionStore,
      { persist: vi.fn(() => Promise.resolve({})) } as never,
      {
        sportKey: "soccer",
        leagueKey: "mls",
        providerLeague: "MLS",
        secondaryOddsProviderLeagues: ["leagues_cup"],
        moneylineMarket: "moneyline",
      } as unknown as SharpApiLeague,
      {
        retrievedAt: "2026-08-13T22:00:00.000Z" as IsoTimestamp,
        events: [
          {
            providerEventId: "leagues_cup_necaxa_nycfc_2026-08-13_b3",
            providerEventUuid: "aaaa",
            awayTeam: "Necaxa",
            homeTeam: "New York City FC",
            // Half an hour before the canonical start: past the primary
            // tolerance, inside the secondary one.
            startsAt: "2026-08-13T23:00:00.000Z" as IsoTimestamp,
            bookmakers: [],
          },
        ],
      },
      {},
      undefined,
      undefined,
      undefined,
      "leagues_cup",
      [{ canonical }],
      onSecondaryGap,
    );

    expect(persisted.rejectionCounts["start-time-conflict"]).toBeUndefined();
    expect(ingestEvent).toHaveBeenCalledWith(
      expect.objectContaining({ mappingKind: "alias" }),
    );
    expect(onSecondaryGap).not.toHaveBeenCalled();
  });

  it("still drops a secondary listing a whole day out", async () => {
    // The wider bound is not "no bound": a participant pair that repeats on
    // another date is a different fixture and must not take these prices.
    const canonical = {
      id: "event:soccer%3Amls:usa_-_major_league_soccer_necaxa_newyorkcity_2026-08-13_b3",
      version: 2,
      sportKey: "soccer",
      leagueKey: "mls",
      status: "scheduled",
      startsAt: "2026-08-13T23:30:00.000Z",
      participantLabels: ["Necaxa", "New York City FC"],
      candidateIdentity: "necaxa-nycfc",
    } as unknown as CanonicalEvent;
    let bound = false;
    const persisted = await persistSharpApiOddsPage(
      {
        getExactMapping: vi.fn(() => Promise.resolve(null)),
        resolveExactCanonicalBinding: vi.fn(() =>
          Promise.resolve(bound ? canonical : null),
        ),
        ingestEvent: vi.fn(() => {
          bound = true;
          return Promise.resolve({ kind: "exact" as const });
        }),
        reconcileScheduledEvent: vi.fn(() => {
          throw new Error("secondary catalogue must never bootstrap");
        }),
      } as unknown as EventIngestionStore,
      { persist: vi.fn(() => Promise.resolve({})) } as never,
      {
        sportKey: "soccer",
        leagueKey: "mls",
        providerLeague: "MLS",
        secondaryOddsProviderLeagues: ["leagues_cup"],
        moneylineMarket: "moneyline",
      } as unknown as SharpApiLeague,
      {
        retrievedAt: "2026-08-13T22:00:00.000Z" as IsoTimestamp,
        events: [
          {
            providerEventId: "leagues_cup_necaxa_nycfc_2026-08-14_b3",
            providerEventUuid: "bbbb",
            awayTeam: "Necaxa",
            homeTeam: "New York City FC",
            startsAt: "2026-08-14T23:30:00.000Z" as IsoTimestamp,
            bookmakers: [],
          },
        ],
      },
      {},
      undefined,
      undefined,
      undefined,
      "leagues_cup",
      [{ canonical }],
      vi.fn(),
    );
    expect(persisted.rejectionCounts["start-time-conflict"]).toBe(1);
  });

  it("drops a secondary row that matches no scheduled fixture", async () => {
    // Label drift between two catalogues is the failure mode that keeps
    // costing this product hours, so an unmatched row is counted rather than
    // quietly turned into a second canonical event.
    const onSecondaryGap = vi.fn();
    const ingestEvent = vi.fn();

    const persisted = await persistSharpApiOddsPage(
      {
        getExactMapping: vi.fn(() => Promise.resolve(null)),
        resolveExactCanonicalBinding: vi.fn(() => Promise.resolve(null)),
        ingestEvent,
        reconcileScheduledEvent: vi.fn(() => {
          throw new Error("secondary catalogue must never bootstrap");
        }),
      } as unknown as EventIngestionStore,
      { persist: vi.fn() },
      {
        sportKey: "soccer",
        leagueKey: "mls",
        providerLeague: "MLS",
        moneylineMarket: "moneyline",
      } as unknown as SharpApiLeague,
      {
        retrievedAt: "2026-08-11T22:00:00.000Z" as IsoTimestamp,
        events: [
          {
            providerEventId: "leagues_cup_someone_else_2026-08-11_b3",
            providerEventUuid: "ffff",
            awayTeam: "Club Nobody",
            homeTeam: "Club Unknown",
            startsAt: "2026-08-11T23:30:00.000Z" as IsoTimestamp,
            bookmakers: [],
          },
        ],
      },
      {},
      undefined,
      undefined,
      undefined,
      "leagues_cup",
      [],
      onSecondaryGap,
    );

    expect(onSecondaryGap).toHaveBeenCalledWith("no-candidate");
    expect(ingestEvent).not.toHaveBeenCalled();
    expect(persisted.events).toBe(0);
  });

  it("attaches a split that abbreviates a club the schedule feed spells out", async () => {
    // Real provider behaviour: /splits says "Athletics", /events says
    // "Oakland Athletics".
    const canonical = {
      id: "event:mlb:athletics-redsox",
      version: 1,
      sportKey: "mlb",
      startsAt: "2026-08-07T23:10:00.000Z",
      participantLabels: ["Oakland Athletics", "Boston Red Sox"],
    } as unknown as CanonicalEvent;
    const persist = vi.fn(() =>
      Promise.resolve({ history: "inserted", current: "advanced" }),
    );
    const persistGap = vi.fn();

    const persisted = await persistSharpApiSplitPage(
      {
        resolveExactCanonicalBinding: vi.fn(
          ({ providerEventId }: { readonly providerEventId: string }) =>
            Promise.resolve(
              providerEventId === "mlb_athletics_redsox_2026-08-07_b1"
                ? canonical
                : null,
            ),
        ),
      } as unknown as EventIngestionStore,
      { persist, persistGap } as unknown as BettingSplitRepository,
      { sportKey: "mlb", leagueKey: "mlb" } as SharpApiLeague,
      {
        retrievedAt: "2026-08-07T23:30:01.000Z" as IsoTimestamp,
        items: [
          {
            providerEventId: "mlb_athletics_redsox_2026-08-07",
            sport: "baseball",
            league: "mlb",
            sportsbookId: "consensus",
            awayTeam: "Athletics",
            homeTeam: "Boston Red Sox",
            providerTimestamp: "2026-08-07T23:30:00.000Z" as IsoTimestamp,
            markets: [
              {
                marketKey: "moneyline",
                selections: [
                  { selectionKey: "away", betPercent: 45 },
                  { selectionKey: "home", betPercent: 55 },
                ],
              },
            ],
          },
        ],
      },
    );

    expect(persisted).toBe(2);
    expect(persistGap).not.toHaveBeenCalled();
  });

  it("never attaches a split across clubs that merely share a city", async () => {
    const persist = vi.fn();
    const persistGap = vi.fn();
    const persisted = await persistSharpApiSplitPage(
      {
        resolveExactCanonicalBinding: vi.fn(() =>
          Promise.resolve({
            id: "event:mlb:cubs-whitesox",
            version: 1,
            sportKey: "mlb",
            startsAt: "2026-08-07T23:10:00.000Z",
            participantLabels: ["Chicago Cubs", "Chicago White Sox"],
          } as unknown as CanonicalEvent),
        ),
      } as unknown as EventIngestionStore,
      { persist, persistGap } as unknown as BettingSplitRepository,
      { sportKey: "mlb", leagueKey: "mlb" } as SharpApiLeague,
      {
        retrievedAt: "2026-08-07T23:30:01.000Z" as IsoTimestamp,
        items: [
          {
            providerEventId: "mlb_cubs_redsox_2026-08-07",
            sport: "baseball",
            league: "mlb",
            sportsbookId: "consensus",
            awayTeam: "Chicago Cubs",
            homeTeam: "Boston Red Sox",
            providerTimestamp: "2026-08-07T23:30:00.000Z" as IsoTimestamp,
            markets: [
              {
                marketKey: "moneyline",
                selections: [{ selectionKey: "away", betPercent: 45 }],
              },
            ],
          },
        ],
      },
    );
    expect(persisted).toBe(0);
    expect(persist).not.toHaveBeenCalled();
  });

  it("does not attach a suffixless split when exact aliases identify different games", async () => {
    const canonical = (id: string) =>
      ({
        id,
        version: 1,
        sportKey: "mlb",
        startsAt: "2026-08-04T20:00:00.000Z",
        participantLabels: ["St. Louis Cardinals", "New York Yankees"],
      }) as unknown as CanonicalEvent;
    const persist = vi.fn();
    const persistGap = vi.fn();

    const persisted = await persistSharpApiSplitPage(
      {
        resolveExactCanonicalBinding: vi.fn(
          ({ providerEventId }: { readonly providerEventId: string }) =>
            Promise.resolve(
              providerEventId.endsWith("_b1")
                ? canonical("event:one")
                : providerEventId.endsWith("_b3")
                  ? canonical("event:two")
                  : null,
            ),
        ),
      } as unknown as EventIngestionStore,
      {
        persist,
        persistGap,
      } as unknown as BettingSplitRepository,
      {
        sportKey: "mlb",
        leagueKey: "mlb",
      } as SharpApiLeague,
      {
        retrievedAt: "2026-08-04T12:00:01.000Z" as IsoTimestamp,
        items: [
          {
            providerEventId: "mlb_cardinals_yankees_2026-08-04",
            sport: "baseball",
            league: "mlb",
            sportsbookId: "consensus",
            awayTeam: "ST Louis Cardinals",
            homeTeam: "New York Yankees",
            providerTimestamp: "2026-08-04T12:00:00.000Z" as IsoTimestamp,
            markets: [
              {
                marketKey: "moneyline",
                selections: [{ selectionKey: "away", betPercent: 42 }],
              },
            ],
          },
        ],
      },
    );

    expect(persisted).toBe(0);
    expect(persist).not.toHaveBeenCalled();
    expect(persistGap).toHaveBeenCalledWith(
      expect.objectContaining({
        providerEventId: "mlb_cardinals_yankees_2026-08-04",
        reason: "event-unmapped",
      }),
    );
  });

  it("does not attach a suffixless split through an exact alias on another Eastern day", async () => {
    const persist = vi.fn();
    const persistGap = vi.fn();
    const persisted = await persistSharpApiSplitPage(
      {
        resolveExactCanonicalBinding: vi.fn(
          ({ providerEventId }: { readonly providerEventId: string }) =>
            Promise.resolve(
              providerEventId.endsWith("_b3")
                ? ({
                    id: "event:next-day",
                    version: 1,
                    sportKey: "mlb",
                    startsAt: "2026-08-05T20:00:00.000Z",
                    participantLabels: [
                      "St. Louis Cardinals",
                      "New York Yankees",
                    ],
                  } as unknown as CanonicalEvent)
                : null,
            ),
        ),
      } as unknown as EventIngestionStore,
      { persist, persistGap } as unknown as BettingSplitRepository,
      { sportKey: "mlb", leagueKey: "mlb" } as SharpApiLeague,
      {
        retrievedAt: "2026-08-04T12:00:01.000Z" as IsoTimestamp,
        items: [
          {
            providerEventId: "mlb_cardinals_yankees_2026-08-04",
            sport: "baseball",
            league: "mlb",
            sportsbookId: "consensus",
            awayTeam: "ST Louis Cardinals",
            homeTeam: "New York Yankees",
            providerTimestamp: "2026-08-04T12:00:00.000Z" as IsoTimestamp,
            markets: [
              {
                marketKey: "moneyline",
                selections: [{ selectionKey: "away", betPercent: 42 }],
              },
            ],
          },
        ],
      },
    );

    expect(persisted).toBe(0);
    expect(persist).not.toHaveBeenCalled();
    expect(persistGap).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "event-unmapped" }),
    );
  });

  it("does not attach suffixless splits to current-run candidates from another game or day", async () => {
    const candidate = (
      id: string,
      awayTeam: string,
      homeTeam: string,
      startsAt: IsoTimestamp,
    ) => ({
      raw: {
        providerEventId: id,
        providerEventUuid: `${id}:uuid`,
        awayTeam,
        homeTeam,
        startsAt,
        bookmakers: [],
      },
      canonical: {
        id: `canonical:${id}`,
        version: 1,
        sportKey: "mlb",
        startsAt,
        participantLabels: [awayTeam, homeTeam],
      } as unknown as CanonicalEvent,
    });
    const persist = vi.fn();
    const persistGap = vi.fn();

    const persisted = await persistSharpApiSplitPage(
      {
        resolveExactCanonicalBinding: vi.fn().mockResolvedValue(null),
      } as unknown as EventIngestionStore,
      { persist, persistGap } as unknown as BettingSplitRepository,
      { sportKey: "mlb", leagueKey: "mlb" } as SharpApiLeague,
      {
        retrievedAt: "2026-08-04T12:00:01.000Z" as IsoTimestamp,
        items: [
          {
            providerEventId: "mlb_cardinals_yankees_2026-08-04",
            sport: "baseball",
            league: "mlb",
            sportsbookId: "consensus",
            awayTeam: "ST Louis Cardinals",
            homeTeam: "New York Yankees",
            providerTimestamp: "2026-08-04T12:00:00.000Z" as IsoTimestamp,
            markets: [
              {
                marketKey: "moneyline",
                selections: [{ selectionKey: "away", betPercent: 42 }],
              },
            ],
          },
        ],
      },
      [
        candidate(
          "wrong-team",
          "Boston Red Sox",
          "New York Yankees",
          "2026-08-04T20:00:00.000Z" as IsoTimestamp,
        ),
        candidate(
          "wrong-day",
          "St. Louis Cardinals",
          "New York Yankees",
          "2026-08-05T20:00:00.000Z" as IsoTimestamp,
        ),
      ],
    );

    expect(persisted).toBe(0);
    expect(persist).not.toHaveBeenCalled();
    expect(persistGap).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "event-unmapped" }),
    );
  });

  it("persists main odds and entitled splits with exact provider bindings", async () => {
    const bindings = new Map<string, CanonicalEvent>();
    const resolveExactCanonicalBinding = vi.fn(
      ({
        providerEventId,
      }: Parameters<EventIngestionStore["resolveExactCanonicalBinding"]>[0]) =>
        Promise.resolve(bindings.get(providerEventId) ?? null),
    );
    const bootstrapCanonicalEvent = vi.fn(
      (bootstrap: CanonicalEventBootstrap) => {
        bindings.set(`${bootstrap.leagueKey}-event_2026-08-03_b3`, {
          id: bootstrap.id,
          version: 1,
          sportKey: bootstrap.sportKey,
          startsAt: "2026-08-04T00:00:00.000Z",
          participantIds: ["away-club", "home-club"],
          participantLabels: ["Away Club", "Home Club"],
        } as unknown as CanonicalEvent);
        return Promise.resolve("created" as const);
      },
    );
    const ingestEvent = vi.fn(
      (input: Parameters<EventIngestionStore["ingestEvent"]>[0]) =>
        Promise.resolve(
          bindings.has(input.providerEventId)
            ? { kind: "updated" as const, eventId: input.providerEventId }
            : { kind: "unresolved" as const, reason: "no-candidate" as const },
        ),
    );
    const store = {
      resolveExactCanonicalBinding,
      getExactMapping: vi.fn(
        ({ providerEventId }: { readonly providerEventId: string }) =>
          Promise.resolve(
            bindings.has(providerEventId)
              ? { bindingKind: "source" as const }
              : null,
          ),
      ),
      bootstrapCanonicalEvent,
      ingestEvent,
      findNearCanonicalCandidates: vi.fn(() => Promise.resolve([])),
      reconcileScheduledEvent: vi.fn(
        ({
          event,
          bootstrap,
        }: Parameters<EventIngestionStore["reconcileScheduledEvent"]>[0]) =>
          bootstrapCanonicalEvent(bootstrap).then(() => ingestEvent(event)),
      ),
    } as unknown as EventIngestionStore;
    const oddsPersist = vi.fn(
      (input: Parameters<SharpApiOddsPersister["persist"]>[0]) => {
        void input;
        return Promise.resolve({});
      },
    );
    const odds = { persist: oddsPersist };
    const splitPersist = vi.fn(
      (input: Parameters<BettingSplitRepository["persist"]>[0]) =>
        Promise.resolve({
          history: "inserted",
          current: "advanced",
          observation: input,
        }),
    );
    const splits = {
      persist: splitPersist,
      current: vi.fn(),
      listCurrent: vi.fn(),
      persistGap: vi.fn(),
    } as unknown as BettingSplitRepository;
    const fetchOddsPage = vi.fn((league: SharpApiLeague) => {
      const eventId = `${league.leagueKey}-event_2026-08-03_b3`;
      return Promise.resolve({
        events: [
          {
            providerEventId: eventId,
            providerEventUuid: `${eventId}-uuid`,
            awayTeam: "Away Club",
            homeTeam: "Home Club",
            startsAt: "2026-08-04T00:00:00.000Z" as IsoTimestamp,
            bookmakers: [
              {
                id: "draftkings",
                label: "DraftKings",
                prices: [
                  {
                    providerPriceId: `${eventId}-price`,
                    marketKey: league.moneylineMarket,
                    outcomeStructure:
                      league.leagueKey === "mls"
                        ? ("three-way" as const)
                        : ("two-way" as const),
                    providerMarketType: "moneyline",
                    providerMarketId: "market-1",
                    selectionKey: "away" as const,
                    selectionLabel: "Away Club",
                    providerSelectionId: "selection-1",
                    americanOdds: 120,
                    decimalOdds: 2.2,
                    impliedProbability: 0.4545,
                    isLive: false,
                    isMainLine: true,
                    isAlternateLine: false,
                    isPlayerProp: false,
                    isStalePregamePrice: false,
                    observedAt: "2026-08-03T23:00:00.000Z" as IsoTimestamp,
                  },
                  {
                    providerPriceId: `${eventId}-price-home`,
                    marketKey: league.moneylineMarket,
                    outcomeStructure:
                      league.leagueKey === "mls"
                        ? ("three-way" as const)
                        : ("two-way" as const),
                    providerMarketType: "moneyline",
                    providerMarketId: "market-1",
                    selectionKey: "home" as const,
                    selectionLabel: "Home Club",
                    providerSelectionId: "selection-home",
                    americanOdds: -130,
                    decimalOdds: 1.77,
                    impliedProbability: 0.565,
                    isLive: false,
                    isMainLine: true,
                    isAlternateLine: false,
                    isPlayerProp: false,
                    isStalePregamePrice: false,
                    observedAt: "2026-08-03T23:00:00.000Z" as IsoTimestamp,
                  },
                  ...(league.leagueKey === "mls"
                    ? [
                        {
                          providerPriceId: `${eventId}-price-draw`,
                          marketKey: league.moneylineMarket,
                          outcomeStructure: "three-way" as const,
                          providerMarketType: "moneyline_3-way",
                          providerMarketId: "market-1",
                          selectionKey: "draw" as const,
                          selectionLabel: "Draw",
                          providerSelectionId: "selection-draw",
                          americanOdds: 240,
                          decimalOdds: 3.4,
                          impliedProbability: 0.294,
                          isLive: false,
                          isMainLine: true,
                          isAlternateLine: false,
                          isPlayerProp: false,
                          isStalePregamePrice: false,
                          observedAt:
                            "2026-08-03T23:00:00.000Z" as IsoTimestamp,
                        },
                      ]
                    : []),
                ],
              },
            ],
          },
          {
            providerEventId: `${league.leagueKey}-props_2026-08-03_b3`,
            providerEventUuid: `${league.leagueKey}-props-uuid`,
            awayTeam: "Away Club - Player Props",
            homeTeam: "Home Club - Player Props",
            startsAt: "2026-08-04T00:00:00.000Z" as IsoTimestamp,
            bookmakers: [],
          },
        ],
        hasMore: false,
        retrievedAt: "2026-08-03T23:00:01.000Z" as IsoTimestamp,
      });
    });
    const fetchSchedulePage = vi.fn((league: SharpApiLeague) =>
      Promise.resolve({
        events: [
          {
            providerEventId: `${league.leagueKey}-event_2026-08-03_b3`,
            awayTeam: "Away Club",
            homeTeam: "Home Club",
            startsAt: "2026-08-04T00:00:00.000Z" as IsoTimestamp,
            status: "scheduled" as const,
          },
        ],
        hasMore: false,
        retrievedAt: "2026-08-03T22:59:00.000Z" as IsoTimestamp,
      }),
    );
    const fetchSplitsPage = vi.fn((league: SharpApiLeague) =>
      Promise.resolve({
        items: [
          {
            providerEventId: `${league.leagueKey}-event_2026-08-03`,
            sport: league.leagueKey === "mlb" ? "baseball" : "soccer",
            league: league.leagueKey,
            sportsbookId: "consensus",
            awayTeam: "Away Club",
            homeTeam: "Home Club",
            providerTimestamp: "2026-08-03T23:00:00.000Z" as IsoTimestamp,
            markets: [
              {
                marketKey: "moneyline" as const,
                selections: [
                  {
                    selectionKey: "away" as const,
                    americanOdds: 120,
                    betPercent: 40,
                    moneyPercent: 60,
                  },
                ],
              },
            ],
          },
        ],
        hasMore: false,
        retrievedAt: "2026-08-03T23:00:01.000Z" as IsoTimestamp,
      }),
    );

    const result = await ingestSharpApi(store, odds as never, splits, "key", {
      fetchAccount: () =>
        Promise.resolve({
          tier: "pro",
          features: ["odds", "schedule", "splits"],
          requestsPerMinute: 300,
          maxBooks: 15,
          streamingEnabled: false,
        }),
      fetchOddsPage,
      fetchSchedulePage,
      fetchSplitsPage,
    });

    expect(result).toMatchObject({
      leagues: 5,
      events: 5,
      observations: 11,
      splits: 5,
      splitsEntitled: true,
    });
    expect(oddsPersist).toHaveBeenCalledTimes(11);
    expect(
      oddsPersist.mock.calls.map(([input]) => input.observation.selectionKey),
    ).toEqual([
      "participant:away-club",
      "participant:home-club",
      "participant:away-club",
      "participant:home-club",
      "draw",
      "participant:away-club",
      "participant:home-club",
      "participant:away-club",
      "participant:home-club",
      "participant:away-club",
      "participant:home-club",
    ]);
    expect(splitPersist).toHaveBeenCalledTimes(5);
    expect(
      splitPersist.mock.calls.map(([input]) => input.providerEventId),
    ).toEqual([
      "mlb-event_2026-08-03",
      "mls-event_2026-08-03",
      "epl-event_2026-08-03",
      "liga-mx-event_2026-08-03",
      "uefa-champions-league-event_2026-08-03",
    ]);
    expect(splitPersist).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: "consensus",
        betPercent: 40,
        moneyPercent: 60,
      }),
    );
  });
});
