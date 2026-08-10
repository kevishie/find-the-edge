export type SportKey = string & { readonly __sportKey: unique symbol };
export * from "./calculation-provenance.js";
export * from "./fixture-odds.js";
export * from "./odds-history.js";
export * from "./paper-evaluation.js";
export * from "./cohort.js";
export * from "./retrospective.js";
export * from "./strategy-experiment.js";
export * from "./paper-pick-run.js";
export * from "./evaluation-attempt.js";
export * from "./opportunity-candidate.js";
export * from "./opportunities/opportunity-lifecycle.js";
export * from "./opportunities/ranked-opportunity.js";
export * from "./provider-status.js";
export * from "./scouting-job.js";
export type EntityId = string & { readonly __entityId: unique symbol };
export type IsoTimestamp = string & { readonly __isoTimestamp: unique symbol };

export type ModuleMaturity = "planned" | "experimental" | "beta" | "production";
export type VerificationStatus =
  "verified" | "unavailable" | "inferred" | "stale" | "conflicting";

export interface VersionRef {
  id: string;
  version: string;
}

export interface EvidenceRef {
  sourceId: string;
  observedAt: IsoTimestamp;
  retrievedAt: IsoTimestamp;
  verification: VerificationStatus;
}

export interface League {
  id: EntityId;
  sportKey: SportKey;
  name: string;
  abbreviation?: string;
}

export interface Season {
  id: EntityId;
  leagueId: EntityId;
  name: string;
  startsAt: IsoTimestamp;
  endsAt: IsoTimestamp;
}

export interface Competition {
  id: EntityId;
  sportKey: SportKey;
  leagueId: EntityId;
  seasonId?: EntityId;
  name: string;
}

export type ParticipantKind = "team" | "player" | "pair" | "field" | "other";

export interface Participant {
  id: EntityId;
  sportKey: SportKey;
  kind: ParticipantKind;
  name: string;
}

export interface Team extends Participant {
  kind: "team";
}

export interface Player extends Participant {
  kind: "player";
  teamId?: EntityId;
}

export interface Venue {
  id: EntityId;
  name: string;
  timezone: string;
  city?: string;
  countryCode?: string;
}

export interface SportDetailPayload {
  schemaId: string;
  schemaVersion: string;
  value: unknown;
}

export interface Event {
  id: EntityId;
  sportKey: SportKey;
  leagueId: EntityId;
  competitionId?: EntityId;
  seasonId?: EntityId;
  participantIds: EntityId[];
  venueId?: EntityId;
  startsAt: IsoTimestamp;
  phase: string;
  detail?: SportDetailPayload;
  evidence: EvidenceRef[];
}

export interface MarketDefinition {
  key: string;
  displayName: string;
  outcomeStructure: "two-way" | "three-way" | "multi-way" | "numeric";
  liveSupported: boolean;
  participantScope: "event" | "team" | "player";
}

export interface Selection {
  key: string;
  marketKey: string;
  participantId?: EntityId;
  label: string;
  line?: number;
}

export interface Sportsbook {
  id: EntityId;
  name: string;
  jurisdiction?: string;
}

export const canonicalMvpMarketKeys = [
  "moneyline",
  "spread",
  "total",
  "btts",
  "team_total",
] as const;
export type CanonicalMvpMarketKey = (typeof canonicalMvpMarketKeys)[number];
export type OddsNormalizationReason =
  | "unknown-bookmaker"
  | "unsupported-market"
  | "unsupported-selection"
  | "incomplete-market"
  | "missing-provider-timestamp"
  | "participant-unavailable"
  | "participant-conflict";
export type CanonicalSelectionKey =
  | `participant:${string}`
  | "draw"
  | "over"
  | "under"
  | "yes"
  | "no"
  | `participant:${string}:over`
  | `participant:${string}:under`;

export function participantSelectionKey(
  participantId: EntityId,
  outcome?: "over" | "under",
): CanonicalSelectionKey {
  const id = String(participantId).trim();
  if (!id) throw new Error("participant-id-invalid");
  return `participant:${encodeURIComponent(id)}${outcome ? `:${outcome}` : ""}` as CanonicalSelectionKey;
}

