import {
  canonicalMlbParticipantLabel,
  resolveMlbParticipantKey,
  sha256Hex,
  type IsoTimestamp,
  type OddsNormalizationReason,
  type SportKey,
} from "@find-the-edge/domain";
import { normalizeSportsbook } from "@find-the-edge/config";

import type { ProviderCapability, ProviderDescriptor } from "./index";

export const SHARP_API_PROVIDER_ID = "sharpapi";
export const SHARP_API_BASE_URL = "https://api.sharpapi.io/api/v1";
export const SHARP_API_SECRET_NAME_SUFFIX = "sharpapi";

export type SharpApiDisabledReason =
  | "contract-unverified"
  | "not-entitled"
  | "coverage-unverified"
  | "operator-disabled";

export interface SharpApiCoverageDecision {
  readonly sportKey: SportKey;
  readonly leagueKey: string;
  readonly capability: Extract<ProviderCapability, "odds" | "public-betting">;
  readonly enabled: boolean;
  readonly marketKeys: readonly string[];
  readonly reason?: SharpApiDisabledReason;
}

export interface SharpApiActivationConfig {
  readonly enabled: boolean;
  readonly contractVerified: boolean;
  readonly licensingVerified: boolean;
  readonly coverage: readonly SharpApiCoverageDecision[];
  readonly splitFreshnessSeconds: number;
  readonly quotaReserve: number;
  readonly cooldownSeconds: number;
  readonly recoverySuccesses: number;
}

export interface SharpApiLeague {
  readonly sportKey: SportKey;
  readonly leagueKey:
    "mlb" | "nfl" | "mls" | "epl" | "liga-mx" | "uefa-champions-league";
  /** Exact, catalog-verified SharpAPI league identity. Never fuzzy matched. */
  readonly providerLeague: string;
  /**
   * Extra provider catalogues whose ODDS belong to games this league already
   * schedules. Leagues Cup is the case: MLS clubs play Liga MX clubs, our
   * canonical event is bootstrapped from the `mls` listing (whose only book
   * we do not approve), and the liquidity sits in a `leagues_cup` listing
   * with a different provider id and a different uuid — the catalogues share
   * no identity at all.
   *
   * Deliberately NOT a league of its own. Cross-league binding is refused by
   * the mapping scope check and by the odds snapshot's own condition, so
   * these rows must persist under THIS leagueKey; and a separate league
   * would mint a second canonical event per fixture, which is the
   * duplicate-game defect fixed on 2026-08-11.
   */
  readonly secondaryOddsProviderLeagues?: readonly string[];
  readonly moneylineMarket: "moneyline";
}

export const sharpApiLeagues: readonly SharpApiLeague[] = [
  {
    sportKey: "mlb" as SportKey,
    leagueKey: "mlb",
    providerLeague: "MLB",
    moneylineMarket: "moneyline",
  },
  {
    sportKey: "soccer" as SportKey,
    leagueKey: "mls",
    providerLeague: "MLS",
    // Every MLS fixture on the board through August is Leagues Cup, and none
    // of them can be priced from the MLS catalogue alone.
    secondaryOddsProviderLeagues: ["leagues_cup"],
    moneylineMarket: "moneyline",
  },
  {
    // Football's moneyline is two-way: a tie is rare enough that books price
    // it as a push rather than a third outcome, so this takes the MLB shape
    // rather than soccer's. It is also the largest league the provider
    // carries — 1,358 events against MLB's 431 — which is exactly why the
    // pricing horizon had to land before it did.
    sportKey: "football" as SportKey,
    leagueKey: "nfl",
    providerLeague: "nfl",
    moneylineMarket: "moneyline",
  },
  {
    sportKey: "soccer" as SportKey,
    leagueKey: "epl",
    providerLeague: "england_-_premier_league",
    moneylineMarket: "moneyline",
  },
  {
    sportKey: "soccer" as SportKey,
    leagueKey: "liga-mx",
    providerLeague: "mexico_-_liga_mx",
    moneylineMarket: "moneyline",
  },
  {
    sportKey: "soccer" as SportKey,
    leagueKey: "uefa-champions-league",
    providerLeague: "uefa_-_champions_league",
    moneylineMarket: "moneyline",
  },
];

export const sharpApiLeagueByKey = (leagueKey: string): SharpApiLeague => {
  const league = sharpApiLeagues.find((entry) => entry.leagueKey === leagueKey);
  if (!league) throw new SharpApiError("configuration");
  return league;
};

export interface SharpApiAccount {
  readonly tier: string;
  readonly features: readonly string[];
  readonly requestsPerMinute: number;
  readonly maxBooks: number;
  readonly streamingEnabled: boolean;
  readonly responseMetadata?: SharpApiResponseMetadata;
}

export interface SharpApiSourceShapeEvidence {
  readonly sourceFields?: readonly string[];
  readonly sourceFieldCount?: number;
  readonly sourceFieldsTruncated?: true;
  readonly sourceSchemaHash?: string;
}

export interface SharpApiCatalogSport extends SharpApiSourceShapeEvidence {
  readonly providerSportId: string;
  readonly displayName: string;
  readonly numericalId?: number;
  readonly eventCount: number;
  readonly liveCount: number;
  readonly providerLeagueIds: readonly string[];
}

export interface SharpApiCatalogLeague extends SharpApiSourceShapeEvidence {
  readonly providerLeagueId: string;
  readonly displayName: string;
  readonly numericalId?: number;
  readonly providerSportId: string;
  readonly eventCount: number;
  readonly liveCount: number;
}

export interface SharpApiLandingQuarantine {
  readonly rowIndex: number;
  readonly reason:
    | "invalid-row"
    | "duplicate-provider-id"
    | "unrepresentable-filter-id"
    | "provider-filter-rejected";
  readonly endpoint: "sports" | "leagues" | "events" | "odds";
  readonly providerRecordId?: string;
  readonly sourceFields: readonly string[];
  readonly sourceFieldCount?: number;
  readonly sourceFieldsTruncated?: true;
  readonly sourceSchemaHash?: string;
  readonly providerCode?: string;
  readonly httpStatus?: number;
  readonly requestId?: string;
}

export interface SharpApiCatalogSnapshot {
  readonly sports: readonly SharpApiCatalogSport[];
  readonly leagues: readonly SharpApiCatalogLeague[];
  readonly quarantines: readonly SharpApiLandingQuarantine[];
  readonly sourceRows: number;
  /** Exact provider generation token. SharpAPI emits nanosecond ISO instants;
   * do not round this before comparing pages from a mutable snapshot. */
  readonly providerUpdatedAt?: string;
  readonly retrievedAt: IsoTimestamp;
  readonly responseMetadata?: SharpApiResponseMetadata;
}

export interface SharpApiUniversalEvent extends SharpApiSourceShapeEvidence {
  readonly providerEventId: string;
  readonly providerEventUuid?: string;
  readonly externalIds: Readonly<Record<string, string>>;
  readonly sport: string;
  readonly league: string;
  readonly homeParticipant?: string;
  readonly awayParticipant?: string;
  readonly startsAt: IsoTimestamp;
  readonly status: string;
  readonly isLive: boolean;
  readonly marketKeys: readonly string[];
  readonly sportsbookIds: readonly string[];
  readonly sourceWarnings?: readonly string[];
}

export interface SharpApiUniversalOddsRecord extends SharpApiSourceShapeEvidence {
  readonly providerPriceId: string;
  readonly providerEventId: string;
  readonly providerEventUuid?: string;
  readonly externalEventId?: string;
  readonly sport: string;
  readonly league: string;
  readonly sportsbook: string;
  readonly homeParticipant?: string;
  readonly awayParticipant?: string;
  readonly marketType: string;
  readonly providerMarketId?: string;
  readonly selection: string;
  readonly selectionType: string;
  readonly providerSelectionId?: string;
  readonly teamSide?: string;
  readonly line?: number;
  readonly americanOdds?: number;
  readonly decimalOdds?: number;
  readonly impliedProbability?: number;
  readonly eventStartsAt?: IsoTimestamp;
  readonly providerTimestamp: IsoTimestamp;
  readonly isLive: boolean;
  readonly isActive?: boolean;
  readonly isMainLine?: boolean;
  readonly isAlternateLine?: boolean;
  readonly isPlayerProp?: boolean;
  readonly isStalePregamePrice?: boolean;
  readonly isImpossibleScoreline?: boolean;
  readonly maxBet?: number;
  readonly volume24h?: number;
  readonly sourceWarnings?: readonly string[];
}

export interface SharpApiUniversalPage<T> {
  readonly records: readonly T[];
  readonly quarantines: readonly SharpApiLandingQuarantine[];
  readonly sourceRows: number;
  readonly hasMore: boolean;
  readonly requestedOffset?: number;
  readonly nextOffset?: number;
  readonly nextCursor?: string;
  readonly providerTotal?: number;
  /** Exact provider generation token. See SharpApiCatalogSnapshot. */
  readonly providerUpdatedAt?: string;
  readonly retrievedAt: IsoTimestamp;
  readonly responseMetadata?: SharpApiResponseMetadata;
}

export interface SharpApiUniversalEventFilter {
  readonly sport: string;
  readonly leagues?: readonly string[];
}

/** Provider-enforced request window. This is deliberately not the customer's
 * subscription quota: SharpAPI's account response currently exposes RPM, not
 * durable monthly credits. Missing headers remain unknown. */
export interface SharpApiRateWindow {
  readonly limit?: number;
  readonly remaining?: number;
  readonly resetsAt?: IsoTimestamp;
}

export interface SharpApiResponseMetadata {
  readonly rateWindow: SharpApiRateWindow;
  readonly retryAt?: IsoTimestamp;
}

