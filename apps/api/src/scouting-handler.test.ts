import { describe, expect, it } from "vitest";
import {
  EventStorageError,
  MemoryScoutingJobRepository,
  type EventRepository,
} from "@find-the-edge/database";
import { assessEventMetadata } from "@find-the-edge/domain";
import { createScoutingHttpHandler } from "./scouting-handler";

const item = {
  id: "event:mlb:one",
  version: 7,
  sportKey: "mlb",
  leagueKey: "mlb",
  competition: { key: "mlb", state: "provisional" as const },
  participants: [
    { id: "away", label: "Away" },
    { id: "home", label: "Home" },
  ],
  startsAt: "2026-08-08T20:00:00.000Z",
  eastern: {
    timeZone: "America/New_York" as const,
    calendarDay: "2026-08-08",
    display: "Aug 8",
  },
  status: "scheduled" as const,
  freshness: "2026-08-07T12:00:00.000Z",
  metadata: assessEventMetadata(
    "scheduled",
    "2026-08-07T12:00:00.000Z",
    "2026-08-07T12:00:00.000Z",
  ),
};

const events: EventRepository = {
  list: () => Promise.reject(new Error("unexpected-list")),
  detail: (eventId) =>
    Promise.resolve({
      projectionState: "ready",
      item: eventId === item.id ? item : null,
      unavailableReason: null,
    }),
};

const create = (overrides: Record<string, unknown> = {}) => ({
  route: "scout-create" as const,
  method: "POST" as const,
  subject: "owner@example.com",
  scopes: ["events/scouting:write"],
  eventId: item.id,
  idempotencyKey: "request-1",
  contentType: "application/json",
  body: "{}",
  ...overrides,
});

const parsedJobId = (body: string): string => {
  const parsed: unknown = JSON.parse(body);
  if (
    !parsed ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    !("jobId" in parsed) ||
    typeof parsed.jobId !== "string"
  )
    throw new Error("expected scouting job response");
  return parsed.jobId;
};