export interface OddsSnapshot {
  id: EntityId;
  sportKey: SportKey;
  eventId: EntityId;
  marketKey: string;
  selectionKey: string;
  sportsbookId: EntityId;
  americanOdds: number;
  observedAt: IsoTimestamp;
  retrievedAt: IsoTimestamp;
  status: "active" | "suspended" | "closed";
  evidence: EvidenceRef;
}

export interface DecisionVersions {
  sportModule: VersionRef;
  strategy: VersionRef;
  model: VersionRef;
  calculation: VersionRef;
  inputSchema: VersionRef;
  promptBundle?: VersionRef;
}

export interface Recommendation {
  id: EntityId;
  sportKey: SportKey;
  eventId: EntityId;
  marketKey: string;
  selectionKey?: string;
  decision: "play" | "no-bet";
  confidence: number;
  reasons: string[];
  versions: DecisionVersions;
}

export interface Pick {
  id: EntityId;
  recommendationId: EntityId;
  sportKey: SportKey;
  eventId: EntityId;
  marketKey: string;
  selectionKey: string;
  placedAmericanOdds?: number;
  versions: DecisionVersions;
}

export interface EventResult {
  eventId: EntityId;
  status: "final" | "cancelled" | "postponed";
  detail?: SportDetailPayload;
  evidence: EvidenceRef[];
}

export type CompletedEventState =
  "final" | "postponed" | "cancelled" | "no-contest";
export type ResultScoreScope =
  "regulation" | "overtime" | "extra-innings" | "unknown";
export interface ParticipantResultScore {
  readonly participantId: EntityId;
  readonly score: number;
}
/** Immutable authoritative result evidence. This is intentionally separate from grading. */
export interface CompletedEventResultObservation {
  readonly id: string;
  readonly providerId: string;
  readonly providerEventId: string;
  readonly canonicalEventId: EntityId;
  readonly canonicalEventVersion: number;
  readonly sportKey: SportKey;
  readonly leagueKey: string;
  readonly state: CompletedEventState;
  readonly scoreScope: ResultScoreScope;
  readonly scores?: readonly ParticipantResultScore[];
  readonly detail?: SportDetailPayload;
  readonly providerRevision: ProviderRevision;
  readonly providerTimestamp: IsoTimestamp;
  readonly retrievedAt: IsoTimestamp;
  readonly sourceProvenance: string;
}
export interface UnresolvedResultObservation {
  readonly id: string;
  readonly providerId: string;
  readonly providerEventId: string;
  readonly sportKey: SportKey;
  readonly leagueKey: string;
  readonly state: CompletedEventState;
  readonly scoreScope: ResultScoreScope;
  readonly scores?: readonly {
    readonly providerParticipantId: string;
    readonly score: number;
  }[];
  readonly detail?: SportDetailPayload;
  readonly providerRevision: ProviderRevision;
  readonly providerTimestamp: IsoTimestamp;
  readonly retrievedAt: IsoTimestamp;
  readonly sourceProvenance: string;
  readonly reason: "event-unmapped" | "scope-mismatch";
}

export interface PickGrade {
  result: "won" | "lost" | "push" | "void" | "ungraded";
  reason: string;
}

export interface ProviderHealth {
  providerId: string;
  capability: string;
  status: "healthy" | "degraded" | "unavailable";
  checkedAt: IsoTimestamp;
  freshnessSeconds?: number;
  message?: string;
}
export * from "./paper-grade.js";

/** Immutable, provider-neutral public betting evidence. Missing values stay missing. */
export interface BettingSplitObservation {
  readonly id: string;
  readonly providerId: string;
  readonly providerEventId: string;
  readonly canonicalEventId: string;
  readonly canonicalEventVersion: number;
  readonly sportKey: SportKey;
  readonly leagueKey: string;
  readonly marketKey: string;
  readonly selectionKey: string;
  readonly point?: number;
  readonly americanOdds?: number;
  readonly betPercent?: number;
  readonly moneyPercent?: number;
  readonly betCount?: number;
  readonly moneyAmount?: number;
  readonly providerTimestamp: IsoTimestamp;
  readonly retrievedAt: IsoTimestamp;
  readonly scope?: string;
}

