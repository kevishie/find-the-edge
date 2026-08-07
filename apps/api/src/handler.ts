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
  type RankedOpportunityRepository,
} from "@find-the-edge/database";
import {
  approvedSportsbookCollection,
  defaultOpportunityRankingPolicy,
} from "@find-the-edge/config";
import {
  canonicalMvpMarketKeys,
  EVENT_LIFECYCLE_STATES,
  opportunityWarningCodes,
  participantSelectionKey,
  type EntityId,
  type ProviderStatusPageDto,
} from "@find-the-edge/domain";
import type {
  ScoutingHttpRequest,
  ScoutingHttpResponse,
} from "./scouting-handler";
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
    | "provider-status"
    | "scout-create"
    | "scout-status"
    | "scout-retry";
  readonly subject?: string;
  readonly scopes?: readonly string[];
  readonly eventId?: string;
  readonly sportKey?: string;
  readonly opportunityId?: string;
  readonly jobId?: string;
  readonly idempotencyKey?: string;
  readonly requestId?: string;
  readonly query?: Readonly<Record<string, string | undefined>>;
  readonly method?: "GET" | "POST";
  readonly contentType?: string;
  readonly body?: string;
  readonly reviewerAuthorized?: boolean;
  readonly strategyPromoterAuthorized?: boolean;
}
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
    try {
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
        const eventId = request.eventId ?? "";
        const event = await repository.detail(eventId);
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
        const result = await gamesRepository.detail(request.eventId ?? "");
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
      metadataCounts = page.items.reduce(
        (counts, item) => ({
          stale:
            counts.stale + (item.metadata.freshness.state === "stale" ? 1 : 0),
          partial:
            counts.partial + (item.metadata.availability === "partial" ? 1 : 0),
          unavailable:
            counts.unavailable +
            (item.metadata.availability === "unavailable" ? 1 : 0),
        }),
        { stale: 0, partial: 0, unavailable: 0 },
      );
      if (page.projectionState === "uninitialized")
        metadataCounts.unavailable = 1;
      if (request.route !== "splits") return response(200, page);
      if (!splitsRepository)
        throw new Error("splits-repository-not-configured");
      const items = await Promise.all(
        page.items.map(async (game) => ({
          ...game,
          // Schedule refreshes may advance the canonical event version even
          // when the event identity and split evidence are unchanged. Return
          // the freshest logical split per market/selection across versions.
          splits: await splitsRepository.listCurrent(game.id),
        })),
      );
      return response(200, { ...page, items });
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
      const scoutingRoute = request.route.startsWith("scout-");
      const retrospectiveRoute = request.route.startsWith("retrospective-");
      const experimentRoute = request.route.startsWith("experiment-");
      const reviewRoute = request.route === "retrospective-review";
      const opportunityRoute = request.route.startsWith("opportunity-");
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
      });
    }
  };
