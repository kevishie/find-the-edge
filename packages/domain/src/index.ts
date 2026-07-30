export type SportKey = string & { readonly __sportKey: unique symbol };
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