export interface BettingSplitGap {
  readonly providerId: string;
  readonly providerEventId: string;
  readonly reason:
    | "event-unmapped"
    | "event-ambiguous"
    | "market-ambiguous"
    | "selection-ambiguous"
    | "line-ambiguous";
  readonly retrievedAt: IsoTimestamp;
}

export type FeedCapability = "schedule" | "odds" | "results";
export type LeagueAllowlistState = "enabled" | "planned" | "disabled";
export type FeedMaturity = "development" | "production";
export type FeedUnsupportedReason =
  | "league-unregistered"
  | "league-planned"
  | "league-disabled"
  | "capability-unavailable"
  | "market-unsupported";
export type FeedCadence =
  | { readonly mode: "interval"; readonly seconds: number }
  | { readonly mode: "manual"; readonly seconds?: never };
export interface FeedQuotaEstimate {
  readonly requestsPerRun: number;
  readonly requestsPerDay: number;
}
export interface FeedCoverageKey {
  readonly sportKey: SportKey;
  readonly leagueKey: string;
  readonly capability: FeedCapability;
}
interface FeedPolicyBase extends FeedCoverageKey {
  readonly leagueName: string;
}
interface ActivePolicyBase extends FeedPolicyBase {
  readonly allowlistState: "enabled";
  readonly providerId: string;
  readonly maturity: FeedMaturity;
  readonly cadence: FeedCadence;
  readonly quotaEstimate: FeedQuotaEstimate;
  readonly active: true;
  readonly unsupportedReason?: never;
}
export type ActiveFeedPolicy =
  | (ActivePolicyBase & {
      readonly capability: "odds";
      readonly supportedMarketKeys: readonly [string, ...string[]];
    })
  | (ActivePolicyBase & {
      readonly capability: "schedule" | "results";
      readonly supportedMarketKeys: readonly [];
    });
interface InactivePolicyBase extends FeedPolicyBase {
  readonly supportedMarketKeys: readonly [];
  readonly active: false;
  readonly providerId?: never;
  readonly maturity?: never;
  readonly cadence?: never;
  readonly quotaEstimate?: never;
}
export type InactiveFeedPolicy =
  | (InactivePolicyBase & {
      readonly allowlistState: "planned";
      readonly unsupportedReason: "league-planned";
    })
  | (InactivePolicyBase & {
      readonly allowlistState: "disabled";
      readonly unsupportedReason: "league-disabled";
    });
export type FeedCoverageRegistration = ActiveFeedPolicy | InactiveFeedPolicy;
export interface FeedCoverageRequest extends FeedCoverageKey {
  readonly marketKeys?: readonly string[];
}
export interface SupportedFeedCoverage extends FeedCoverageKey {
  readonly supported: true;
  readonly providerId: string;
  readonly maturity: FeedMaturity;
  readonly cadence: FeedCadence;
  readonly supportedMarketKeys: readonly string[];
  readonly quotaEstimate: FeedQuotaEstimate;
}
export interface UnsupportedFeedCoverage extends FeedCoverageKey {
  readonly supported: false;
  readonly reason: FeedUnsupportedReason;
  readonly allowlistState?: LeagueAllowlistState;
}
export type FeedCoverageResolution =
  SupportedFeedCoverage | UnsupportedFeedCoverage;
export interface FeedCoverageReportEntry extends FeedCoverageKey {
  readonly leagueName: string;
  readonly allowlistState: LeagueAllowlistState;
  readonly supported: boolean;
  readonly providerId?: string;
  readonly maturity?: FeedMaturity;
  readonly cadence?: FeedCadence;
  readonly supportedMarketKeys: readonly string[];
  readonly quotaEstimate?: FeedQuotaEstimate;
  readonly reason?: FeedUnsupportedReason;
}
export interface FeedCoverageReport {
  readonly version: string;
  readonly entries: readonly FeedCoverageReportEntry[];
}

export type EventStatus =
  "scheduled" | "postponed" | "cancelled" | "started" | "completed" | "unknown";