const boundedHeaderInteger = (value: string | null) => {
  if (value === null || !/^\d{1,16}$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
};

const RATE_METADATA_PAST_GRACE_MS = 5 * 60 * 1_000;
const RATE_METADATA_FUTURE_HORIZON_MS = 24 * 60 * 60 * 1_000;

const boundedRateIsoFromMilliseconds = (value: number, nowMs: number) => {
  // ECMAScript Date clips outside +/-8.64e15ms. Provider headers are
  // untrusted, so an otherwise safe integer must not be allowed to throw a
  // RangeError while handling a response or a 429. SharpAPI rate windows are
  // minute-scale; retain a five-minute race grace and a conservative 24-hour
  // operational horizon so corrupt headers cannot create a durable pause.
  if (
    !Number.isFinite(value) ||
    !Number.isFinite(nowMs) ||
    Math.abs(value) > 8_640_000_000_000_000 ||
    value < nowMs - RATE_METADATA_PAST_GRACE_MS ||
    value > nowMs + RATE_METADATA_FUTURE_HORIZON_MS
  )
    return undefined;
  try {
    return new Date(value).toISOString() as IsoTimestamp;
  } catch {
    return undefined;
  }
};

export const parseSharpApiResponseMetadata = (
  headers: Headers,
  now = new Date(),
): SharpApiResponseMetadata => {
  const nowMs = now.getTime();
  const limit = boundedHeaderInteger(
    headers.get("x-ratelimit-limit") ?? headers.get("ratelimit-limit"),
  );
  const remaining = boundedHeaderInteger(
    headers.get("x-ratelimit-remaining") ?? headers.get("ratelimit-remaining"),
  );
  const rawReset =
    headers.get("x-ratelimit-reset") ?? headers.get("ratelimit-reset");
  const resetNumber = boundedHeaderInteger(rawReset);
  const resetMs =
    resetNumber === undefined
      ? rawReset
        ? Date.parse(rawReset)
        : Number.NaN
      : resetNumber > 10_000_000_000
        ? resetNumber
        : resetNumber > nowMs / 2_000
          ? resetNumber * 1_000
          : nowMs + resetNumber * 1_000;
  const retryAfter = headers.get("retry-after");
  const retrySeconds = boundedHeaderInteger(retryAfter);
  const retryMs =
    retrySeconds !== undefined
      ? nowMs + retrySeconds * 1_000
      : retryAfter
        ? Date.parse(retryAfter)
        : Number.NaN;
  const resetsAt = boundedRateIsoFromMilliseconds(resetMs, nowMs);
  const retryAt = boundedRateIsoFromMilliseconds(retryMs, nowMs);
  return {
    rateWindow: {
      ...(limit === undefined ? {} : { limit }),
      ...(remaining === undefined ? {} : { remaining }),
      ...(resetsAt ? { resetsAt } : {}),
    },
    ...(retryAt ? { retryAt } : {}),
  };
};

export interface SharpApiPrice {
  readonly providerPriceId: string;
  readonly marketKey: "moneyline" | "spread" | "total" | "btts" | "team_total";
  readonly providerMarketType: string;
  readonly providerMarketId: string;
  readonly selectionKey:
    "away" | "draw" | "home" | "over" | "under" | "yes" | "no";
  readonly participantSide?: "away" | "home";
  readonly outcomeStructure?: "two-way" | "three-way";
  readonly selectionLabel: string;
  readonly providerSelectionId: string;
  readonly point?: number;
  readonly americanOdds: number;
  readonly decimalOdds: number;
  readonly impliedProbability: number;
  readonly publicBetPercent?: number;
  readonly deepLink?: string;
  readonly isLive: boolean;
  readonly isMainLine: boolean;
  readonly isAlternateLine: boolean;
  readonly isPlayerProp: boolean;
  readonly isStalePregamePrice: boolean;
  readonly isActive?: boolean;
  readonly isSuspended?: boolean;
  readonly observedAt: IsoTimestamp;
  /** Local retrieval boundary for durable replay; never sourced from provider input. */
  readonly retrievedAt?: IsoTimestamp;
}

export interface SharpApiBookmaker {
  readonly id: string;
  readonly label: string;
  /** Bounded provider wire identifiers retained for contract verification. */
  readonly providerSportsbookIds?: readonly string[];
  readonly prices: readonly SharpApiPrice[];
}

export interface SharpApiEvent {
  readonly providerEventId: string;
  readonly providerEventUuid: string;
  readonly awayTeam: string;
  readonly homeTeam: string;
  readonly awayClubKey?: string;
  readonly homeClubKey?: string;
  readonly startsAt: IsoTimestamp;
  readonly bookmakers: readonly SharpApiBookmaker[];
}

export interface SharpApiOddsPage {
  readonly events: readonly SharpApiEvent[];
  readonly rejections?: readonly SharpApiNormalizationRejection[];
  readonly hasMore: boolean;
  readonly nextCursor?: string;
  readonly retrievedAt: IsoTimestamp;
  readonly eventRetrievedAt?: Readonly<Record<string, IsoTimestamp>>;
  readonly responseMetadata?: SharpApiResponseMetadata;
}

export interface SharpApiNormalizationRejection {
  readonly providerId: typeof SHARP_API_PROVIDER_ID;
  readonly reason: OddsNormalizationReason;
  readonly auditId: string;
  readonly providerEventId?: string;
  readonly sportsbookId?: string;
  readonly participantBoundaryReason?:
    "participant-out-of-scope" | "same-club-matchup";
}

export interface SharpApiScheduleEvent {
  readonly providerEventId: string;
  readonly providerEventUuid?: string;
  readonly awayTeam: string;
  readonly homeTeam: string;
  readonly awayClubKey?: string;
  readonly homeClubKey?: string;
  readonly startsAt: IsoTimestamp;
  readonly status: "scheduled";
}
export interface SharpApiSchedulePage {
  readonly events: readonly SharpApiScheduleEvent[];
  readonly exclusions?: readonly SharpApiScheduleExclusion[];
  readonly hasMore: boolean;
  readonly nextOffset?: number;
  readonly retrievedAt: IsoTimestamp;
  readonly responseMetadata?: SharpApiResponseMetadata;
}

export interface SharpApiScheduleExclusion {
  readonly providerEventId: string;
  readonly reason:
    | "participant-out-of-scope"
    | "same-club-matchup"
    | "catalogue-derivative"
    | "not-upcoming";
  readonly auditId: string;
}

const derivativeLabelKind = (value: string) => {
  const label = value.normalize("NFKC").trim().replace(/\s+/g, " ");
  if (/(?:\s-\s|:\s*)player props?$/i.test(label)) return "player-props";
  if (
    /(?:\s-\s|:\s*)(?:first|last|extra|(?:\d+(?:st|nd|rd|th)))(?:\s+(?:one|two|three|four|five|six|seven|eight|nine|\d+))?\s+innings?$/i.test(
      label,
    )
  )
    return "period";
  if (/\b(?:team )?total (?:runs?|goals?|points?)$/i.test(label))
    return "team-total";
  if (
    /^(?:american|national|eastern|western|world)?\s*(?:league|conference|division|series|championship)\s+(?:winner|champion)$/i.test(
      label,
    )
  )
    return "award";
  // A trailing "+" marks the provider's secondary catalogue, not a club.
  // SharpAPI publishes an `mls+` catalogue whose participants are labelled
  // "Rapids +", "Earthquakes +" and whose fixtures are USL sides — Charleston
  // against Hartford, Charlotte against Tampa Bay. Twenty-one of them were
  // bootstrapped as canonical events for 2026-08-13 alone, and that partition
  // reaching 61 events against a board limit of 50 is what stopped the soccer
  // board being materialised at all: its page always needed a cursor, and
  // `materializeBoards` skips any board that does.
  if (/\s\+$/.test(label)) return "plus-catalogue";
  return null;
};

/** Only paired, recognizable catalogue labels are excluded. A single unusual
 * but legitimate team name is never enough to classify a matchup. */
export const isSharpDerivativeMatchup = (
  awayTeam: string,
  homeTeam: string,
) => {
  const awayKind = derivativeLabelKind(awayTeam);
  return awayKind !== null && derivativeLabelKind(homeTeam) !== null;
};

const canonicalSharpParticipants = (
  league: SharpApiLeague,
  awayTeam: string,
  homeTeam: string,
) => {
  if (league.leagueKey !== "mlb")
    return { kind: "accepted" as const, awayTeam, homeTeam };
  const awayClubKey = resolveMlbParticipantKey(awayTeam);
  const homeClubKey = resolveMlbParticipantKey(homeTeam);
  if (!awayClubKey || !homeClubKey)
    return {
      kind: "rejected" as const,
      reason: "participant-out-of-scope" as const,
    };
  if (awayClubKey === homeClubKey)
    return {
      kind: "rejected" as const,
      reason: "same-club-matchup" as const,
    };
  return {
    kind: "accepted" as const,
    awayTeam: canonicalMlbParticipantLabel(awayClubKey),
    homeTeam: canonicalMlbParticipantLabel(homeClubKey),
    awayClubKey,
    homeClubKey,
  };
};

/** Cursor identity is carried separately so durable orchestration never guesses page progress. */
export interface SharpApiControlPlanePage extends SharpApiOddsPage {
  readonly pageToken: string;
}

export interface SharpApiSplitSelection {
  readonly selectionKey: "away" | "home" | "over" | "under";
  readonly point?: number;
  readonly americanOdds?: number;
  readonly betPercent?: number;
  readonly moneyPercent?: number;
}

export interface SharpApiSplitMarket {
  readonly marketKey: "spread" | "total" | "moneyline";
  readonly selections: readonly SharpApiSplitSelection[];
}

export interface SharpApiSplitEvent {
  readonly providerEventId: string;
  readonly sport: string;
  readonly league: string;
  readonly sportsbookId: string;
  readonly awayTeam: string;
  readonly homeTeam: string;
  readonly providerTimestamp: IsoTimestamp;
  readonly markets: readonly SharpApiSplitMarket[];
}

export interface SharpApiSplitPage {
  readonly items: readonly SharpApiSplitEvent[];
  readonly hasMore: boolean;
  readonly nextOffset?: number;
  readonly retrievedAt: IsoTimestamp;
  readonly responseMetadata?: SharpApiResponseMetadata;
}

export interface SharpApiSplitHistoryPage {
  readonly items: readonly SharpApiSplitEvent[];
  readonly retrievedAt: IsoTimestamp;
  readonly responseMetadata?: SharpApiResponseMetadata;
}

export class SharpApiError extends Error {
  override readonly name = "SharpApiError";
  constructor(
    readonly code:
      | "configuration"
      | "unauthorized"
      | "not-entitled"
      | "rate-limited"
      | "provider-request-ambiguous"
      | "provider-unavailable"
      | "provider-rejected"
      | "invalid-response",
    readonly retryable = false,
    readonly retryAt?: IsoTimestamp,
    readonly stage?: string,
    /** Stable SharpAPI error-envelope code. Never match the prose message. */
    readonly providerCode?: string,
    readonly httpStatus?: number,
    /** Bounded provider trace identifier documented for support requests. */
    readonly requestId?: string,
  ) {
    super(code);
  }
}

const wellFormedUtf16 = (value: string) => {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
};

const canonical = (value: unknown, maximum = 256): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= maximum &&
  value === value.trim() &&
  wellFormedUtf16(value);
const encodedBytes = (value: string) =>
  new TextEncoder().encode(value).byteLength;
const encodedKeyComponent = (value: string) => {
  try {
    return encodeURIComponent(value);
  } catch {
    return undefined;
  }
};
const storageKeyComponent = (
  value: unknown,
  maximumCharacters: number,
): value is string => {
  if (!canonical(value, maximumCharacters)) return false;
  if (
    [...value].some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || (code >= 127 && code <= 159);
    })
  )
    return false;
  return encodedKeyComponent(value) !== undefined;
};
const landingKeyFits = (
  prefix: string,
  components: readonly string[],
  maximumBytes: number,
) => {
  const encoded = components.map(encodedKeyComponent);
  return (
    encoded.every((value): value is string => value !== undefined) &&
    encodedBytes(`${prefix}${encoded.join("#")}`) <= maximumBytes
  );
};
const LANDING_SLOT_PREFIX = "SLOT#0#";
const landingSportFits = (
  sport: unknown,
  kind: "event" | "odds",
): sport is string =>
  storageKeyComponent(sport, 64) &&
  landingKeyFits(
    `PROVIDER_LANDING#SHARPAPI#${kind === "event" ? "EVENT" : "ODDS"}#`,
    [sport],
    2_048,
  );
const landingRecordIdFits = (recordId: unknown, prefix: string) =>
  storageKeyComponent(recordId, 512) &&
  landingKeyFits(`${LANDING_SLOT_PREFIX}${prefix}`, [recordId], 1_024);
const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);
const safeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value);
const providerInstant = (value: unknown): value is IsoTimestamp => {
  if (!canonical(value, 40)) return false;
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(?:Z|[+-](\d{2}):(\d{2}))$/.exec(
      value,
    );
  if (!match) return false;
  const [, year, month, day, hour, minute, second, zoneHour, zoneMinute] =
    match;
  const y = Number(year);
  const m = Number(month);
  const d = Number(day);
  const leapYear = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
  const daysInMonth = [
    31,
    leapYear ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];
  const offsetHour = zoneHour === undefined ? 0 : Number(zoneHour);
  const offsetMinute = zoneMinute === undefined ? 0 : Number(zoneMinute);
  return (
    m >= 1 &&
    m <= 12 &&
    d >= 1 &&
    d <= daysInMonth[m - 1]! &&
    Number(hour) <= 23 &&
    Number(minute) <= 59 &&
    (second === undefined || Number(second) <= 59) &&
    offsetHour <= 14 &&
    offsetMinute <= 59 &&
    (offsetHour < 14 || offsetMinute === 0) &&
    Number.isFinite(Date.parse(value))
  );
};
const instant = providerInstant;
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const iso = (value: string) => new Date(value).toISOString() as IsoTimestamp;
const MAX_RESPONSE_BYTES = 10_000_000;
const MAX_CATALOG_ROWS = 50_000;
const UNIVERSAL_EVENTS_PAGE_LIMIT = 200;
const UNIVERSAL_EVENTS_MAX_OFFSET = 5_000;
// SharpAPI permits up to 200 Odds rows, but the unfiltered staging response at
// that maximum exceeded the bounded request timeout. A 25-row opaque-cursor
// page is provider-supported and completed with materially better throughput.
const UNIVERSAL_ODDS_PAGE_LIMIT = 25;
const MAX_LANDING_VALUE_BYTES = 300_000;
const MAX_SOURCE_FIELDS = 64;
const MAX_SOURCE_VALUE_NODES = 100_000;
const UNSAFE_DYNAMO_NUMBER = Symbol("unsafe-dynamo-number");

const decimalLexemeIdentity = (source: string) => {
  const match = /^-?(0|[1-9]\d*)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(source);
  if (!match) return undefined;
  const integerDigits = match[1]!;
  const digits = `${integerDigits}${match[2] ?? ""}`;
  const firstSignificant = digits.search(/[1-9]/);
  if (firstSignificant === -1) return "0";
  let lastSignificant = digits.length - 1;
  while (digits[lastSignificant] === "0") lastSignificant -= 1;
  const explicitExponent = Number(match[3] ?? "0");
  if (!Number.isFinite(explicitExponent)) return undefined;
  const scientificExponent =
    explicitExponent + integerDigits.length - firstSignificant - 1;
  return `${source.startsWith("-") ? "-" : ""}${digits.slice(
    firstSignificant,
    lastSignificant + 1,
  )}e${scientificExponent}`;
};

/** DynamoDB accepts at most 38 significant digits and non-zero magnitudes
 * from 1E-130 through 9.999...E+125. Validate the source token before
 * JavaScript can round an over-precise provider value into an apparently safe
 * Number. Trailing zeroes do not increase the stored value's precision. */
const dynamoNumberLexemeSafe = (source: string) => {
  const match = /^-?(0|[1-9]\d*)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(source);
  if (!match) return false;
  const integerDigits = match[1]!;
  const digits = `${integerDigits}${match[2] ?? ""}`;
  const firstSignificant = digits.search(/[1-9]/);
  if (firstSignificant === -1) return true;
  let lastSignificant = digits.length - 1;
  while (digits[lastSignificant] === "0") lastSignificant -= 1;
  if (lastSignificant - firstSignificant + 1 > 38) return false;

  const signedExponent = match[3] ?? "0";
  const exponentNegative = signedExponent.startsWith("-");
  const exponentDigits = signedExponent.replace(/^[+-]/, "").replace(/^0+/, "");
  // Any exponent with more than six non-zero digits is far outside the
  // supported range, even after the bounded mantissa adjustment.
  if (exponentDigits.length > 6) return false;
  const explicitExponent =
    (exponentNegative ? -1 : 1) * Number(exponentDigits || "0");
  const scientificExponent =
    explicitExponent + integerDigits.length - firstSignificant - 1;
  if (scientificExponent < -130 || scientificExponent > 125) return false;

  // The default AWS document marshaller rejects integer Numbers outside the
  // JavaScript safe range even when DynamoDB itself could represent them.
  // Refuse those source values before a later batch write can throw.
  const parsed = Number(source);
  return (
    (!Number.isInteger(parsed) || Number.isSafeInteger(parsed)) &&
    decimalLexemeIdentity(source) === decimalLexemeIdentity(String(parsed))
  );
};

const dynamoNumber = (value: unknown): value is number =>
  finite(value) &&
  (!Number.isInteger(value) || Number.isSafeInteger(value)) &&
  dynamoNumberLexemeSafe(String(value));

const providerNumber = (value: unknown): value is number => {
  if (!dynamoNumber(value)) return false;
  if (Number.isInteger(value)) return true;
  const identity = decimalLexemeIdentity(String(value));
  const significantDigits = identity?.match(/^-?(\d+)e/)?.[1]?.length;
  // A direct parser caller has no raw JSON token to compare after JavaScript
  // has rounded it. Fifteen decimal digits are the portable exact-input
  // guarantee; HTTP callers get the stricter raw-token round-trip check too.
  return significantDigits !== undefined && significantDigits <= 15;
};

/** Provider rows are untrusted generic JSON. Walk them iteratively so novel
 * nested values cannot smuggle a DynamoDB-invalid number into landing and so
 * direct parser callers remain memory-bounded even without the HTTP body cap. */
const dynamoJsonValueSafe = (input: unknown) => {
  const pending: unknown[] = [input];
  const visited = new Set<object>();
  let visitedValues = 0;
  while (pending.length > 0) {
    const value = pending.pop();
    visitedValues += 1;
    if (visitedValues > MAX_SOURCE_VALUE_NODES) return false;
    if (value === UNSAFE_DYNAMO_NUMBER) return false;
    if (typeof value === "number") {
      if (!dynamoNumber(value)) return false;
      continue;
    }
    if (
      value === null ||
      value === undefined ||
      typeof value === "string" ||
      typeof value === "boolean"
    )
      continue;
    if (!Array.isArray(value) && !record(value)) return false;
    if (visited.has(value)) return false;
    visited.add(value);
    const children: readonly unknown[] = Array.isArray(value)
      ? (value as unknown[])
      : Object.values(value);
    if (
      children.length >
      MAX_SOURCE_VALUE_NODES - visitedValues - pending.length
    )
      return false;
    for (const child of children) pending.push(child);
  }
  return true;
};

