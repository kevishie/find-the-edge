import {
  fixtureOddsPartition,
  type GameDisplayDto,
  type GameOddsSelectionDto,
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
}
export interface CurrentOddsReadGateway {
  batchGet(
    keys: readonly { readonly pk: string; readonly sk: "CURRENT" }[],
  ): Promise<readonly unknown[]>;
}

const marketSpecification = (sportKey: string) => {
  if (sportKey === "mlb")
    return {
      marketKey: "moneyline",
      selectionKeys: ["away", "home"] as const,
    };
  if (sportKey === "soccer")
    return {
      marketKey: "three_way_moneyline",
      selectionKeys: ["away", "draw", "home"] as const,
    };
  throw new EventStorageError("unsupported-games-sport");
};

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
    americanOdds: normalized.americanOdds,
    observedAt: normalized.observedAt,
    retrievedAt: normalized.retrievedAt,
  };
};

export class JoinedGamesRepository implements GamesRepository {
  constructor(
    readonly events: EventRepository,
    readonly odds: CurrentOddsReadGateway,
    readonly sportsbookIds: readonly string[] = [
      "draftkings",
      "fanduel",
      "betmgm",
      "williamhill_us",
    ],
  ) {}
  async list(
    filter: EventListFilter,
    limit: number,
    cursor?: string,
  ): Promise<GamesPage> {
    const page = await this.events.list(filter, limit, cursor);
    if (!page.items.length) return { ...page, items: [] };
    const requestedByEvent = page.items.map((event) => {
      const specification = marketSpecification(event.sportKey);
      return this.sportsbookIds.map((sportsbookId) =>
        specification.selectionKeys.map((selectionKey) =>
          currentKey(
            event,
            specification.marketKey,
            selectionKey,
            sportsbookId,
          ),
        ),
      );
    });
    const requested = requestedByEvent.flat(2);
    let rows: readonly unknown[];
    try {
      rows = await this.odds.batchGet(requested);
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
      byKey.set(row.pk, row);
    }
    return {
      ...page,
      items: page.items.map((event, index) => {
        const candidates = requestedByEvent[index]!.map((keys) => ({
          keys,
          rows: keys.map(({ pk }) => byKey.get(pk)),
        }));
        const selected = candidates.find(({ rows }) =>
          rows.every((row) => row !== undefined),
        );
        const validated = selected?.rows.map((row, selectionIndex) =>
          validateCurrent(row, selected.keys[selectionIndex]!, event),
        );
        const coherent =
          validated &&
          validated.every(
            (selection) =>
              selection.sportsbookId === validated[0]!.sportsbookId &&
              selection.observedAt === validated[0]!.observedAt &&
              selection.retrievedAt === validated[0]!.retrievedAt,
          );
        return {
          ...event,
          odds: coherent
            ? {
                state: "available" as const,
                selections: validated,
              }
            : { state: "unavailable" as const },
        };
      }),
    };
  }
}