export * from "./event-metadata";
import type { EventMetadataAssessment } from "./event-metadata";
export interface ProviderRevision {
  readonly providerId: string;
  readonly authorityRank: number;
  readonly updatedAt: IsoTimestamp;
  readonly sequence: number;
  readonly token: string;
}
export interface CanonicalEvent extends Event {
  readonly leagueKey: string;
  readonly participantLabels?: readonly string[];
  readonly status: EventStatus;
  readonly revisions: Readonly<Record<string, ProviderRevision>>;
  readonly updatedAt: IsoTimestamp;
  readonly candidateIdentity: string;
  readonly authoritativeRevision?: ProviderRevision;
  readonly bootstrapRevision?: ProviderRevision;
  readonly version: number;
}
export interface EventDisplayDto {
  readonly id: string;
  readonly version: number;
  readonly sportKey: string;
  readonly leagueKey: string;
  readonly competition: { readonly key: string; readonly state: "provisional" };
  readonly participants: readonly {
    readonly id: string;
    readonly label: string;
  }[];
  readonly startsAt: string;
  readonly eastern: {
    readonly timeZone: "America/New_York";
    readonly calendarDay: string;
    readonly display: string;
  };
  readonly status: EventStatus;
  readonly freshness: string | null;
  readonly metadata: EventMetadataAssessment;
}

export interface GameOddsSelectionDto {
  readonly marketKey: string;
  readonly selectionKey: string;
  readonly selectionLabel?: string;
  readonly sportsbookId: string;
  readonly sportsbookLabel?: string;
  readonly point?: number;
  readonly americanOdds: number;
  /** Pinnacle's price for the same selection, when collected — the sharp
   * anchor no-vig fair lines derive from. */
  readonly sharpAmericanOdds?: number;
  readonly observedAt: string;
  readonly retrievedAt: string;
}

export interface GameDisplayDto extends EventDisplayDto {
  readonly odds:
    | {
        readonly state: "available";
        readonly selections: readonly GameOddsSelectionDto[];
      }
    | { readonly state: "unavailable" };
}

export type GameOddsCellDto =
  | {
      readonly state: "active";
      readonly eligible: true;
      readonly point?: number;
      readonly americanOdds: number;
      readonly observedAt: string;
      readonly retrievedAt: string;
    }
  | ({
      readonly state: "stale" | "suspended" | "partial" | "unavailable";
      readonly eligible: false;
      readonly reason: string;
      readonly evidenceAt: string | null;
    } & (
      | {
          readonly point?: number;
          readonly americanOdds: number;
          readonly observedAt: string;
          readonly retrievedAt: string;
        }
      | {
          readonly point?: never;
          readonly americanOdds?: never;
          readonly observedAt?: never;
          readonly retrievedAt?: never;
        }
    ));

export interface GameOddsComparisonDto extends EventDisplayDto {
  readonly oddsComparison: {
    readonly targetSportsbookId: string;
    readonly targetQualified: boolean;
    readonly generatedAt: string;
    readonly sportsbooks: readonly {
      readonly id: string;
      readonly label: string;
      readonly target: boolean;
    }[];
    readonly markets: readonly {
      readonly marketKey: string;
      readonly selections: readonly {
        readonly selectionKey: string;
        readonly selectionLabel: string;
        readonly cells: Readonly<Record<string, GameOddsCellDto>>;
      }[];
    }[];
  };
}

const normalizedParticipantAlias = (label: string) =>
  label
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("en-US")
    .replace(/[ø]/g, "o")
    .replace(/[ł]/g, "l")
    .replace(/[^a-z0-9]/g, "");

/**
 * Exact MLB membership catalogue. Nicknames are deliberate product aliases;
 * lookup is exact after cosmetic Unicode/case/punctuation normalization.
 */
