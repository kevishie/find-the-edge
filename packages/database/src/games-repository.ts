import {
  collapseNearDuplicateGames,
  gamePassesMlbParticipantBoundary,
  fixtureOddsPartition,
  participantSelectionKey,
  selectionsShareObservationWindow,
  type GameDisplayDto,
  type GameOddsComparisonDto,
  type GameOddsCellDto,
  type GameOddsSelectionDto,
  type EntityId,
  fixtureOddsGroupAvailabilityIdentity,
  type FixtureOddsAvailabilityEvidence,
} from "@find-the-edge/domain";
import { EventStorageError } from "./event-errors";
import {
  validateFixtureOddsCurrentItem,
  type FixtureOddsItem,
} from "./fixture-odds-adapter";
import type {
  EventListFilter,
  EventPage,
  EventRepository,
} from "./event-repository";

export interface GamesPage extends Omit<EventPage, "items"> {
  readonly items: readonly GameDisplayDto[];
}
export interface GamesRepository {
  list(
    filter: EventListFilter,
    limit: number,
    cursor?: string,
  ): Promise<GamesPage>;
  detail?(eventId: string): Promise<{
    readonly projectionState: "ready" | "uninitialized";
    readonly item: GameOddsComparisonDto | null;
    readonly unavailableReason: "projection-uninitialized" | null;
  }>;
}
export interface CurrentOddsReadGateway {
  batchGet(
    keys: readonly {
      readonly pk: string;
      readonly sk: "CURRENT" | "AVAILABILITY";
    }[],
    options?: { readonly consistentRead?: boolean },
  ): Promise<readonly unknown[]>;
}
export interface GameDetailSportsbook {
  readonly id: string;
  readonly label: string;
}

/**
 * Page freshness is the OLDEST item freshness, so it only means anything when
 * it is derived from the items being returned. Spreading an upstream page
 * inherits a value computed over rows that later filtering removed: a page
 * emptied by its own filters then goes out as zero items carrying a non-null
 * freshness, which contradicts the definition and which the browser client
 * refuses outright — the reader gets "The games response was invalid."
 * instead of an empty board. `withoutWithdrawnListings` recomputes for the
 * same reason.
 */
const oldestFreshness = (
  items: readonly { readonly freshness: string | null }[],
): string | null =>
  items.reduce<string | null>(
    (oldest, item) =>
      item.freshness === null
        ? oldest
        : oldest === null || item.freshness < oldest
          ? item.freshness
          : oldest,
    null,
  );

const marketSpecifications = (event: EventPage["items"][number]) => {
  const sides = event.participants
    .slice(0, 2)
    .map(({ id }) => participantSelectionKey(id as EntityId));
  const sportKey = event.sportKey;
  if (sportKey === "mlb")
    return [
      {
        marketKey: "moneyline",
        selectionKeys: sides,
        required: true,
      },
      {
        marketKey: "spread",
        selectionKeys: sides,
        required: false,
      },
      {
        marketKey: "total",
        selectionKeys: ["over", "under"] as const,
        required: false,
      },
    ] as const;
  if (sportKey === "soccer")
    return [
      {
        marketKey: "moneyline",
        selectionKeys: [sides[0]!, "draw", sides[1]!],
        required: true,
      },
      {
        marketKey: "spread",
        selectionKeys: sides,
        required: false,
      },
      {
        marketKey: "total",
        selectionKeys: ["over", "under"] as const,
        required: false,
      },
    ] as const;
  throw new EventStorageError("unsupported-games-sport");
};

const detailMarketSpecifications = (event: EventPage["items"][number]) => {
  const participantTotals = event.participants
    .slice(0, 2)
    .flatMap(({ id }) => [
      participantSelectionKey(id as EntityId, "over"),
      participantSelectionKey(id as EntityId, "under"),
    ]);
  return [
    ...marketSpecifications(event),
    ...(event.sportKey === "soccer"
      ? [
          {
            marketKey: "btts",
            selectionKeys: ["yes", "no"] as const,
            required: false,
          },
        ]
      : []),
    {
      marketKey: "team_total",
      selectionKeys: participantTotals,
      required: false,
    },
  ] as const;
};

