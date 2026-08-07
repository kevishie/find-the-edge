import { describe, expect, it } from "vitest";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import {
  DynamoExactOddsSnapshotRepository,
  DynamoFixtureOddsAdapter,
  EventCursorCodec,
  FixtureOddsTransactionCanceledError,
  JoinedOddsHistoryRepository,
  MemoryBettingSplitRepository,
  MemoryEventIngestionStore,
  MemoryOddsControlPlaneStore,
  oddsHistoryPartition,
  type FixtureOddsCurrentWrite,
  type FixtureOddsDynamoGateway,
  type FixtureOddsItem,
  type FixtureOddsSnapshotTransaction,
} from "@find-the-edge/database";
import type { FixtureOddsAvailabilityEvidence } from "@find-the-edge/domain";
import {
  productionOddsCollectionPolicies,
  sportsbookRegistry,
} from "@find-the-edge/config";
import {
  fetchSharpApiAccount,
  fetchSharpApiOddsPage,
  fetchSharpApiSchedulePage,
  fetchSharpApiSplitsPage,
  SharpApiError,
  sharpApiLeagueByKey,
  sharpApiLeagues,
} from "@find-the-edge/providers";

import {
  ingestSharpApi,
  persistSharpApiOddsPage,
  persistSharpApiSplitPage,
  type SharpApiOddsPersister,
} from "./sharp-api-ingestion";
import { runProductionOddsControlPlane } from "./production-odds-control-plane";
import { reconcileScheduledProviderEvent } from "./schedule-reconciliation";

const apiKey = process.env["SHARP_API_KEY"];
const canRunLiveContracts =
  Boolean(apiKey) && process.env["FTE_RUN_SHARP_LIVE_CONTRACTS"] === "1";
const canRunPaidCanary =
  Boolean(apiKey) && process.env["FTE_RUN_SHARP_CANARY"] === "1";

class LocalFixtureOddsGateway implements FixtureOddsDynamoGateway {
  private readonly items = new Map<string, FixtureOddsItem>();
  private readonly availability = new Map<
    string,
    FixtureOddsAvailabilityEvidence
  >();

  constructor(private readonly events: MemoryEventIngestionStore) {}

  private key(pk: string, sk: string) {
    return `${pk}\u0000${sk}`;
  }

  getExact(pk: string, sk: string) {
    const item = this.items.get(this.key(pk, sk));
    return Promise.resolve(item ? structuredClone(item) : null);
  }

  transactSnapshot(request: FixtureOddsSnapshotTransaction) {
    const exactId = (
      key: { readonly pk: string; readonly sk: string },
      prefix: "MAPPING#" | "EVENT#",
    ) =>
      key.sk === "CURRENT" && key.pk.startsWith(prefix)
        ? key.pk.slice(prefix.length) || undefined
        : undefined;
    const mappingId = exactId(request.mapping.key, "MAPPING#");
    const canonicalEventId = exactId(request.canonicalEvent.key, "EVENT#");
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
      mappingId !== undefined &&
      matches(this.events.mappings.get(mappingId), request.mapping.expected)
        ? "None"
        : "ConditionalCheckFailed",
      canonicalEventId !== undefined &&
      matches(
        this.events.events.get(canonicalEventId),
        request.canonicalEvent.expected,
      )
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
    const value = this.availability.get(partitionKey);
    return Promise.resolve(value ? structuredClone(value) : null);
  }

  putAvailability(value: FixtureOddsAvailabilityEvidence) {
    this.availability.set(value.identity, structuredClone(value));
    return Promise.resolve();
  }

  snapshots() {
    return [...this.items.values()]
      .filter(({ sk }) => sk !== "CURRENT")
      .map(({ value }) => structuredClone(value));
  }
}

class LocalExactSnapshotClient {
  private readonly items = new Map<string, Record<string, unknown>>();

  private key(pk: unknown, sk: unknown) {
    return `${String(pk)}\u0000${String(sk)}`;
  }

  send(command: { readonly input: Record<string, unknown> }) {
    if (command.constructor.name === "GetCommand") {
      const key = command.input["Key"] as Record<string, unknown>;
      const item = this.items.get(this.key(key["pk"], key["sk"]));
      return Promise.resolve(item ? { Item: structuredClone(item) } : {});
    }
    if (command.constructor.name !== "PutCommand")
      throw new Error("canary-exact-index-command-invalid");
    const item = command.input["Item"] as Record<string, unknown>;
    const key = this.key(item["pk"], item["sk"]);
    if (this.items.has(key)) {
      const error = new Error("canary-exact-index-conflict");
      error.name = "ConditionalCheckFailedException";
      throw error;
    }
    this.items.set(key, structuredClone(item));
    return Promise.resolve({});
  }

