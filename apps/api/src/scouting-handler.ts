import {
  EventStorageError,
  ScoutingRepositoryError,
  type EventRepository,
  type ScoutingJobRepository,
} from "@find-the-edge/database";
import {
  SCOUTING_WORKFLOW_INTENT,
  normalizeScoutingJobCommand,
  toPublicScoutingJob,
} from "@find-the-edge/domain";

export type ScoutingHttpRoute = "scout-create" | "scout-status" | "scout-retry";

export interface ScoutingHttpRequest {
  readonly route: ScoutingHttpRoute;
  readonly subject?: string;
  readonly scopes?: readonly string[];
  readonly eventId?: string;
  /** Decode-depth variants of the event-id segment; see EventApiRequest. */
  readonly eventIdAlternatives?: readonly string[];
  readonly jobId?: string;
  readonly idempotencyKey?: string;
  readonly query?: Readonly<Record<string, string | undefined>>;
  readonly method?: "GET" | "POST" | "DELETE";
  readonly contentType?: string;
  readonly body?: string;
}

export interface ScoutingHttpResponse {
  readonly statusCode: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

const response = (
  statusCode: number,
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
): ScoutingHttpResponse => ({
  statusCode,
  headers: {
    "content-type": "application/json",
    "cache-control": "no-store",
    ...headers,
  },
  body: JSON.stringify(body),
});

const exactEmptyBody = (request: ScoutingHttpRequest): boolean => {
  if (
    request.contentType?.split(";")[0]?.trim().toLowerCase() !==
      "application/json" ||
    !request.body ||
    Buffer.byteLength(request.body) > 256
  )
    return false;
  try {
    const parsed: unknown = JSON.parse(request.body);
    return (
      !!parsed &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      Object.keys(parsed).length === 0
    );
  } catch {
    return false;
  }
};

const retryStateVersion = (request: ScoutingHttpRequest): number | null => {
  if (
    request.contentType?.split(";")[0]?.trim().toLowerCase() !==
      "application/json" ||
    !request.body ||
    Buffer.byteLength(request.body) > 256
  )
    return null;
  try {
    const parsed: unknown = JSON.parse(request.body);
    if (
      !parsed ||
      typeof parsed !== "object" ||
      Array.isArray(parsed) ||
      Object.keys(parsed).length !== 1 ||
      !("expectedStateVersion" in parsed) ||
      !Number.isSafeInteger(parsed.expectedStateVersion) ||
      Number(parsed.expectedStateVersion) < 1
    )
      return null;
    return Number(parsed.expectedStateVersion);
  } catch {
    return null;
  }
};

const validJobId = (value: string | undefined) =>
  /^scout-job:[a-f0-9]{64}$/.test(value ?? "");

export const createScoutingHttpHandler =
  (
    events: EventRepository,
    jobs: ScoutingJobRepository,
    now: () => Date = () => new Date(),
  ) =>
  async (request: ScoutingHttpRequest): Promise<ScoutingHttpResponse> => {
    if (!request.subject) return response(401, { error: "unauthorized" });
    const write = request.route !== "scout-status";
    const requiredScope = write
      ? "events/scouting:write"
      : "events/scouting:read";
    if (!request.scopes?.includes(requiredScope))
      return response(403, { error: "forbidden" });
    if (Object.keys(request.query ?? {}).length > 0)
      return response(400, { error: "invalid-request" });

    try {
      if (request.route === "scout-status") {
        if (
          request.method !== "GET" ||
          !validJobId(request.jobId) ||
          request.body !== undefined
        )
          return response(400, { error: "invalid-request" });
        const job = await jobs.getJobForRequester(
          request.jobId ?? "",
          request.subject,
        );
        return job
          ? response(200, toPublicScoutingJob(job))
          : response(404, { error: "not-found" });
      }

      const idempotencyKey = request.idempotencyKey ?? "";
      if (
        request.method !== "POST" ||
        !/^[A-Za-z0-9._:-]{1,128}$/.test(idempotencyKey)
      )
        return response(400, { error: "invalid-request" });

      if (request.route === "scout-retry") {
        const expectedStateVersion = retryStateVersion(request);
        if (!validJobId(request.jobId) || expectedStateVersion === null)
          return response(400, { error: "invalid-request" });
        const result = await jobs.retryJob({
          jobId: request.jobId ?? "",
          requesterId: request.subject,
          idempotencyKey,
          expectedStateVersion,
          requestedAt: now().toISOString(),
        });
        return response(
          result.outcome === "retried" ? 202 : 200,
          toPublicScoutingJob(result.job),
          { location: `/scout-jobs/${result.job.jobId}` },
        );
      }

      if (!exactEmptyBody(request))
        return response(400, { error: "invalid-request" });

      // The gateway over-decodes path parameters, so the true event id is
      // whichever decode variant the store recognizes. Resolution runs
      // before the replay lookup so replays key on the same canonical id.
      const fallbackEventId = request.eventId ?? "";
      const candidates =
        request.eventIdAlternatives && request.eventIdAlternatives.length > 0
          ? request.eventIdAlternatives
          : [fallbackEventId];
      let detail: Awaited<ReturnType<(typeof events)["detail"]>> | undefined;
      for (const candidate of candidates) {
        try {
          const result = await events.detail(candidate);
          if (result.projectionState !== "ready" || result.item) {
            detail = result;
            break;
          }
          if (candidate === fallbackEventId) detail ??= result;
        } catch {
          // A decode variant the grammar rejects is simply not the id.
        }
      }
      detail ??= await events.detail(fallbackEventId);
      const canonicalEventId = detail.item?.id ?? fallbackEventId;

      const replay = await jobs.getCreateReplay({
        requesterId: request.subject,
        idempotencyKey,
        eventId: canonicalEventId,
      });
      if (replay)
        return response(200, toPublicScoutingJob(replay), {
          location: `/scout-jobs/${replay.jobId}`,
        });

      if (detail.projectionState !== "ready")
        return response(503, { error: "temporarily-unavailable" });
      if (!detail.item) return response(404, { error: "not-found" });
      if (detail.item.status !== "scheduled")
        return response(422, { error: "event-not-scoutable" });
      const command = normalizeScoutingJobCommand({
        schemaVersion: 1,
        requesterId: request.subject,
        idempotencyKey,
        eventId: detail.item.id,
        eventVersion: detail.item.version,
        workflowIntent: SCOUTING_WORKFLOW_INTENT,
      });
      const result = await jobs.createJob({
        command,
        createdAt: now().toISOString(),
      });
      return response(
        result.outcome === "created" ? 202 : 200,
        toPublicScoutingJob(result.job),
        { location: `/scout-jobs/${result.job.jobId}` },
      );
    } catch (error) {
      if (
        error instanceof EventStorageError &&
        error.message === "event-detail-snapshot-unstable"
      )
        return response(503, { error: "temporarily-unavailable" });
      if (error instanceof ScoutingRepositoryError) {
        if (
          error.code === "scouting-job-not-found" ||
          error.code === "scouting-job-owner-mismatch"
        )
          return response(404, { error: "not-found" });
        if (error.code === "scouting-retry-limit-reached")
          return response(422, { error: "retry-limit-reached" });
        if (
          error.code === "scouting-idempotency-conflict" ||
          error.code === "scouting-event-version-conflict" ||
          error.code === "scouting-retry-not-allowed"
        )
          return response(409, { error: "conflict" });
      }
      if (
        error instanceof Error &&
        [
          "scouting-command-invalid",
          "scouting-requester-invalid",
          "scouting-idempotency-key-invalid",
          "scouting-event-id-invalid",
        ].includes(error.message)
      )
        return response(400, { error: "invalid-request" });
      throw error;
    }
  };
