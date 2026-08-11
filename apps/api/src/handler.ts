import {
  EventCursorError,
  EventInputError,
  type GamesRepository,
  type BettingSplitRepository,
  type CohortRepository,
  type EventRepository,
  type RetrospectiveRepository,
  RetrospectiveConflictError,
  RetrospectiveNotFoundError,
  StrategyExperimentConflictError,
  StrategyExperimentNotFoundError,
  type StrategyExperimentRepository,
  type OddsHistoryRepository,
  OddsHistoryInputError,
  RankedOpportunityUnavailableError,
  type ArbitrageBoardRepository,
  type ClvRepository,
  type RankedOpportunityRepository,
  type ScoutingReportRepository,
  type WatchlistRepository,
  type IdentityRepository,
  attachSplits,
  boardCounts,
  type BoardKey,
  type GamesPage,
  type StoredBoard,
} from "@find-the-edge/database";
import {
  approvedSportsbookCollection,
  defaultOpportunityRankingPolicy,
} from "@find-the-edge/config";
import {
  assertWatchlistEventId,
  assertWatchlistRequesterId,
  canonicalMvpMarketKeys,
  createWatchlistEntry,
  EVENT_LIFECYCLE_STATES,
  opportunityWarningCodes,
  participantSelectionKey,
  WATCHLIST_ENTRY_SCHEMA_VERSION,
  type EntityId,
  type EventDisplayDto,
  type ProviderStatusPageDto,
  type ScoutingReportVersionRecord,
  type WatchlistEntry,
} from "@find-the-edge/domain";
import { createHash } from "node:crypto";
import type {
  ScoutingHttpRequest,
  ScoutingHttpResponse,
} from "./scouting-handler";
import {
  createIdentityHttpHandler,
  type IdentityObservation,
  type IdentityRuntime,
} from "./identity-handler";
import { createSplitLookupCache } from "./splits-cache";
export interface ApiRequest {
  readonly route:
    | "list"
    | "detail"
    | "games"
    | "odds-history"
    | "splits"
    | "performance-list"
    | "performance-detail"
    | "performance-members"
    | "performance-reports"
    | "retrospective-list"
    | "retrospective-detail"
    | "retrospective-versions"
    | "retrospective-review"
    | "experiment-list"
    | "experiment-detail"
    | "experiment-approve"
    | "experiment-promote"
    | "experiment-rollback"
    | "opportunity-list"
    | "opportunity-detail"
    | "arbitrage-list"
    | "clv-list"
    | "provider-status"
    | "scout-create"
    | "scout-status"
    | "scout-retry"
    | "scout-report-by-job"
    | "scout-report-versions"
    | "scout-report-version"
    | "watchlist-list"
    | "watchlist-add"
    | "watchlist-remove"
    // Public by design: these routes are how a caller obtains a token, so
    // they cannot sit behind one.
    | "auth-otp-request"
    | "auth-otp-verify"
    | "auth-session-refresh";
  readonly subject?: string;
  readonly scopes?: readonly string[];
  readonly eventId?: string;
  /**
   * Decode-depth variants of the event-id path segment, most-likely-true
   * first. API Gateway over-decodes path parameters, which corrupts
   * canonical ids that embed percent sequences; the handler resolves the
   * variants against the store instead of trusting one decode depth.
   */
  readonly eventIdAlternatives?: readonly string[];
  readonly sportKey?: string;
  readonly opportunityId?: string;
  readonly jobId?: string;
  readonly reportId?: string;
  /** Raw path segment; validated as a bounded positive integer. */
  readonly versionNumber?: string;
  readonly idempotencyKey?: string;
  readonly requestId?: string;
  readonly query?: Readonly<Record<string, string | undefined>>;
  readonly method?: "GET" | "POST" | "DELETE";
  readonly contentType?: string;
  readonly body?: string;
  readonly reviewerAuthorized?: boolean;
  readonly strategyPromoterAuthorized?: boolean;
  /** Raw `Authorization` header, read only by the session-refresh route. */
  readonly authorization?: string;
  /** Gateway-observed source address, used only as a rate-limit subject. */
  readonly sourceIp?: string;
}

const safeDecode = (value: string): string | null => {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
};
/**
 * Canonical event ids embed percent sequences ("event:mlb%3Amlb:…"), and API
 * Gateway HTTP APIs decode the path once for routing and once more when
 * extracting path parameters — an over-decode that destroys those ids
 * irreversibly. The raw path still holds the segment at a lower decode
 * depth. Because the gateway's exact rawPath encoding differs between
 * environments, every plausible decode depth is offered as a candidate and
 * the handler resolves them against the store, most-likely-true first.
 */
export const eventIdCandidates = (
  rawPath: string | undefined,
  routeKey: string | undefined,
  reported: string | undefined,
): readonly string[] => {
  const candidates: string[] = [];
  const push = (value: string | null | undefined) => {
    if (typeof value === "string" && value.length > 0)
      if (!candidates.includes(value)) candidates.push(value);
  };
  if (rawPath && routeKey) {
    const template = routeKey.split(" ")[1]?.split("/") ?? [];
    const actual = rawPath.split("/");
    const slot = template.indexOf("{eventId}");
    if (slot !== -1 && template.length === actual.length) {
      const segment = actual[slot];
      push(segment);
      if (segment) push(safeDecode(segment));
    }
  }
  // Observed on the hosted gateway: rawPath arrives as fully decoded as the
  // path parameters, so the raw id cannot be read off the request at all.
  // The canonical grammar recovers it: an id is
  // event:<sport%3Aleague>:<provider-event-id>, so a reported value with
  // four or more colon parts had its interior %3A destroyed — re-encoding
  // the interior joins reconstructs the stored id.
  if (reported) {
    const parts = reported.split(":");
    if (parts.length >= 4 && parts.every((part) => part.length > 0))
      push(
        `${parts[0]}:${parts.slice(1, -1).join("%3A")}:${parts[parts.length - 1]}`,
      );
  }
  push(reported);
  return candidates;
};

// Module scope on purpose: the handler is rebuilt per invocation, so a cache
// owned by it would never survive to serve a second request.
const splitLookupCache = createSplitLookupCache<
  Awaited<ReturnType<BettingSplitRepository["listCurrent"]>>
>({ ttlMs: 30_000, maxEntries: 512 });

// Whole-response cache for the anonymous games and splits boards. The window
// is short against the five-minute ingest cadence, so it trades at most
// fifteen seconds of staleness for serving repeats without any storage reads.
const boardResponseCache = createSplitLookupCache<{
  readonly body: ApiResponse;
  readonly counts: { stale: number; partial: number; unavailable: number };
}>({ ttlMs: 15_000, maxEntries: 64 });

/** Test hook: module-scope caches otherwise bleed between handler instances. */
export const clearHandlerCaches = () => {
  splitLookupCache.clear();
  boardResponseCache.clear();
};

// Board assembly is shared with the materializing worker so both produce
// byte-identical responses.
export { publishedSplitScopes } from "@find-the-edge/database";
export interface ApiResponse {
  readonly statusCode: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}
const response = (statusCode: number, body: unknown): ApiResponse => ({
  statusCode,
  headers: { "content-type": "application/json", "cache-control": "no-store" },
  body: JSON.stringify(body),
});
/** A removal returns no representation, so it carries no body at all. */
const noContent = (): ApiResponse => ({
  statusCode: 204,
  headers: { "cache-control": "no-store" },
  body: "",
});
/**
 * Public projection of a watchlist entry. The requester is never echoed: the
 * caller already is the requester, and the subject is identity data that has
 * no place in a response body or a log line.
 */