type SharpApiEndpoint =
  | "account"
  | "sports"
  | "leagues"
  | "universal-events"
  | "universal-odds"
  | "odds"
  | "focused-odds"
  | "schedule"
  | "splits"
  | "splits-history";

const invalidResponse = (endpoint: SharpApiEndpoint, stage: string) =>
  new SharpApiError(
    "invalid-response",
    false,
    undefined,
    `${endpoint}:${stage}`,
  );

const rethrowInvalidResponseAt = (
  error: unknown,
  endpoint: SharpApiEndpoint,
): never => {
  if (
    error instanceof SharpApiError &&
    error.code === "invalid-response" &&
    !error.stage
  )
    throw invalidResponse(endpoint, "unknown");
  throw error;
};

const isEmptyProviderErrorSentinel = (value: unknown) =>
  value === null ||
  value === undefined ||
  value === false ||
  value === "" ||
  (Array.isArray(value) && value.length === 0) ||
  (record(value) && Object.keys(value).length === 0);

const providerEnvelopeIssue = (
  payload: Record<string, unknown>,
): "declared-error" | "malformed" | undefined => {
  if (
    Object.prototype.hasOwnProperty.call(payload, "success") &&
    typeof payload["success"] !== "boolean"
  )
    return "malformed";
  if (payload["success"] === false) return "declared-error";
  return ["error", "errors"].some(
    (key) =>
      Object.prototype.hasOwnProperty.call(payload, key) &&
      !isEmptyProviderErrorSentinel(payload[key]),
  )
    ? "declared-error"
    : undefined;
};

const assertProviderEnvelope = (
  payload: Record<string, unknown>,
  endpoint: SharpApiEndpoint,
) => {
  const issue = providerEnvelopeIssue(payload);
  if (issue === "declared-error")
    throw new SharpApiError(
      "provider-rejected",
      false,
      undefined,
      `${endpoint}:provider-error`,
    );
  if (issue === "malformed") throw invalidResponse(endpoint, "envelope");
};

const boundedJson = async (
  response: Response,
  endpoint: SharpApiEndpoint,
): Promise<unknown> => {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES)
    throw invalidResponse(endpoint, "content-length");
  let raw = "";
  if (response.body) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const decode = (chunk?: Uint8Array, stream = false) => {
      try {
        return decoder.decode(chunk, { stream });
      } catch {
        throw invalidResponse(endpoint, "utf8");
      }
    };
    let bytes = 0;
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw invalidResponse(endpoint, "body-size");
      }
      try {
        raw += decode(chunk.value, true);
      } catch (error) {
        await reader.cancel().catch(() => undefined);
        throw error;
      }
    }
    raw += decode();
  } else {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > MAX_RESPONSE_BYTES)
      throw invalidResponse(endpoint, "body-size");
    try {
      raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw invalidResponse(endpoint, "utf8");
    }
  }
  try {
    type JsonParseContext = { readonly source?: string };
    const parseJsonWithSource = JSON.parse as (
      text: string,
      reviver: (
        key: string,
        value: unknown,
        context?: JsonParseContext,
      ) => unknown,
    ) => unknown;
    return parseJsonWithSource(raw, (_key, value, context) =>
      typeof value === "number" &&
      typeof context?.source === "string" &&
      !dynamoNumberLexemeSafe(context.source)
        ? UNSAFE_DYNAMO_NUMBER
        : value,
    );
  } catch {
    throw invalidResponse(endpoint, "json");
  }
};

const request = async (
  path: string,
  endpoint: SharpApiEndpoint,
  apiKey: string,
  fetcher: typeof fetch,
  timeoutMs = 10_000,
): Promise<{
  readonly payload: unknown;
  readonly metadata: SharpApiResponseMetadata;
}> => {
  if (!canonical(apiKey, 512)) throw new SharpApiError("configuration");
  if (!safeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 30_000)
    throw new SharpApiError("configuration");
  let response: Response;
  try {
    response = await fetcher(`${SHARP_API_BASE_URL}${path}`, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: "application/json", "X-API-Key": apiKey },
    });
  } catch {
    // A transport failure after dispatch has unknown provider-side outcome. It
    // must be reconciled rather than blindly repeated.
    throw new SharpApiError("provider-request-ambiguous", false);
  }
  if (!response.ok) {
    const observedRequestId = response.headers.get("x-request-id");
    const requestId = storageKeyComponent(observedRequestId, 128)
      ? observedRequestId
      : undefined;
    if ([401, 403].includes(response.status)) {
      let body: unknown;
      try {
        body = await boundedJson(response, endpoint);
      } catch {
        throw new SharpApiError(
          "unauthorized",
          false,
          undefined,
          `${endpoint}:http-${response.status}`,
          undefined,
          response.status,
          requestId,
        );
      }
      const error = record(body) && record(body["error"]) ? body["error"] : {};
      const providerCode = storageKeyComponent(error["code"], 64)
        ? error["code"]
        : undefined;
      if (error["code"] === "tier_restricted")
        throw new SharpApiError(
          "not-entitled",
          false,
          undefined,
          `${endpoint}:http-${response.status}`,
          providerCode,
          response.status,
          requestId,
        );
      throw new SharpApiError(
        "unauthorized",
        false,
        undefined,
        `${endpoint}:http-${response.status}`,
        providerCode,
        response.status,
        requestId,
      );
    }
    if (response.status === 429) {
      const metadata = parseSharpApiResponseMetadata(response.headers);
      let retryAt = metadata.retryAt ?? metadata.rateWindow.resetsAt;
      let providerCode: string | undefined;
      try {
        const body = await boundedJson(response, endpoint);
        const error =
          record(body) && record(body["error"]) ? body["error"] : {};
        if (storageKeyComponent(error["code"], 64))
          providerCode = error["code"];
        if (!retryAt) {
          const observedAt = Date.now();
          if (
            safeInteger(error["retryAfter"]) &&
            error["retryAfter"] >= 0 &&
            error["retryAfter"] <= 86_400
          )
            retryAt = new Date(
              observedAt + error["retryAfter"] * 1_000,
            ).toISOString() as IsoTimestamp;
          else if (safeInteger(error["retry_after"])) {
            const candidate = error["retry_after"];
            if (
              candidate >= observedAt - 5 * 60_000 &&
              candidate <= observedAt + 24 * 60 * 60_000
            )
              retryAt = new Date(candidate).toISOString() as IsoTimestamp;
          }
        }
      } catch {
        // A malformed rate-limit body cannot override bounded header truth.
      }
      throw new SharpApiError(
        "rate-limited",
        true,
        retryAt,
        `${endpoint}:http-429`,
        providerCode,
        429,
        requestId,
      );
    }
    let providerCode: string | undefined;
    try {
      const body = await boundedJson(response, endpoint);
      const error = record(body) && record(body["error"]) ? body["error"] : {};
      if (storageKeyComponent(error["code"], 64)) providerCode = error["code"];
    } catch {
      // HTTP status remains authoritative when a proxy/provider sends a
      // malformed error body. Never inspect or retain the prose message.
    }
    throw new SharpApiError(
      response.status >= 500 ? "provider-unavailable" : "provider-rejected",
      response.status >= 500,
      undefined,
      `${endpoint}:http-${response.status}`,
      providerCode,
      response.status,
      requestId,
    );
  }
  return {
    payload: await boundedJson(response, endpoint),
    metadata: parseSharpApiResponseMetadata(response.headers),
  };
};

export function parseSharpApiAccount(input: unknown): SharpApiAccount {
  if (!record(input)) throw invalidResponse("account", "envelope");
  assertProviderEnvelope(input, "account");
  if (!record(input["data"])) throw invalidResponse("account", "envelope");
  const data = input["data"];
  const rate = data["rate_limit"];
  const streaming = data["streaming"];
  if (
    !canonical(data["tier"], 32) ||
    !Array.isArray(data["features"]) ||
    !data["features"].every((feature) => canonical(feature, 64)) ||
    !record(rate) ||
    !safeInteger(rate["requests_per_minute"]) ||
    !safeInteger(rate["max_books"]) ||
    !record(streaming) ||
    typeof streaming["enabled"] !== "boolean"
  )
    throw invalidResponse("account", "data");
  return {
    tier: data["tier"],
    features: [...data["features"]] as string[],
    requestsPerMinute: rate["requests_per_minute"],
    maxBooks: rate["max_books"],
    streamingEnabled: streaming["enabled"],
  };
}

const sourceValueKind = (value: unknown) =>
  value === null ? "null" : Array.isArray(value) ? "array" : typeof value;

const sourceShapeEvidence = (
  value: unknown,
): SharpApiSourceShapeEvidence & {
  readonly sourceFields: readonly string[];
  readonly sourceFieldCount: number;
  readonly sourceSchemaHash: string;
} => {
  if (!record(value))
    return {
      sourceFields: [],
      sourceFieldCount: 0,
      sourceSchemaHash: sha256Hex(
        JSON.stringify([["$", sourceValueKind(value)]]),
      ),
    };
  const keys = Object.keys(value).sort();
  const sourceFields = keys
    .filter((key) => storageKeyComponent(key, 64))
    .slice(0, MAX_SOURCE_FIELDS);
  return {
    sourceFields,
    sourceFieldCount: keys.length,
    ...(sourceFields.length === keys.length
      ? {}
      : { sourceFieldsTruncated: true as const }),
    sourceSchemaHash: sha256Hex(
      JSON.stringify(keys.map((key) => [key, sourceValueKind(value[key])])),
    ),
  };
};

const landingValueFits = (value: Readonly<Record<string, unknown>>) =>
  dynamoJsonValueSafe(value) &&
  encodedBytes(JSON.stringify(value)) <= MAX_LANDING_VALUE_BYTES;

const quarantineRow = (
  value: unknown,
  rowIndex: number,
  endpoint: SharpApiLandingQuarantine["endpoint"],
  reason: SharpApiLandingQuarantine["reason"] = "invalid-row",
): SharpApiLandingQuarantine => ({
  rowIndex,
  reason,
  endpoint,
  ...(record(value) && canonical(value["id"], 256)
    ? { providerRecordId: value["id"] }
    : {}),
  ...sourceShapeEvidence(value),
});

const nonNegativeInteger = (value: unknown): value is number =>
  safeInteger(value) && value >= 0;

const boundedStringArray = (
  value: unknown,
  maximumItems: number,
  maximumLength = 256,
): readonly string[] | undefined =>
  Array.isArray(value) &&
  value.length <= maximumItems &&
  value.every((item) => canonical(item, maximumLength)) &&
  new Set(value).size === value.length
    ? [...value]
    : undefined;

const boundedExternalIds = (
  value: unknown,
): Readonly<Record<string, string>> => {
  if (!record(value)) return {};
  const entries = Object.entries(value)
    .filter(
      (entry): entry is [string, string] =>
        canonical(entry[0], 64) && canonical(entry[1], 256),
    )
    .sort(([left], [right]) => left.localeCompare(right))
    .slice(0, 128);
  return Object.fromEntries(entries);
};

const sanitizedStringArray = (
  value: unknown,
  maximumItems: number,
  maximumLength = 256,
) =>
  Array.isArray(value)
    ? [
        ...new Set(
          value.filter((item): item is string =>
            canonical(item, maximumLength),
          ),
        ),
      ].slice(0, maximumItems)
    : [];

const optionalStringWarning = (
  value: unknown,
  maximumLength: number,
  warning: string,
) =>
  value !== undefined &&
  value !== null &&
  value !== "" &&
  !canonical(value, maximumLength)
    ? warning
    : null;

const catalogEnvelope = (
  input: unknown,
  endpoint: Extract<SharpApiEndpoint, "sports" | "leagues">,
) => {
  if (!record(input)) throw invalidResponse(endpoint, "envelope");
  assertProviderEnvelope(input, endpoint);
  if (!Array.isArray(input["data"]) || input["data"].length > MAX_CATALOG_ROWS)
    throw invalidResponse(endpoint, "data");
  if (input["updated_at"] !== undefined && !instant(input["updated_at"]))
    throw invalidResponse(endpoint, "updated-at");
  return input;
};

export function parseSharpApiSportsCatalog(
  input: unknown,
  retrievedAt: IsoTimestamp,
): Omit<SharpApiCatalogSnapshot, "leagues" | "responseMetadata"> {
  const payload = catalogEnvelope(input, "sports");
  const sports: SharpApiCatalogSport[] = [];
  const quarantines: SharpApiLandingQuarantine[] = [];
  const ids = new Set<string>();
  (payload["data"] as unknown[]).forEach((value, rowIndex) => {
    if (!record(value) || !dynamoJsonValueSafe(value)) {
      quarantines.push(quarantineRow(value, rowIndex, "sports"));
      return;
    }
    const leagues = boundedStringArray(value["leagues"], 5_000, 128);
    if (
      !storageKeyComponent(value["id"], 64) ||
      value["id"].includes(",") ||
      !landingKeyFits(`${LANDING_SLOT_PREFIX}SPORT#`, [value["id"]], 1_024) ||
      !canonical(value["name"], 128) ||
      !nonNegativeInteger(value["event_count"]) ||
      !nonNegativeInteger(value["live_count"]) ||
      !leagues ||
      leagues.some(
        (league) =>
          !storageKeyComponent(league, 128) ||
          !landingKeyFits(
            `${LANDING_SLOT_PREFIX}LEAGUE#`,
            [value["id"] as string, league],
            1_024,
          ),
      ) ||
      (value["numerical_id"] !== undefined &&
        !nonNegativeInteger(value["numerical_id"]))
    ) {
      quarantines.push(quarantineRow(value, rowIndex, "sports"));
      return;
    }
    if (ids.has(value["id"])) {
      quarantines.push(
        quarantineRow(value, rowIndex, "sports", "duplicate-provider-id"),
      );
      return;
    }
    const sport: SharpApiCatalogSport = {
      providerSportId: value["id"],
      displayName: value["name"],
      ...(value["numerical_id"] === undefined
        ? {}
        : { numericalId: value["numerical_id"] }),
      eventCount: value["event_count"],
      liveCount: value["live_count"],
      providerLeagueIds: leagues,
      ...sourceShapeEvidence(value),
    };
    if (
      !landingValueFits(sport as unknown as Readonly<Record<string, unknown>>)
    ) {
      quarantines.push(quarantineRow(value, rowIndex, "sports"));
      return;
    }
    ids.add(value["id"]);
    sports.push(sport);
  });
  return {
    sports,
    quarantines,
    sourceRows: (payload["data"] as unknown[]).length,
    ...(instant(payload["updated_at"])
      ? { providerUpdatedAt: payload["updated_at"] }
      : {}),
    retrievedAt,
  };
}

