import {
  EventCursorError,
  EventInputError,
  type EventRepository,
} from "@find-the-edge/database";
export interface ApiRequest {
  readonly route: "list" | "detail";
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
    log: (entry: Readonly<Record<string, unknown>>) => void = console.log,
  ) =>
  async (request: ApiRequest): Promise<ApiResponse> => {
    const started = Date.now();
    let status = 200;
    try {
      if (!request.subject)
        return response((status = 401), { error: "unauthorized" });
      if (!request.scopes?.includes("events:read"))
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
      if (query["cursor"] === "") throw new EventCursorError("invalid-cursor");
      const rawLimit = query["limit"] ?? "20";
      if (!/^(?:[1-9]|[1-4][0-9]|50)$/.test(rawLimit))
        throw new EventInputError("invalid-event-limit");
      const page = await repository.list(
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
      return response(200, page);
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