const canonicalSelectionLabel = (
  event: EventPage["items"][number],
  selectionKey: string,
) => {
  const participant = event.participants.find(
    ({ id }) => participantSelectionKey(id as EntityId) === selectionKey,
  );
  if (participant) return participant.label;
  if (selectionKey === "over") return "Over";
  if (selectionKey === "under") return "Under";
  if (selectionKey === "draw") return "Draw";
  if (selectionKey === "yes") return "Yes";
  if (selectionKey === "no") return "No";
  for (const { id, label } of event.participants.slice(0, 2)) {
    if (participantSelectionKey(id as EntityId, "over") === selectionKey)
      return `${label} Over`;
    if (participantSelectionKey(id as EntityId, "under") === selectionKey)
      return `${label} Under`;
  }
  throw new EventStorageError("unsupported-detail-selection");
};

const canonicalSnapshotValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalSnapshotValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [
        key,
        canonicalSnapshotValue((value as Record<string, unknown>)[key]),
      ]),
  );
};

const sameDetailSnapshot = (
  left: ReadonlyMap<string, unknown>,
  right: ReadonlyMap<string, unknown>,
) =>
  left.size === right.size &&
  [...left].every(
    ([identity, row]) =>
      right.has(identity) &&
      JSON.stringify(canonicalSnapshotValue(row)) ===
        JSON.stringify(canonicalSnapshotValue(right.get(identity))),
  );

const blockingCellState = (
  blocker: FixtureOddsAvailabilityEvidence | null | undefined,
): "partial" | "suspended" | "unavailable" =>
  blocker?.state === "incomplete"
    ? "partial"
    : blocker?.state === "suspended" || blocker?.state === "closed"
      ? "suspended"
      : "unavailable";

/** The book whose prices anchor no-vig fair lines on the served board. */
const SHARP_ANCHOR_SPORTSBOOK_ID = "pinnacle";

const pointRequired = (marketKey: string) =>
  marketKey === "spread" || marketKey === "total" || marketKey === "team_total";

const canonicalInstant = (value: unknown): value is string =>
  typeof value === "string" &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString() === value;

const boundedEvidenceText = (value: unknown, maximum: number) =>
  typeof value === "string" && value.length > 0 && value.length <= maximum;

const currentKey = (
  event: EventPage["items"][number],
  marketKey: string,
  selectionKey: string,
  sportsbookId: string,
) => ({
  pk: fixtureOddsPartition({
    canonicalEventId: event.id,
    canonicalEventVersion: event.version,
    sportKey: event.sportKey,
    marketKey,
    selectionKey,
    sportsbookId,
  }).key,
  sk: "CURRENT" as const,
});

const validateCurrent = (
  row: unknown,
  expected: ReturnType<typeof currentKey>,
  event: EventPage["items"][number],
): GameOddsSelectionDto => {
  if (!row || typeof row !== "object" || Array.isArray(row))
    throw new EventStorageError("invalid-current-odds-row");
  const keys = Reflect.ownKeys(row);
  if (
    keys.length !== 3 ||
    !["pk", "sk", "value"].every((key) => keys.includes(key))
  )
    throw new EventStorageError("invalid-current-odds-row");
  const typed = row as {
    readonly pk: unknown;
    readonly sk: unknown;
    readonly value: unknown;
  };
  if (typed.pk !== expected.pk || typed.sk !== expected.sk)
    throw new EventStorageError("current-odds-key-mismatch");
  let normalized;
  try {
    normalized = validateFixtureOddsCurrentItem(
      typed as FixtureOddsItem,
      expected.pk,
    );
  } catch (error) {
    throw new EventStorageError("invalid-current-odds-value", { cause: error });
  }
  if (!normalized) throw new EventStorageError("missing-current-odds-value");
  if (
    normalized.canonicalEventId !== event.id ||
    normalized.canonicalEventVersion !== event.version ||
    normalized.sportKey !== event.sportKey
  )
    throw new EventStorageError("current-odds-binding-mismatch");
  return {
    marketKey: normalized.marketKey,
    selectionKey: normalized.selectionKey,
    ...(normalized.selectionLabel
      ? { selectionLabel: normalized.selectionLabel }
      : {}),
    sportsbookId: normalized.sportsbookId,
    ...(normalized.sportsbookLabel
      ? { sportsbookLabel: normalized.sportsbookLabel }
      : {}),
    ...(normalized.point === undefined ? {} : { point: normalized.point }),
    americanOdds: normalized.americanOdds,
    observedAt: normalized.observedAt,
    retrievedAt: normalized.retrievedAt,
  };
};