export const MLB_PARTICIPANT_CATALOGUE = [
  ["angels", ["Los Angeles Angels", "Angels"]],
  ["astros", ["Houston Astros", "Astros"]],
  [
    "athletics",
    ["Athletics", "A's", "Oakland A's", "Sacramento A's", "Oakland Athletics"],
  ],
  ["bluejays", ["Toronto Blue Jays", "Blue Jays"]],
  ["braves", ["Atlanta Braves", "Braves"]],
  ["brewers", ["Milwaukee Brewers", "Brewers"]],
  ["cardinals", ["St. Louis Cardinals", "Cardinals"]],
  ["cubs", ["Chicago Cubs", "Cubs"]],
  [
    "diamondbacks",
    ["Arizona Diamondbacks", "Diamondbacks", "D-backs", "Arizona D-backs"],
  ],
  ["dodgers", ["Los Angeles Dodgers", "Dodgers"]],
  ["giants", ["San Francisco Giants", "Giants"]],
  ["guardians", ["Cleveland Guardians", "Guardians"]],
  ["mariners", ["Seattle Mariners", "Mariners"]],
  ["marlins", ["Miami Marlins", "Marlins"]],
  ["mets", ["New York Mets", "Mets"]],
  ["nationals", ["Washington Nationals", "Nationals"]],
  ["orioles", ["Baltimore Orioles", "Orioles"]],
  ["padres", ["San Diego Padres", "Padres"]],
  ["phillies", ["Philadelphia Phillies", "Phillies"]],
  ["pirates", ["Pittsburgh Pirates", "Pirates"]],
  ["rangers", ["Texas Rangers", "Rangers"]],
  ["rays", ["Tampa Bay Rays", "Rays"]],
  ["redsox", ["Boston Red Sox", "Red Sox"]],
  ["reds", ["Cincinnati Reds", "Reds"]],
  ["rockies", ["Colorado Rockies", "Rockies"]],
  ["royals", ["Kansas City Royals", "Royals"]],
  ["tigers", ["Detroit Tigers", "Tigers"]],
  ["twins", ["Minnesota Twins", "Twins"]],
  [
    "whitesox",
    ["Chicago White Sox", "White Sox", "Chicago WS", "Chi White Sox", "CWS"],
  ],
  ["yankees", ["New York Yankees", "Yankees"]],
] as const;

export type MlbParticipantKey = (typeof MLB_PARTICIPANT_CATALOGUE)[number][0];

export function buildExactParticipantAliasMap<K extends string>(
  entries: readonly (readonly [K, readonly string[]])[],
): ReadonlyMap<string, K> {
  const aliases = new Map<string, K>();
  for (const [key, labels] of entries)
    for (const label of labels) {
      const normalized = normalizedParticipantAlias(label);
      const existing = aliases.get(normalized);
      if (existing !== undefined && existing !== key)
        throw new Error("participant-alias-collision");
      aliases.set(normalized, key);
    }
  return aliases;
}

const MLB_PARTICIPANT_ALIASES = buildExactParticipantAliasMap(
  MLB_PARTICIPANT_CATALOGUE,
);
const MLB_PARTICIPANT_LABELS = new Map<MlbParticipantKey, string>(
  MLB_PARTICIPANT_CATALOGUE.map(([key, aliases]) => [key, aliases[0]]),
);

export function resolveMlbParticipantKey(
  label: string,
): MlbParticipantKey | null {
  return MLB_PARTICIPANT_ALIASES.get(normalizedParticipantAlias(label)) ?? null;
}

export function resolveMlbMatchup(
  awayLabel: string,
  homeLabel: string,
): {
  readonly awayKey: MlbParticipantKey;
  readonly homeKey: MlbParticipantKey;
} | null {
  const awayKey = resolveMlbParticipantKey(awayLabel);
  const homeKey = resolveMlbParticipantKey(homeLabel);
  return awayKey && homeKey && awayKey !== homeKey
    ? { awayKey, homeKey }
    : null;
}

export function canonicalMlbParticipantLabel(key: MlbParticipantKey): string {
  return MLB_PARTICIPANT_LABELS.get(key)!;
}

export function gamePassesMlbParticipantBoundary(input: {
  readonly leagueKey: string;
  readonly participants: readonly { readonly label: string }[];
}): boolean {
  return (
    input.leagueKey !== "mlb" ||
    (input.participants.length === 2 &&
      resolveMlbMatchup(
        input.participants[0]!.label,
        input.participants[1]!.label,
      ) !== null)
  );
}

export function canonicalDisplayParticipantKey(
  sportKey: string,
  label: string,
): string {
  let compact = normalizedParticipantAlias(label);
  if (sportKey === "soccer") {
    compact = compact.replace(/(?:footballclub|futbolclub|fc|cf|sc)$/u, "");
    return compact;
  }
  if (sportKey !== "mlb") return compact;
  return resolveMlbParticipantKey(label) ?? compact;
}