export function parseSharpApiLeaguesCatalog(
  input: unknown,
  retrievedAt: IsoTimestamp,
): Omit<SharpApiCatalogSnapshot, "sports" | "responseMetadata"> {
  const payload = catalogEnvelope(input, "leagues");
  const leagues: SharpApiCatalogLeague[] = [];
  const quarantines: SharpApiLandingQuarantine[] = [];
  const ids = new Set<string>();
  (payload["data"] as unknown[]).forEach((value, rowIndex) => {
    const displayName = record(value)
      ? canonical(value["display_name"], 256)
        ? value["display_name"]
        : canonical(value["name"], 256)
          ? value["name"]
          : undefined
      : undefined;
    if (
      !record(value) ||
      !dynamoJsonValueSafe(value) ||
      !storageKeyComponent(value["id"], 128) ||
      !displayName ||
      !storageKeyComponent(value["sport"], 64) ||
      value["sport"].includes(",") ||
      !landingKeyFits(
        `${LANDING_SLOT_PREFIX}LEAGUE#`,
        [value["sport"], value["id"]],
        1_024,
      ) ||
      !nonNegativeInteger(value["event_count"]) ||
      !nonNegativeInteger(value["live_count"]) ||
      (value["numerical_id"] !== undefined &&
        !nonNegativeInteger(value["numerical_id"]))
    ) {
      quarantines.push(quarantineRow(value, rowIndex, "leagues"));
      return;
    }
    const compoundId = `${value["sport"]}\u0000${value["id"]}`;
    if (ids.has(compoundId)) {
      quarantines.push(
        quarantineRow(value, rowIndex, "leagues", "duplicate-provider-id"),
      );
      return;
    }
    // SharpAPI documents `league` as a comma-separated filter. A catalog ID
    // containing a comma cannot be represented as one atomic value after URL
    // decoding. Preserve bounded quarantine evidence instead of silently
    // omitting it or accidentally requesting two different leagues.
    if (value["id"].includes(",")) {
      quarantines.push(
        quarantineRow(value, rowIndex, "leagues", "unrepresentable-filter-id"),
      );
      return;
    }
    const league: SharpApiCatalogLeague = {
      providerLeagueId: value["id"],
      displayName,
      ...(value["numerical_id"] === undefined
        ? {}
        : { numericalId: value["numerical_id"] }),
      providerSportId: value["sport"],
      eventCount: value["event_count"],
      liveCount: value["live_count"],
      ...sourceShapeEvidence(value),
    };
    if (
      !landingValueFits(league as unknown as Readonly<Record<string, unknown>>)
    ) {
      quarantines.push(quarantineRow(value, rowIndex, "leagues"));
      return;
    }
    ids.add(compoundId);
    leagues.push(league);
  });
  return {
    leagues,
    quarantines,
    sourceRows: (payload["data"] as unknown[]).length,
    ...(instant(payload["updated_at"])
      ? { providerUpdatedAt: payload["updated_at"] }
      : {}),
    retrievedAt,
  };
}

const universalPageEnvelope = (
  input: unknown,
  endpoint: Extract<SharpApiEndpoint, "universal-events" | "universal-odds">,
) => {
  if (!record(input)) throw invalidResponse(endpoint, "envelope");
  assertProviderEnvelope(input, endpoint);
  const pagination = input["pagination"];
  const nullEmptyPage =
    input["data"] === null &&
    record(pagination) &&
    pagination["has_more"] === false &&
    pagination["count"] === 0 &&
    (pagination["total"] === undefined || pagination["total"] === 0);
  if (
    (!Array.isArray(input["data"]) && !nullEmptyPage) ||
    (Array.isArray(input["data"]) && input["data"].length > 200) ||
    !record(pagination) ||
    typeof pagination["has_more"] !== "boolean"
  )
    throw invalidResponse(endpoint, "page");
  if (input["updated_at"] !== undefined && !instant(input["updated_at"]))
    throw invalidResponse(endpoint, "updated-at");
  return nullEmptyPage ? { ...input, data: [] } : input;
};

export function parseSharpApiUniversalEventsPage(
  input: unknown,
  retrievedAt: IsoTimestamp,
  requestedOffset = 0,
): SharpApiUniversalPage<SharpApiUniversalEvent> {
  if (!nonNegativeInteger(requestedOffset))
    throw invalidResponse("universal-events", "requested-offset");
  const payload = universalPageEnvelope(input, "universal-events");
  const records: SharpApiUniversalEvent[] = [];
  const quarantines: SharpApiLandingQuarantine[] = [];
  const ids = new Set<string>();
  (payload["data"] as unknown[]).forEach((value, rowIndex) => {
    if (!record(value) || !dynamoJsonValueSafe(value)) {
      quarantines.push(quarantineRow(value, rowIndex, "events"));
      return;
    }
    const markets = sanitizedStringArray(value["markets"], 256, 128);
    const books = sanitizedStringArray(value["books"], 256, 128);
    const externalIds = boundedExternalIds(value["external_ids"]);
    if (
      !storageKeyComponent(value["id"], 256) ||
      !landingRecordIdFits(value["id"], "EVENT#") ||
      !landingSportFits(value["sport"], "event") ||
      !canonical(value["league"], 128) ||
      !instant(value["start_time"]) ||
      !canonical(value["status"], 64) ||
      typeof value["is_live"] !== "boolean"
    ) {
      quarantines.push(quarantineRow(value, rowIndex, "events"));
      return;
    }
    if (ids.has(value["id"])) {
      quarantines.push(
        quarantineRow(value, rowIndex, "events", "duplicate-provider-id"),
      );
      return;
    }
    ids.add(value["id"]);
    const sourceWarnings = [
      optionalStringWarning(value["uuid"], 128, "uuid-invalid"),
      optionalStringWarning(
        value["home_team"],
        512,
        "home-participant-invalid",
      ),
      optionalStringWarning(
        value["away_team"],
        512,
        "away-participant-invalid",
      ),
      !record(value["external_ids"])
        ? "external-ids-invalid"
        : Object.entries(value["external_ids"]).some(
              ([key, item]) => !canonical(key, 64) || !canonical(item, 256),
            )
          ? "external-ids-entry-invalid"
          : Object.keys(value["external_ids"]).length > 128
            ? "external-ids-truncated"
            : null,
      !Array.isArray(value["markets"])
        ? "markets-invalid"
        : value["markets"].some((item) => !canonical(item, 128))
          ? "markets-entry-invalid"
          : value["markets"].length > 256
            ? "markets-truncated"
            : null,
      !Array.isArray(value["books"])
        ? "books-invalid"
        : value["books"].some((item) => !canonical(item, 128))
          ? "books-entry-invalid"
          : value["books"].length > 256
            ? "books-truncated"
            : null,
    ].filter((warning): warning is string => warning !== null);
    const event: SharpApiUniversalEvent = {
      providerEventId: value["id"],
      ...(canonical(value["uuid"], 128)
        ? { providerEventUuid: value["uuid"] }
        : {}),
      externalIds,
      sport: value["sport"],
      league: value["league"],
      ...(canonical(value["home_team"], 512)
        ? { homeParticipant: value["home_team"] }
        : {}),
      ...(canonical(value["away_team"], 512)
        ? { awayParticipant: value["away_team"] }
        : {}),
      startsAt: iso(value["start_time"]),
      status: value["status"],
      isLive: value["is_live"],
      marketKeys: markets,
      sportsbookIds: books,
      ...(sourceWarnings.length > 0 ? { sourceWarnings } : {}),
      ...sourceShapeEvidence(value),
    };
    if (
      !landingValueFits(event as unknown as Readonly<Record<string, unknown>>)
    ) {
      quarantines.push(quarantineRow(value, rowIndex, "events"));
      return;
    }
    records.push(event);
  });
  return universalPagination(
    payload,
    records,
    quarantines,
    retrievedAt,
    "offset",
    requestedOffset,
  );
}

export function parseSharpApiUniversalOddsPage(
  input: unknown,
  retrievedAt: IsoTimestamp,
  requestedLimit = 200,
): SharpApiUniversalPage<SharpApiUniversalOddsRecord> {
  const payload = universalPageEnvelope(input, "universal-odds");
  const records: SharpApiUniversalOddsRecord[] = [];
  const quarantines: SharpApiLandingQuarantine[] = [];
  const ids = new Set<string>();
  (payload["data"] as unknown[]).forEach((value, rowIndex) => {
    const americanOddsValid =
      record(value) &&
      safeInteger(value["odds_american"]) &&
      providerNumber(value["odds_american"]) &&
      Math.abs(value["odds_american"]) >= 100;
    const decimalOddsValid =
      record(value) &&
      providerNumber(value["odds_decimal"]) &&
      value["odds_decimal"] > 1;
    const probabilityValid =
      record(value) &&
      providerNumber(value["odds_probability"]) &&
      value["odds_probability"] > 0 &&
      value["odds_probability"] <= 1;
    const priceFieldInvalid =
      record(value) &&
      [
        ["odds_american", americanOddsValid],
        ["odds_decimal", decimalOddsValid],
        ["odds_probability", probabilityValid],
      ].some(
        ([key, valid]) =>
          value[key as string] !== undefined &&
          value[key as string] !== null &&
          valid !== true,
      );
    const lifecycleFieldInvalid =
      record(value) &&
      [
        "is_main_line",
        "is_alternate_line",
        "is_player_prop",
        "is_stale_pregame_price",
        "is_impossible_scoreline",
      ].some(
        (key) => value[key] !== undefined && typeof value[key] !== "boolean",
      );
    if (
      !record(value) ||
      !dynamoJsonValueSafe(value) ||
      !storageKeyComponent(value["id"], 256) ||
      !landingRecordIdFits(value["id"], "PRICE#") ||
      !canonical(value["event_id"], 256) ||
      !landingSportFits(value["sport"], "odds") ||
      !canonical(value["league"], 128) ||
      !canonical(value["sportsbook"], 128) ||
      !canonical(value["market_type"], 128) ||
      !canonical(value["selection"], 512) ||
      !canonical(value["selection_type"], 128) ||
      !instant(value["timestamp"]) ||
      typeof value["is_live"] !== "boolean" ||
      (value["is_active"] !== undefined &&
        typeof value["is_active"] !== "boolean") ||
      (!americanOddsValid && !decimalOddsValid && !probabilityValid) ||
      priceFieldInvalid ||
      (value["line"] !== undefined &&
        value["line"] !== null &&
        !providerNumber(value["line"])) ||
      lifecycleFieldInvalid
    ) {
      quarantines.push(quarantineRow(value, rowIndex, "odds"));
      return;
    }
    if (ids.has(value["id"])) {
      quarantines.push(
        quarantineRow(value, rowIndex, "odds", "duplicate-provider-id"),
      );
      return;
    }
    ids.add(value["id"]);
    const optionalNumber = (key: string, target: string) =>
      providerNumber(value[key]) ? { [target]: value[key] } : {};
    const optionalBoolean = (key: string, target: string) =>
      typeof value[key] === "boolean" ? { [target]: value[key] } : {};
    const numberKeys = ["max_bet", "volume_24h"];
    const stringKeys = [
      "event_uuid",
      "external_event_id",
      "market_id",
      "selection_id",
      "team_side",
    ];
    const sourceWarnings = [
      ...numberKeys
        .filter(
          (key) =>
            value[key] !== undefined &&
            value[key] !== null &&
            !providerNumber(value[key]),
        )
        .map((key) => `${key}-invalid`),
      ...stringKeys
        .filter(
          (key) =>
            value[key] !== undefined &&
            value[key] !== null &&
            !canonical(value[key], 256),
        )
        .map((key) => `${key}-invalid`),
      optionalStringWarning(
        value["home_team"],
        512,
        "home-participant-invalid",
      ),
      optionalStringWarning(
        value["away_team"],
        512,
        "away-participant-invalid",
      ),
      value["event_start_time"] !== undefined &&
      value["event_start_time"] !== null &&
      value["event_start_time"] !== "" &&
      !instant(value["event_start_time"])
        ? "event-start-time-invalid"
        : null,
    ].filter((warning): warning is string => warning !== null);
    const odds: SharpApiUniversalOddsRecord = {
      providerPriceId: value["id"],
      providerEventId: value["event_id"],
      ...(canonical(value["event_uuid"], 128)
        ? { providerEventUuid: value["event_uuid"] }
        : {}),
      ...(canonical(value["external_event_id"], 256)
        ? { externalEventId: value["external_event_id"] }
        : {}),
      sport: value["sport"],
      league: value["league"],
      sportsbook: value["sportsbook"],
      ...(canonical(value["home_team"], 512)
        ? { homeParticipant: value["home_team"] }
        : {}),
      ...(canonical(value["away_team"], 512)
        ? { awayParticipant: value["away_team"] }
        : {}),
      marketType: value["market_type"],
      ...(canonical(value["market_id"], 256)
        ? { providerMarketId: value["market_id"] }
        : {}),
      selection: value["selection"],
      selectionType: value["selection_type"],
      ...(canonical(value["selection_id"], 256)
        ? { providerSelectionId: value["selection_id"] }
        : {}),
      ...(canonical(value["team_side"], 128)
        ? { teamSide: value["team_side"] }
        : {}),
      ...optionalNumber("line", "line"),
      ...optionalNumber("odds_american", "americanOdds"),
      ...optionalNumber("odds_decimal", "decimalOdds"),
      ...optionalNumber("odds_probability", "impliedProbability"),
      ...(instant(value["event_start_time"])
        ? { eventStartsAt: iso(value["event_start_time"]) }
        : {}),
      providerTimestamp: iso(value["timestamp"]),
      isLive: value["is_live"],
      isActive: value["is_active"] !== false,
      ...optionalBoolean("is_main_line", "isMainLine"),
      ...optionalBoolean("is_alternate_line", "isAlternateLine"),
      ...optionalBoolean("is_player_prop", "isPlayerProp"),
      ...optionalBoolean("is_stale_pregame_price", "isStalePregamePrice"),
      ...optionalBoolean("is_impossible_scoreline", "isImpossibleScoreline"),
      ...optionalNumber("max_bet", "maxBet"),
      ...optionalNumber("volume_24h", "volume24h"),
      ...(sourceWarnings.length > 0 ? { sourceWarnings } : {}),
      ...sourceShapeEvidence(value),
    };
    if (
      !landingValueFits(odds as unknown as Readonly<Record<string, unknown>>)
    ) {
      quarantines.push(quarantineRow(value, rowIndex, "odds"));
      return;
    }
    records.push(odds);
  });
  return universalPagination(
    payload,
    records,
    quarantines,
    retrievedAt,
    "cursor",
    undefined,
    requestedLimit,
  );
}

