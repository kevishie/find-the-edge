import {
  EventCursorError,
  EventInputError,
  type GamesRepository,
  type BettingSplitRepository,
  type CohortRepository,
  type EventRepository,
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
    | "performance-reports";
  readonly subject?: string;
  readonly scopes?: readonly string[];
  readonly eventId?: string;
  readonly query?: Readonly<Record<string, string | undefined>>;
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
      status = 500;
      return response(500, { error: "internal-error" });
    } finally {
      const metrics = [
        { Name: "Requests", Unit: "Count" },
        { Name: "Latency", Unit: "Milliseconds" },
        ...(status === 500 ? [{ Name: "Caught5xx", Unit: "Count" }] : []),
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
      });
    }
  };