const displayDuplicateKey = (game: GameDisplayDto) =>
  JSON.stringify([
    game.sportKey,
    game.leagueKey,
    game.participants.map(({ label }) =>
      canonicalDisplayParticipantKey(game.sportKey, label),
    ),
  ]);

const finiteInstant = (value: string | null) => {
  const parsed = Date.parse(value ?? "");
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
};

const lifecycleRank: Readonly<Record<EventStatus, number>> = {
  unknown: 0,
  scheduled: 1,
  postponed: 2,
  cancelled: 3,
  started: 4,
  completed: 5,
};

const preferredDisplayDuplicate = (
  left: GameDisplayDto,
  right: GameDisplayDto,
) => {
  // Existing SharpAPI-owned events have accumulated authoritative versions;
  // legacy one-off fallback rows are version 1. Authority outranks whether an
  // obsolete row happens to retain an old price.
  if (left.version !== right.version)
    return left.version > right.version ? left : right;
  const leftEvidence = finiteInstant(left.metadata.freshness.evidenceAt);
  const rightEvidence = finiteInstant(right.metadata.freshness.evidenceAt);
  if (leftEvidence !== rightEvidence)
    return leftEvidence > rightEvidence ? left : right;
  if (lifecycleRank[left.status] !== lifecycleRank[right.status])
    return lifecycleRank[left.status] > lifecycleRank[right.status]
      ? left
      : right;
  const leftOdds = left.odds.state === "available" ? 1 : 0;
  const rightOdds = right.odds.state === "available" ? 1 : 0;
  if (leftOdds !== rightOdds) return leftOdds > rightOdds ? left : right;
  return left.id.localeCompare(right.id) <= 0 ? left : right;
};

/** Collapses legacy cross-provider aliases after pagination/status partitions
 * are combined. Clusters are deterministic and anchored to the earliest start
 * so tolerance is never widened transitively. */
export function collapseNearDuplicateGames(
  games: readonly GameDisplayDto[],
): readonly GameDisplayDto[] {
  const sorted = games
    .filter(gamePassesMlbParticipantBoundary)
    .sort(
      (left, right) =>
        left.startsAt.localeCompare(right.startsAt) ||
        left.id.localeCompare(right.id),
    );
  const clusters = new Map<
    string,
    { anchor: number; winner: GameDisplayDto }[]
  >();
  for (const game of sorted) {
    const key = displayDuplicateKey(game);
    const candidates = clusters.get(key) ?? [];
    const startsAt = Date.parse(game.startsAt);
    const nearby = candidates.findIndex(
      ({ anchor }) => Math.abs(startsAt - anchor) <= 120_000,
    );
    if (nearby < 0) candidates.push({ anchor: startsAt, winner: game });
    else
      candidates[nearby] = {
        ...candidates[nearby]!,
        winner: preferredDisplayDuplicate(candidates[nearby]!.winner, game),
      };
    clusters.set(key, candidates);
  }
  const retained = new Set(
    [...clusters.values()].flatMap((entries) =>
      entries.map(({ winner }) => winner.id),
    ),
  );
  return sorted.filter(({ id }) => retained.has(id));
}
export interface CanonicalEventBootstrap {
  readonly id: EntityId;
  readonly sportKey: SportKey;
  readonly leagueKey: string;
  readonly leagueId: EntityId;
  readonly participantIds: readonly [EntityId, EntityId, ...EntityId[]];
  readonly participantLabels: readonly [string, string, ...string[]];
  readonly startsAt: IsoTimestamp;
  readonly phase: string;
  readonly status: EventStatus;
  readonly normalizedIdentity: string;
  readonly canonicalKey: string;
  readonly revision: ProviderRevision;
}
export interface ProviderEventMapping {
  readonly id: string;
  readonly providerId: string;
  readonly providerEventId: string;
  readonly canonicalEventId: EntityId;
  readonly sportKey: SportKey;
  readonly leagueKey: string;
  readonly createdAt: IsoTimestamp;
  readonly bindingKind: "source" | "alias";
}
export interface EventHistoryEntry {
  readonly id: string;
  readonly eventId: EntityId;
  readonly providerId: string;
  readonly revision: ProviderRevision;
  readonly changedAt: IsoTimestamp;
  readonly previousStartsAt: IsoTimestamp;
  readonly startsAt: IsoTimestamp;
  readonly previousStatus: EventStatus;
  readonly status: EventStatus;
}
export interface UnresolvedEventMapping {
  readonly id: string;
  readonly providerId: string;
  readonly providerEventId: string;
  readonly sportKey: SportKey;
  readonly leagueKey: string;
  readonly normalizedIdentity: string;
  readonly reason: "no-candidate" | "ambiguous-candidates";
  readonly candidateEventIds: readonly EntityId[];
  readonly observations: readonly {
    readonly observedAt: IsoTimestamp;
    readonly reason: "no-candidate" | "ambiguous-candidates";
    readonly candidateEventIds: readonly EntityId[];
  }[];
  readonly version: number;
}
export type CheckpointPosition =
  | { readonly state: "start" }
  | { readonly state: "cursor"; readonly cursor: string }
  | { readonly state: "terminal" };
