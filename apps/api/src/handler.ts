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
} from "@find-the-edge/database";
export interface ApiRequest {
  readonly route:
    | "list"
    | "detail"
    | "games"
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
    | "experiment-rollback";
  readonly subject?: string;
  readonly scopes?: readonly string[];
  readonly eventId?: string;
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
    try {
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
      if (request.route === "detail") {
        const result = await repository.detail(request.eventId ?? "");
        if (result.projectionState === "uninitialized")
          return response(200, result);
        if (!result.item)
          return response((status = 404), { error: "not-found" });
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
          query["status"] !== "scheduled" ||
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
      if (error instanceof EventInputError || error instanceof EventCursorError)
        return response((status = 400), { error: "invalid-request" });
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
      return response(500, { error: "internal-error" });
    } finally {
      const retrospectiveRoute = request.route.startsWith("retrospective-");
      const experimentRoute = request.route.startsWith("experiment-");
      const reviewRoute = request.route === "retrospective-review";
      const metrics = [
        { Name: "Requests", Unit: "Count" },
        { Name: "Latency", Unit: "Milliseconds" },
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
        Status: status,
        Requests: 1,
        Latency: Date.now() - started,
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
      });
    }
  };