const universalPagination = <T>(
  payload: Record<string, unknown>,
  records: readonly T[],
  quarantines: readonly SharpApiLandingQuarantine[],
  retrievedAt: IsoTimestamp,
  mode: "offset" | "cursor",
  requestedOffset?: number,
  expectedLimit = UNIVERSAL_EVENTS_PAGE_LIMIT,
): SharpApiUniversalPage<T> => {
  const pagination = payload["pagination"] as Record<string, unknown>;
  const data = payload["data"] as unknown[];
  const hasMore = pagination["has_more"] as boolean;
  const nextOffset = pagination["next_offset"];
  const nextCursor = pagination["next_cursor"];
  const endpoint = mode === "offset" ? "universal-events" : "universal-odds";
  if (!safeInteger(expectedLimit) || expectedLimit < 1 || expectedLimit > 200)
    throw invalidResponse(endpoint, "requested-limit");
  const count = pagination["count"];
  const declaredLimit = pagination["limit"];
  const declaredOffset = pagination["offset"];
  const providerTotal = pagination["total"];
  if (
    (count !== undefined &&
      (!nonNegativeInteger(count) || count !== data.length)) ||
    (declaredLimit !== undefined &&
      (!nonNegativeInteger(declaredLimit) ||
        declaredLimit !== expectedLimit)) ||
    (mode === "offset" &&
      declaredOffset !== undefined &&
      (!nonNegativeInteger(declaredOffset) ||
        declaredOffset !== requestedOffset)) ||
    (hasMore && data.length === 0)
  )
    throw invalidResponse(endpoint, "pagination-coherence");
  if (
    (hasMore &&
      ((mode === "offset" &&
        (!nonNegativeInteger(nextOffset) ||
          nextOffset !== (requestedOffset ?? 0) + expectedLimit ||
          (nextOffset > UNIVERSAL_EVENTS_MAX_OFFSET &&
            (!nonNegativeInteger(providerTotal) ||
              providerTotal <=
                UNIVERSAL_EVENTS_MAX_OFFSET + expectedLimit)))) ||
        (mode === "cursor" && !storageKeyComponent(nextCursor, 4096)))) ||
    (!hasMore &&
      (mode === "offset"
        ? nextOffset !== null && nextOffset !== undefined
        : nextCursor !== null && nextCursor !== undefined))
  )
    throw invalidResponse(endpoint, "pagination");
  if (providerTotal !== undefined && !nonNegativeInteger(providerTotal))
    throw invalidResponse(endpoint, "pagination-total");
  if (
    mode === "offset" &&
    nonNegativeInteger(providerTotal) &&
    (providerTotal < (requestedOffset ?? 0) + data.length ||
      (hasMore && providerTotal <= (requestedOffset ?? 0) + data.length) ||
      (!hasMore && providerTotal !== (requestedOffset ?? 0) + data.length))
  )
    throw invalidResponse(endpoint, "pagination-total-coherence");
  return {
    records,
    quarantines,
    sourceRows: data.length,
    hasMore,
    ...(mode === "offset" ? { requestedOffset: requestedOffset ?? 0 } : {}),
    ...(mode === "offset" && nonNegativeInteger(nextOffset)
      ? { nextOffset }
      : {}),
    ...(mode === "cursor" && storageKeyComponent(nextCursor, 4096)
      ? { nextCursor }
      : {}),
    ...(nonNegativeInteger(providerTotal) ? { providerTotal } : {}),
    ...(instant(payload["updated_at"])
      ? { providerUpdatedAt: payload["updated_at"] }
      : {}),
    retrievedAt,
  };
};

/**
 * Whether a moneyline is two-way or three-way is a property of the MARKET, but
 * `market_type` reports it per price and reports it wrong: SharpAPI publishes
 * soccer's three-way moneyline as `moneyline` with a separate `draw`
 * selection, not as `moneyline_3-way`. Read one price at a time that is
 * indistinguishable from a two-way market.
 *
 * The cost was total. A moneyline labelled two-way is expected to hold exactly
 * away and home, so a three-selection group failed the completeness check and
 * every soccer moneyline was rejected whole — which is why no soccer fixture
 * has ever carried a price, in any competition, while the odds sat in the
 * table. It would also have mis-valued the no-vig consensus, since removing
 * vig from three outcomes as though there were two is simply a different sum.
 *
 * So the structure is decided once, here, where the book's prices are grouped
 * and the draw is actually visible. A moneyline carrying a main-line draw is
 * three-way. Nothing else is touched: no other sport quotes a draw.
 */
const withResolvedMoneylineStructure = (
  prices: readonly SharpApiPrice[],
): readonly SharpApiPrice[] => {
  const threeWay = prices.some(
    (price) =>
      price.marketKey === "moneyline" &&
      price.selectionKey === "draw" &&
      price.isMainLine &&
      !price.isAlternateLine,
  );
  return threeWay
    ? prices.map((price) =>
        price.marketKey === "moneyline"
          ? { ...price, outcomeStructure: "three-way" as const }
          : price,
      )
    : prices;
};

const selection = (
  raw: Record<string, unknown>,
  league: SharpApiLeague,
): SharpApiPrice["selectionKey"] | undefined => {
  const type =
    typeof raw["selection_type"] === "string"
      ? raw["selection_type"].toLowerCase()
      : "";
  const label = typeof raw["selection"] === "string" ? raw["selection"] : "";
  if (["away", "home", "draw", "over", "under", "yes", "no"].includes(type))
    return type as SharpApiPrice["selectionKey"];
  if (label === raw["away_team"]) return "away";
  if (label === raw["home_team"]) return "home";
  if (/^draw$/i.test(label) && String(league.sportKey) === "soccer")
    return "draw";
  if (/^over\b/i.test(label)) return "over";
  if (/^under\b/i.test(label)) return "under";
  if (/^yes$/i.test(label)) return "yes";
  if (/^no$/i.test(label)) return "no";
  return undefined;
};

const market = (
  raw: Record<string, unknown>,
  league: SharpApiLeague,
): SharpApiPrice["marketKey"] | undefined => {
  const value =
    typeof raw["market_type"] === "string"
      ? raw["market_type"].toLowerCase()
      : "";
  if (value === "moneyline" || value === "moneyline_3-way")
    return league.moneylineMarket;
  if (["point_spread", "run_line", "puck_line"].includes(value))
    return "spread";
  if (["total_points", "total_goals", "total_runs"].includes(value))
    return "total";
  if (["both_teams_to_score", "btts"].includes(value)) return "btts";
  if (
    ["team_total_points", "team_total_goals", "team_total_runs"].includes(value)
  )
    return "team_total";
  return undefined;
};

const auditId = (value: unknown) =>
  (typeof value === "string" ? value : "unknown")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "")
    .slice(0, 64) || "unknown";

const teamName = (raw: Record<string, unknown>, side: "away" | "home") => {
  const reference = raw[side];
  if (record(reference) && canonical(reference["name"]))
    return reference["name"];
  const flat = raw[`${side}_team`];
  return canonical(flat) ? flat : undefined;
};