const toWatchlistDto = (entry: WatchlistEntry) => ({
  schemaVersion: WATCHLIST_ENTRY_SCHEMA_VERSION,
  eventId: entry.canonicalEventId,
  eventVersion: entry.canonicalEventVersion,
  sportKey: entry.sportKey,
  leagueKey: entry.leagueKey,
  startsAt: entry.startsAt,
  addedAt: entry.addedAt,
});
/** The add body carries exactly one field: the event to watch. */
const isWatchlistAddBody = (
  value: unknown,
): value is { readonly eventId: string } =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  Object.keys(value).join("|") === "eventId" &&
  "eventId" in value &&
  typeof value.eventId === "string";
/** Mutation logs identify the user by a stable digest, never by subject. */
const requesterDigest = (requesterId: string): string =>
  createHash("sha256")
    .update("fte:watchlist-requester:v1")
    .update(requesterId)
    .digest("hex")
    .slice(0, 32);
const SCOUT_REPORT_ID = /^scout-report:[a-f0-9]{64}$/;
const SCOUT_REPORT_JOB_ID = /^scout-job:[a-f0-9]{64}$/;
/** Positive integer within the storage layer's 16-digit padding bound. */
const SCOUT_REPORT_VERSION_NUMBER = /^[1-9][0-9]{0,15}$/;
/**
 * Public projection of a stored report version: the full payload, provenance,
 * and change summary the report screen renders, plus the head's latest
 * version number so the client knows history depth. Internal identities
 * (attempt id, draft hash, predecessor fence, persistence fingerprint) never
 * leave the storage layer.
 */