const quarantinableCurrentOddsErrors = new Set([
  "invalid-current-odds-value",
  "missing-current-odds-value",
  "current-odds-binding-mismatch",
]);
const isQuarantinableCurrentOddsError = (error: unknown) =>
  error instanceof EventStorageError &&
  quarantinableCurrentOddsErrors.has(error.message);

/** How long past its claimed start an evidence-free scheduled listing keeps
 * the benefit of the doubt before the board treats it as withdrawn. */
const WITHDRAWN_EVENT_GRACE_MS = 2 * 60 * 60 * 1000;

const collapseEventRows = (events: EventPage["items"]) =>
  collapseNearDuplicateGames(
    events.map((event) => ({
      ...event,
      odds: { state: "unavailable" as const },
    })),
  ).map((game) => {
    const { odds, ...event } = game;
    void odds;
    return event;
  });

export class JoinedGamesRepository implements GamesRepository {
  constructor(
    readonly events: EventRepository,
    readonly odds: CurrentOddsReadGateway,
    readonly sportsbookIds: readonly string[] = [
      "hardrock",
      "draftkings",
      "fanduel",
      "betmgm",
      "caesars",
    ],
    readonly now: () => Date = () => new Date(),
    readonly freshnessWindowMs = 2 * 60 * 60 * 1000,
    readonly targetSportsbookId = "hardrock",
    readonly clockSkewToleranceMs = 5 * 60 * 1000,
    readonly detailSportsbooks: readonly GameDetailSportsbook[] = sportsbookIds.map(
      (id) => ({ id, label: id }),
    ),
  ) {
    if (!Number.isFinite(freshnessWindowMs) || freshnessWindowMs < 0)
      throw new EventStorageError("invalid-detail-freshness-window");
    if (!Number.isFinite(clockSkewToleranceMs) || clockSkewToleranceMs < 0)
      throw new EventStorageError("invalid-detail-clock-skew-tolerance");
  }
  async detail(eventId: string) {
    const detail = await this.events.detail(eventId);
    if (detail.projectionState === "uninitialized" || !detail.item)
      return { ...detail, item: null };
    const event = detail.item;
    const capturedAt = this.now();
    if (!(capturedAt instanceof Date))
      throw new EventStorageError("invalid-detail-clock");
    const readAt = capturedAt.getTime();
    if (!Number.isFinite(readAt))
      throw new EventStorageError("invalid-detail-clock");
    if (
      new Set(this.detailSportsbooks.map(({ id }) => id)).size !==
        this.detailSportsbooks.length ||
      this.detailSportsbooks.some(
        ({ id, label }) => !id || !label || id === "consensus",
      ) ||
      this.detailSportsbooks.filter(({ id }) => id === this.targetSportsbookId)
        .length !== 1
    )
      throw new EventStorageError("invalid-detail-sportsbook-roster");
    const specifications = detailMarketSpecifications(event);
    // Provider id churn advances the canonical version faster than the odds
    // persist path, so a market's rows can live one version behind. Both
    // versions are read; each book's market then resolves to one version
    // wholesale so availability evidence never mixes versions.
    const priorEvent =
      event.version > 1 ? { ...event, version: event.version - 1 } : null;
    const versionVariants = priorEvent ? [event, priorEvent] : [event];
    const requested = versionVariants.flatMap((variant) =>
      this.detailSportsbooks.flatMap(({ id: sportsbookId }) =>
        specifications.flatMap((specification) => [
          ...specification.selectionKeys.flatMap((selectionKey) => {
            const key = currentKey(
              variant,
              specification.marketKey,
              selectionKey,
              sportsbookId,
            );
            return [key, { pk: key.pk, sk: "AVAILABILITY" as const }];
          }),
          {
            pk: fixtureOddsGroupAvailabilityIdentity({
              canonicalEventId: variant.id,
              canonicalEventVersion: variant.version,
              sportKey: variant.sportKey,
              marketKey: specification.marketKey,
              sportsbookId,
            }),
            sk: "AVAILABILITY" as const,
          },
        ]),
      ),
    );
    const allowed = new Set(requested.map(({ pk, sk }) => `${pk}|${sk}`));
    const readSnapshot = async () => {
      let rows: readonly unknown[];
      try {
        rows = await this.odds.batchGet(requested);
      } catch (error) {
        throw new EventStorageError("detail-odds-read-failed", {
          cause: error,
        });
      }
      const snapshot = new Map<string, unknown>();
      for (const row of rows) {
        if (!row || typeof row !== "object" || Array.isArray(row))
          throw new EventStorageError("invalid-detail-odds-row");
        const record = row as Record<string, unknown>;
        const identity = `${String(record["pk"])}|${String(record["sk"])}`;
        if (!allowed.has(identity) || snapshot.has(identity))
          throw new EventStorageError("unexpected-detail-odds-row");
        snapshot.set(identity, row);
      }
      return snapshot;
    };
    const byKey = await readSnapshot();
    const stableByKey = await readSnapshot();
    if (!sameDetailSnapshot(byKey, stableByKey))
      throw new EventStorageError("detail-odds-snapshot-unstable");
    const availability = (pk: string) => {
      const row = byKey.get(`${pk}|AVAILABILITY`);
      if (row === undefined) return null;
      const record = row as Record<string, unknown>;
      if (
        Object.keys(record).sort().join("|") !== "pk|sk|value" ||
        record["pk"] !== pk ||
        record["sk"] !== "AVAILABILITY"
      )
        throw new EventStorageError("invalid-detail-availability-row");
      const value = record["value"];
      if (
        !value ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        (value as FixtureOddsAvailabilityEvidence).identity !== pk ||
        ![
          "active",
          "suspended",
          "closed",
          "missing",
          "malformed",
          "incomplete",
          "unavailable",
        ].includes((value as FixtureOddsAvailabilityEvidence).state) ||
        !canonicalInstant(
          (value as FixtureOddsAvailabilityEvidence).observedAt,
        ) ||
        !boundedEvidenceText(
          (value as FixtureOddsAvailabilityEvidence).evidenceId,
          256,
        ) ||
        !boundedEvidenceText(
          (value as FixtureOddsAvailabilityEvidence).reason,
          256,
        ) ||
        Date.parse((value as FixtureOddsAvailabilityEvidence).observedAt) >
          readAt + this.clockSkewToleranceMs
      )
        throw new EventStorageError("invalid-detail-availability-row");
      return value as FixtureOddsAvailabilityEvidence;
    };
    const generatedAt = capturedAt.toISOString();
    // A book's market serves the current version when any of its rows exist
    // there and otherwise falls back to the prior version wholesale.
    const marketEventFor = (
      specification: (typeof specifications)[number],
      sportsbookId: string,
    ) => {
      if (!priorEvent) return event;
      const hasCurrent = (variant: EventPage["items"][number]) =>
        specification.selectionKeys.some((selectionKey) =>
          byKey.has(
            `${
              currentKey(
                variant,
                specification.marketKey,
                selectionKey,
                sportsbookId,
              ).pk
            }|CURRENT`,
          ),
        );
      if (hasCurrent(event)) return event;
      return hasCurrent(priorEvent) ? priorEvent : event;
    };
    const markets = specifications.map((specification) => ({
      marketKey: specification.marketKey,
      selections: specification.selectionKeys.map((selectionKey) => {
        const cells: Record<string, GameOddsCellDto> = {};
        const label = canonicalSelectionLabel(event, selectionKey);
        for (const { id: sportsbookId } of this.detailSportsbooks) {
          const source = marketEventFor(specification, sportsbookId);
          const key = currentKey(
            source,
            specification.marketKey,
            selectionKey,
            sportsbookId,
          );
          const raw = byKey.get(`${key.pk}|CURRENT`);
          const exact = availability(key.pk);
          const group = availability(
            fixtureOddsGroupAvailabilityIdentity({
              canonicalEventId: source.id,
              canonicalEventVersion: source.version,
              sportKey: source.sportKey,
              marketKey: specification.marketKey,
              sportsbookId,
            }),
          );
          if (raw === undefined) {
            const blocker = [exact, group]
              .filter(
                (item): item is FixtureOddsAvailabilityEvidence =>
                  !!item && item.state !== "active",
              )
              .sort(
                (a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt),
              )[0];
            cells[sportsbookId] = {
              state: blockingCellState(blocker),
              eligible: false,
              reason: blocker?.reason ?? "price-unavailable",
              evidenceAt: blocker?.observedAt ?? null,
            };
            continue;
          }
          let price: GameOddsSelectionDto;
          try {
            price = validateCurrent(raw, key, source);
          } catch (error) {
            if (!isQuarantinableCurrentOddsError(error)) throw error;
            cells[sportsbookId] = {
              state: "unavailable",
              eligible: false,
              reason: "price-unavailable",
              evidenceAt: null,
            };
            continue;
          }
          if (
            Date.parse(price.observedAt) > readAt + this.clockSkewToleranceMs ||
            Date.parse(price.retrievedAt) > readAt + this.clockSkewToleranceMs
          )
            throw new EventStorageError("future-detail-odds-evidence");
          const latestBlocker = [exact, group]
            .filter(
              (item): item is FixtureOddsAvailabilityEvidence =>
                !!item && item.state !== "active",
            )
            .sort(
              (a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt),
            )[0];
          const stale =
            readAt - Date.parse(price.observedAt) > this.freshnessWindowMs;
          const missingAvailability = !exact || !group;
          const staleBinding = [exact, group]
            .filter(
              (item): item is FixtureOddsAvailabilityEvidence =>
                !!item &&
                item.state === "active" &&
                Date.parse(item.observedAt) < Date.parse(price.observedAt),
            )
            .sort(
              (a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt),
            )[0];
          if (
            !exact ||
            !group ||
            latestBlocker ||
            exact.state !== "active" ||
            group.state !== "active" ||
            staleBinding ||
            stale
          ) {
            const blocker = latestBlocker ?? staleBinding;
            cells[sportsbookId] = {
              state:
                stale && !latestBlocker && !staleBinding && !missingAvailability
                  ? "stale"
                  : blockingCellState(blocker),
              eligible: false,
              reason:
                stale && !latestBlocker && !staleBinding && !missingAvailability
                  ? "price-stale"
                  : (blocker?.reason ?? "availability-evidence-missing"),
              evidenceAt: blocker?.observedAt ?? null,
              ...(price.point === undefined ? {} : { point: price.point }),
              americanOdds: price.americanOdds,
              observedAt: price.observedAt,
              retrievedAt: price.retrievedAt,
            };
          } else if (
            pointRequired(specification.marketKey) &&
            price.point === undefined
          )
            cells[sportsbookId] = {
              state: "unavailable",
              eligible: false,
              reason: "point-required",
              evidenceAt: price.observedAt,
              americanOdds: price.americanOdds,
              observedAt: price.observedAt,
              retrievedAt: price.retrievedAt,
            };
          else
            cells[sportsbookId] = {
              state: "active",
              eligible: true,
              ...(price.point === undefined ? {} : { point: price.point }),
              americanOdds: price.americanOdds,
              observedAt: price.observedAt,
              retrievedAt: price.retrievedAt,
            };
        }
        return { selectionKey, selectionLabel: label, cells };
      }),
    }));
    const targetSportsbookId = this.targetSportsbookId;
    return {
      projectionState: "ready" as const,
      unavailableReason: null,
      item: {
        ...event,
        oddsComparison: {
          targetSportsbookId,
          // Deliberately NOT gated on `metadata.freshness`. That field is
          // `canonicalFreshness`, which is the canonical event row's
          // `updatedAt` — it advances only when the provider publishes a
          // REVISED schedule listing, so a game listed once and never
          // corrected goes "stale" two hours later and stays there. On
          // 2026-08-13 every MLB game on staging reported a freshness age of
          // 2.2 days against a 7,200s threshold while carrying prices minutes
          // old, and the detail page told every reader the target book's
          // "coverage is incomplete" — blaming the sportsbook for a schedule
          // clock. Price freshness is already enforced where it belongs, per
          // cell: a price older than `freshnessWindowMs` is marked
          // `price-stale` and `eligible: false`, and every required market's
          // target cell must be eligible below.
          targetQualified:
            event.status === "scheduled" &&
            event.metadata.lifecycle.state === "scheduled" &&
            event.metadata.availability === "complete" &&
            markets.every((market) => {
              const required = ["moneyline", "spread", "total"].includes(
                market.marketKey,
              );
              const applicable =
                required ||
                market.selections.some((selection) =>
                  Object.values(selection.cells).some(
                    (cell) => cell.eligible === true,
                  ),
                );
              return (
                !applicable ||
                market.selections.every(
                  (selection) =>
                    selection.cells[targetSportsbookId]?.eligible === true,
                )
              );
            }),
          generatedAt,
          sportsbooks: this.detailSportsbooks.map(({ id, label }) => ({
            id,
            label,
            target: id === targetSportsbookId,
          })),
          markets,
        },
      },
    };
  }
  async list(
    filter: EventListFilter,
    limit: number,
    cursor?: string,
  ): Promise<GamesPage> {
    const first = await this.events.list(filter, limit, cursor);
    const collected = [...first.items];
    const visibleItems = () => {
      const visible = collected.filter(gamePassesMlbParticipantBoundary);
      return filter.sportKey === "mlb" ? collapseEventRows(visible) : visible;
    };
    let items = visibleItems();
    let needsBackfill = items.length !== first.items.length;
    let nextCursor = first.nextCursor;
    const seen = new Set<string>();
    if (cursor) seen.add(cursor);
    let pages = 1;
    const maxPages = 50;
    const maxRows = Math.max(limit * maxPages, maxPages);
    while (needsBackfill && items.length < limit && nextCursor) {
      if (pages >= maxPages || collected.length >= maxRows)
        throw new EventStorageError("games-backfill-limit");
      if (seen.has(nextCursor))
        throw new EventStorageError("games-cursor-cycle");
      seen.add(nextCursor);
      const following = await this.events.list(
        filter,
        Math.max(1, limit - items.length),
        nextCursor,
      );
      pages += 1;
      collected.push(...following.items);
      items = visibleItems();
      needsBackfill = items.length !== collected.length;
      nextCursor = following.nextCursor;
    }
    items = items.slice(0, limit);
    const page: EventPage = {
      ...first,
      items,
      freshness: oldestFreshness(items),
      nextCursor: nextCursor ?? null,
    };
    if (!page.items.length) return { ...page, items: [], freshness: null };
    // Provider id churn advances canonical versions faster than the odds
    // persist path follows, so fresh rows can sit one version behind the
    // event. Each selection reads both versions and the newer row wins.
    const priorVersionEvent = (event: EventPage["items"][number]) =>
      event.version > 1 ? { ...event, version: event.version - 1 } : null;
    const requestedByEvent = page.items.map((event) => {
      const prior = priorVersionEvent(event);
      return this.sportsbookIds.map((sportsbookId) =>
        marketSpecifications(event).map((specification) => ({
          specification,
          keys: specification.selectionKeys.map((selectionKey) =>
            currentKey(
              event,
              specification.marketKey,
              selectionKey,
              sportsbookId,
            ),
          ),
          fallbackKeys: specification.selectionKeys.map((selectionKey) =>
            prior
              ? currentKey(
                  prior,
                  specification.marketKey,
                  selectionKey,
                  sportsbookId,
                )
              : null,
          ),
        })),
      );
    });
    const requested = requestedByEvent
      .flat(2)
      .flatMap(({ keys, fallbackKeys }) => [
        ...keys,
        ...fallbackKeys.filter(
          (key): key is NonNullable<typeof key> => key !== null,
        ),
      ]);
    const validationByKey = new Map<
      string,
      {
        readonly expected: ReturnType<typeof currentKey>;
        readonly event: EventPage["items"][number];
      }
    >();
    requestedByEvent.forEach((books, eventIndex) => {
      const event = page.items[eventIndex]!;
      const prior = priorVersionEvent(event);
      for (const { keys, fallbackKeys } of books.flat()) {
        for (const expected of keys)
          validationByKey.set(expected.pk, { expected, event });
        for (const expected of fallbackKeys)
          if (expected && prior)
            validationByKey.set(expected.pk, { expected, event: prior });
      }
    });
    let rows: readonly unknown[];
    try {
      // The board tolerates evidence a few hundred milliseconds stale, so the
      // list path reads eventually consistent; the detail path keeps strong
      // reads because its read-twice stability check depends on them.
      rows = await this.odds.batchGet(requested, { consistentRead: false });
    } catch (error) {
      throw new EventStorageError("current-odds-read-failed", { cause: error });
    }
    const byKey = new Map<string, unknown>();
    const allowedKeys = new Set(requested.map(({ pk }) => pk));
    for (const row of rows) {
      if (
        !row ||
        typeof row !== "object" ||
        !("pk" in row) ||
        typeof row.pk !== "string"
      )
        throw new EventStorageError("invalid-current-odds-row");
      if (!("sk" in row) || row.sk !== "CURRENT" || !allowedKeys.has(row.pk))
        throw new EventStorageError("unexpected-current-odds-row");
      if (byKey.has(row.pk))
        throw new EventStorageError("duplicate-current-odds-row");
      const validation = validationByKey.get(row.pk);
      if (!validation)
        throw new EventStorageError("unexpected-current-odds-row");
      try {
        validateCurrent(row, validation.expected, validation.event);
      } catch (error) {
        if (isQuarantinableCurrentOddsError(error)) continue;
        throw error;
      }
      byKey.set(row.pk, row);
    }
    const sharpAnchorIndex = this.sportsbookIds.indexOf(
      SHARP_ANCHOR_SPORTSBOOK_ID,
    );
    const joined = page.items.map((event, index) => {
      const candidates = requestedByEvent[index]!.map((groups) => {
        const selections: GameOddsSelectionDto[] = [];
        let requiredAvailable = false;
        for (const { specification, keys, fallbackKeys } of groups) {
          const prior = priorVersionEvent(event);
          // Rows in byKey already passed validation; per selection the
          // newer of the current-version and prior-version rows wins.
          const merged = keys.map((key, selectionIndex) => {
            const primary = byKey.get(key.pk);
            const fallbackKey = fallbackKeys[selectionIndex];
            const fallback =
              fallbackKey && prior ? byKey.get(fallbackKey.pk) : undefined;
            const current =
              primary === undefined
                ? null
                : validateCurrent(primary, key, event);
            const previous =
              fallback === undefined || !fallbackKey || !prior
                ? null
                : validateCurrent(fallback, fallbackKey, prior);
            if (current && previous)
              return Date.parse(previous.retrievedAt) >
                Date.parse(current.retrievedAt)
                ? previous
                : current;
            return current ?? previous ?? undefined;
          });
          const present = merged.filter((row) => row !== undefined).length;
          if (present === 0) {
            if (specification.required) return null;
            continue;
          }
          if (present !== merged.length) {
            if (specification.required) return null;
            continue;
          }
          const market = merged as NonNullable<(typeof merged)[number]>[];
          if (!selectionsShareObservationWindow(market)) {
            if (specification.required) return null;
            continue;
          }
          if (specification.required) requiredAvailable = true;
          selections.push(...market);
        }
        if (!requiredAvailable) return null;
        // Every market that survived above already shares one book and one
        // observation window; a market whose prices drifted outside it was
        // dropped rather than trimmed, so nothing further needs filtering.
        return selections;
      });
      const selected = candidates.find(
        (candidate): candidate is GameOddsSelectionDto[] =>
          candidate !== null && candidate.length > 0,
      );
      // The sharp book's candidate is already merged and validated above;
      // anchor each served selection to its price so fair lines derive from
      // the sharpest market instead of the displayed book's own vig. A
      // point-mismatched spread or total is a different proposition, so only
      // identical lines anchor.
      const sharpCandidate =
        sharpAnchorIndex >= 0 ? candidates[sharpAnchorIndex] : null;
      const anchors = new Map(
        (sharpCandidate ?? []).map((row) => [
          `${row.marketKey} ${row.selectionKey}`,
          row,
        ]),
      );
      const anchored = selected?.map((selection) => {
        const anchor = anchors.get(
          `${selection.marketKey} ${selection.selectionKey}`,
        );
        return anchor && anchor.point === selection.point
          ? { ...selection, sharpAmericanOdds: anchor.americanOdds }
          : selection;
      });
      return {
        ...event,
        odds: anchored
          ? {
              state: "available" as const,
              selections: anchored,
            }
          : { state: "unavailable" as const },
      };
    });
    // The provider occasionally publishes a spurious listing and withdraws it
    // before any book quotes it. Nothing retires the stored event, so it
    // would sit on the schedule forever as an evidence-free "scheduled" game
    // whose start never arrives. A real game always retains its last odds
    // rows after first pitch, so a long-started scheduled game with no odds
    // evidence at all is a withdrawn phantom, not a game.
    const phantomCutoff = this.now().getTime() - WITHDRAWN_EVENT_GRACE_MS;
    const surviving = joined.filter(
      (game) =>
        game.status !== "scheduled" ||
        game.odds.state !== "unavailable" ||
        Date.parse(game.startsAt) > phantomCutoff,
    );
    // Recomputed HERE, against what is actually returned, not against the
    // rows this method started with. Everything between those two points can
    // remove items — the participant boundary, the phantom cutoff above, and
    // the near-duplicate collapse below — and each one leaves the inherited
    // freshness describing rows that are no longer in the page.
    const finalItems = collapseNearDuplicateGames(surviving);
    return {
      ...page,
      items: finalItems,
      freshness: oldestFreshness(finalItems),
    };
  }
}