export interface IngestionCheckpoint {
  readonly key: string;
  readonly providerId: string;
  readonly sportKey: SportKey;
  readonly leagueKey: string;
  readonly checkpointScope: string;
  readonly windowStart: IsoTimestamp;
  readonly windowEnd: IsoTimestamp;
  readonly position: CheckpointPosition;
  readonly continuationCycle: number;
  readonly continuationCount: number;
  readonly bootstrapRequestCount: number;
  readonly bootstrapQuotaUsed?: number;
  readonly bootstrapCursor?: string;
  readonly bootstrapPageOrdinal?: number;
  readonly bootstrapCursorHistory?: readonly string[];
  readonly bootstrapCursorChain?: string;
  readonly bootstrapCompletedPositionDigest?: string;
  readonly bootstrapReservation?: {
    readonly id: string;
    readonly status: "reserved" | "succeeded" | "failed";
    readonly cursor?: string;
    readonly pageOrdinal: number;
    readonly identities: readonly string[];
    readonly authorityRank: number;
    readonly requestDigest: string;
    readonly claimedAt?: IsoTimestamp;
    readonly leaseUntil?: IsoTimestamp;
    readonly responseRef?: string;
    readonly responseDigest?: string;
    readonly providerRequests?: number;
    readonly quotaUsed?: number;
  };
  readonly cursorHistory?: readonly string[];
  readonly cursorChain?: string;
  readonly lastRunId: string;
  readonly updatedAt: IsoTimestamp;
}
export interface UpcomingEventIngestionCommand {
  readonly attemptId: string;
  readonly checkpointScope: string;
  readonly sportKey: SportKey;
  readonly leagueKey: string;
  readonly windowStart: IsoTimestamp;
  readonly windowEnd: IsoTimestamp;
  readonly pageLimit: number;
  readonly maxPages: number;
  readonly expectedContinuation?: {
    readonly cycle: number;
    readonly epoch: number;
    readonly position: CheckpointPosition;
  };
}
export interface IngestionCounters {
  readonly providerRequests: number;
  readonly pages: number;
  readonly bootstrapped: number;
  readonly repaired: number;
  readonly updated: number;
  readonly skipped: number;
  readonly unresolved: number;
  readonly quotaUsed: number;
}
export type IngestionFailureCode =
  | "invalid-command"
  | "coverage-unavailable"
  | "adapter-unavailable"
  | "invalid-provider-output"
  | "provider-failed"
  | "continuation-delivery-failed"
  | "continuation-delivery-required"
  | "persistence-failed"
  | "checkpoint-conflict"
  | "cursor-stalled"
  | "retry-required"
  | "run-record-failed";
export interface LeagueIngestionRun {
  readonly id: string;
  readonly attemptId: string;
  readonly sportKey: SportKey;
  readonly leagueKey: string;
  readonly providerId?: string;
  readonly startedAt: IsoTimestamp;
  readonly finishedAt: IsoTimestamp;
  readonly status:
    | "succeeded"
    | "continuation-queued"
    | "delivery-required"
    | "no-op"
    | "retry-required"
    | "failed";
  readonly counters: IngestionCounters;
  readonly finalPosition?: CheckpointPosition;
  readonly failureCode?: IngestionFailureCode;
  readonly runRecordPersisted: boolean;
  readonly durationMs: number;
  readonly checkpointKey?: string;
}
