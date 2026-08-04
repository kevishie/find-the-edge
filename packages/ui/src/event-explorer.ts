import type { EventStatus, GameDisplayDto } from "@find-the-edge/domain";

export const EVENT_EXPLORER_STATUSES = [
  "all",
  "scheduled",
  "postponed",
  "cancelled",
  "started",
  "completed",
  "unknown",
] as const;
export type EventExplorerStatus = (typeof EVENT_EXPLORER_STATUSES)[number];
export const EVENT_EXPLORER_SORT_FIELDS = [
  "kickoff",
  "matchup",
  "competition",
  "lifecycle",
  "freshness",
] as const;
export type EventExplorerSortField =
  (typeof EVENT_EXPLORER_SORT_FIELDS)[number];
export type EventExplorerSortDirection = "asc" | "desc";

export interface EventExplorerFilters {
  readonly competition: string;
  readonly query: string;
  readonly sort: EventExplorerSortField;
  readonly direction: EventExplorerSortDirection;
}

export const normalizeEventSearch = (value: string): string =>
  value
    .normalize("NFKC")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("en-US")
    .replace(/\s+/g, " ")
    .trim();

const safeLabel = (value: unknown, fallback = "Unknown"): string => {
  if (typeof value !== "string") return fallback;
  const normalized = [...value.normalize("NFKC")]
    .filter((character) => {
      const code = character.charCodeAt(0);
      return code > 31 && code !== 127;
    })
    .join("")
    .trim();
  return normalized.slice(0, 160) || fallback;
};

export const eventMatchupLabel = (
  event: Pick<GameDisplayDto, "participants">,
): string =>
  event.participants.map(({ label }) => safeLabel(label)).join(" vs ");

export const eventCompetitionOptions = (
  events: readonly Pick<GameDisplayDto, "competition">[],
): readonly { readonly value: string; readonly label: string }[] =>
  [...new Set(events.map(({ competition }) => competition.key))]
    .sort((a, b) => a.localeCompare(b, "en-US"))
    .map((key) => ({ value: key, label: safeLabel(key) }));

const lifecycleRank: Record<EventStatus, number> = {
  scheduled: 0,
  started: 1,
  postponed: 2,
  completed: 3,
  cancelled: 4,
  unknown: 5,
};
const freshnessRank = { current: 0, stale: 1, unavailable: 2 } as const;

export const filterAndSortEvents = <T extends GameDisplayDto>(
  events: readonly T[],
  filters: EventExplorerFilters,
): readonly T[] => {
  const query = normalizeEventSearch(filters.query);
  const filtered = events.filter((event) => {
    if (filters.competition && event.competition.key !== filters.competition)
      return false;
    if (!query) return true;
    return event.participants.some(({ label }) =>
      normalizeEventSearch(label).includes(query),
    );
  });
  const direction = filters.direction === "asc" ? 1 : -1;
  return filtered
    .map((event, index) => ({ event, index }))
    .sort((left, right) => {
      const a = left.event;
      const b = right.event;
      let comparison = 0;
      if (filters.sort === "kickoff")
        comparison = a.startsAt.localeCompare(b.startsAt);
      else if (filters.sort === "matchup")
        comparison = eventMatchupLabel(a).localeCompare(
          eventMatchupLabel(b),
          "en-US",
        );
      else if (filters.sort === "competition")
        comparison = a.competition.key.localeCompare(
          b.competition.key,
          "en-US",
        );
      else if (filters.sort === "lifecycle")
        comparison = lifecycleRank[a.status] - lifecycleRank[b.status];
      else
        comparison =
          freshnessRank[a.metadata.freshness.state] -
          freshnessRank[b.metadata.freshness.state];
      return comparison === 0
        ? a.id.localeCompare(b.id, "en-US") || left.index - right.index
        : comparison * direction;
    })
    .map(({ event }) => event);
};