export function parseSharpApiOddsPage(
  input: unknown,
  league: SharpApiLeague,
  retrievedAt: IsoTimestamp,
  maximumRows = 200,
  requestKind: "initial" | "cursor" | "focused" = "initial",
): SharpApiOddsPage {
  const endpoint: SharpApiEndpoint =
    requestKind === "focused" ? "focused-odds" : "odds";
  const payload = record(input) ? input : undefined;
  if (payload) assertProviderEnvelope(payload, endpoint);
  const pagination = payload?.["pagination"];
  const terminalCount = record(pagination) ? pagination["count"] : undefined;
  const terminalTotal = record(pagination) ? pagination["total"] : undefined;
  const commonTerminalPagination =
    record(pagination) &&
    pagination["has_more"] === false &&
    (pagination["next_cursor"] === null ||
      pagination["next_cursor"] === undefined);
  const initialZeroEvidence = terminalCount === 0 && terminalTotal === 0;
  const cursorZeroEvidence =
    (terminalCount === null ||
      terminalCount === undefined ||
      terminalCount === 0) &&
    (terminalTotal === null ||
      terminalTotal === undefined ||
      (safeInteger(terminalTotal) && terminalTotal >= 0)) &&
    (terminalCount === 0 || (safeInteger(terminalTotal) && terminalTotal >= 0));
  const terminalPagination =
    commonTerminalPagination &&
    (requestKind === "initial" || requestKind === "focused"
      ? initialZeroEvidence
      : requestKind === "cursor"
        ? cursorZeroEvidence
        : false);
  const explicitlyEmpty =
    payload?.["data"] === null && terminalPagination && payload !== undefined;
  if (
    !payload ||
    (!explicitlyEmpty && !Array.isArray(payload["data"])) ||
    (Array.isArray(payload["data"]) && payload["data"].length > maximumRows)
  )
    throw invalidResponse(endpoint, "page-envelope");
  const data = explicitlyEmpty ? [] : (payload["data"] as unknown[]);
  if (record(pagination) && Array.isArray(payload["data"])) {
    const count = pagination["count"];
    const total = pagination["total"];
    if (
      (count !== null &&
        count !== undefined &&
        (!safeInteger(count) || count < 0 || count !== data.length)) ||
      (total !== null &&
        total !== undefined &&
        (!safeInteger(total) || total < data.length)) ||
      (safeInteger(count) && safeInteger(total) && count > total) ||
      (requestKind !== "cursor" &&
        pagination["has_more"] === false &&
        safeInteger(total) &&
        total !== data.length) ||
      (pagination["has_more"] === false &&
        pagination["next_cursor"] !== null &&
        pagination["next_cursor"] !== undefined)
    )
      throw invalidResponse(endpoint, "pagination-coherence");
  }
  const deduplicatedRows: (Record<string, unknown> | null)[] = [];
  const rejections: SharpApiNormalizationRejection[] = [];
  const priceIdentities = new Map<
    string,
    { readonly signature: string; readonly index: number }
  >();
  for (const candidate of data) {
    if (!record(candidate)) {
      rejections.push({
        providerId: SHARP_API_PROVIDER_ID,
        reason: "incomplete-market",
        auditId: "non-record-row",
      });
      continue;
    }
    let value: Record<string, unknown> = candidate;
    const providerSportsbookId =
      typeof value["sportsbook"] === "string" ? value["sportsbook"] : "";
    const bookResult = normalizeSportsbook(providerSportsbookId);
    if (bookResult.kind === "rejected") {
      rejections.push({
        providerId: SHARP_API_PROVIDER_ID,
        reason: bookResult.reason,
        auditId: bookResult.auditId,
        ...(canonical(value["event_id"])
          ? { providerEventId: value["event_id"] }
          : {}),
      });
      continue;
    }
    value = {
      ...value,
      provider_sportsbook_id: providerSportsbookId,
      sportsbook: bookResult.sportsbook.id,
    };
    const marketKey = market(value, league);
    if (!marketKey) {
      rejections.push({
        providerId: SHARP_API_PROVIDER_ID,
        reason: "unsupported-market",
        auditId: auditId(value["market_type"]),
        sportsbookId: bookResult.sportsbook.id,
        ...(canonical(value["event_id"])
          ? { providerEventId: value["event_id"] }
          : {}),
      });
      continue;
    }
    const selectionKey = selection(value, league);
    if (!selectionKey) {
      rejections.push({
        providerId: SHARP_API_PROVIDER_ID,
        reason: "unsupported-selection",
        auditId: auditId(value["selection_type"] ?? value["selection"]),
        sportsbookId: bookResult.sportsbook.id,
        ...(canonical(value["event_id"])
          ? { providerEventId: value["event_id"] }
          : {}),
      });
      continue;
    }
    const compatible =
      (marketKey === "moneyline" &&
        ["away", "home", "draw"].includes(selectionKey)) ||
      (marketKey === "spread" && ["away", "home"].includes(selectionKey)) ||
      (marketKey === "total" && ["over", "under"].includes(selectionKey)) ||
      (marketKey === "btts" && ["yes", "no"].includes(selectionKey)) ||
      (marketKey === "team_total" && ["over", "under"].includes(selectionKey));
    if (!compatible) {
      rejections.push({
        providerId: SHARP_API_PROVIDER_ID,
        reason: "unsupported-selection",
        auditId: auditId(value["selection_type"] ?? value["selection"]),
        sportsbookId: bookResult.sportsbook.id,
        ...(canonical(value["event_id"])
          ? { providerEventId: value["event_id"] }
          : {}),
      });
      continue;
    }
    if (typeof value["is_active"] !== "boolean") {
      rejections.push({
        providerId: SHARP_API_PROVIDER_ID,
        reason: "incomplete-market",
        auditId: auditId(value["id"]),
        sportsbookId: bookResult.sportsbook.id,
        ...(canonical(value["event_id"])
          ? { providerEventId: value["event_id"] }
          : {}),
      });
      continue;
    }
    if (marketKey === "btts" && !["yes", "no"].includes(selectionKey)) {
      rejections.push({
        providerId: SHARP_API_PROVIDER_ID,
        reason: "unsupported-selection",
        auditId: auditId(value["selection_type"] ?? value["selection"]),
        sportsbookId: bookResult.sportsbook.id,
        ...(canonical(value["event_id"])
          ? { providerEventId: value["event_id"] }
          : {}),
      });
      continue;
    }
    if (
      marketKey === "team_total" &&
      !["over", "under"].includes(selectionKey)
    ) {
      rejections.push({
        providerId: SHARP_API_PROVIDER_ID,
        reason: "unsupported-selection",
        auditId: auditId(value["selection_type"] ?? value["selection"]),
        sportsbookId: bookResult.sportsbook.id,
        ...(canonical(value["event_id"])
          ? { providerEventId: value["event_id"] }
          : {}),
      });
      continue;
    }
    if (!providerInstant(value["timestamp"])) {
      rejections.push({
        providerId: SHARP_API_PROVIDER_ID,
        reason: "missing-provider-timestamp",
        auditId: auditId(value["id"]),
        sportsbookId: bookResult.sportsbook.id,
        ...(canonical(value["event_id"])
          ? { providerEventId: value["event_id"] }
          : {}),
      });
      if (canonical(value["id"])) {
        const previous = priceIdentities.get(value["id"]);
        if (previous) deduplicatedRows[previous.index] = null;
      }
      continue;
    }
    if (
      marketKey === "team_total" &&
      value["participant_side"] !== "away" &&
      value["participant_side"] !== "home"
    ) {
      rejections.push({
        providerId: SHARP_API_PROVIDER_ID,
        reason: "participant-unavailable",
        auditId: auditId(value["selection_id"]),
        sportsbookId: bookResult.sportsbook.id,
        ...(canonical(value["event_id"])
          ? { providerEventId: value["event_id"] }
          : {}),
      });
      continue;
    }
    const awayTeam = teamName(value, "away");
    const homeTeam = teamName(value, "home");
    if (
      !canonical(value["id"]) ||
      !canonical(value["event_id"]) ||
      !canonical(value["event_uuid"]) ||
      !awayTeam ||
      !homeTeam ||
      !instant(value["event_start_time"]) ||
      !canonical(value["sportsbook"], 128) ||
      !canonical(value["market_type"], 128) ||
      !canonical(value["market_id"]) ||
      !canonical(value["selection"]) ||
      !canonical(value["selection_id"])
    ) {
      rejections.push({
        providerId: SHARP_API_PROVIDER_ID,
        reason: "incomplete-market",
        auditId: auditId(value["id"]),
        ...(canonical(value["sportsbook"], 128)
          ? { sportsbookId: value["sportsbook"] }
          : {}),
        ...(canonical(value["event_id"])
          ? { providerEventId: value["event_id"] }
          : {}),
      });
      continue;
    }
    const participants = canonicalSharpParticipants(league, awayTeam, homeTeam);
    if (participants.kind === "rejected") {
      rejections.push({
        providerId: SHARP_API_PROVIDER_ID,
        reason: "participant-unavailable",
        auditId: auditId(value["id"]),
        providerEventId: value["event_id"],
        sportsbookId: value["sportsbook"],
        participantBoundaryReason: participants.reason,
      });
      continue;
    }
    const signature = JSON.stringify([
      value["event_id"],
      value["event_uuid"],
      participants.awayTeam,
      participants.homeTeam,
      Date.parse(value["event_start_time"]),
      value["sportsbook"],
      value["market_type"],
      value["market_id"],
      value["selection"],
      value["selection_id"],
    ]);
    const previous = priceIdentities.get(value["id"]);
    if (previous) {
      if (previous.signature !== signature) {
        deduplicatedRows[previous.index] = null;
        rejections.push({
          providerId: SHARP_API_PROVIDER_ID,
          reason: "incomplete-market",
          auditId: auditId(value["id"]),
          providerEventId: value["event_id"],
          sportsbookId: value["sportsbook"],
        });
        continue;
      }
      // SharpAPI snapshots can repeat a stable price id after repricing it.
      // Provider order is authoritative when timestamps have only coarse precision.
      deduplicatedRows[previous.index] = value;
      continue;
    }
    priceIdentities.set(value["id"], {
      signature,
      index: deduplicatedRows.length,
    });
    deduplicatedRows.push(value);
  }
  const grouped = new Map<string, Map<string, SharpApiPrice[]>>();
  const providerSportsbookIds = new Map<string, Map<string, Set<string>>>();
  const identities = new Map<string, Omit<SharpApiEvent, "bookmakers">>();
  for (const value of deduplicatedRows) {
    if (!value) continue;
    const marketKey = market(value, league);
    const selectionKey = selection(value, league);
    if (!marketKey || !selectionKey) continue;
    const awayTeam = teamName(value, "away");
    const homeTeam = teamName(value, "home");
    if (
      !canonical(value["id"]) ||
      !canonical(value["event_id"]) ||
      !canonical(value["event_uuid"]) ||
      !awayTeam ||
      !homeTeam ||
      awayTeam === homeTeam ||
      !instant(value["event_start_time"]) ||
      !canonical(value["sportsbook"], 128) ||
      !canonical(value["market_type"], 128) ||
      !canonical(value["market_id"]) ||
      !canonical(value["selection"]) ||
      !canonical(value["selection_id"]) ||
      !safeInteger(value["odds_american"]) ||
      Math.abs(value["odds_american"]) < 100 ||
      !finite(value["odds_decimal"]) ||
      value["odds_decimal"] <= 1 ||
      !finite(value["odds_probability"]) ||
      value["odds_probability"] < 0 ||
      value["odds_probability"] > 1 ||
      !instant(value["timestamp"])
    ) {
      rejections.push({
        providerId: SHARP_API_PROVIDER_ID,
        reason: "incomplete-market",
        auditId: auditId(value["id"]),
        ...(canonical(value["event_id"])
          ? { providerEventId: value["event_id"] }
          : {}),
        ...(canonical(value["sportsbook"], 128)
          ? { sportsbookId: value["sportsbook"] }
          : {}),
      });
      continue;
    }
    const participants = canonicalSharpParticipants(league, awayTeam, homeTeam);
    if (participants.kind === "rejected") continue;
    const eventId = value["event_id"];
    const existing = identities.get(eventId);
    let identity: Omit<SharpApiEvent, "bookmakers"> = {
      providerEventId: eventId,
      providerEventUuid: value["event_uuid"],
      awayTeam: participants.awayTeam,
      homeTeam: participants.homeTeam,
      ...(participants.awayClubKey
        ? {
            awayClubKey: participants.awayClubKey,
            homeClubKey: participants.homeClubKey,
          }
        : {}),
      startsAt: iso(value["event_start_time"]),
    };
    if (existing) {
      const sameOrientation =
        existing.awayTeam === identity.awayTeam &&
        existing.homeTeam === identity.homeTeam;
      const reversedOrientation =
        existing.awayTeam === identity.homeTeam &&
        existing.homeTeam === identity.awayTeam;
      if (
        existing.providerEventUuid !== identity.providerEventUuid ||
        (!sameOrientation && !reversedOrientation)
      )
        continue;
      // The schedule endpoint is authoritative for event time. Sportsbook rows
      // for the same exact event UUID can retain an older pre-delay start.
      // Keep the first normalized identity and merge only its compatible books.
      // A minority of SharpAPI sportsbook rows reverse soccer participants.
      // Dropping the outlier is safer than assigning its prices to the wrong side.
      if (reversedOrientation) continue;
      identity = existing;
    }
    identities.set(eventId, identity);
    const books = grouped.get(eventId) ?? new Map<string, SharpApiPrice[]>();
    const book = value["sportsbook"];
    const prices = books.get(book) ?? [];
    const line = value["line"];
    if ((marketKey === "spread" || marketKey === "total") && !finite(line)) {
      rejections.push({
        providerId: SHARP_API_PROVIDER_ID,
        reason: "incomplete-market",
        auditId: auditId(value["id"]),
        providerEventId: value["event_id"],
        sportsbookId: value["sportsbook"],
      });
      continue;
    }
    const publicPct = value["public_bet_pct"];
    if (
      publicPct !== undefined &&
      publicPct !== null &&
      (!finite(publicPct) || publicPct < 0 || publicPct > 1)
    ) {
      rejections.push({
        providerId: SHARP_API_PROVIDER_ID,
        reason: "incomplete-market",
        auditId: auditId(value["id"]),
        providerEventId: value["event_id"],
        sportsbookId: value["sportsbook"],
      });
      continue;
    }
    prices.push({
      providerPriceId: value["id"],
      marketKey,
      providerMarketType: value["market_type"],
      providerMarketId: value["market_id"],
      selectionKey,
      ...(marketKey === "moneyline"
        ? {
            outcomeStructure:
              value["market_type"] === "moneyline_3-way"
                ? ("three-way" as const)
                : ("two-way" as const),
          }
        : {}),
      ...(marketKey === "team_total" &&
      (value["participant_side"] === "away" ||
        value["participant_side"] === "home")
        ? { participantSide: value["participant_side"] }
        : {}),
      selectionLabel: value["selection"],
      providerSelectionId: value["selection_id"],
      ...(finite(line) ? { point: line } : {}),
      americanOdds: value["odds_american"],
      decimalOdds: value["odds_decimal"],
      impliedProbability: value["odds_probability"],
      ...(publicPct === undefined || publicPct === null
        ? {}
        : { publicBetPercent: publicPct * 100 }),
      ...(canonical(value["deep_link"], 2048)
        ? { deepLink: value["deep_link"] }
        : {}),
      isLive: value["is_live"] === true,
      isMainLine: value["is_main_line"] === true,
      isAlternateLine: value["is_alternate_line"] === true,
      isPlayerProp: value["is_player_prop"] === true,
      isStalePregamePrice: value["is_stale_pregame_price"] === true,
      isActive: value["is_active"] !== false,
      isSuspended: value["is_active"] === false,
      observedAt: iso(value["timestamp"]),
      retrievedAt,
    });
    books.set(book, prices);
    grouped.set(eventId, books);
    const eventProviderIds =
      providerSportsbookIds.get(eventId) ?? new Map<string, Set<string>>();
    const bookProviderIds = eventProviderIds.get(book) ?? new Set<string>();
    if (canonical(value["provider_sportsbook_id"], 128))
      bookProviderIds.add(value["provider_sportsbook_id"]);
    eventProviderIds.set(book, bookProviderIds);
    providerSportsbookIds.set(eventId, eventProviderIds);
  }
  if (!record(pagination) || typeof pagination["has_more"] !== "boolean")
    throw invalidResponse(endpoint, "pagination-envelope");
  const nextCursor = pagination["next_cursor"];
  if (pagination["has_more"] && !canonical(nextCursor, 4096))
    throw invalidResponse(endpoint, "pagination-cursor");
  return {
    events: [...identities].map(([eventId, identity]) => ({
      ...identity,
      bookmakers: [...(grouped.get(eventId) ?? [])].map(([id, prices]) => ({
        id,
        label: id,
        providerSportsbookIds: [
          ...(providerSportsbookIds.get(eventId)?.get(id) ?? []),
        ]
          .sort()
          .slice(0, 16),
        prices: withResolvedMoneylineStructure(prices),
      })),
    })),
    rejections,
    hasMore: pagination["has_more"],
    ...(canonical(nextCursor, 4096) ? { nextCursor } : {}),
    retrievedAt,
  };
}

export function parseSharpApiSchedulePage(
  input: unknown,
  league: SharpApiLeague,
  retrievedAt: IsoTimestamp,
): SharpApiSchedulePage {
  const invalid = (stage: string) => invalidResponse("schedule", stage);
  if (!record(input)) throw invalid("page-envelope");
  assertProviderEnvelope(input, "schedule");
  if (
    !Array.isArray(input["data"]) ||
    input["data"].length > 200 ||
    !record(input["pagination"]) ||
    typeof input["pagination"]["has_more"] !== "boolean"
  )
    throw invalid("page-envelope");
  const events: SharpApiScheduleEvent[] = [];
  const exclusions: SharpApiScheduleExclusion[] = [];
  const ids = new Set<string>();
  for (const value of input["data"]) {
    if (
      !record(value) ||
      !canonical(value["id"]) ||
      !canonical(value["league"], 64)
    )
      throw invalid("event-identity");
    // The endpoint can include valid but differently shaped rows from related
    // catalogues despite an exact filter. League identity is the only field we
    // need in order to exclude those rows safely.
    if (
      // Schedule only — and deliberately NOT widened to the secondary
      // catalogues. This request asks for one league, and rows outside it are
      // skipped here BEFORE the shape check below, which throws. Accepting a
      // foreign row moves it past that guard, so a single live row fails the
      // whole page — which took MLS's schedule down, and with it the odds run
      // the schedule gates.
      ![league.leagueKey, league.providerLeague.toLowerCase()].includes(
        value["league"].toLowerCase(),
      )
    )
      continue;
    // Shape only. A row whose lifecycle we do not want is handled below as an
    // exclusion — a malformed row is a different thing and still throws.
    if (
      !instant(value["start_time"]) ||
      typeof value["status"] !== "string" ||
      typeof value["is_live"] !== "boolean" ||
      (value["away_team"] !== null &&
        !["string", "undefined"].includes(typeof value["away_team"])) ||
      (value["home_team"] !== null &&
        !["string", "undefined"].includes(typeof value["home_team"])) ||
      (typeof value["away_team"] === "string" &&
        value["away_team"].length > 512) ||
      (typeof value["home_team"] === "string" &&
        value["home_team"].length > 512)
    )
      throw invalid("event-shape");
    const awayTeam = value["away_team"];
    const homeTeam = value["home_team"];
    if (ids.has(value["id"])) throw invalid("duplicate-event");
    ids.add(value["id"]);
    // A row we do not want is not evidence that the response is corrupt. The
    // provider flips a listing to in-play at first pitch and can leave it in
    // the league's own catalogue, so throwing here would fail the whole page
    // and take the league's schedule — and the odds run that schedule gates —
    // down with it. That is exactly what 02c1a67 had to be reverted around:
    // the league filter above happened to skip foreign live rows first, which
    // hid this from every league except the one whose own catalogue carried
    // them. Cost the row, never the page.
    if (value["status"] !== "upcoming" || value["is_live"]) {
      exclusions.push({
        providerEventId: value["id"],
        reason: "not-upcoming",
        auditId: auditId(value["id"]),
      });
      continue;
    }
    // Sharp includes futures/binary propositions in this catalogue. Those
    // records intentionally have a missing participant and are not games.
    if (
      typeof awayTeam !== "string" ||
      awayTeam.length === 0 ||
      typeof homeTeam !== "string" ||
      homeTeam.length === 0
    )
      continue;
    if (!canonical(awayTeam) || !canonical(homeTeam))
      throw invalid("participants");
    // Sharp's MLB event catalogue can contain thin, book-specific derivative
    // rows whose participant labels happen to be real clubs. A lone run-line
    // record is not a scheduled game and has previously created phantom games
    // with provider-generated timestamps. Full-game MLB events expose at least
    // one unambiguous primary market in the catalogue metadata.
    const markets = value["markets"];
    if (
      league.leagueKey === "mlb" &&
      Array.isArray(markets) &&
      !markets.includes("moneyline") &&
      !markets.includes("total_runs")
    ) {
      exclusions.push({
        providerEventId: value["id"],
        reason: "catalogue-derivative",
        auditId: auditId(value["id"]),
      });
      continue;
    }
    if (awayTeam === homeTeam) {
      exclusions.push({
        providerEventId: value["id"],
        reason: "same-club-matchup",
        auditId: auditId(value["id"]),
      });
      continue;
    }
    const participants = canonicalSharpParticipants(league, awayTeam, homeTeam);
    if (participants.kind === "rejected") {
      exclusions.push({
        providerEventId: value["id"],
        reason: participants.reason,
        auditId: auditId(value["id"]),
      });
      continue;
    }
    if (
      league.leagueKey !== "mlb" &&
      isSharpDerivativeMatchup(awayTeam, homeTeam)
    )
      continue;
    events.push({
      providerEventId: value["id"],
      // The atlas uuid is SharpAPI's feed-stable identity; ids are
      // deterministic renderings of league/team/time inputs the provider
      // renormalizes at will.
      ...(canonical(value["uuid"], 64)
        ? { providerEventUuid: value["uuid"] }
        : {}),
      awayTeam: participants.awayTeam,
      homeTeam: participants.homeTeam,
      ...(participants.awayClubKey
        ? {
            awayClubKey: participants.awayClubKey,
            homeClubKey: participants.homeClubKey,
          }
        : {}),
      startsAt: iso(value["start_time"]),
      status: "scheduled",
    });
  }
  const next = input["pagination"]["next_offset"];
  if (next !== null && next !== undefined && (!safeInteger(next) || next < 0))
    throw invalid("pagination-offset");
  return {
    events,
    ...(exclusions.length > 0 ? { exclusions } : {}),
    hasMore: input["pagination"]["has_more"],
    ...(safeInteger(next) ? { nextOffset: next } : {}),
    retrievedAt,
  };
}