describe("scouting HTTP boundary", () => {
  it("maps an unstable event snapshot to a safe temporary response", async () => {
    const unstableEvents: EventRepository = {
      list: () => Promise.reject(new Error("unexpected-list")),
      detail: () =>
        Promise.reject(new EventStorageError("event-detail-snapshot-unstable")),
    };
    expect(
      await createScoutingHttpHandler(
        unstableEvents,
        new MemoryScoutingJobRepository(),
      )(create()),
    ).toMatchObject({
      statusCode: 503,
      body: JSON.stringify({ error: "temporarily-unavailable" }),
    });
  });

  it("reports an uninitialized projection and unscheduled event safely", async () => {
    const unavailable: EventRepository = {
      list: () => Promise.reject(new Error("unexpected-list")),
      detail: () =>
        Promise.resolve({
          projectionState: "uninitialized",
          item: null,
          unavailableReason: "projection-uninitialized",
        }),
    };
    expect(
      await createScoutingHttpHandler(
        unavailable,
        new MemoryScoutingJobRepository(),
      )(create()),
    ).toMatchObject({ statusCode: 503 });

    const unscheduled: EventRepository = {
      list: () => Promise.reject(new Error("unexpected-list")),
      detail: () =>
        Promise.resolve({
          projectionState: "ready",
          item: { ...item, status: "completed" },
          unavailableReason: null,
        }),
    };
    expect(
      await createScoutingHttpHandler(
        unscheduled,
        new MemoryScoutingJobRepository(),
      )(create()),
    ).toMatchObject({ statusCode: 422 });
  });

  it("creates once and converges exact replay and equivalent active work", async () => {
    const jobs = new MemoryScoutingJobRepository(),
      handler = createScoutingHttpHandler(
        events,
        jobs,
        () => new Date("2026-08-07T13:00:00.000Z"),
      );
    const first = await handler(create());
    const replay = await handler(create());
    const equivalent = await handler(create({ idempotencyKey: "request-2" }));
    expect(first.statusCode).toBe(202);
    expect(replay.statusCode).toBe(200);
    expect(equivalent.statusCode).toBe(200);
    expect(parsedJobId(replay.body)).toBe(parsedJobId(first.body));
    expect(parsedJobId(equivalent.body)).toBe(parsedJobId(first.body));
    expect(first.headers.location).toBe(
      `/scout-jobs/${parsedJobId(first.body)}`,
    );
  });

  it("replays a committed request before consulting mutable event state", async () => {
    let unavailable = false;
    const mutableEvents: EventRepository = {
      list: () => Promise.reject(new Error("unexpected-list")),
      detail: () =>
        Promise.resolve(
          unavailable
            ? {
                projectionState: "uninitialized" as const,
                item: null,
                unavailableReason: "projection-uninitialized" as const,
              }
            : {
                projectionState: "ready" as const,
                item,
                unavailableReason: null,
              },
        ),
    };
    const handler = createScoutingHttpHandler(
      mutableEvents,
      new MemoryScoutingJobRepository(),
      () => new Date("2026-08-07T13:00:00.000Z"),
    );
    expect((await handler(create())).statusCode).toBe(202);
    unavailable = true;
    expect((await handler(create())).statusCode).toBe(200);
  });

  it("serves owner status while hiding foreign jobs", async () => {
    const jobs = new MemoryScoutingJobRepository(),
      handler = createScoutingHttpHandler(events, jobs);
    const created = await handler(create()),
      jobId = parsedJobId(created.body);
    expect(
      await handler({
        route: "scout-status",
        method: "GET",
        subject: "owner@example.com",
        scopes: ["events/scouting:read"],
        jobId,
      }),
    ).toMatchObject({ statusCode: 200 });
    expect(
      await handler({
        route: "scout-status",
        method: "GET",
        subject: "other@example.com",
        scopes: ["events/scouting:read"],
        jobId,
      }),
    ).toMatchObject({ statusCode: 404 });
  });

  it("rejects reuse of a create idempotency key for a different event", async () => {
    const second = { ...item, id: "event:mlb:two" };
    const twoEvents: EventRepository = {
      list: () => Promise.reject(new Error("unexpected-list")),
      detail: (eventId) =>
        Promise.resolve({
          projectionState: "ready",
          item:
            eventId === item.id ? item : eventId === second.id ? second : null,
          unavailableReason: null,
        }),
    };
    const handler = createScoutingHttpHandler(
      twoEvents,
      new MemoryScoutingJobRepository(),
    );
    expect((await handler(create())).statusCode).toBe(202);
    expect(
      (
        await handler(
          create({ eventId: second.id, idempotencyKey: "request-1" }),
        )
      ).statusCode,
    ).toBe(409);
  });

  it.each([
    [create({ subject: undefined }), 401],
    [create({ scopes: [] }), 403],
    [create({ method: "GET" }), 400],
    [create({ contentType: "text/plain" }), 400],
    [create({ body: '{"state":"completed"}' }), 400],
    [create({ query: { leaked: "1" } }), 400],
    [create({ idempotencyKey: "bad key" }), 400],
    [create({ eventId: "event:missing" }), 404],
  ] as const)("rejects hostile request %# safely", async (request, status) => {
    expect(
      await createScoutingHttpHandler(
        events,
        new MemoryScoutingJobRepository(),
      )(request),
    ).toMatchObject({ statusCode: status });
  });

  it("creates exactly one retry for a retryable failed attempt", async () => {
    const jobs = new MemoryScoutingJobRepository(),
      handler = createScoutingHttpHandler(
        events,
        jobs,
        () => new Date("2026-08-07T13:00:00.000Z"),
      ),
      created = await handler(create()),
      jobId = parsedJobId(created.body),
      job = await jobs.getJob(jobId);
    if (!job) throw new Error("job missing");
    await jobs.claimAttempt({
      jobId,
      attemptId: job.currentAttemptId,
      eventId: job.eventId,
      eventVersion: job.eventVersion,
      claimedAt: "2026-08-07T13:01:00.000Z",
    });
    await jobs.finishAttempt({
      jobId,
      attemptId: job.currentAttemptId,
      status: "failed_retryable",
      failureCode: "fixture-transient-failure",
      finishedAt: "2026-08-07T13:02:00.000Z",
    });
    const failed = await jobs.getJob(jobId);
    if (!failed) throw new Error("failed job missing");
    const retry = {
      route: "scout-retry" as const,
      method: "POST" as const,
      subject: "owner@example.com",
      scopes: ["events/scouting:write"],
      jobId,
      idempotencyKey: "retry-1",
      contentType: "application/json",
      body: JSON.stringify({ expectedStateVersion: failed.stateVersion }),
    };
    expect((await handler(retry)).statusCode).toBe(202);
    expect((await handler(retry)).statusCode).toBe(200);
    expect(
      (
        await handler({
          ...retry,
          idempotencyKey: "concurrent-retry",
        })
      ).statusCode,
    ).toBe(200);
  });

  it("hides foreign retries and enforces the three-attempt limit", async () => {
    const jobs = new MemoryScoutingJobRepository();
    const handler = createScoutingHttpHandler(
      events,
      jobs,
      () => new Date("2026-08-07T13:00:00.000Z"),
    );
    const created = await handler(create());
    const jobId = parsedJobId(created.body);
    const failCurrent = async () => {
      const current = await jobs.getJob(jobId);
      if (!current) throw new Error("job missing");
      await jobs.claimAttempt({
        jobId,
        attemptId: current.currentAttemptId,
        eventId: current.eventId,
        eventVersion: current.eventVersion,
        claimedAt: "2026-08-07T13:01:00.000Z",
      });
      await jobs.finishAttempt({
        jobId,
        attemptId: current.currentAttemptId,
        status: "failed_retryable",
        failureCode: "fixture-transient-failure",
        finishedAt: "2026-08-07T13:02:00.000Z",
      });
      const failed = await jobs.getJob(jobId);
      if (!failed) throw new Error("failed job missing");
      return failed;
    };
    const retry = (
      stateVersion: number,
      key: string,
      subject = "owner@example.com",
    ) =>
      handler({
        route: "scout-retry",
        method: "POST",
        subject,
        scopes: ["events/scouting:write"],
        jobId,
        idempotencyKey: key,
        contentType: "application/json",
        body: JSON.stringify({ expectedStateVersion: stateVersion }),
      });

    let failed = await failCurrent();
    expect(
      (await retry(failed.stateVersion, "foreign", "other@example.com"))
        .statusCode,
    ).toBe(404);
    expect((await retry(failed.stateVersion, "retry-2")).statusCode).toBe(202);
    failed = await failCurrent();
    expect((await retry(failed.stateVersion, "retry-3")).statusCode).toBe(202);
    failed = await failCurrent();
    expect((await retry(failed.stateVersion, "retry-4")).statusCode).toBe(422);
  });
});