const toScoutReportDto = (
  version: ScoutingReportVersionRecord,
  latestVersionNumber: number,
) => ({
  schemaVersion: "scout-report-v1" as const,
  reportId: version.reportId,
  versionNumber: version.versionNumber,
  latestVersionNumber,
  jobId: version.jobId,
  eventId: version.eventId,
  eventVersion: version.eventVersion,
  generatedAt: version.generatedAt,
  validationOutcome: version.validationOutcome,
  changeSummary: version.changeSummary,
  payload: version.payload,
  provenance: version.provenance,
});
export const createEventHandler =
  (
    repository: EventRepository,
    gamesOrLog?:
      GamesRepository | ((entry: Readonly<Record<string, unknown>>) => void),
    suppliedLog?: (entry: Readonly<Record<string, unknown>>) => void,
    splitsRepository?: BettingSplitRepository,
    cohortRepository?: CohortRepository,
    retrospectiveRepository?: RetrospectiveRepository,
    strategyExperimentRepository?: StrategyExperimentRepository,
    oddsHistoryRepository?: OddsHistoryRepository,
    rankedOpportunityRepository?: RankedOpportunityRepository,
    providerStatus?: () => Promise<ProviderStatusPageDto>,
    scoutingHandler?: (
      request: ScoutingHttpRequest,
    ) => Promise<ScoutingHttpResponse>,
    loadStoredBoard?: (key: BoardKey) => Promise<StoredBoard | null>,
    arbitrageBoardRepository?: ArbitrageBoardRepository,
    clvRepository?: ClvRepository,
    scoutingReportRepository?: ScoutingReportRepository,
    watchlistRepository?: WatchlistRepository,
    identityRepository?: IdentityRepository,
    identityRuntime?: IdentityRuntime,
  ) =>
  async (request: ApiRequest): Promise<ApiResponse> => {
    const gamesRepository =
      typeof gamesOrLog === "function" ? undefined : gamesOrLog;
    const log =
      typeof gamesOrLog === "function"
        ? gamesOrLog
        : (suppliedLog ?? console.log);
    const started = Date.now();
    let status = 200;
    let metadataCounts: {
      stale: number;
      partial: number;
      unavailable: number;
    } | null = null;
    let detailOddsCounts: {
      stale: number;
      partial: number;
      suspendedOrUnavailable: number;
    } | null = null;
    let oddsHistoryCounts: {
      series: number;
      sportsbooks: number;
      points: number;
    } | null = null;
    let opportunityCounts: {
      discovered: number;
      returned: number;
      filtered: number;
      stale: number;
      joinFailure: number;
      cursorRejected: number;
    } | null = null;
    let identityObservation: IdentityObservation | null = null;
    try {
      if (
        request.route === "auth-otp-request" ||
        request.route === "auth-otp-verify" ||
        request.route === "auth-session-refresh"
      ) {
        if (!identityRepository || !identityRuntime)
          throw new Error("identity-service-not-configured");
        const result = await createIdentityHttpHandler(
          identityRepository,
          identityRuntime,
        )({
          route: request.route,
          ...(request.method ? { method: request.method } : {}),
          ...(request.contentType ? { contentType: request.contentType } : {}),
          ...(request.body === undefined ? {} : { body: request.body }),
          ...(request.authorization
            ? { authorization: request.authorization }
            : {}),
          ...(request.sourceIp ? { sourceIp: request.sourceIp } : {}),
          ...(request.query ? { query: request.query } : {}),
        });
        identityObservation = result.observation;
        // The only identity data in this line is a peppered digest of the
        // number: never the number, never the code, never the token.
        log({
          event: "identity-request",
          route: request.route,
          outcome: result.observation.outcome,
          ...(result.observation.delivery
            ? { delivery: result.observation.delivery }
            : {}),
          ...(result.observation.failureClass
            ? { failureClass: result.observation.failureClass }
            : {}),
          ...(result.observation.phoneDigest
            ? { phoneDigest: result.observation.phoneDigest }
            : {}),
          ...(request.requestId
            ? { requestId: request.requestId.slice(0, 128) }
            : {}),
        });
        status = result.response.statusCode;
        return result.response;
      }
      if (request.route.startsWith("watchlist-")) {
        if (!watchlistRepository)
          throw new Error("watchlist-repository-not-configured");
        if (!request.subject)
          return response((status = 401), { error: "unauthorized" });
        // The partition is derived from the token subject and nothing else,
        // so a caller can only ever read or write their own watchlist.
        let requesterId: string;
        try {
          requesterId = assertWatchlistRequesterId(request.subject);
        } catch {
          return response((status = 401), { error: "unauthorized" });
        }
        if (Object.keys(request.query ?? {}).length > 0)
          throw new EventInputError("watchlist-query-invalid");
        if (request.route === "watchlist-list") {
          if (request.method !== "GET" || request.body !== undefined)
            throw new EventInputError("watchlist-request-invalid");
          const items = await watchlistRepository.list(requesterId);
          return response(200, {
            schemaVersion: "watchlist-page-v1",
            items: items.map(toWatchlistDto),
          });
        }
        if (request.route === "watchlist-remove") {
          if (request.method !== "DELETE" || request.body !== undefined)
            throw new EventInputError("watchlist-request-invalid");
          // The gateway over-decodes path parameters, so the id on the wire
          // may not be the stored id. The watchlist itself is the authority
          // for a removal: whichever decode variant names a watched entry is
          // the one to delete.
          const candidates =
            request.eventIdAlternatives &&
            request.eventIdAlternatives.length > 0
              ? request.eventIdAlternatives
              : [request.eventId ?? ""];
          const syntactic = candidates.filter((candidate) => {
            try {
              assertWatchlistEventId(candidate);
              return true;
            } catch {
              return false;
            }
          });
          if (syntactic.length === 0)
            throw new EventInputError("watchlist-event-id-invalid");
          const watched = await watchlistRepository.list(requesterId);
          const match = syntactic.find((candidate) =>
            watched.some((entry) => entry.canonicalEventId === candidate),
          );
          if (match) await watchlistRepository.remove(requesterId, match);
          log({
            event: "watchlist-mutation",
            action: "remove",
            outcome: match ? "removed" : "absent",
            eventId: (match ?? syntactic[0] ?? "").slice(0, 512),
            requesterDigest: requesterDigest(requesterId),
            ...(request.requestId
              ? { requestId: request.requestId.slice(0, 128) }
              : {}),
          });
          status = 204;
          return noContent();
        }
        if (
          request.method !== "POST" ||
          request.contentType?.split(";")[0]?.trim().toLowerCase() !==
            "application/json" ||
          !request.body ||
          Buffer.byteLength(request.body) > 1024
        )
          throw new EventInputError("watchlist-body-invalid");
        let parsed: unknown;
        try {
          parsed = JSON.parse(request.body);
        } catch {
          throw new EventInputError("watchlist-json-invalid");
        }
        if (!isWatchlistAddBody(parsed))
          throw new EventInputError("watchlist-body-invalid");
        const requestedEventId = parsed.eventId;
        // A body-supplied id can also arrive with its percent sequences
        // already destroyed, so it resolves through the same candidate
        // machinery the detail route uses, against the same store.
        let event: EventDisplayDto | null = null;
        for (const candidate of eventIdCandidates(
          undefined,
          undefined,
          requestedEventId,
        )) {
          try {
            const found = await repository.detail(candidate);
            if (found.item) {
              event = found.item;
              break;
            }
          } catch {
            // A decode variant the grammar rejects is simply not the id.
          }
        }
        // Missing, deleted, and never-existed events are one neutral answer.
        if (!event) return response((status = 404), { error: "not-found" });
        const result = await watchlistRepository.add(
          createWatchlistEntry({
            requesterId,
            canonicalEventId: event.id,
            canonicalEventVersion: event.version,
            sportKey: event.sportKey,
            leagueKey: event.leagueKey,
            startsAt: event.startsAt,
            addedAt: new Date().toISOString(),
          }),
        );
        log({
          event: "watchlist-mutation",
          action: "add",
          outcome: result.outcome,
          eventId: result.entry.canonicalEventId,
          requesterDigest: requesterDigest(requesterId),
          ...(request.requestId
            ? { requestId: request.requestId.slice(0, 128) }
            : {}),
        });
        return response(
          (status = result.outcome === "created" ? 201 : 200),
          toWatchlistDto(result.entry),
        );
      }
      if (request.route.startsWith("scout-report-")) {
        if (!scoutingReportRepository)
          throw new Error("scouting-report-repository-not-configured");
        if (!request.subject)
          return response((status = 401), { error: "unauthorized" });
        if (!request.scopes?.includes("events/scouting:read"))
          return response((status = 403), { error: "forbidden" });
        if (
          request.method !== "GET" ||
          request.body !== undefined ||
          Object.keys(request.query ?? {}).length > 0
        )
          throw new EventInputError("scout-report-request-invalid");
        const requesterId = request.subject;
        if (request.route === "scout-report-by-job") {
          if (!SCOUT_REPORT_JOB_ID.test(request.jobId ?? ""))
            throw new EventInputError("scout-report-job-id-invalid");
          const version = await scoutingReportRepository.getByJobBinding(
            request.jobId ?? "",
            requesterId,
          );
          if (!version) return response((status = 404), { error: "not-found" });
          const head = await scoutingReportRepository.getHead(
            version.reportId,
            requesterId,
          );
          if (!head) throw new Error("scout-report-head-missing");
          return response(
            200,
            toScoutReportDto(version, head.latestVersionNumber),
          );
        }
        const reportId = request.reportId ?? "";
        if (!SCOUT_REPORT_ID.test(reportId))
          throw new EventInputError("scout-report-id-invalid");
        if (request.route === "scout-report-version") {
          const versionText = request.versionNumber ?? "";
          if (!SCOUT_REPORT_VERSION_NUMBER.test(versionText))
            throw new EventInputError("scout-report-version-number-invalid");
          const versionNumber = Number(versionText);
          // 16-digit values above the safe-integer range cannot exist in
          // storage; they resolve as neutral missing, never as a cast.
          const version = Number.isSafeInteger(versionNumber)
            ? await scoutingReportRepository.getVersion(
                reportId,
                versionNumber,
                requesterId,
              )
            : null;
          if (!version) return response((status = 404), { error: "not-found" });
          const head = await scoutingReportRepository.getHead(
            reportId,
            requesterId,
          );
          if (!head) throw new Error("scout-report-head-missing");
          return response(
            200,
            toScoutReportDto(version, head.latestVersionNumber),
          );
        }
        const versions = await scoutingReportRepository.listVersions(
          reportId,
          requesterId,
        );
        // A report history always has version 1, so an empty list is the
        // same neutral missing a foreign requester sees.
        if (versions.length === 0)
          return response((status = 404), { error: "not-found" });
        const head = await scoutingReportRepository.getHead(
          reportId,
          requesterId,
        );
        if (!head) throw new Error("scout-report-head-missing");
        return response(200, {
          schemaVersion: "scout-report-versions-v1",
          reportId,
          eventId: head.eventId,
          latestVersionNumber: head.latestVersionNumber,
          updatedAt: head.updatedAt,
          items: versions.map((version) => ({
            versionNumber: version.versionNumber,
            generatedAt: version.generatedAt,
            validationOutcome: version.validationOutcome,
            changeSummary: version.changeSummary,
            jobId: version.jobId,
          })),
        });
      }
      if (request.route.startsWith("scout-")) {
        if (!scoutingHandler)
          throw new Error("scouting-handler-not-configured");
        const result = await scoutingHandler(request as ScoutingHttpRequest);
        status = result.statusCode;
        return result;
      }
      if (request.route === "provider-status") {
        if (!providerStatus)
          throw new Error("provider-status-source-not-configured");
        if (request.method && request.method !== "GET")
          throw new EventInputError("provider-status-method-invalid");
        if (Object.keys(request.query ?? {}).length > 0)
          throw new EventInputError("provider-status-query-invalid");
        return response(200, await providerStatus());
      }
      if (request.route === "clv-list") {
        if (!clvRepository) throw new Error("clv-repository-not-configured");
        const sportKey = request.sportKey ?? "";
        if (
          !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(sportKey) ||
          Object.keys(request.query ?? {}).length > 0
        )
          throw new EventInputError("clv-query-invalid");
        const board = await clvRepository.board(sportKey);
        return response(200, {
          schemaVersion: "clv-page-v1",
          updatedAt: board?.updatedAt ?? null,
          items: board?.results ?? [],
        });
      }
      if (request.route === "arbitrage-list") {
        if (!arbitrageBoardRepository)
          throw new Error("arbitrage-board-repository-not-configured");
        const sportKey = request.sportKey ?? "";
        if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(sportKey))
          throw new EventInputError("arbitrage-sport-invalid");
        const query = request.query ?? {};
        const classification = query["classification"];
        const limitText = query["limit"];
        const limit =
          limitText === undefined
            ? 20
            : /^[1-9]\d?$/.test(limitText)
              ? Number(limitText)
              : Number.NaN;
        if (
          Object.keys(query).some(
            (key) => !["classification", "limit"].includes(key),
          ) ||
          (classification !== undefined &&
            classification !== "arbitrage" &&
            classification !== "low-hold") ||
          !Number.isSafeInteger(limit) ||
          limit < 1 ||
          limit > 50
        )
          throw new EventInputError("arbitrage-query-invalid");
        const asOf = new Date().toISOString();
        const board = await arbitrageBoardRepository.listCurrent(
          sportKey,
          asOf,
        );
        const findings = (board?.findings ?? [])
          .filter(
            (finding) =>
              classification === undefined ||
              finding.classification === classification,
          )
          .slice(0, limit);
        // A finding stores selection keys, not names. Without the event a card
        // can only print "participant%3Amlb%253Amlb%3Aroyals" and never says
        // which game it belongs to, so the matchup and the readable side names
        // are resolved here from the authoritative event projection. A lookup
        // that fails leaves the labels absent rather than inventing one.
        const eventIds = [
          ...new Set(findings.map(({ canonicalEventId }) => canonicalEventId)),
        ];
        const participantsById = new Map<
          string,
          {
            readonly participants: readonly {
              readonly id: string;
              readonly label: string;
            }[];
            readonly startsAt: string;
          }
        >();
        for (const id of eventIds) {
          const detail = await repository.detail(id).catch(() => null);
          const item = detail?.item;
          if (item)
            participantsById.set(id, {
              participants: item.participants,
              startsAt: item.startsAt,
            });
        }
        const sideLabel = (
          selectionKey: string,
          eventId: string,
        ): string | undefined => {
          const known = participantsById.get(eventId);
          const participant = known?.participants.find(
            ({ id }) =>
              participantSelectionKey(id as EntityId) === selectionKey,
          );
          if (participant) return participant.label;
          if (selectionKey === "over") return "Over";
          if (selectionKey === "under") return "Under";
          if (selectionKey === "draw") return "Draw";
          return undefined;
        };
        return response(200, {
          schemaVersion: "arbitrage-page-v1",
          snapshotAt: board?.scannedAt ?? null,
          totalCount: board?.totalCount ?? 0,
          items: findings.map((finding) => {
            const known = participantsById.get(finding.canonicalEventId);
            return {
              ...finding,
              ...(known
                ? {
                    event: {
                      participants: known.participants,
                      startsAt: known.startsAt,
                    },
                  }
                : {}),
              legs: finding.legs.map((leg) => {
                const label = sideLabel(
                  leg.selectionKey,
                  finding.canonicalEventId,
                );
                return label === undefined
                  ? leg
                  : { ...leg, selectionLabel: label };
              }),
            };
          }),
        });
      }
      if (request.route.startsWith("opportunity-")) {
        if (!rankedOpportunityRepository)
          throw new Error("ranked-opportunity-repository-not-configured");
        const sportKey = request.sportKey ?? "";
        if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(sportKey))
          throw new EventInputError("ranked-opportunity-sport-invalid");
        if (request.route === "opportunity-detail") {
          if (
            Object.keys(request.query ?? {}).length > 0 ||
            !/^opportunity:[a-f0-9]{64}$/.test(request.opportunityId ?? "")
          )
            throw new EventInputError("ranked-opportunity-detail-invalid");
          const item = await rankedOpportunityRepository.detail(
            sportKey,
            request.opportunityId ?? "",
          );
          if (!item) return response((status = 404), { error: "not-found" });
          opportunityCounts = {
            discovered: 1,
            returned: 1,
            filtered: 0,
            stale: 0,
            joinFailure: 0,
            cursorRejected: 0,
          };
          return response(200, item);
        }
        const query = request.query ?? {};
        const allowed = [
          "market",
          "target",
          "competition",
          "warning",
          "kickoffFrom",
          "kickoffTo",
          "minEv",
          "minBooks",
          "maxAge",
          "limit",
          "cursor",
        ];
        const number = (value: string | undefined) =>
          value === undefined
            ? undefined
            : /^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)
              ? Number(value)
              : Number.NaN;
        const kickoffFrom = query["kickoffFrom"];
        const kickoffTo = query["kickoffTo"];
        const minEv = number(query["minEv"]);
        const minBooks = number(query["minBooks"]);
        const maxAge = number(query["maxAge"]);
        const limit = number(query["limit"]) ?? 20;
        const canonicalTimestamp = (value: string | undefined) =>
          value === undefined ||
          (Number.isFinite(Date.parse(value)) &&
            new Date(value).toISOString() === value);
        if (
          Object.keys(query).some((key) => !allowed.includes(key)) ||
          (query["market"] !== undefined &&
            !canonicalMvpMarketKeys.includes(query["market"] as never)) ||
          (query["target"] !== undefined &&
            !Object.hasOwn(approvedSportsbookCollection, query["target"])) ||
          (query["competition"] !== undefined &&
            !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(query["competition"])) ||
          (query["warning"] !== undefined &&
            !opportunityWarningCodes.includes(query["warning"] as never)) ||
          !canonicalTimestamp(kickoffFrom) ||
          !canonicalTimestamp(kickoffTo) ||
          (kickoffFrom !== undefined &&
            kickoffTo !== undefined &&
            (Date.parse(kickoffFrom) > Date.parse(kickoffTo) ||
              Date.parse(kickoffTo) - Date.parse(kickoffFrom) >
                31 * 24 * 60 * 60 * 1_000)) ||
          (minEv !== undefined && (!Number.isFinite(minEv) || minEv < 0)) ||
          (minBooks !== undefined &&
            (!Number.isSafeInteger(minBooks) ||
              minBooks < 1 ||
              minBooks > 100)) ||
          (maxAge !== undefined &&
            (!Number.isFinite(maxAge) ||
              maxAge < 0 ||
              maxAge >
                defaultOpportunityRankingPolicy.maximumFilterAgeMinutes)) ||
          !Number.isSafeInteger(limit) ||
          limit < 1 ||
          limit > 50 ||
          (query["cursor"] !== undefined &&
            (query["cursor"].length < 1 || query["cursor"].length > 4096))
        )
          throw new EventInputError("ranked-opportunity-filter-invalid");
        const page = await rankedOpportunityRepository.list({
          sportKey,
          limit,
          ...(query["market"] ? { marketKey: query["market"] } : {}),
          ...(query["target"] ? { targetSportsbookId: query["target"] } : {}),
          ...(query["competition"]
            ? { competitionKey: query["competition"] }
            : {}),
          ...(query["warning"]
            ? { warningCode: query["warning"] as never }
            : {}),
          ...(kickoffFrom ? { kickoffFrom } : {}),
          ...(kickoffTo ? { kickoffTo } : {}),
          ...(minEv !== undefined ? { minimumExpectedValue: minEv } : {}),
          ...(minBooks !== undefined ? { minimumBooks: minBooks } : {}),
          ...(maxAge !== undefined ? { maximumAgeMinutes: maxAge } : {}),
          ...(query["cursor"] ? { cursor: query["cursor"] } : {}),
        });
        opportunityCounts = {
          discovered: page.evaluatedCount,
          returned: page.items.length,
          filtered: page.filteredCount,
          stale: page.staleCount,
          joinFailure: page.joinFailureCount,
          cursorRejected: 0,
        };
        return response(200, page);
      }
      if (request.route.startsWith("experiment-")) {
        if (!strategyExperimentRepository)
          throw new Error("strategy-experiment-repository-not-configured");
        if (request.route === "experiment-list") {
          const limit = Number(request.query?.["limit"] ?? "20");
          if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50)
            throw new EventInputError("strategy-experiment-filter-invalid");
          return response(
            200,
            await strategyExperimentRepository.listExperiments({
              limit,
              ...(request.query?.["cursor"]
                ? { cursor: request.query["cursor"] }
                : {}),
              ...(request.query?.["strategyId"]
                ? { strategyId: request.query["strategyId"] }
                : {}),
              ...(request.query?.["state"]
                ? { state: request.query["state"] as never }
                : {}),
            }),
          );
        }
        const id = request.eventId ?? "";
        if (!/^strategy-experiment:[a-f0-9]{64}$/.test(id))
          throw new EventInputError("strategy-experiment-id-invalid");
        if (request.route === "experiment-detail") {
          const item = await strategyExperimentRepository.getExperiment(id);
          return item
            ? response(200, {
                ...item,
                audit: await strategyExperimentRepository.listAudit(id),
                active: await strategyExperimentRepository.resolveActive(
                  item.challenger.strategyId,
                  new Date().toISOString(),
                ),
              })
            : response(404, { error: "not-found" });
        }
        if (!request.subject)
          return response((status = 401), { error: "unauthorized" });
        if (
          !request.scopes?.includes("strategies:promote") ||
          !request.strategyPromoterAuthorized
        )
          return response((status = 403), { error: "forbidden" });
        if (
          request.method !== "POST" ||
          request.contentType?.split(";")[0]?.trim().toLowerCase() !==
            "application/json" ||
          !request.body ||
          Buffer.byteLength(request.body) > 4096
        )
          throw new EventInputError("strategy-experiment-body-invalid");
        let value: Record<string, unknown>;
        try {
          const parsed: unknown = JSON.parse(request.body);
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
            throw new Error();
          value = parsed as Record<string, unknown>;
        } catch {
          throw new EventInputError("strategy-experiment-json-invalid");
        }
        const text = (key: string) =>
          typeof value[key] === "string" ? value[key] : "";
        const now = new Date().toISOString();
        if (request.route === "experiment-approve")
          return response(
            200,
            await strategyExperimentRepository.approve({
              experimentId: id,
              promoterId: request.subject,
              reason: text("reason"),
              decidedAt: now,
              idempotencyKey: text("idempotencyKey"),
              expectedStateVersion: Number(value["expectedStateVersion"]),
              expectedDigest: text("expectedDigest"),
              artifactDigest: text("artifactDigest"),
            }),
          );
        if (
          typeof value["effectiveAt"] !== "string" ||
          !Number.isFinite(Date.parse(value["effectiveAt"])) ||
          value["effectiveAt"] <= now
        )
          throw new EventInputError("strategy-activation-effective-at-invalid");
        return response(
          200,
          await strategyExperimentRepository.activate({
            experimentId: id,
            strategyId: text("strategyId"),
            artifactVersion: text("artifactVersion"),
            artifactDigest: text("artifactDigest"),
            kind:
              request.route === "experiment-promote" ? "promotion" : "rollback",
            effectiveAt: text("effectiveAt"),
            actorId: request.subject,
            reason: text("reason"),
            idempotencyKey: text("idempotencyKey"),
            expectedActivationId:
              typeof value["expectedActivationId"] === "string"
                ? value["expectedActivationId"]
                : null,
          }),
        );
      }
      if (request.route.startsWith("retrospective-")) {
        if (!retrospectiveRepository)
          throw new Error("retrospective-repository-not-configured");
        const limitText = request.query?.["limit"] ?? "20";
        if (
          !/^(?:[1-9]|[1-4][0-9]|50)$/.test(limitText) ||
          Object.keys(request.query ?? {}).some(
            (key) => !["limit", "cursor"].includes(key),
          )
        )
          throw new EventInputError("invalid-retrospective-filter");
        if (request.route === "retrospective-list")
          return response(
            200,
            await retrospectiveRepository.list({
              limit: Number(limitText),
              ...(request.query?.["cursor"]
                ? { cursor: request.query["cursor"] }
                : {}),
            }),
          );
        const id = request.eventId ?? "";
        if (request.route === "retrospective-detail") {
          if (!/^retrospective-version:[a-f0-9]{64}$/.test(id))
            throw new EventInputError("retrospective-version-id-invalid");
          const item = await retrospectiveRepository.getVersion(id);
          if (!item) return response((status = 404), { error: "not-found" });
          return response(200, {
            ...item,
            audit: await retrospectiveRepository.listAudit({
              versionId: id,
              limit: Number(limitText),
              ...(request.query?.["cursor"]
                ? { cursor: request.query["cursor"] }
                : {}),
            }),
          });
        }
        if (request.route === "retrospective-versions") {
          if (!/^retrospective:[a-f0-9]{64}$/.test(id))
            throw new EventInputError("retrospective-id-invalid");
          return response(
            200,
            await retrospectiveRepository.listVersions({
              retrospectiveId: id,
              limit: Number(limitText),
              ...(request.query?.["cursor"]
                ? { cursor: request.query["cursor"] }
                : {}),
            }),
          );
        }
        if (
          !/^retrospective-version:[a-f0-9]{64}$/.test(id) ||
          Object.keys(request.query ?? {}).length
        )
          throw new EventInputError("retrospective-review-request-invalid");
        if (!request.subject)
          return response((status = 401), { error: "unauthorized" });
        if (!request.scopes?.includes("retrospectives:approve"))
          return response((status = 403), { error: "forbidden" });
        if (!request.reviewerAuthorized)
          return response((status = 403), { error: "forbidden" });
        if (
          request.method !== "POST" ||
          request.contentType?.split(";")[0]?.trim().toLowerCase() !==
            "application/json" ||
          !request.body ||
          Buffer.byteLength(request.body) > 4096
        )
          throw new EventInputError("retrospective-review-body-invalid");
        let body: unknown;
        try {
          body = JSON.parse(request.body);
        } catch {
          throw new EventInputError("retrospective-review-json-invalid");
        }
        if (!body || typeof body !== "object" || Array.isArray(body))
          throw new EventInputError("retrospective-review-body-invalid");
        const value = body as Record<string, unknown>,
          allowed = [
            "reasonCode",
            "note",
            "idempotencyKey",
            "expectedState",
            "expectedStateVersion",
          ];
        if (
          Object.keys(value).some((key) => !allowed.includes(key)) ||
          !["approve", "reject", "request-changes"].includes(
            String(value["reasonCode"]),
          ) ||
          typeof value["idempotencyKey"] !== "string" ||
          value["idempotencyKey"].length < 1 ||
          value["idempotencyKey"].length > 128 ||
          value["expectedState"] !== "draft" ||
          !Number.isSafeInteger(value["expectedStateVersion"]) ||
          value["expectedStateVersion"] !== 1 ||
          (value["note"] !== undefined &&
            value["note"] !== null &&
            (typeof value["note"] !== "string" || value["note"].length > 1000))
        )
          throw new EventInputError("retrospective-review-body-invalid");
        const result = await retrospectiveRepository.review({
          versionId: id,
          reviewerId: request.subject,
          reasonCode: value["reasonCode"] as
            "approve" | "reject" | "request-changes",
          ...(typeof value["note"] === "string" ? { note: value["note"] } : {}),
          decidedAt: new Date().toISOString(),
          idempotencyKey: value["idempotencyKey"],
          expectedState: "draft",
          expectedStateVersion: 1,
        });
        return response(200, {
          version: result.version,
          decision: {
            decisionId: result.decision.decisionId,
            versionId: result.decision.versionId,
            fromState: result.decision.fromState,
            toState: result.decision.toState,
            reasonCode: result.decision.reasonCode,
            decidedAt: result.decision.decidedAt,
          },
        });
      }
      if (request.route.startsWith("performance-")) {
        if (!cohortRepository)
          throw new Error("cohort-repository-not-configured");
        if (
          request.route === "performance-list" ||
          request.route === "performance-reports"
        ) {
          const limitText = request.query?.["limit"] ?? "20";
          if (
            !/^(?:[1-9]|[1-4][0-9]|50)$/.test(limitText) ||
            Object.keys(request.query ?? {}).some(
              (key) => !["limit", "cursor"].includes(key),
            )
          )
            throw new EventInputError("invalid-performance-filter");
          return response(
            200,
            await (request.route === "performance-reports"
              ? cohortRepository.listReports({
                  limit: Number(limitText),
                  ...(request.query?.["cursor"]
                    ? { cursor: request.query["cursor"] }
                    : {}),
                })
              : cohortRepository.listCohorts({
                  limit: Number(limitText),
                  ...(request.query?.["cursor"]
                    ? { cursor: request.query["cursor"] }
                    : {}),
                })),
          );
        }
        const id = request.eventId ?? "";
        if (Object.keys(request.query ?? {}).length)
          throw new EventInputError("performance-detail-query-invalid");
        if (request.route === "performance-members") {
          if (!/^cohort:[a-f0-9]{64}$/.test(id))
            throw new EventInputError("cohort-id-invalid");
          const cohort = await cohortRepository.getCohort(id);
          if (!cohort) return response((status = 404), { error: "not-found" });
          return response(200, {
            cohortId: cohort.cohortId,
            cutoff: cohort.cutoff,
            membershipDigest: cohort.membershipDigest,
            items: cohort.members,
          });
        }
        if (!/^performance-report:[a-f0-9]{64}$/.test(id))
          throw new EventInputError("performance-report-id-invalid");
        const report = await cohortRepository.getReport(id);
        if (!report) return response((status = 404), { error: "not-found" });
        return response(200, report);
      }
      if (request.route === "list" && !request.subject)
        return response((status = 401), { error: "unauthorized" });
      if (
        request.route === "list" &&
        !request.scopes?.includes("events/events:read")
      )
        return response((status = 403), { error: "forbidden" });
      // Resolves the event-id decode variants against the store: the first
      // candidate the lookup recognizes wins. When none resolve, the
      // reported id's outcome (including its validation errors) stands.
      const resolveEventDetail = async <T extends { readonly item: unknown }>(
        lookup: (id: string) => Promise<T>,
      ): Promise<{ readonly eventId: string; readonly result: T }> => {
        const fallback = request.eventId ?? "";
        const candidates =
          request.eventIdAlternatives && request.eventIdAlternatives.length > 0
            ? request.eventIdAlternatives
            : [fallback];
        let fallbackResult: { readonly result: T } | undefined;
        for (const candidate of candidates) {
          try {
            const result = await lookup(candidate);
            if (result.item) return { eventId: candidate, result };
            if (candidate === fallback) fallbackResult = { result };
          } catch (error) {
            // A decode variant the grammar rejects is simply not the id.
            if (candidate === fallback) throw error;
          }
        }
        return {
          eventId: fallback,
          result: fallbackResult?.result ?? (await lookup(fallback)),
        };
      };
      if (request.route === "odds-history") {
        if (!oddsHistoryRepository)
          throw new Error("odds-history-repository-not-configured");
        const query = request.query ?? {};
        const from = query["from"] ?? "";
        const to = query["to"] ?? "";
        const limitText = query["limit"] ?? "100";
        const marketKey = query["market"];
        const selectionKey = query["selection"];
        const booksText = query["books"];
        const sportsbookIds = booksText?.split(",");
        const validMarketOrBook = (value: string) =>
          /^[a-z0-9][a-z0-9._-]{0,127}$/.test(value);
        const validSelection = (value: string) =>
          value.length <= 128 &&
          /^[A-Za-z0-9._:-](?:[A-Za-z0-9._:-]|%[0-9A-Fa-f]{2})*$/.test(value);
        const canonicalTimestamp = (value: string) => {
          const parsed = Date.parse(value);
          return (
            Number.isFinite(parsed) && new Date(parsed).toISOString() === value
          );
        };
        if (
          Object.keys(query).some(
            (key) =>
              ![
                "from",
                "to",
                "limit",
                "cursor",
                "market",
                "selection",
                "books",
              ].includes(key),
          ) ||
          !canonicalTimestamp(from) ||
          !canonicalTimestamp(to) ||
          Date.parse(from) > Date.parse(to) ||
          Date.parse(to) - Date.parse(from) > 31 * 24 * 60 * 60 * 1_000 ||
          !/^(?:[1-9]|[1-9][0-9]|1[0-9]{2}|200)$/.test(limitText) ||
          (marketKey !== undefined &&
            (!validMarketOrBook(marketKey) ||
              !["moneyline", "spread", "total"].includes(marketKey))) ||
          (selectionKey !== undefined && !validSelection(selectionKey)) ||
          (sportsbookIds !== undefined &&
            (sportsbookIds.length < 1 ||
              sportsbookIds.length > 64 ||
              new Set(sportsbookIds).size !== sportsbookIds.length ||
              sportsbookIds.some((id) => !validMarketOrBook(id)))) ||
          (query["cursor"] !== undefined &&
            (query["cursor"].length < 1 || query["cursor"].length > 4096))
        )
          throw new EventInputError("invalid-odds-history-query");
        oddsHistoryRepository.validateSportsbookIds(sportsbookIds);
        const { eventId, result: event } = await resolveEventDetail((id) =>
          repository.detail(id),
        );
        if (!event.item)
          return response((status = 404), { error: "not-found" });
        if (selectionKey) {
          const participantSelections = event.item.participants.map(({ id }) =>
            participantSelectionKey(id as EntityId),
          );
          const validForMarket =
            marketKey === "total"
              ? ["over", "under"].includes(selectionKey)
              : marketKey === "spread"
                ? participantSelections.includes(selectionKey as never)
                : marketKey === "moneyline"
                  ? participantSelections.includes(selectionKey as never) ||
                    (event.item.sportKey === "soccer" &&
                      selectionKey === "draw")
                  : participantSelections.includes(selectionKey as never) ||
                    ["over", "under"].includes(selectionKey) ||
                    (event.item.sportKey === "soccer" &&
                      selectionKey === "draw");
          if (!validForMarket)
            throw new EventInputError("unsupported-odds-history-selection");
        }
        const page = await oddsHistoryRepository.list({
          eventId,
          canonicalEventVersion: event.item.version,
          from,
          to,
          limit: Number(limitText),
          ...(marketKey ? { marketKey } : {}),
          ...(selectionKey ? { selectionKey } : {}),
          ...(sportsbookIds ? { sportsbookIds } : {}),
          ...(query["cursor"] ? { cursor: query["cursor"] } : {}),
        });
        oddsHistoryCounts = {
          series: page.series.length,
          sportsbooks: new Set(
            page.series.map(({ sportsbookId }) => sportsbookId),
          ).size,
          points: page.series.reduce(
            (count, series) => count + series.points.length,
            0,
          ),
        };
        return response(200, page);
      }
      if (request.route === "detail") {
        if (!gamesRepository?.detail)
          throw new Error("games-detail-repository-not-configured");
        const { result } = await resolveEventDetail((id) =>
          gamesRepository.detail!(id),
        );
        if (result.projectionState === "uninitialized") {
          metadataCounts = { stale: 0, partial: 0, unavailable: 1 };
          return response(200, result);
        }
        if (!result.item)
          return response((status = 404), { error: "not-found" });
        metadataCounts = {
          stale: result.item.metadata.freshness.state === "stale" ? 1 : 0,
          partial: result.item.metadata.availability === "partial" ? 1 : 0,
          unavailable:
            result.item.metadata.availability === "unavailable" ? 1 : 0,
        };
        detailOddsCounts = {
          stale: 0,
          partial: 0,
          suspendedOrUnavailable: 0,
        };
        for (const market of result.item.oddsComparison.markets)
          for (const selection of market.selections)
            for (const cell of Object.values(selection.cells)) {
              if (cell.state === "stale") detailOddsCounts.stale += 1;
              else if (cell.state === "partial") detailOddsCounts.partial += 1;
              else if (
                cell.state === "suspended" ||
                cell.state === "unavailable"
              )
                detailOddsCounts.suspendedOrUnavailable += 1;
            }
        return response(200, result);
      }
      const query = request.query ?? {};
      if (
        (request.route === "games" || request.route === "splits") &&
        (Object.keys(query).some(
          (key) =>
            !["sport", "league", "status", "day", "limit", "cursor"].includes(
              key,
            ),
        ) ||
          (request.route === "splits" && query["status"] !== "scheduled") ||
          (request.route === "games" &&
            query["status"] !== "all" &&
            !EVENT_LIFECYCLE_STATES.includes(
              query["status"] as (typeof EVENT_LIFECYCLE_STATES)[number],
            )) ||
          !["mlb", "soccer"].includes(query["sport"] ?? "") ||
          (query["league"] !== undefined &&
            query["league"] !== (query["sport"] === "mlb" ? "mlb" : "mls")))
      )
        throw new EventInputError("invalid-games-filter");
      if (query["cursor"] === "") throw new EventCursorError("invalid-cursor");
      const rawLimit = query["limit"] ?? "20";
      if (!/^(?:[1-9]|[1-4][0-9]|50)$/.test(rawLimit))
        throw new EventInputError("invalid-event-limit");
      const target =
        request.route === "games" || request.route === "splits"
          ? gamesRepository
          : repository;
      if (!target) throw new Error("games-repository-not-configured");
      // The board is identical for every anonymous caller and its evidence
      // refreshes on a five-minute cadence, so repeat requests within the
      // cache window serve the already-built response instead of re-running
      // the projection and its DynamoDB fan-out.
      const boardKey = [
        request.route,
        query["sport"] ?? "",
        query["league"] ?? "",
        query["status"] ?? "",
        query["day"] ?? "",
        rawLimit,
        query["cursor"] ?? "",
      ].join("|");
      const board = await boardResponseCache(boardKey, async () => {
        // The ingest worker materializes the default boards right after each
        // run, so the common request is one stored read rather than the live
        // projection. Anything the store cannot answer — other days, other
        // limits, cursors, stale or missing boards — falls through.
        if (
          loadStoredBoard &&
          (request.route === "games" || request.route === "splits") &&
          query["cursor"] === undefined &&
          (query["sport"] === "mlb" || query["sport"] === "soccer")
        ) {
          const stored = await loadStoredBoard({
            route: request.route,
            sportKey: query["sport"],
            leagueKey: query["league"] ?? "",
            status: query["status"] ?? "",
            day: query["day"] ?? "",
            limit: Number(rawLimit),
          });
          if (stored)
            return {
              body: {
                statusCode: 200,
                headers: {
                  "content-type": "application/json",
                  "cache-control": "no-store",
                },
                body: stored.body,
              },
              counts: stored.counts,
            };
        }
        const page = await target.list(
          {
            sportKey: query["sport"] ?? "",
            ...(query["league"] ? { leagueKey: query["league"] } : {}),
            status: (query["status"] ?? "") as Parameters<
              EventRepository["list"]
            >[0]["status"],
            day: query["day"] ?? "",
          },
          Number(rawLimit),
          query["cursor"],
        );
        const counts = boardCounts(page);
        if (request.route !== "splits")
          return { body: response(200, page), counts };
        if (!splitsRepository)
          throw new Error("splits-repository-not-configured");
        const withSplits = await attachSplits(
          page as GamesPage,
          splitsRepository,
          (id) => splitLookupCache(id, () => splitsRepository.listCurrent(id)),
        );
        return { body: response(200, withSplits), counts };
      });
      metadataCounts = board.counts;
      return board.body;
    } catch (error) {
      if (
        request.route.startsWith("opportunity-") &&
        error instanceof EventCursorError
      )
        opportunityCounts = {
          discovered: 0,
          returned: 0,
          filtered: 0,
          stale: 0,
          joinFailure: 0,
          cursorRejected: 1,
        };
      if (
        error instanceof EventInputError ||
        error instanceof EventCursorError ||
        error instanceof OddsHistoryInputError
      )
        return response((status = 400), { error: "invalid-request" });
      if (error instanceof RankedOpportunityUnavailableError)
        return response((status = 503), { error: "temporarily-unavailable" });
      if (
        error instanceof RetrospectiveNotFoundError ||
        error instanceof StrategyExperimentNotFoundError
      )
        return response((status = 404), { error: "not-found" });
      if (
        error instanceof RetrospectiveConflictError ||
        error instanceof StrategyExperimentConflictError
      )
        return response((status = 409), { error: "conflict" });
      status = 500;
      const scoutingFailure = request.route.startsWith("scout-");
      log({
        event: "event-api-internal-failure",
        route: request.route,
        errorName: scoutingFailure
          ? "ScoutingInternalError"
          : error instanceof Error
            ? error.name.slice(0, 80)
            : "Unknown",
        errorMessage: scoutingFailure
          ? "scouting-operation-failed"
          : error instanceof Error
            ? error.message.slice(0, 240)
            : "non-error-thrown",
      });
      return response(500, { error: "internal-error" });
    } finally {
      // Report reads share the scouting redaction rules but not the job
      // lifecycle metrics: a 200 report read is not a duplicate creation.
      const scoutingRoute =
        request.route.startsWith("scout-") &&
        !request.route.startsWith("scout-report-");
      const retrospectiveRoute = request.route.startsWith("retrospective-");
      const experimentRoute = request.route.startsWith("experiment-");
      const reviewRoute = request.route === "retrospective-review";
      const opportunityRoute = request.route.startsWith("opportunity-");
      // Identity counters carry no dimension beyond the route, so no metric
      // can ever be sliced by number, address, or account.
      const identityMetricNames = identityObservation
        ? [
            "AuthLatency",
            ...(identityObservation.delivery === "delivered"
              ? ["AuthOtpDelivered"]
              : []),
            ...(identityObservation.delivery === "failed" ||
            identityObservation.delivery === "rejected"
              ? ["AuthOtpDeliveryFailed"]
              : []),
            ...(identityObservation.delivery === "suppressed"
              ? ["AuthOtpSuppressed"]
              : []),
            ...(identityObservation.outcome === "verified"
              ? ["AuthOtpVerified"]
              : []),
            ...(identityObservation.outcome === "invalid-credentials"
              ? ["AuthOtpRejected"]
              : []),
            ...(identityObservation.outcome === "rate-limited"
              ? ["AuthRateLimited"]
              : []),
            ...(identityObservation.outcome === "refreshed"
              ? ["AuthSessionRefreshed"]
              : []),
            ...(identityObservation.outcome === "unauthorized"
              ? ["AuthUnauthorized"]
              : []),
          ]
        : [];
      const metrics = [
        { Name: "Requests", Unit: "Count" },
        { Name: "Latency", Unit: "Milliseconds" },
        ...(scoutingRoute
          ? [{ Name: "ScoutingLatency", Unit: "Milliseconds" }]
          : []),
        ...(request.route === "scout-create" && status === 202
          ? [{ Name: "ScoutingJobCreated", Unit: "Count" }]
          : []),
        ...(scoutingRoute && status === 200
          ? [{ Name: "ScoutingDuplicate", Unit: "Count" }]
          : []),
        ...(request.route === "scout-retry" && status === 202
          ? [{ Name: "ScoutingRetryCreated", Unit: "Count" }]
          : []),
        ...(scoutingRoute && status >= 500
          ? [{ Name: "ScoutingFailure", Unit: "Count" }]
          : []),
        ...(status === 500 ? [{ Name: "Caught5xx", Unit: "Count" }] : []),
        ...(retrospectiveRoute
          ? [{ Name: "RetrospectiveLatency", Unit: "Milliseconds" }]
          : []),
        ...(experimentRoute
          ? [{ Name: "StrategyExperimentLatency", Unit: "Milliseconds" }]
          : []),
        ...(experimentRoute && status === 409
          ? [{ Name: "StrategyPromotionConflict", Unit: "Count" }]
          : []),
        ...(experimentRoute && status === 403
          ? [{ Name: "StrategyPromotionForbidden", Unit: "Count" }]
          : []),
        ...(reviewRoute && status === 200
          ? [{ Name: "RetrospectiveReviewSuccess", Unit: "Count" }]
          : []),
        ...(reviewRoute && status === 409
          ? [{ Name: "RetrospectiveReviewConflict", Unit: "Count" }]
          : []),
        ...(reviewRoute && status === 403
          ? [{ Name: "RetrospectiveReviewForbidden", Unit: "Count" }]
          : []),
        ...(metadataCounts
          ? [
              { Name: "StaleEventMetadata", Unit: "Count" },
              { Name: "PartialEventMetadata", Unit: "Count" },
              { Name: "UnavailableEventMetadata", Unit: "Count" },
            ]
          : []),
        ...(detailOddsCounts
          ? [
              { Name: "StaleOddsCells", Unit: "Count" },
              { Name: "PartialOddsCells", Unit: "Count" },
              {
                Name: "SuspendedOrUnavailableOddsCells",
                Unit: "Count",
              },
            ]
          : []),
        ...(oddsHistoryCounts
          ? [
              { Name: "OddsHistorySeries", Unit: "Count" },
              { Name: "OddsHistorySportsbooks", Unit: "Count" },
              { Name: "OddsHistoryPoints", Unit: "Count" },
            ]
          : []),
        ...(opportunityRoute
          ? [
              { Name: "OpportunityLatency", Unit: "Milliseconds" },
              { Name: "OpportunityDiscovered", Unit: "Count" },
              { Name: "OpportunityReturned", Unit: "Count" },
              { Name: "OpportunityFiltered", Unit: "Count" },
              { Name: "OpportunityStaleRead", Unit: "Count" },
              { Name: "OpportunityJoinFailure", Unit: "Count" },
              { Name: "OpportunityCursorRejected", Unit: "Count" },
            ]
          : []),
        ...identityMetricNames.map((Name) => ({
          Name,
          Unit: Name === "AuthLatency" ? "Milliseconds" : "Count",
        })),
      ];
      log({
        _aws: {
          Timestamp: Date.now(),
          CloudWatchMetrics: [
            {
              Namespace: "FindTheEdge/EventApi",
              Dimensions: [["Route"]],
              Metrics: metrics,
            },
          ],
        },
        Route: request.route,
        ...(request.requestId
          ? { RequestId: request.requestId.slice(0, 128) }
          : {}),
        Status: status,
        Requests: 1,
        Latency: Date.now() - started,
        ...(scoutingRoute ? { ScoutingLatency: Date.now() - started } : {}),
        ...(request.route === "scout-create" && status === 202
          ? { ScoutingJobCreated: 1 }
          : {}),
        ...(scoutingRoute && status === 200 ? { ScoutingDuplicate: 1 } : {}),
        ...(request.route === "scout-retry" && status === 202
          ? { ScoutingRetryCreated: 1 }
          : {}),
        ...(scoutingRoute && status >= 500 ? { ScoutingFailure: 1 } : {}),
        ...(status === 500 ? { Caught5xx: 1 } : {}),
        ...(retrospectiveRoute
          ? { RetrospectiveLatency: Date.now() - started }
          : {}),
        ...(experimentRoute
          ? { StrategyExperimentLatency: Date.now() - started }
          : {}),
        ...(experimentRoute && status === 409
          ? { StrategyPromotionConflict: 1 }
          : {}),
        ...(experimentRoute && status === 403
          ? { StrategyPromotionForbidden: 1 }
          : {}),
        ...(reviewRoute && status === 200
          ? { RetrospectiveReviewSuccess: 1 }
          : {}),
        ...(reviewRoute && status === 409
          ? { RetrospectiveReviewConflict: 1 }
          : {}),
        ...(reviewRoute && status === 403
          ? { RetrospectiveReviewForbidden: 1 }
          : {}),
        ...(metadataCounts
          ? {
              StaleEventMetadata: metadataCounts.stale,
              PartialEventMetadata: metadataCounts.partial,
              UnavailableEventMetadata: metadataCounts.unavailable,
            }
          : {}),
        ...(detailOddsCounts
          ? {
              StaleOddsCells: detailOddsCounts.stale,
              PartialOddsCells: detailOddsCounts.partial,
              SuspendedOrUnavailableOddsCells:
                detailOddsCounts.suspendedOrUnavailable,
            }
          : {}),
        ...(oddsHistoryCounts
          ? {
              OddsHistorySeries: oddsHistoryCounts.series,
              OddsHistorySportsbooks: oddsHistoryCounts.sportsbooks,
              OddsHistoryPoints: oddsHistoryCounts.points,
            }
          : {}),
        ...(opportunityRoute
          ? {
              OpportunityLatency: Date.now() - started,
              OpportunityDiscovered: opportunityCounts?.discovered ?? 0,
              OpportunityReturned: opportunityCounts?.returned ?? 0,
              OpportunityFiltered: opportunityCounts?.filtered ?? 0,
              OpportunityStaleRead: opportunityCounts?.stale ?? 0,
              OpportunityJoinFailure: opportunityCounts?.joinFailure ?? 0,
              OpportunityCursorRejected: opportunityCounts?.cursorRejected ?? 0,
            }
          : {}),
        ...Object.fromEntries(
          identityMetricNames.map((name) => [
            name,
            name === "AuthLatency" ? Date.now() - started : 1,
          ]),
        ),
      });
    }
  };