const splitPercent = (value: unknown) => {
  if (!finite(value) || value < 0 || value > 1)
    throw invalidResponse("splits", "percentage");
  return Math.round(value * 10_000) / 100;
};

export function parseSharpApiSplitPage(
  input: unknown,
  retrievedAt: IsoTimestamp,
): SharpApiSplitPage {
  const invalid = (stage: string) => invalidResponse("splits", stage);
  if (!record(input)) throw invalid("page-envelope");
  assertProviderEnvelope(input, "splits");
  const pagination = input["pagination"];
  if (!record(pagination) || typeof pagination["has_more"] !== "boolean")
    throw invalid("pagination-envelope");
  const emptyPage =
    input["data"] === null &&
    pagination["has_more"] === false &&
    pagination["count"] === 0 &&
    pagination["total"] === 0;
  if (
    (!emptyPage && !Array.isArray(input["data"])) ||
    (Array.isArray(input["data"]) && input["data"].length > 200)
  )
    throw invalid("data-envelope");
  const data = emptyPage ? [] : (input["data"] as unknown[]);
  const items = data.map((value): SharpApiSplitEvent => {
    if (
      !record(value) ||
      !canonical(value["event_id"]) ||
      !canonical(value["sport"]) ||
      !canonical(value["league"]) ||
      !canonical(value["sportsbook"], 128) ||
      !canonical(value["away_team"]) ||
      !canonical(value["home_team"]) ||
      !instant(value["fetched_at"])
    )
      throw invalid("event-shape");
    const markets: SharpApiSplitMarket[] = [];
    const add = (
      marketKey: SharpApiSplitMarket["marketKey"],
      sides: readonly SharpApiSplitSelection["selectionKey"][],
      pointField: "line" | "odds",
    ) => {
      const raw = value[marketKey];
      if (raw === null || raw === undefined) return;
      if (!record(raw)) throw invalid("market-shape");
      const handle = record(raw["handle_pct"]) ? raw["handle_pct"] : undefined;
      const bets = record(raw["bets_pct"]) ? raw["bets_pct"] : undefined;
      if (!handle && !bets) throw invalid("market-percentages");
      const selections = sides.flatMap((side) => {
        const pointValue =
          marketKey === "total" ? raw["line"] : raw[`${side}_${pointField}`];
        const rawBetPercent = bets?.[side] ?? undefined;
        const rawMoneyPercent = handle?.[side] ?? undefined;
        const betPercent =
          rawBetPercent === undefined ? undefined : splitPercent(rawBetPercent);
        const moneyPercent =
          rawMoneyPercent === undefined
            ? undefined
            : splitPercent(rawMoneyPercent);
        if (betPercent === undefined && moneyPercent === undefined) return [];
        return [
          {
            selectionKey: side,
            ...(finite(pointValue)
              ? marketKey === "moneyline"
                ? { americanOdds: pointValue }
                : { point: pointValue }
              : {}),
            ...(betPercent === undefined ? {} : { betPercent }),
            ...(moneyPercent === undefined ? {} : { moneyPercent }),
          },
        ];
      });
      if (selections.length > 0) markets.push({ marketKey, selections });
    };
    add("spread", ["away", "home"], "odds");
    add("total", ["over", "under"], "odds");
    add("moneyline", ["away", "home"], "odds");
    return {
      providerEventId: value["event_id"],
      sport: value["sport"],
      league: value["league"],
      sportsbookId: value["sportsbook"],
      awayTeam: value["away_team"],
      homeTeam: value["home_team"],
      providerTimestamp: iso(value["fetched_at"]),
      markets,
    };
  });
  const nextOffset = pagination["next_offset"];
  if (
    nextOffset !== null &&
    nextOffset !== undefined &&
    !safeInteger(nextOffset)
  )
    throw invalid("pagination-offset");
  return {
    items,
    hasMore: pagination["has_more"],
    ...(safeInteger(nextOffset) ? { nextOffset } : {}),
    retrievedAt,
  };
}

export function parseSharpApiSplitHistoryPage(
  input: unknown,
  sourceEvent: SharpApiSplitEvent,
  retrievedAt: IsoTimestamp,
  startTime: IsoTimestamp,
  endTime: IsoTimestamp,
): SharpApiSplitHistoryPage {
  const invalid = (stage: string) => invalidResponse("splits-history", stage);
  if (!record(input)) throw invalid("page-envelope");
  assertProviderEnvelope(input, "splits-history");
  const meta = input["meta"];
  const data = input["data"];
  // This endpoint has no cursor. A full page could be the oldest 200 rows of
  // a truncated result, so fail closed instead of treating it as the latest.
  if (!record(meta) || !Array.isArray(data) || data.length >= 200)
    throw invalid("data-envelope");
  if (
    meta["event_id"] !== sourceEvent.providerEventId ||
    !safeInteger(meta["total"]) ||
    meta["total"] !== data.length ||
    !instant(meta["updated_at"])
  )
    throw invalid("metadata");
  const metaBookValues = meta["books"];
  if (
    data.length === 0
      ? metaBookValues !== undefined &&
        (!Array.isArray(metaBookValues) || metaBookValues.length > 0)
      : !Array.isArray(metaBookValues) ||
        metaBookValues.some((book) => !canonical(book, 128))
  )
    throw invalid("metadata-books");
  if (!instant(startTime) || !instant(endTime)) throw invalid("window");
  const startMs = Date.parse(startTime);
  const endMs = Date.parse(endTime);
  if (startMs > endMs) throw invalid("window");

  const items = data.map((value): SharpApiSplitEvent => {
    if (
      !record(value) ||
      !canonical(value["book"], 128) ||
      !instant(value["ts"]) ||
      !finite(value["timestamp"])
    )
      throw invalid("event-shape");
    const providerTimestamp = iso(value["ts"]);
    const providerMs = Date.parse(providerTimestamp);
    if (
      providerMs < startMs ||
      providerMs > endMs ||
      Math.abs(providerMs - value["timestamp"] * 1_000) > 2_000
    )
      throw invalid("event-timestamp");
    const markets: SharpApiSplitMarket[] = [];
    const add = (
      marketKey: SharpApiSplitMarket["marketKey"],
      sides: readonly SharpApiSplitSelection["selectionKey"][],
      pointField: "line" | "odds",
    ) => {
      const raw = value[marketKey];
      if (raw === null || raw === undefined) return;
      if (!record(raw)) throw invalid("market-shape");
      const handle = record(raw["handle_pct"]) ? raw["handle_pct"] : undefined;
      const bets = record(raw["bets_pct"]) ? raw["bets_pct"] : undefined;
      if (!handle && !bets) throw invalid("market-percentages");
      const selections = sides.flatMap((side) => {
        const pointValue =
          marketKey === "total" ? raw["line"] : raw[`${side}_${pointField}`];
        const rawBetPercent = bets?.[side] ?? undefined;
        const rawMoneyPercent = handle?.[side] ?? undefined;
        const betPercent =
          rawBetPercent === undefined ? undefined : splitPercent(rawBetPercent);
        const moneyPercent =
          rawMoneyPercent === undefined
            ? undefined
            : splitPercent(rawMoneyPercent);
        if (betPercent === undefined && moneyPercent === undefined) return [];
        return [
          {
            selectionKey: side,
            ...(finite(pointValue)
              ? marketKey === "moneyline"
                ? { americanOdds: pointValue }
                : { point: pointValue }
              : {}),
            ...(betPercent === undefined ? {} : { betPercent }),
            ...(moneyPercent === undefined ? {} : { moneyPercent }),
          },
        ];
      });
      if (selections.length > 0) markets.push({ marketKey, selections });
    };
    add("spread", ["away", "home"], "line");
    add("total", ["over", "under"], "odds");
    add("moneyline", ["away", "home"], "odds");
    return {
      ...sourceEvent,
      sportsbookId: value["book"],
      providerTimestamp,
      markets,
    };
  });
  const rowBooks = new Set(items.map(({ sportsbookId }) => sportsbookId));
  const metaBooks = new Set(
    (Array.isArray(metaBookValues) ? metaBookValues : []) as string[],
  );
  if (
    rowBooks.size !== metaBooks.size ||
    [...rowBooks].some((book) => !metaBooks.has(book))
  )
    throw invalid("book-set");
  if (items.length === 0) {
    if (
      (meta["oldest"] !== null && meta["oldest"] !== undefined) ||
      (meta["newest"] !== null && meta["newest"] !== undefined)
    )
      throw invalid("empty-range");
  } else {
    if (!instant(meta["oldest"]) || !instant(meta["newest"]))
      throw invalid("range");
    const timestamps = items.map(({ providerTimestamp }) =>
      Date.parse(providerTimestamp),
    );
    if (
      Math.abs(Math.min(...timestamps) - Date.parse(meta["oldest"])) > 2_000 ||
      Math.abs(Math.max(...timestamps) - Date.parse(meta["newest"])) > 2_000
    )
      throw invalid("range");
  }
  return { items, retrievedAt };
}

export const latestSharpApiSplitHistoryByBook = (
  items: readonly SharpApiSplitEvent[],
  books: readonly string[] = ["draftkings", "circa"],
) => {
  const accepted = new Set(books.map((book) => book.toLowerCase()));
  const latest = new Map<string, SharpApiSplitEvent>();
  for (const item of items) {
    const sportsbookId = item.sportsbookId.toLowerCase();
    if (!accepted.has(sportsbookId)) continue;
    const previous = latest.get(sportsbookId);
    if (
      !previous ||
      Date.parse(item.providerTimestamp) >
        Date.parse(previous.providerTimestamp)
    )
      latest.set(sportsbookId, item);
  }
  return [...latest.values()].sort((left, right) =>
    left.sportsbookId.localeCompare(right.sportsbookId),
  );
};

export async function fetchSharpApiAccount(
  apiKey: string,
  fetcher: typeof fetch = fetch,
): Promise<SharpApiAccount> {
  try {
    const { payload, metadata } = await request(
      "/account",
      "account",
      apiKey,
      fetcher,
    );
    return { ...parseSharpApiAccount(payload), responseMetadata: metadata };
  } catch (error) {
    return rethrowInvalidResponseAt(error, "account");
  }
}

export async function fetchSharpApiCatalog(
  apiKey: string,
  fetcher: typeof fetch = fetch,
): Promise<SharpApiCatalogSnapshot> {
  const retrievedAt = new Date().toISOString() as IsoTimestamp;
  try {
    // These share one provider account/rate window. Keep the catalogue pair
    // ordered so the second response carries the conservative remaining
    // allowance and a low balance cannot be overshot by a concurrent request.
    const sportsResponse = await request(
      "/sports?include_empty=true",
      "sports",
      apiKey,
      fetcher,
      20_000,
    );
    const leaguesResponse = await request(
      "/leagues?include_empty=true",
      "leagues",
      apiKey,
      fetcher,
      20_000,
    );
    const sports = parseSharpApiSportsCatalog(
      sportsResponse.payload,
      retrievedAt,
    );
    const leagues = parseSharpApiLeaguesCatalog(
      leaguesResponse.payload,
      retrievedAt,
    );
    if (!sports.providerUpdatedAt || !leagues.providerUpdatedAt)
      throw invalidResponse("leagues", "catalog-generation");
    return {
      sports: sports.sports,
      leagues: leagues.leagues,
      quarantines: [
        ...sports.quarantines,
        ...leagues.quarantines.map((item) => ({
          ...item,
          rowIndex: sports.sourceRows + item.rowIndex,
        })),
      ],
      sourceRows: sports.sourceRows + leagues.sourceRows,
      // SharpAPI documents updated_at as the emission time of each response,
      // not a cross-endpoint transaction identifier. The ordered /leagues
      // response is the latest bounded catalog observation. The endpoints are
      // not transactional, so the worker reconciles their membership union
      // instead of rejecting a short-lived cross-response mismatch.
      providerUpdatedAt: leagues.providerUpdatedAt,
      retrievedAt,
      responseMetadata: leaguesResponse.metadata,
    };
  } catch (error) {
    if (
      error instanceof SharpApiError &&
      error.code === "invalid-response" &&
      error.stage
    )
      throw error;
    return rethrowInvalidResponseAt(error, "sports");
  }
}