  historyRows() {
    return [...this.items.values()]
      .filter(({ pk }) => String(pk).startsWith("ODDS_HISTORY#"))
      .map((item) => structuredClone(item)) as {
      readonly pk: string;
      readonly sk: string;
      readonly value: unknown;
    }[];
  }
}

describe("SharpAPI live contract", () => {
  it.skipIf(!canRunLiveContracts)(
    "persists the current MLB schedule, odds, and splits locally",
    async () => {
      const events = new MemoryEventIngestionStore();
      const splits = new MemoryBettingSplitRepository();
      const oddsGateway = new LocalFixtureOddsGateway(events);
      const exactClient = new LocalExactSnapshotClient();
      const recordingOdds = new DynamoFixtureOddsAdapter(
        oddsGateway,
        new DynamoExactOddsSnapshotRepository(
          exactClient as unknown as DynamoDBDocumentClient,
          "local-live-contract",
        ),
      );
      const league = sharpApiLeagueByKey("mlb");
      const schedule = await fetchSharpApiSchedulePage(league, apiKey!);
      for (const raw of schedule.events)
        await reconcileScheduledProviderEvent(
          events,
          "sharpapi",
          {
            providerEventId: raw.providerEventId,
            sportKey: league.sportKey,
            leagueKey: league.leagueKey,
            participantLabels: [raw.awayTeam, raw.homeTeam],
            ...(raw.awayClubKey && raw.homeClubKey
              ? {
                  participantIdentityKeys: [
                    raw.awayClubKey,
                    raw.homeClubKey,
                  ] as [string, string],
                }
              : {}),
            startsAt: raw.startsAt,
            status: "scheduled",
            revision: {
              providerId: "sharpapi",
              authorityRank: 60,
              updatedAt: schedule.retrievedAt,
              sequence: 0,
              token: schedule.retrievedAt,
            },
          },
          schedule.retrievedAt,
        );
      const page = await fetchSharpApiOddsPage(league, apiKey!);
      const policy = productionOddsCollectionPolicies
        .find(({ leagueKey }) => leagueKey === league.leagueKey)!
        .providers.find(({ providerId }) => providerId === "sharpapi")!;
      const persisted = await persistSharpApiOddsPage(
        events,
        recordingOdds,
        league,
        page,
        policy.books,
        undefined,
        policy.expectedBooks,
      );

      const hasPregameApprovedEvidence = page.events.some(
        (event) =>
          Date.parse(event.startsAt) > Date.parse(page.retrievedAt) &&
          event.bookmakers.some(
            (book) =>
              policy.books[book.id] &&
              book.prices.some(
                (price) =>
                  price.isMainLine &&
                  !price.isAlternateLine &&
                  !price.isPlayerProp &&
                  !price.isStalePregamePrice &&
                  price.isActive !== false &&
                  !price.isSuspended &&
                  Date.parse(price.observedAt) < Date.parse(event.startsAt),
              ),
          ),
      );
      if (hasPregameApprovedEvidence)
        expect(persisted.observations).toBeGreaterThan(0);
      else expect(persisted.observations).toBe(0);
      expect(persisted.canonicalOddsEvents).toHaveLength(persisted.events);
      const historyRows = exactClient.historyRows();
      expect(historyRows).toHaveLength(persisted.observations);
      const approvedSportsbooks = Object.fromEntries(
        sportsbookRegistry.flatMap(({ id, name }) =>
          id === "consensus" ? [] : [[id, name]],
        ),
      );
      const history = new JoinedOddsHistoryRepository(
        {
          query: async (input) => {
            await Promise.resolve();
            const matching = historyRows
              .filter(
                ({ pk, sk }) =>
                  pk === input.pk &&
                  sk >= input.fromSk &&
                  sk <= input.toSk &&
                  (!input.startSk || sk > input.startSk),
              )
              .sort((left, right) => left.sk.localeCompare(right.sk));
            return {
              items: matching.slice(0, input.limit),
              hasMore: matching.length > input.limit,
            };
          },
        },
        new EventCursorCodec({
          current: { id: "live-contract", secret: new Uint8Array(32).fill(9) },
        }),
        approvedSportsbooks,
        (americanOdds) =>
          americanOdds < 0
            ? -americanOdds / (-americanOdds + 100)
            : 100 / (americanOdds + 100),
        () => new Date(page.retrievedAt),
      );
      for (const eventId of new Set(
        historyRows.map(({ pk }) => pk.slice("ODDS_HISTORY#".length)),
      )) {
        const rows = historyRows.filter(
          ({ pk }) => pk === oddsHistoryPartition(eventId),
        );
        const observed = rows.map(({ value }) =>
          String((value as { observedAt?: unknown }).observedAt),
        );
        await expect(
          history.list({
            eventId,
            canonicalEventVersion: 1,
            from: observed.sort()[0]!,
            to: observed.sort().at(-1)!,
            limit: Math.min(200, rows.length),
          }),
        ).resolves.toMatchObject({ eventId });
      }
      const account = await fetchSharpApiAccount(apiKey!);
      if (account.features.includes("splits")) {
        const splitPage = await fetchSharpApiSplitsPage(league, apiKey!);
        const count = await persistSharpApiSplitPage(
          events,
          splits,
          league,
          splitPage,
          persisted.canonicalOddsEvents,
        );
        expect(count).toBeGreaterThan(0);
      }
    },
    120_000,
  );

  it.skipIf(!canRunLiveContracts)(
    "ingests the current schedule, odds, and entitled splits locally",
    async () => {
      const events = new MemoryEventIngestionStore();
      const splits = new MemoryBettingSplitRepository();
      let writes = 0;
      const recordingOdds: SharpApiOddsPersister = {
        persist: ({ observation }) => {
          writes += 1;
          return Promise.resolve({
            snapshot: "created",
            current: "advanced",
            value: observation as never,
          });
        },
        persistAvailability: () => Promise.resolve(),
      };

      const summary = await ingestSharpApi(
        events,
        recordingOdds,
        splits,
        apiKey!,
      );

      expect(summary.leagues).toBeGreaterThan(0);
      expect(summary.events).toBeGreaterThan(0);
      expect(summary.observations).toBeGreaterThan(0);
      expect(summary.observations).toBe(writes);
      expect(events.events.size).toBeGreaterThan(0);
      expect(events.mappings.size).toBeGreaterThanOrEqual(events.events.size);
      if (summary.splitsEntitled) expect(summary.splits).toBeGreaterThan(0);
    },
    120_000,
  );

  it.skipIf(!canRunLiveContracts)(
    "parses complete odds pagination for every production league locally",
    async () => {
      const failures: {
        readonly leagueKey: string;
        readonly requestKind: "initial" | "cursor";
        readonly status?: number;
        readonly code: string;
        readonly stage?: string;
      }[] = [];

      for (const league of sharpApiLeagues) {
        let cursor: string | undefined;
        let reachedTerminalPage = false;
        const cursors = new Set<string>();
        for (let pageNumber = 0; pageNumber < 100; pageNumber += 1) {
          let status: number | undefined;
          try {
            const page = await fetchSharpApiOddsPage(
              league,
              apiKey!,
              cursor,
              async (...args) => {
                const response = await fetch(...args);
                status = response.status;
                return response;
              },
            );
            if (!page.hasMore) {
              reachedTerminalPage = true;
              break;
            }
            expect(page.nextCursor).toBeTruthy();
            expect(cursors.has(page.nextCursor!)).toBe(false);
            cursors.add(page.nextCursor!);
            cursor = page.nextCursor;
          } catch (error) {
            failures.push({
              leagueKey: league.leagueKey,
              requestKind: cursor ? "cursor" : "initial",
              ...(status === undefined ? {} : { status }),
              code: error instanceof Error ? error.message : typeof error,
              ...(error instanceof SharpApiError && error.stage
                ? { stage: error.stage }
                : {}),
            });
            break;
          }
        }
        if (
          !reachedTerminalPage &&
          !failures.some(({ leagueKey }) => leagueKey === league.leagueKey)
        )
          failures.push({
            leagueKey: league.leagueKey,
            requestKind: cursor ? "cursor" : "initial",
            code: "page-limit-exceeded",
          });
      }

      expect(failures).toEqual([]);
    },
    300_000,
  );

  it.skipIf(!canRunPaidCanary)(
    "runs the complete production control plane locally against SharpAPI",
    async () => {
      const events = new MemoryEventIngestionStore();
      const splits = new MemoryBettingSplitRepository();
      const control = new MemoryOddsControlPlaneStore();
      const oddsGateway = new LocalFixtureOddsGateway(events);
      const exactSnapshots = new DynamoExactOddsSnapshotRepository(
        new LocalExactSnapshotClient() as unknown as DynamoDBDocumentClient,
        "local-canary",
      );
      const recordingOdds = new DynamoFixtureOddsAdapter(
        oddsGateway,
        exactSnapshots,
      );
      const metrics: {
        readonly name: string;
        readonly value: number;
        readonly dimensions: Readonly<Record<string, string>>;
      }[] = [];

      const providerPinnacleIds = new Set<string>();
      const fetchSharpOdds = async (
        ...args: Parameters<typeof fetchSharpApiOddsPage>
      ) => {
        const page = await fetchSharpApiOddsPage(...args);
        for (const event of page.events)
          for (const book of event.bookmakers)
            if (book.id === "pinnacle")
              for (const providerId of book.providerSportsbookIds ?? [])
                providerPinnacleIds.add(providerId);
        return page;
      };

      const summary = await runProductionOddsControlPlane({
        events,
        odds: recordingOdds,
        splits,
        control,
        sharpApiKey: apiKey!,
        forceRefresh: true,
        fetchSharpOdds,
        metrics: {
          emit: (name, value, dimensions) => {
            metrics.push({ name, value, dimensions });
          },
        },
      });

      const snapshots = oddsGateway.snapshots();
      const persistedBooks = new Set(
        snapshots.map(({ sportsbookId }) => sportsbookId),
      );
      const pinnacleSnapshots = snapshots.filter(
        ({ sportsbookId }) => sportsbookId === "pinnacle",
      );
      const actionablePinnacleSnapshots = await Promise.all(
        pinnacleSnapshots.map(async (snapshot) => ({
          snapshot,
          current: await recordingOdds.getActionableCurrent(
            snapshot.partitionKey,
          ),
        })),
      );
      const actionablePinnacle = actionablePinnacleSnapshots.find(
        ({ snapshot, current }) => current?.snapshotId === snapshot.snapshotId,
      );
      const pinnacle = actionablePinnacle?.snapshot;
      const accountCapacity = Math.max(
        ...metrics
          .filter(({ name }) => name === "OddsAccountBookCapacity")
          .map(({ value }) => value),
      );
      const approvedBooksPersisted = persistedBooks.size;
      const unknownBooksRejected = metrics
        .filter(
          ({ name, dimensions }) =>
            name === "OddsNormalizationRejected" &&
            dimensions["reason"] === "unknown-bookmaker",
        )
        .reduce((total, { value }) => total + value, 0);

      const pinnacleMetricObserved = metrics.some(
        ({ name, dimensions }) =>
          name === "OddsRunPinnacleCoverage" &&
          dimensions["status"] === "observed",
      );
      const pinnacleCoverage =
        pinnacle && pinnacleMetricObserved ? "observed" : "coverage-unverified";
      const pinnacleWireIdentifier = providerPinnacleIds.has("pinnacle")
        ? "observed"
        : "coverage-unverified";

      console.info(
        JSON.stringify({
          accountCapacity,
          pinnacleCoverage,
          pinnacleWireIdentifier,
          normalizedSnapshots: snapshots.length,
          pinnacleSnapshots: pinnacleSnapshots.length,
          approvedBooksPersisted,
          unknownBooksRejected,
        }),
      );

      const exactReadback = pinnacle
        ? await exactSnapshots.get(pinnacle.snapshotId)
        : null;
      const currentReadback = actionablePinnacle?.current ?? null;
      const exactReadbackMatches =
        exactReadback !== null &&
        pinnacle !== undefined &&
        exactReadback.snapshotId === pinnacle.snapshotId &&
        exactReadback.partitionKey === pinnacle.partitionKey &&
        exactReadback.sportsbookId === "pinnacle" &&
        exactReadback.eventId === pinnacle.canonicalEventId &&
        exactReadback.americanOdds === pinnacle.americanOdds;
      const currentReadbackMatches =
        currentReadback !== null &&
        pinnacle !== undefined &&
        currentReadback.snapshotId === pinnacle.snapshotId &&
        currentReadback.sportsbookId === "pinnacle" &&
        currentReadback.provenance?.providerId === "sharpapi" &&
        currentReadback.provenance.sourceState === "active";

      expect(summary.length, "canary-league-count-invalid").toBe(
        sharpApiLeagues.length,
      );
      expect(
        summary.every(({ status }) => status === "completed"),
        "canary-control-plane-incomplete",
      ).toBe(true);
      expect(snapshots.length > 0, "canary-no-normalized-snapshots").toBe(true);
      expect(accountCapacity >= 25, "canary-entitlement-insufficient").toBe(
        true,
      );
      expect(
        pinnacleCoverage === "observed",
        "canary-pinnacle-coverage-unverified",
      ).toBe(true);
      expect(
        pinnacleWireIdentifier === "observed",
        "canary-pinnacle-wire-identifier-unverified",
      ).toBe(true);
      expect(unknownBooksRejected, "canary-unknown-books-rejected").toBe(0);
      expect(
        exactReadbackMatches,
        "canary-pinnacle-exact-readback-failed",
      ).toBe(true);
      expect(
        currentReadbackMatches,
        "canary-pinnacle-current-readback-failed",
      ).toBe(true);
    },
    300_000,
  );
});
