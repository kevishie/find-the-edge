export const ODDS_HISTORY_OBSERVATION_STATES = [
  "active",
  "suspended",
  "unavailable",
] as const;
export type OddsHistoryObservationState =
  (typeof ODDS_HISTORY_OBSERVATION_STATES)[number];

export const ODDS_HISTORY_COVERAGE_STATUSES = [
  "available",
  "unavailable",
] as const;
export type OddsHistoryCoverageStatus =
  (typeof ODDS_HISTORY_COVERAGE_STATUSES)[number];
export type OddsHistoryMarkerScope = "page" | "loaded";

export interface OddsHistoryObservationDto {
  readonly observationId: string;
  readonly state: OddsHistoryObservationState;
  readonly point?: number;
  readonly americanOdds: number;
  readonly impliedProbability: number;
  readonly observedAt: string;
  readonly retrievedAt: string;
  /** First observation in this loaded page-series. Recompute after merging pages. */
  readonly isOpening: boolean;
  /** Last observation in this loaded page-series. Recompute after merging pages. */
  readonly isCurrent: boolean;
}

export interface OddsHistorySeriesDto {
  readonly marketKey: string;
  readonly selectionKey: string;
  readonly selectionLabel: string;
  readonly sportsbookId: string;
  readonly sportsbookLabel: string;
  readonly points: readonly OddsHistoryObservationDto[];
}

export interface OddsHistoryCoverageDto {
  readonly sportsbookId: string;
  readonly sportsbookLabel: string;
  /** Whether this requested book has an observation in this loaded page. */
  readonly status: OddsHistoryCoverageStatus;
}

export interface OddsHistoryPageDto {
  readonly eventId: string;
  readonly generatedAt: string;
  readonly markerScope: OddsHistoryMarkerScope;
  readonly series: readonly OddsHistorySeriesDto[];
  readonly coverage: readonly OddsHistoryCoverageDto[];
  readonly nextCursor: string | null;
}