export async function fetchSharpApiUniversalEventsPage(
  apiKey: string,
  filter: SharpApiUniversalEventFilter,
  offset = 0,
  fetcher: typeof fetch = fetch,
): Promise<SharpApiUniversalPage<SharpApiUniversalEvent>> {
  const leagues = filter.leagues;
  if (
    !nonNegativeInteger(offset) ||
    offset > UNIVERSAL_EVENTS_MAX_OFFSET ||
    !storageKeyComponent(filter.sport, 64) ||
    filter.sport.includes(",") ||
    (leagues !== undefined &&
      (!Array.isArray(leagues) ||
        leagues.length === 0 ||
        leagues.length > 50 ||
        new Set(leagues).size !== leagues.length ||
        leagues.some(
          (league) => !storageKeyComponent(league, 128) || league.includes(","),
        )))
  )
    throw new SharpApiError("configuration");
  const query = new URLSearchParams({
    sport: filter.sport,
    limit: String(UNIVERSAL_EVENTS_PAGE_LIMIT),
    offset: String(offset),
  });
  if (leagues) query.set("league", leagues.join(","));
  if (query.toString().length > 4_096) throw new SharpApiError("configuration");
  const retrievedAt = new Date().toISOString() as IsoTimestamp;
  try {
    const { payload, metadata } = await request(
      `/events?${query.toString()}`,
      "universal-events",
      apiKey,
      fetcher,
      20_000,
    );
    const page = parseSharpApiUniversalEventsPage(payload, retrievedAt, offset);
    if (!page.providerUpdatedAt)
      throw invalidResponse("universal-events", "updated-at-missing");
    return {
      ...page,
      responseMetadata: metadata,
    };
  } catch (error) {
    return rethrowInvalidResponseAt(error, "universal-events");
  }
}

export async function fetchSharpApiUniversalOddsPage(
  apiKey: string,
  cursor?: string,
  fetcher: typeof fetch = fetch,
): Promise<SharpApiUniversalPage<SharpApiUniversalOddsRecord>> {
  if (cursor !== undefined && !storageKeyComponent(cursor, 4096))
    throw new SharpApiError("configuration");
  const query = new URLSearchParams({
    limit: String(UNIVERSAL_ODDS_PAGE_LIMIT),
  });
  if (cursor) query.set("cursor", cursor);
  const retrievedAt = new Date().toISOString() as IsoTimestamp;
  try {
    const { payload, metadata } = await request(
      `/odds?${query.toString()}`,
      "universal-odds",
      apiKey,
      fetcher,
      25_000,
    );
    const page = parseSharpApiUniversalOddsPage(
      payload,
      retrievedAt,
      UNIVERSAL_ODDS_PAGE_LIMIT,
    );
    if (!page.providerUpdatedAt)
      throw invalidResponse("universal-odds", "updated-at-missing");
    return {
      ...page,
      responseMetadata: metadata,
    };
  } catch (error) {
    return rethrowInvalidResponseAt(error, "universal-odds");
  }
}

/**
 * Every provider catalogue a league's odds may legitimately arrive from: its
 * own, plus any secondary catalogue carrying fixtures it already schedules.
 */
export const acceptedProviderLeagues = (
  league: SharpApiLeague,
): readonly string[] => [
  league.providerLeague,
  ...(league.secondaryOddsProviderLeagues ?? []),
];

/**
 * The secondary catalogue a row came from, or null when it is the league's
 * own. A secondary row may only alias onto an event this league already has.
 */
export const secondaryLeagueOf = (
  league: SharpApiLeague,
  rowLeague: string,
): string | null =>
  (league.secondaryOddsProviderLeagues ?? []).find(
    (candidate) => candidate.toLowerCase() === rowLeague.toLowerCase(),
  ) ?? null;

export async function fetchSharpApiOddsPage(
  league: SharpApiLeague,
  apiKey: string,
  cursor?: string,
  fetcher: typeof fetch = fetch,
): Promise<SharpApiOddsPage> {
  const query = new URLSearchParams({
    // REVERTED 2026-08-12. `league` IS comma-separated and the combined
    // request works when called by hand — but asking for MLS,leagues_cup in
    // the ingestion path took MLS from completing 19-20 pages a run to
    // skipping every pass with provider-recovering, and reverting the
    // schedule parser did not bring it back. A working league is worth more
    // than an unpriced one, so the request narrows again until the cause is
    // understood. See spec-leagues-cup-odds-resolution.md.
    league: league.providerLeague,
    market: "main",
    is_live: "false",
    limit: "200",
  });
  if (cursor) query.set("cursor", cursor);
  const retrievedAt = new Date().toISOString() as IsoTimestamp;
  try {
    const { payload, metadata } = await request(
      `/odds?${query.toString()}`,
      "odds",
      apiKey,
      fetcher,
    );
    return {
      ...parseSharpApiOddsPage(
        payload,
        league,
        retrievedAt,
        200,
        cursor ? "cursor" : "initial",
      ),
      responseMetadata: metadata,
    };
  } catch (error) {
    return rethrowInvalidResponseAt(error, "odds");
  }
}

export interface SharpApiOddsRequestMetadata {
  readonly endpointMode: "featured" | "focused";
  readonly leagueKey: SharpApiLeague["leagueKey"];
  readonly providerLeague: string;
  readonly marketSet: readonly ["main"];
  readonly providerEventId?: string;
}

export interface SharpApiOddsOperation {
  readonly page: SharpApiOddsPage;
  readonly request: SharpApiOddsRequestMetadata;
}

export async function fetchSharpApiFeaturedOdds(
  league: SharpApiLeague,
  apiKey: string,
  cursor?: string,
  fetcher: typeof fetch = fetch,
): Promise<SharpApiOddsOperation> {
  return {
    page: await fetchSharpApiOddsPage(league, apiKey, cursor, fetcher),
    request: {
      endpointMode: "featured",
      leagueKey: league.leagueKey,
      providerLeague: league.providerLeague,
      marketSet: ["main"],
    },
  };
}

export async function fetchSharpApiEventOdds(
  league: SharpApiLeague,
  providerEventId: string,
  apiKey: string,
  fetcher: typeof fetch = fetch,
): Promise<SharpApiOddsOperation> {
  if (!canonical(providerEventId, 256))
    throw new SharpApiError("configuration");
  const retrievedAt = new Date().toISOString() as IsoTimestamp;
  try {
    const response = await request(
      `/events/${encodeURIComponent(providerEventId)}/odds`,
      "focused-odds",
      apiKey,
      fetcher,
    );
    const payload = response.payload;
    if (!record(payload)) throw invalidResponse("focused-odds", "envelope");
    assertProviderEnvelope(payload, "focused-odds");
    if (!Array.isArray(payload["data"]) && payload["data"] !== null)
      throw invalidResponse("focused-odds", "envelope");
    if (Array.isArray(payload["data"]) && payload["data"].length > 5_000)
      throw invalidResponse("focused-odds", "envelope");
    if (record(payload["pagination"])) {
      const hasMore = payload["pagination"]["has_more"];
      if (
        (hasMore !== undefined && typeof hasMore !== "boolean") ||
        hasMore === true
      )
        throw invalidResponse("focused-odds", "pagination-envelope");
    }
    for (const row of Array.isArray(payload["data"]) ? payload["data"] : []) {
      if (
        !record(row) ||
        row["event_id"] !== providerEventId ||
        !canonical(row["league"], 128) ||
        ![
          league.leagueKey,
          ...acceptedProviderLeagues(league).map((name) => name.toLowerCase()),
        ].includes(row["league"].toLowerCase())
      )
        throw invalidResponse("focused-odds", "identity");
    }
    const page = {
      ...parseSharpApiOddsPage(
        record(payload["pagination"])
          ? payload
          : {
              ...payload,
              pagination: {
                has_more: false,
                next_cursor: null,
                count: Array.isArray(payload["data"])
                  ? payload["data"].length
                  : 0,
                total: Array.isArray(payload["data"])
                  ? payload["data"].length
                  : 0,
              },
            },
        league,
        retrievedAt,
        5_000,
        "focused",
      ),
      responseMetadata: response.metadata,
    };
    if (page.events.some((event) => event.providerEventId !== providerEventId))
      throw invalidResponse("focused-odds", "identity");
    return {
      page,
      request: {
        endpointMode: "focused",
        leagueKey: league.leagueKey,
        providerLeague: league.providerLeague,
        marketSet: ["main"],
        providerEventId,
      },
    };
  } catch (error) {
    return rethrowInvalidResponseAt(error, "focused-odds");
  }
}

export async function fetchSharpApiSchedulePage(
  league: SharpApiLeague,
  apiKey: string,
  offset = 0,
  fetcher: typeof fetch = fetch,
): Promise<SharpApiSchedulePage> {
  const query = new URLSearchParams({
    league: league.providerLeague.toLowerCase(),
    live: "false",
    limit: "200",
    offset: String(offset),
  });
  const retrievedAt = new Date().toISOString() as IsoTimestamp;
  try {
    const { payload, metadata } = await request(
      `/events?${query.toString()}`,
      "schedule",
      apiKey,
      fetcher,
    );
    return {
      ...parseSharpApiSchedulePage(payload, league, retrievedAt),
      responseMetadata: metadata,
    };
  } catch (error) {
    return rethrowInvalidResponseAt(error, "schedule");
  }
}

export async function fetchSharpApiSplitsPage(
  league: SharpApiLeague,
  apiKey: string,
  offset = 0,
  fetcher: typeof fetch = fetch,
): Promise<SharpApiSplitPage> {
  const query = new URLSearchParams({
    league: league.providerLeague.toLowerCase(),
    limit: "200",
    offset: String(offset),
  });
  const retrievedAt = new Date().toISOString() as IsoTimestamp;
  try {
    const { payload, metadata } = await request(
      `/splits?${query.toString()}`,
      "splits",
      apiKey,
      fetcher,
    );
    return {
      ...parseSharpApiSplitPage(payload, retrievedAt),
      responseMetadata: metadata,
    };
  } catch (error) {
    return rethrowInvalidResponseAt(error, "splits");
  }
}

export async function fetchSharpApiSplitHistory(
  sourceEvent: SharpApiSplitEvent,
  startTime: IsoTimestamp,
  endTime: IsoTimestamp,
  apiKey: string,
  fetcher: typeof fetch = fetch,
): Promise<SharpApiSplitHistoryPage> {
  const query = new URLSearchParams({
    event_id: sourceEvent.providerEventId,
    start_time: startTime,
    end_time: endTime,
    limit: "200",
  });
  const retrievedAt = new Date().toISOString() as IsoTimestamp;
  try {
    const { payload, metadata } = await request(
      `/splits/history?${query.toString()}`,
      "splits-history",
      apiKey,
      fetcher,
    );
    return {
      ...parseSharpApiSplitHistoryPage(
        payload,
        sourceEvent,
        retrievedAt,
        startTime,
        endTime,
      ),
      responseMetadata: metadata,
    };
  } catch (error) {
    return rethrowInvalidResponseAt(error, "splits-history");
  }
}

export function validateSharpApiActivation(value: SharpApiActivationConfig) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("sharpapi-config-invalid");
  for (const [field, minimum] of [
    ["splitFreshnessSeconds", 1],
    ["quotaReserve", 0],
    ["cooldownSeconds", 1],
    ["recoverySuccesses", 1],
  ] as const) {
    const number = value[field];
    if (!Number.isSafeInteger(number) || number < minimum)
      throw new Error("sharpapi-config-invalid");
  }
  if (value.enabled && (!value.contractVerified || !value.licensingVerified))
    throw new Error("sharpapi-activation-unverified");
  const identities = new Set<string>();
  for (const entry of value.coverage) {
    if (
      !canonical(entry.sportKey) ||
      !canonical(entry.leagueKey) ||
      !["odds", "public-betting"].includes(entry.capability) ||
      !Array.isArray(entry.marketKeys) ||
      entry.marketKeys.some((marketKey) => !canonical(marketKey)) ||
      new Set(entry.marketKeys).size !== entry.marketKeys.length
    )
      throw new Error("sharpapi-coverage-invalid");
    const identity = `${entry.sportKey}\u0000${entry.leagueKey}\u0000${entry.capability}`;
    if (identities.has(identity))
      throw new Error("sharpapi-coverage-duplicate");
    identities.add(identity);
    if (entry.enabled) {
      if (
        !value.contractVerified ||
        entry.reason !== undefined ||
        entry.marketKeys.length === 0
      )
        throw new Error("sharpapi-coverage-unverified");
    } else if (!entry.reason || entry.marketKeys.length > 0) {
      throw new Error("sharpapi-disabled-reason-required");
    }
  }
  return structuredClone(value);
}

export function sharpApiDescriptor(
  config: SharpApiActivationConfig,
): ProviderDescriptor | null {
  const validated = validateSharpApiActivation(config);
  if (!validated.enabled) return null;
  const enabled = validated.coverage.filter((entry) => entry.enabled);
  const grouped = new Map<string, typeof enabled>();
  for (const entry of enabled) {
    const key = `${entry.sportKey}\u0000${entry.leagueKey}`;
    grouped.set(key, [...(grouped.get(key) ?? []), entry]);
  }
  if (grouped.size === 0) throw new Error("sharpapi-coverage-empty");
  return {
    id: SHARP_API_PROVIDER_ID,
    displayName: "Odds Feed",
    capabilities: [...new Set(enabled.map(({ capability }) => capability))],
    coverage: {
      leagues: [...grouped.values()].map((entries) => ({
        sportKey: entries[0]!.sportKey,
        leagueKey: entries[0]!.leagueKey,
        capabilities: entries.map(({ capability }) => capability),
        marketKeys: [
          ...new Set(entries.flatMap(({ marketKeys }) => marketKeys)),
        ],
      })),
    },
    expectedFreshnessSeconds: validated.splitFreshnessSeconds,
    qualityTier: "premium",
  };
}
