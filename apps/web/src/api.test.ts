import { afterEach, describe, expect, it, vi } from "vitest";
import type { EntityId, GameOddsSelectionDto } from "@find-the-edge/domain";
import {
  assessEventMetadata,
  participantSelectionKey,
} from "@find-the-edge/domain";

import {
  createGamesClient as createGamesClientWithTransport,
  GamesClientError,
  isCanonicalEventStatus,
  OWNED_SESSION_CAPABILITIES,
  parseOwnedSessionCapabilities,
  parsePublicScoutingJob,
  type GamesClient,
  type OwnedSessionTransport,
} from "./api";
import type { RuntimeBootstrap } from "./runtime-config";

const payload = {
  items: [
    {
      id: "event:mlb%3Amlb:fixture-1",
      version: 1,
      sportKey: "mlb",
      leagueKey: "mlb",
      competition: { key: "mlb", state: "provisional" },
      participants: [
        { id: "participant:mlb:boston", label: "Boston Red Sox" },
        { id: "participant:mlb:new-york", label: "New York Yankees" },
      ],
      startsAt: "2026-08-01T23:05:00.000Z",
      eastern: {
        timeZone: "America/New_York",
        calendarDay: "2026-08-01",
        display: "Aug 1, 2026, 7:05 PM",
      },
      status: "scheduled",
      freshness: "2026-08-01T12:30:00.000Z",
      metadata: assessEventMetadata(
        "scheduled",
        "2026-08-01T12:30:00.000Z",
        "2026-08-01T12:30:00.000Z",
      ),
      odds: {
        state: "available",
        selections: [
          {
            marketKey: "moneyline",
            selectionKey: "away",
            selectionLabel: "Boston Red Sox",
            sportsbookId: "fixture-book",
            sportsbookLabel: "Fixture Book",
            americanOdds: 120,
            observedAt: "2026-08-01T12:00:00.000Z",
            retrievedAt: "2026-08-01T12:00:00.000Z",
          },
          {
            marketKey: "moneyline",
            selectionKey: "home",
            selectionLabel: "New York Yankees",
            sportsbookId: "fixture-book",
            sportsbookLabel: "Fixture Book",
            americanOdds: -135,
            observedAt: "2026-08-01T12:00:00.000Z",
            retrievedAt: "2026-08-01T12:00:00.000Z",
          },
        ],
      },
    },
  ],
  nextCursor: null,
  projectionState: "ready",
  evaluationState: "complete",
  hasMoreUnknown: false,
  snapshotAt: "2026-08-01T12:30:00.000Z",
  freshness: "2026-08-01T12:30:00.000Z",
  unavailableReason: null,
};

const detailFixture = () => {
  const item: Record<string, unknown> = structuredClone(payload.items[0]!);
  delete item["odds"];
  const sides = payload.items[0]!.participants.map(({ id }) =>
    participantSelectionKey(id as EntityId),
  );
  const active = (point?: number) => ({
    state: "active",
    eligible: true,
    ...(point === undefined ? {} : { point }),
    americanOdds: 120,
    observedAt: "2026-08-01T12:00:00.000Z",
    retrievedAt: "2026-08-01T12:00:00.000Z",
  });
  const selections = (keys: readonly string[], point?: number) =>
    keys.map((selectionKey) => ({
      selectionKey,
      selectionLabel: selectionKey,
      cells: { hardrock: active(point) },
    }));
  item["oddsComparison"] = {
    targetSportsbookId: "hardrock",
    targetQualified: true,
    generatedAt: "2026-08-01T12:30:00.000Z",
    sportsbooks: [{ id: "hardrock", label: "Hard Rock Bet", target: true }],
    markets: [
      { marketKey: "moneyline", selections: selections(sides) },
      { marketKey: "spread", selections: selections(sides, 1.5) },
      { marketKey: "total", selections: selections(["over", "under"], 8.5) },
    ],
  };
  return item;
};
const mutableRecord = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("fixture-record-invalid");
  return value as Record<string, unknown>;
};
const mutableArray = (value: unknown): unknown[] => {
  if (!Array.isArray(value)) throw new Error("fixture-array-invalid");
  return value;
};

const bootstrap = (): RuntimeBootstrap => ({
  config: {
    schemaVersion: 1,
    apiBase: "https://api.example.test",
    tokenProviderKey: "session",
    cognitoIssuer: "https://issuer.example.test",
    cognitoClientId: "client-id",
  },
});

const ownedToken = `fte1.${"payload".padEnd(40, "x")}.${"a".repeat(64)}`;
const ownedAccount = `account:${"b".repeat(64)}`;
const authorization = (token = ownedToken) => ({
  token,
  accountId: ownedAccount,
});
const ownedSession = (): OwnedSessionTransport => ({
  authorize: vi.fn(() => Promise.resolve(authorization())),
  refuse: vi.fn(),
});
const createGamesClient = (
  runtime: Parameters<typeof createGamesClientWithTransport>[0],
  fetcher: typeof fetch = fetch,
  session: OwnedSessionTransport = ownedSession(),
) => createGamesClientWithTransport(runtime, fetcher, session);

const deferredJsonResponse = <T>(body: T, status = 200) => {
  let release!: () => void;
  let started!: () => void;
  const bodyStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  const response = new Response(null, { status });
  Object.defineProperty(response, "json", {
    value: vi.fn(
      () =>
        new Promise<T>((resolve) => {
          started();
          release = () => resolve(body);
        }),
    ),
  });
  return { response, bodyStarted, release: () => release() };
};

describe("scouting browser client", () => {
  const job = {
    schemaVersion: 1 as const,
    jobId: `scout-job:${"a".repeat(64)}`,
    eventId: "event:mlb:fixture-1",
    eventVersion: 1,
    workflowIntent: "fixture-v1" as const,
    status: "queued" as const,
    stateVersion: 1,
    attemptNumber: 1,
    createdAt: "2026-08-07T13:00:00.000Z",
    updatedAt: "2026-08-07T13:00:00.000Z",
  };
  afterEach(() => {
    Reflect.deleteProperty(globalThis, "__FTE_TOKEN_PROVIDERS__");
    Reflect.deleteProperty(globalThis, "__FTE_TOKEN_INVALIDATORS__");
    vi.useRealTimers();
  });

  it("strictly validates public job chronology and failure consistency", () => {
    expect(parsePublicScoutingJob(job)).toEqual(job);
    expect(() =>
      parsePublicScoutingJob({ ...job, workflowIntent: "internal-v2" }),
    ).toThrowError(GamesClientError);
    expect(() =>
      parsePublicScoutingJob({
        ...job,
        status: "failed_retryable",
        stateVersion: 2,
      }),
    ).toThrowError(GamesClientError);
    expect(() =>
      parsePublicScoutingJob({ ...job, stateVersion: 4 }),
    ).toThrowError(GamesClientError);
    expect(() => parsePublicScoutingJob({ ...job, secret: true })).toThrowError(
      GamesClientError,
    );
    for (const eventId of [
      "event::fixture",
      "event:UPPER:fixture",
      "event:%2f:fixture",
      "event:__proto__:fixture",
      "event:%ZZ:fixture",
    ])
      expect(() => parsePublicScoutingJob({ ...job, eventId })).toThrowError(
        GamesClientError,
      );
  });

  it.each([200, 202])(
    "creates from an authoritative %s convergence response with exact headers",
    async (status) => {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
        new Response(JSON.stringify(job), {
          status,
          headers: { location: `/scout-jobs/${job.jobId}` },
        }),
      );
      const result = createGamesClient(
        { ok: true, value: bootstrap() },
        fetcher,
      );
      if (!result.ok) throw result.error;
      await expect(
        result.value.createScoutingJob?.(
          job.eventId,
          "create-key-1",
          new AbortController().signal,
        ),
      ).resolves.toEqual(job);
      expect(fetcher.mock.calls[0]?.[0]).toBe(
        `https://api.example.test/events/${encodeURIComponent(job.eventId)}/scout`,
      );
      const request = fetcher.mock.calls[0]?.[1];
      expect(request).toMatchObject({
        method: "POST",
        credentials: "omit",
        body: "{}",
      });
      const headers = new Headers(request?.headers);
      expect(headers.get("authorization")).toBe(`Bearer ${ownedToken}`);
      expect(headers.get("content-type")).toBe("application/json");
      expect(headers.get("idempotency-key")).toBe("create-key-1");
    },
  );

  it("rejects a mismatched status location and fails closed without owned authority", async () => {
    const mismatch = createGamesClient(
      { ok: true, value: bootstrap() },
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(JSON.stringify(job), {
          status: 202,
          headers: { location: "/scout-jobs/other" },
        }),
      ),
    );
    if (!mismatch.ok) throw mismatch.error;
    await expect(
      mismatch.value.createScoutingJob?.(
        job.eventId,
        "create-key-1",
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "invalid-response" });

    const fetcher = vi.fn<typeof fetch>();
    const forbidden = createGamesClient(
      { ok: true, value: bootstrap() },
      fetcher,
      {
        authorize: vi.fn(() => Promise.resolve(null)),
        refuse: vi.fn(),
      },
    );
    if (!forbidden.ok) throw forbidden.error;
    await expect(
      forbidden.value.getScoutingJob?.(job.jobId, new AbortController().signal),
    ).rejects.toMatchObject({ code: "authentication" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("never consults the legacy token provider for ordinary scouting", async () => {
    const provider = vi.fn(() => Promise.reject(new Error("legacy-called")));
    Object.defineProperty(globalThis, "__FTE_TOKEN_PROVIDERS__", {
      configurable: true,
      value: { session: provider },
    });
    const result = createGamesClient(
      { ok: true, value: bootstrap() },
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response(null, { status: 401 })),
    );
    if (!result.ok) throw result.error;
    await expect(
      result.value.getScoutingJob?.(job.jobId, new AbortController().signal),
    ).rejects.toMatchObject({ code: "authentication" });
    expect(provider).not.toHaveBeenCalled();
  });

  it("exposes owned scouting methods without Cognito launch configuration", () => {
    const result = createGamesClient({
      ok: true,
      value: {
        config: {
          schemaVersion: 1,
          apiBase: "https://api.example.test",
          tokenProviderKey: "session",
        },
      },
    });
    if (!result.ok) throw result.error;
    expect("createScoutingJob" in result.value).toBe(true);
    expect("getScoutingJob" in result.value).toBe(true);
    expect("retryScoutingJob" in result.value).toBe(true);
    expect("getScoutReportByJob" in result.value).toBe(true);
  });

  it("reads owner status and sends a fenced retry", async () => {
    const failed = {
      ...job,
      status: "failed_retryable" as const,
      stateVersion: 2,
      updatedAt: "2026-08-07T13:01:00.000Z",
      failure: { code: "workflow-timeout" as const, retryable: true },
    };
    const retried = {
      ...job,
      status: "queued" as const,
      stateVersion: 3,
      attemptNumber: 2,
      updatedAt: "2026-08-07T13:02:00.000Z",
    };
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify(failed)))
      .mockResolvedValueOnce(
        new Response(JSON.stringify(retried), {
          status: 202,
          headers: { location: `/scout-jobs/${job.jobId}` },
        }),
      );
    const result = createGamesClient({ ok: true, value: bootstrap() }, fetcher);
    if (!result.ok) throw result.error;
    await expect(
      result.value.getScoutingJob?.(job.jobId, new AbortController().signal),
    ).resolves.toEqual(failed);
    await expect(
      result.value.retryScoutingJob?.(
        job.jobId,
        failed.stateVersion,
        "retry-key-1",
        new AbortController().signal,
      ),
    ).resolves.toEqual(retried);
    const request = fetcher.mock.calls[1]?.[1];
    expect(request).toMatchObject({
      method: "POST",
      body: JSON.stringify({ expectedStateVersion: 2 }),
    });
    expect(new Headers(request?.headers).get("idempotency-key")).toBe(
      "retry-key-1",
    );
  });

  it.each([
    [401, "authentication"],
    [403, "forbidden"],
    [404, "not-found"],
    [409, "conflict"],
    [422, "retry-limit"],
    [503, "request-failed"],
  ] as const)("maps retry HTTP %s to safe %s failure", async (status, code) => {
    const result = createGamesClient(
      { ok: true, value: bootstrap() },
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response('{"secret":"hidden"}', { status })),
    );
    if (!result.ok) throw result.error;
    await expect(
      result.value.retryScoutingJob?.(
        job.jobId,
        2,
        "retry-key",
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code });
  });

  it("refuses only the exact owned session after an authoritative 401", async () => {
    const session = ownedSession();
    const result = createGamesClient(
      { ok: true, value: bootstrap() },
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response(null, { status: 401 })),
      session,
    );
    if (!result.ok) throw result.error;
    await expect(
      result.value.getScoutingJob?.(job.jobId, new AbortController().signal),
    ).rejects.toMatchObject({ code: "authentication" });
    expect(session.refuse).toHaveBeenCalledWith(
      authorization(),
      "authentication",
    );
  });

  it("aborts while owned authorization is still pending", async () => {
    const authorize = vi.fn(
      () => new Promise<ReturnType<typeof authorization>>(() => {}),
    );
    const result = createGamesClient(
      { ok: true, value: bootstrap() },
      vi.fn<typeof fetch>(),
      { authorize, refuse: vi.fn() },
    );
    if (!result.ok) throw result.error;
    const controller = new AbortController();
    const request = result.value.getScoutingJob?.(job.jobId, controller.signal);
    controller.abort();
    expect(authorize).toHaveBeenCalledOnce();
    await expect(request).rejects.toMatchObject({ name: "AbortError" });
  });

  it("times out a hung scouting fetch with a safe failure", async () => {
    const timeout = new AbortController();
    const timeoutSpy = vi
      .spyOn(AbortSignal, "timeout")
      .mockReturnValue(timeout.signal);
    const result = createGamesClient(
      { ok: true, value: bootstrap() },
      vi.fn<typeof fetch>(() => new Promise<Response>(() => {})),
    );
    if (!result.ok) throw result.error;
    const request = result.value.getScoutingJob?.(
      job.jobId,
      new AbortController().signal,
    );
    await Promise.resolve();
    timeout.abort(new DOMException("Timed out", "TimeoutError"));
    await expect(request).rejects.toMatchObject({ code: "request-failed" });
    timeoutSpy.mockRestore();
  });

  it("resolves a fresh owned token for every ordinary physical request", async () => {
    const requestTokens = Array.from(
      { length: 9 },
      (_, index) =>
        `fte1.${String(index + 1).repeat(40)}.${String(index + 1).repeat(64)}`,
    );
    const authorize = vi.fn<OwnedSessionTransport["authorize"]>();
    for (const requestToken of requestTokens) {
      authorize.mockResolvedValueOnce(authorization(requestToken));
      authorize.mockResolvedValueOnce(authorization(requestToken));
    }
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(null, { status: 401 }));
    const result = createGamesClient(
      { ok: true, value: bootstrap() },
      fetcher,
      { authorize, refuse: vi.fn() },
    );
    if (!result.ok) throw result.error;
    const reportId = `scout-report:${"b".repeat(64)}`;
    const calls = [
      () =>
        result.value.createScoutingJob?.(
          job.eventId,
          "create-key",
          new AbortController().signal,
        ),
      () =>
        result.value.getScoutingJob?.(job.jobId, new AbortController().signal),
      () =>
        result.value.retryScoutingJob?.(
          job.jobId,
          1,
          "retry-key",
          new AbortController().signal,
        ),
      () =>
        result.value.getScoutReportByJob?.(
          job.jobId,
          new AbortController().signal,
        ),
      () =>
        result.value.getScoutReportVersion?.(
          reportId,
          1,
          new AbortController().signal,
        ),
      () =>
        result.value.listScoutReportVersions?.(
          reportId,
          new AbortController().signal,
        ),
      () => result.value.listWatchlist?.(new AbortController().signal),
      () =>
        result.value.addToWatchlist?.(
          job.eventId,
          new AbortController().signal,
        ),
      () =>
        result.value.removeFromWatchlist?.(
          job.eventId,
          new AbortController().signal,
        ),
    ];
    for (const call of calls)
      await expect(call()).rejects.toMatchObject({ code: "authentication" });
    expect(authorize).toHaveBeenCalledTimes(18);
    expect(
      fetcher.mock.calls.map(([, init]) =>
        new Headers(init?.headers).get("authorization"),
      ),
    ).toEqual(requestTokens.map((requestToken) => `Bearer ${requestToken}`));
  });

  it("rejects a successful response after the owned session changes", async () => {
    const replacementToken = `fte1.${"z".repeat(40)}.${"z".repeat(64)}`;
    const authorize = vi
      .fn<OwnedSessionTransport["authorize"]>()
      .mockResolvedValueOnce(authorization())
      .mockResolvedValueOnce(authorization(replacementToken));
    const refuse = vi.fn();
    const result = createGamesClient(
      { ok: true, value: bootstrap() },
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response(JSON.stringify(job))),
      { authorize, refuse },
    );
    if (!result.ok) throw result.error;
    await expect(
      result.value.getScoutingJob?.(job.jobId, new AbortController().signal),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(refuse).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "scouting 403",
      status: 403,
      call: (client: GamesClient, signal: AbortSignal) =>
        client.getScoutingJob?.(job.jobId, signal),
    },
    {
      label: "report 404",
      status: 404,
      call: (client: GamesClient, signal: AbortSignal) =>
        client.getScoutReportByJob?.(job.jobId, signal),
    },
    {
      label: "scouting 409",
      status: 409,
      call: (client: GamesClient, signal: AbortSignal) =>
        client.retryScoutingJob?.(job.jobId, 1, "retry-key", signal),
    },
    {
      label: "scouting 422",
      status: 422,
      call: (client: GamesClient, signal: AbortSignal) =>
        client.createScoutingJob?.(job.eventId, "create-key", signal),
    },
  ])(
    "cancels a stale $label terminal error before it reaches the replacement session",
    async ({ status, call }) => {
      const replacement = authorization(
        `fte1.${"e".repeat(40)}.${"e".repeat(64)}`,
      );
      const authorize = vi
        .fn<OwnedSessionTransport["authorize"]>()
        .mockResolvedValueOnce(authorization())
        .mockResolvedValueOnce(replacement);
      const refuse = vi.fn();
      const result = createGamesClient(
        { ok: true, value: bootstrap() },
        vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status })),
        { authorize, refuse },
      );
      if (!result.ok) throw result.error;
      await expect(
        call(result.value, new AbortController().signal),
      ).rejects.toMatchObject({ name: "AbortError" });
      expect(refuse).not.toHaveBeenCalled();
    },
  );

  it.each([
    {
      label: "scouting",
      call: (client: GamesClient, signal: AbortSignal) =>
        client.getScoutingJob?.(job.jobId, signal),
    },
    {
      label: "report",
      call: (client: GamesClient, signal: AbortSignal) =>
        client.getScoutReportByJob?.(job.jobId, signal),
    },
    {
      label: "watchlist",
      call: (client: GamesClient, signal: AbortSignal) =>
        client.listWatchlist?.(signal),
    },
  ])(
    "cancels a stale malformed $label body before surfacing parser failure",
    async ({ call }) => {
      const authorize = vi
        .fn<OwnedSessionTransport["authorize"]>()
        .mockResolvedValueOnce(authorization())
        .mockResolvedValueOnce(
          authorization(`fte1.${"m".repeat(40)}.${"m".repeat(64)}`),
        );
      const refuse = vi.fn();
      const result = createGamesClient(
        { ok: true, value: bootstrap() },
        vi
          .fn<typeof fetch>()
          .mockResolvedValue(new Response(JSON.stringify({ malformed: true }))),
        { authorize, refuse },
      );
      if (!result.ok) throw result.error;
      await expect(
        call(result.value, new AbortController().signal),
      ).rejects.toMatchObject({ name: "AbortError" });
      expect(refuse).not.toHaveBeenCalled();
    },
  );

  it("cancels a stale 401 without refusing a replacement token", async () => {
    const authorize = vi
      .fn<OwnedSessionTransport["authorize"]>()
      .mockResolvedValueOnce(authorization())
      .mockResolvedValueOnce(
        authorization(`fte1.${"n".repeat(40)}.${"n".repeat(64)}`),
      );
    const refuse = vi.fn();
    const result = createGamesClient(
      { ok: true, value: bootstrap() },
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response(null, { status: 401 })),
      { authorize, refuse },
    );
    if (!result.ok) throw result.error;
    await expect(
      result.value.getScoutingJob?.(job.jobId, new AbortController().signal),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(refuse).not.toHaveBeenCalled();
  });

  it("account-fences 402 while preserving same-account token refresh", async () => {
    const refreshed = authorization(`fte1.${"p".repeat(40)}.${"p".repeat(64)}`);
    const authorize = vi
      .fn<OwnedSessionTransport["authorize"]>()
      .mockResolvedValueOnce(authorization())
      .mockResolvedValueOnce(refreshed);
    const refuse = vi.fn();
    const result = createGamesClient(
      { ok: true, value: bootstrap() },
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response(null, { status: 402 })),
      { authorize, refuse },
    );
    if (!result.ok) throw result.error;
    await expect(
      result.value.getScoutingJob?.(job.jobId, new AbortController().signal),
    ).rejects.toMatchObject({ code: "payment-required" });
    expect(refuse).toHaveBeenCalledWith(authorization(), "payment-required");
  });

  it("cancels a stale 402 after an account replacement", async () => {
    const authorize = vi
      .fn<OwnedSessionTransport["authorize"]>()
      .mockResolvedValueOnce(authorization())
      .mockResolvedValueOnce({
        token: `fte1.${"q".repeat(40)}.${"q".repeat(64)}`,
        accountId: `account:${"d".repeat(64)}`,
      });
    const refuse = vi.fn();
    const result = createGamesClient(
      { ok: true, value: bootstrap() },
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response(null, { status: 402 })),
      { authorize, refuse },
    );
    if (!result.ok) throw result.error;
    await expect(
      result.value.getScoutingJob?.(job.jobId, new AbortController().signal),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(refuse).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "scouting status token replacement",
      body: job,
      replacement: authorization(`fte1.${"s".repeat(40)}.${"s".repeat(64)}`),
      call: (client: GamesClient, signal: AbortSignal) =>
        client.getScoutingJob?.(job.jobId, signal),
    },
    {
      label: "report account replacement",
      body: {
        schemaVersion: "scout-report-versions-v1",
        reportId: `scout-report:${"b".repeat(64)}`,
        eventId: job.eventId,
        latestVersionNumber: 1,
        updatedAt: "2026-08-07T13:02:00.000Z",
        items: [
          {
            versionNumber: 1,
            generatedAt: "2026-08-07T13:02:00.000Z",
            validationOutcome: "complete",
            changeSummary: { kind: "initial", changedFields: [] },
            jobId: job.jobId,
          },
        ],
      },
      replacement: {
        token: `fte1.${"r".repeat(40)}.${"r".repeat(64)}`,
        accountId: `account:${"c".repeat(64)}`,
      },
      call: (client: GamesClient, signal: AbortSignal) =>
        client.listScoutReportVersions?.(
          `scout-report:${"b".repeat(64)}`,
          signal,
        ),
    },
    {
      label: "watchlist token replacement",
      body: { schemaVersion: "watchlist-page-v1", items: [] },
      replacement: authorization(`fte1.${"w".repeat(40)}.${"w".repeat(64)}`),
      call: (client: GamesClient, signal: AbortSignal) =>
        client.listWatchlist?.(signal),
    },
  ])(
    "ignores a deferred $label completion",
    async ({ body, replacement, call }) => {
      const deferred = deferredJsonResponse(body);
      const authorize = vi
        .fn<OwnedSessionTransport["authorize"]>()
        .mockResolvedValueOnce(authorization())
        .mockResolvedValueOnce(replacement);
      const refuse = vi.fn();
      const result = createGamesClient(
        { ok: true, value: bootstrap() },
        vi.fn<typeof fetch>().mockResolvedValue(deferred.response),
        { authorize, refuse },
      );
      if (!result.ok) throw result.error;
      const pending = call(result.value, new AbortController().signal);
      await deferred.bodyStarted;
      deferred.release();
      await expect(pending).rejects.toMatchObject({ name: "AbortError" });
      expect(refuse).not.toHaveBeenCalled();
    },
  );

  it("bounds a deferred report body read with the request timeout", async () => {
    const deferred = deferredJsonResponse({});
    const timeout = new AbortController();
    const timeoutSpy = vi
      .spyOn(AbortSignal, "timeout")
      .mockReturnValue(timeout.signal);
    const result = createGamesClient(
      { ok: true, value: bootstrap() },
      vi.fn<typeof fetch>().mockResolvedValue(deferred.response),
    );
    if (!result.ok) throw result.error;
    const pending = result.value.listScoutReportVersions?.(
      `scout-report:${"b".repeat(64)}`,
      new AbortController().signal,
    );
    await deferred.bodyStarted;
    timeout.abort(new DOMException("Timed out", "TimeoutError"));
    await expect(pending).rejects.toMatchObject({ code: "request-failed" });
    deferred.release();
    timeoutSpy.mockRestore();
  });

  it("aborts a deferred watchlist body read without a late session effect", async () => {
    const deferred = deferredJsonResponse({
      schemaVersion: "watchlist-page-v1",
      items: [],
    });
    const session = ownedSession();
    const result = createGamesClient(
      { ok: true, value: bootstrap() },
      vi.fn<typeof fetch>().mockResolvedValue(deferred.response),
      session,
    );
    if (!result.ok) throw result.error;
    const controller = new AbortController();
    const pending = result.value.listWatchlist?.(controller.signal);
    await deferred.bodyStarted;
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    deferred.release();
    await Promise.resolve();
    expect(session.refuse).not.toHaveBeenCalled();
    expect(session.authorize).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed job IDs before session acquisition", async () => {
    const authorize = vi.fn<OwnedSessionTransport["authorize"]>();
    const result = createGamesClient(
      { ok: true, value: bootstrap() },
      vi.fn<typeof fetch>(),
      { authorize, refuse: vi.fn() },
    );
    if (!result.ok) throw result.error;
    await expect(
      result.value.getScoutingJob?.("not-a-job", new AbortController().signal),
    ).rejects.toMatchObject({ code: "invalid-response" });
    expect(authorize).not.toHaveBeenCalled();
  });
});

const rankedOpportunity = (
  suffix: string,
  expectedValue: number,
  sportKey: "mlb" | "soccer" = "mlb",
): import("@find-the-edge/domain").RankedOpportunityDto => ({
  schemaVersion: "ranked-opportunity-dto-v1",
  opportunityId: `opportunity:${suffix.repeat(64)}`,
  sportKey,
  event: {
    id: `event-${suffix}`,
    version: 1,
    competitionKey: sportKey === "mlb" ? "mlb" : "mls",
    participants: [
      { id: `team-${suffix}-a`, label: `Team ${suffix.toUpperCase()} A` },
      { id: `team-${suffix}-b`, label: `Team ${suffix.toUpperCase()} B` },
    ],
    startsAt: "2026-08-06T20:00:00.000Z",
    eastern: {
      timeZone: "America/New_York",
      calendarDay: "2026-08-06",
      display: "Aug 6, 2026, 4:00 PM",
    },
    status: "scheduled",
  },
  market: { key: "moneyline", selectionKey: "away", point: null },
  target: {
    sportsbookId: "hardrock",
    americanOdds: 120,
    impliedProbability: 100 / 220,
    observedAt: "2026-08-06T12:00:00.000Z",
    retrievedAt: "2026-08-06T12:00:01.000Z",
  },
  bestComparison: {
    sportsbookId: "draftkings",
    americanOdds: 115,
    observedAt: "2026-08-06T12:00:00.000Z",
    retrievedAt: "2026-08-06T12:00:01.000Z",
  },
  consensus: { probability: 0.5, fairAmericanOdds: 100 },
  expectedValue,
  confidence: {
    score: 80,
    bucket: "high",
    weakestComponent: "coverage",
    components: { freshness: 100, coverage: 80, agreement: 90 },
  },
  dataQuality: { score: 80, bucket: "high", weakestComponent: "coverage" },
  contributingBooks: ["draftkings", "fanduel", "betmgm"],
  warningCodes: ["market-disagreement-warning"],
  liveFreshness: {
    scoredAt: "2026-08-06T12:05:00.000Z",
    oldestRequiredEvidenceAt: "2026-08-06T12:00:00.000Z",
    ageMinutes: 5,
    maximumAgeMinutes: 15,
    expiresAt: "2026-08-06T12:15:00.001Z",
  },
  versions: {
    ranking: { id: "find-the-edge-opportunity-ranking", version: "1.0.0" },
    evaluationPolicy: { id: "evaluation", version: "1.0.0" },
    strategy: { id: "strategy", version: "1.0.0" },
    sportModule: { id: sportKey, version: "1.0.0" },
    calculation: { id: "opportunity-qualification", version: "1.0.0" },
  },
});

const rankedPage = (items = [rankedOpportunity("a", 0.12)]) => ({
  schemaVersion: "ranked-opportunity-page-v1",
  rankingPolicy: {
    id: "find-the-edge-opportunity-ranking",
    version: "1.0.0",
  },
  items,
  nextCursor: null,
  snapshotAt: "2026-08-06T12:05:00.000Z",
  evaluationState: "complete",
  hasMoreUnknown: false,
  evaluatedCount: items.length,
  filteredCount: 0,
  staleCount: 0,
  joinFailureCount: 0,
});

const providerStatusPage = () => ({
  schemaVersion: "provider-status-page-v1",
  snapshotAt: "2026-08-07T12:00:00.000Z",
  evaluationState: "complete",
  summary: {
    total: 1,
    healthy: 1,
    partial: 0,
    stale: 0,
    outage: 0,
    unknown: 0,
    impacted: 0,
  },
  items: [
    {
      scopeId: "sharpapi:mlb:odds",
      providerId: "sharpapi",
      providerName: "Odds Feed",
      sportKey: "mlb",
      leagueKey: "mlb",
      capability: "odds",
      purpose: "Sportsbook prices",
      supportedData: ["moneyline"],
      connection: "healthy",
      safeReason: "none",
      lastCheckedAt: "2026-08-07T11:59:00.000Z",
      lastSuccessfulAt: "2026-08-07T11:59:00.000Z",
      retryAt: null,
      freshness: { ageSeconds: 60, expectedSeconds: 900 },
      capacity: {
        state: "available",
        limit: 1000,
        remaining: 800,
        reserve: 100,
        resetsAt: "2026-08-07T12:10:00.000Z",
      },
      recommendationImpact: "none",
    },
  ],
});

describe("provider status client", () => {
  it("uses the public endpoint without credentials", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify(providerStatusPage())));
    const result = createGamesClient({ ok: true, value: bootstrap() }, fetcher);
    if (!result.ok) throw result.error;
    await expect(
      result.value.providerStatus!(new AbortController().signal),
    ).resolves.toMatchObject({ summary: { healthy: 1 } });
    expect(fetcher.mock.calls[0]?.[0]).toBe(
      "https://api.example.test/providers/status",
    );
    expect(fetcher.mock.calls[0]?.[1]?.credentials).toBe("omit");
    expect(fetcher.mock.calls[0]?.[1]?.headers).toBeUndefined();
  });

  it.each([
    { ...providerStatusPage(), internalHealthKey: "secret" },
    {
      ...providerStatusPage(),
      summary: { ...providerStatusPage().summary, healthy: 0 },
    },
    {
      ...providerStatusPage(),
      items: [providerStatusPage().items[0], providerStatusPage().items[0]],
    },
    {
      ...providerStatusPage(),
      items: [
        {
          ...providerStatusPage().items[0],
          capacity: {
            ...providerStatusPage().items[0]!.capacity,
            resetsAt: "2026-08-07T11:00:00.000Z",
          },
        },
      ],
    },
  ])("rejects hostile provider status responses", async (body) => {
    const result = createGamesClient(
      { ok: true, value: bootstrap() },
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response(JSON.stringify(body))),
    );
    if (!result.ok) throw result.error;
    await expect(
      result.value.providerStatus!(new AbortController().signal),
    ).rejects.toMatchObject({ code: "invalid-response" });
  });
});

describe("owned product transport", () => {
  it("does not refuse after cancellation wins a missing-authority race", async () => {
    let resolveAuthorization!: (value: null) => void;
    const refuse = vi.fn();
    const fetcher = vi.fn<typeof fetch>();
    const authorize = vi.fn(
      () =>
        new Promise<null>((resolve) => {
          resolveAuthorization = resolve;
        }),
    );
    const result = createGamesClient(
      { ok: true, value: bootstrap() },
      fetcher,
      {
        authorize,
        refuse,
      },
    );
    if (!result.ok) throw result.error;
    const controller = new AbortController();
    const pending = result.value.getScoutingJob?.(
      `scout-job:${"a".repeat(64)}`,
      controller.signal,
    );
    await vi.waitFor(() => expect(authorize).toHaveBeenCalledOnce());
    controller.abort();
    resolveAuthorization(null);
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(refuse).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("does not refuse when cancellation wins invalid-authority validation", async () => {
    const controller = new AbortController();
    const refuse = vi.fn();
    const invalidAuthorization = {
      get token() {
        controller.abort();
        return "invalid";
      },
      accountId: ownedAccount,
    };
    const fetcher = vi.fn<typeof fetch>();
    const result = createGamesClient(
      { ok: true, value: bootstrap() },
      fetcher,
      {
        authorize: vi.fn(() => Promise.resolve(invalidAuthorization)),
        refuse,
      },
    );
    if (!result.ok) throw result.error;
    await expect(
      result.value.getScoutingJob?.(
        `scout-job:${"a".repeat(64)}`,
        controller.signal,
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(refuse).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([401, 402])(
    "does not refuse after cancellation wins a %s response race",
    async (status) => {
      let resolveFetch!: (response: Response) => void;
      const refuse = vi.fn();
      const fetcher = vi.fn<typeof fetch>(
        () =>
          new Promise<Response>((resolve) => {
            resolveFetch = resolve;
          }),
      );
      const result = createGamesClient(
        { ok: true, value: bootstrap() },
        fetcher,
        { authorize: ownedSession().authorize, refuse },
      );
      if (!result.ok) throw result.error;
      const controller = new AbortController();
      const pending = result.value.getScoutingJob?.(
        `scout-job:${"a".repeat(64)}`,
        controller.signal,
      );
      await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
      controller.abort();
      resolveFetch(new Response(null, { status }));
      await expect(pending).rejects.toMatchObject({ name: "AbortError" });
      expect(refuse).not.toHaveBeenCalled();
    },
  );

  it("fails before a product fetch when no owned session is usable", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const result = createGamesClientWithTransport(
      { ok: true, value: bootstrap() },
      fetcher,
    );
    if (!result.ok) throw result.error;

    await expect(
      result.value.listOpportunities!("mlb", new AbortController().signal),
    ).rejects.toMatchObject({ code: "authentication" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("reports a session that disappears before the fetch", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const refuse = vi.fn();
    const result = createGamesClient(
      { ok: true, value: bootstrap() },
      fetcher,
      { authorize: () => Promise.resolve(null), refuse },
    );
    if (!result.ok) throw result.error;

    await expect(
      result.value.listOpportunities!("mlb", new AbortController().signal),
    ).rejects.toMatchObject({ code: "authentication" });
    expect(refuse).toHaveBeenCalledWith(null, "authentication");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("reports rejected owned sessions and preserves payment-required", async () => {
    const refuse = vi.fn();
    const session = {
      authorize: vi.fn(() => Promise.resolve(authorization())),
      refuse,
    };
    const unauthorized = createGamesClient(
      { ok: true, value: bootstrap() },
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response(null, { status: 401 })),
      session,
    );
    if (!unauthorized.ok) throw unauthorized.error;
    await expect(
      unauthorized.value.listOpportunities!(
        "mlb",
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "authentication" });
    expect(refuse).toHaveBeenLastCalledWith(authorization(), "authentication");

    const paymentRequired = createGamesClient(
      { ok: true, value: bootstrap() },
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response(null, { status: 402 })),
      session,
    );
    if (!paymentRequired.ok) throw paymentRequired.error;
    await expect(
      paymentRequired.value.listExperiments!(new AbortController().signal),
    ).rejects.toMatchObject({ code: "payment-required" });
    expect(refuse).toHaveBeenLastCalledWith(
      authorization(),
      "payment-required",
    );
    expect(refuse).toHaveBeenCalledTimes(2);
  });

  it("reauthorizes every page and sends the latest token", async () => {
    const nextItem = {
      ...payload.items[0]!,
      id: "event:mlb%3Amlb:fixture-2",
      startsAt: "2026-08-01T23:06:00.000Z",
    };
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ...payload, nextCursor: "next" })),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ ...payload, items: [nextItem], nextCursor: null }),
        ),
      );
    const authorize = vi
      .fn<OwnedSessionTransport["authorize"]>()
      .mockResolvedValueOnce(authorization(`${ownedToken}-page-1`))
      .mockResolvedValueOnce(authorization(`${ownedToken}-page-2`));
    const result = createGamesClient(
      { ok: true, value: bootstrap() },
      fetcher,
      { authorize, refuse: vi.fn() },
    );
    if (!result.ok) throw result.error;

    await expect(
      result.value.list(
        { sport: "mlb", day: "2026-08-01" },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ items: [{ id: payload.items[0]!.id }] });
    expect(authorize).toHaveBeenCalledTimes(2);
    expect(
      fetcher.mock.calls.map((call) =>
        new Headers(call[1]?.headers).get("authorization"),
      ),
    ).toEqual([`Bearer ${ownedToken}-page-1`, `Bearer ${ownedToken}-page-2`]);
  });

  it("does not fetch when the caller aborts while authorization is pending", async () => {
    let resolveAuthorization!: (
      value: ReturnType<typeof authorization>,
    ) => void;
    const authorize = vi.fn(
      () =>
        new Promise<ReturnType<typeof authorization>>((resolve) => {
          resolveAuthorization = resolve;
        }),
    );
    const fetcher = vi.fn<typeof fetch>();
    const result = createGamesClient(
      { ok: true, value: bootstrap() },
      fetcher,
      { authorize, refuse: vi.fn() },
    );
    if (!result.ok) throw result.error;
    const controller = new AbortController();
    const reason = new DOMException("Stopped", "AbortError");
    const pending = result.value.listOpportunities!("mlb", controller.signal);
    controller.abort(reason);

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(fetcher).not.toHaveBeenCalled();
    // The shared refresh is not canceled; settling it later remains harmless.
    resolveAuthorization(authorization());
  });
});

describe("owned session capabilities client", () => {
  const capabilities = {
    schemaVersion: "owned-session-capabilities-v1",
    accountId: ownedAccount,
    capabilities: [...OWNED_SESSION_CAPABILITIES],
  };

  it("reads canonical capabilities with the current owned session", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify(capabilities)));
    const result = createGamesClient({ ok: true, value: bootstrap() }, fetcher);
    if (!result.ok) throw result.error;

    const loaded = await result.value.getSessionCapabilities?.(
      new AbortController().signal,
    );
    expect(loaded).toEqual(capabilities);
    expect(Object.isFrozen(loaded)).toBe(true);
    expect(Object.isFrozen(loaded?.capabilities)).toBe(true);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0]?.[0]).toBe(
      "https://api.example.test/auth/session/capabilities",
    );
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
      method: "GET",
      credentials: "omit",
      cache: "no-store",
    });
    expect(
      new Headers(fetcher.mock.calls[0]?.[1]?.headers).get("authorization"),
    ).toBe(`Bearer ${ownedToken}`);
  });

  it("rejects a capability response when the active account changes in flight", async () => {
    const nextAccount = `account:${"c".repeat(64)}`;
    const authorize = vi
      .fn()
      .mockResolvedValueOnce(authorization())
      .mockResolvedValueOnce({ token: ownedToken, accountId: nextAccount });
    const result = createGamesClient(
      { ok: true, value: bootstrap() },
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response(JSON.stringify(capabilities))),
      { authorize, refuse: vi.fn() },
    );
    if (!result.ok) throw result.error;

    await expect(
      result.value.getSessionCapabilities?.(new AbortController().signal),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(authorize).toHaveBeenCalledTimes(2);
  });

  it("accepts a same-account token refresh while capabilities are in flight", async () => {
    const authorize = vi
      .fn()
      .mockResolvedValueOnce(authorization())
      .mockResolvedValueOnce(authorization(`${ownedToken}-refreshed`));
    const result = createGamesClient(
      { ok: true, value: bootstrap() },
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response(JSON.stringify(capabilities))),
      { authorize, refuse: vi.fn() },
    );
    if (!result.ok) throw result.error;

    await expect(
      result.value.getSessionCapabilities?.(new AbortController().signal),
    ).resolves.toEqual(capabilities);
  });

  it("rejects a malformed replacement token for the same account", async () => {
    const authorize = vi
      .fn()
      .mockResolvedValueOnce(authorization())
      .mockResolvedValueOnce({ token: "legacy.jwt", accountId: ownedAccount });
    const result = createGamesClient(
      { ok: true, value: bootstrap() },
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response(JSON.stringify(capabilities))),
      { authorize, refuse: vi.fn() },
    );
    if (!result.ok) throw result.error;

    await expect(
      result.value.getSessionCapabilities?.(new AbortController().signal),
    ).rejects.toMatchObject({ code: "authentication" });
  });

  it("accepts an empty capability projection for an ordinary account", () => {
    expect(
      parseOwnedSessionCapabilities(
        { ...capabilities, capabilities: [] },
        ownedAccount,
      ),
    ).toEqual({ ...capabilities, capabilities: [] });
  });

  it.each([
    [
      "another account",
      { ...capabilities, accountId: `account:${"c".repeat(64)}` },
    ],
    [
      "an unknown schema",
      { ...capabilities, schemaVersion: "owned-session-capabilities-v2" },
    ],
    [
      "an unknown capability",
      { ...capabilities, capabilities: ["events/admin"] },
    ],
    [
      "a repeated capability",
      {
        ...capabilities,
        capabilities: [
          OWNED_SESSION_CAPABILITIES[0],
          OWNED_SESSION_CAPABILITIES[0],
        ],
      },
    ],
    [
      "a noncanonical order",
      {
        ...capabilities,
        capabilities: [...OWNED_SESSION_CAPABILITIES].reverse(),
      },
    ],
    ["an extra field", { ...capabilities, roles: ["strategy-promoter"] }],
  ])("fails closed on %s", async (_label, body) => {
    const result = createGamesClient(
      { ok: true, value: bootstrap() },
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response(JSON.stringify(body))),
    );
    if (!result.ok) throw result.error;
    await expect(
      result.value.getSessionCapabilities?.(new AbortController().signal),
    ).rejects.toMatchObject({ code: "invalid-response" });
  });

  it("refuses a malformed owned-session identity before the request", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const refuse = vi.fn();
    const result = createGamesClient(
      { ok: true, value: bootstrap() },
      fetcher,
      {
        authorize: () =>
          Promise.resolve({ token: "legacy.jwt", accountId: ownedAccount }),
        refuse,
      },
    );
    if (!result.ok) throw result.error;

    await expect(
      result.value.getSessionCapabilities?.(new AbortController().signal),
    ).rejects.toMatchObject({ code: "authentication" });
    expect(fetcher).not.toHaveBeenCalled();
    expect(refuse).toHaveBeenCalledWith(
      { token: "legacy.jwt", accountId: ownedAccount },
      "authentication",
    );
  });
});

type ElevatedDomainFixture = {
  readonly label: string;
  readonly capability: (typeof OWNED_SESSION_CAPABILITIES)[number];
  readonly otherCapability: (typeof OWNED_SESSION_CAPABILITIES)[number];
  readonly mutationPath: string;
  readonly expectedBody: Readonly<Record<string, unknown>>;
  readonly can: (client: GamesClient, signal: AbortSignal) => Promise<boolean>;
  readonly mutate: (
    client: GamesClient,
    signal: AbortSignal,
  ) => Promise<unknown>;
};

const retrospectiveVersionId = `retrospective-version:${"a".repeat(64)}`;
const retrospectiveVersion = {
  versionId: retrospectiveVersionId,
  state: "draft",
  stateVersion: 1,
} as never;
const experimentId = `strategy-experiment:${"b".repeat(64)}`;
const experimentMutation = {
  reason: "Reviewed evidence.",
  idempotencyKey: "key-2",
  expectedStateVersion: 1,
  expectedDigest: "c".repeat(64),
  artifactDigest: "d".repeat(64),
};

const elevatedDomains: readonly ElevatedDomainFixture[] = [
  {
    label: "retrospective review",
    capability: "events/retrospectives:approve",
    otherCapability: "events/strategies:promote",
    mutationPath: `/retrospectives/${encodeURIComponent(
      retrospectiveVersionId,
    )}/review`,
    expectedBody: {
      reasonCode: "approve",
      note: "Reviewed evidence.",
      idempotencyKey: "key-1",
      expectedState: "draft",
      expectedStateVersion: 1,
    },
    can: (client, signal) => {
      if (!client.canReviewRetrospectives)
        throw new Error("review-capability-check-missing");
      const abortableClient = client as GamesClient & {
        canReviewRetrospectives(signal: AbortSignal): Promise<boolean>;
      };
      return abortableClient.canReviewRetrospectives(signal);
    },
    mutate: (client, signal) => {
      if (!client.reviewRetrospective)
        throw new Error("retrospective-mutation-missing");
      return client.reviewRetrospective(
        retrospectiveVersion,
        {
          reasonCode: "approve",
          note: "Reviewed evidence.",
          idempotencyKey: "key-1",
        },
        signal,
      );
    },
  },
  {
    label: "strategy promotion",
    capability: "events/strategies:promote",
    otherCapability: "events/retrospectives:approve",
    mutationPath: `/strategy-experiments/${encodeURIComponent(
      experimentId,
    )}/approve`,
    expectedBody: experimentMutation,
    can: (client, signal) => {
      if (!client.canManageExperiments)
        throw new Error("strategy-capability-check-missing");
      const abortableClient = client as GamesClient & {
        canManageExperiments(signal: AbortSignal): Promise<boolean>;
      };
      return abortableClient.canManageExperiments(signal);
    },
    mutate: (client, signal) => {
      if (!client.manageExperiment)
        throw new Error("strategy-mutation-missing");
      return client.manageExperiment(
        experimentId,
        "approve",
        experimentMutation,
        signal,
      );
    },
  },
];

const capabilityResponse = (
  capabilities: readonly (typeof OWNED_SESSION_CAPABILITIES)[number][],
) =>
  new Response(
    JSON.stringify({
      schemaVersion: "owned-session-capabilities-v1",
      accountId: ownedAccount,
      capabilities,
    }),
  );

const requestUrl = (request: RequestInfo | URL): string =>
  typeof request === "string"
    ? request
    : request instanceof URL
      ? request.toString()
      : request.url;

const elevatedClient = (
  fetcher: typeof fetch,
  session: OwnedSessionTransport = ownedSession(),
): GamesClient => {
  const result = createGamesClient(
    { ok: true, value: bootstrap() },
    fetcher,
    session,
  );
  if (!result.ok) throw result.error;
  return result.value;
};

describe.each(elevatedDomains)("$label owned capability gate", (domain) => {
  const capabilityUrl = "https://api.example.test/auth/session/capabilities";
  const mutationUrl = `https://api.example.test${domain.mutationPath}`;

  it("selects only the exact owned capability and forwards cancellation", async () => {
    for (const [capabilities, expected] of [
      [[domain.capability], true],
      [[domain.otherCapability], false],
      [[], false],
    ] as const) {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValue(capabilityResponse(capabilities));
      const signal = new AbortController().signal;

      await expect(domain.can(elevatedClient(fetcher), signal)).resolves.toBe(
        expected,
      );
      expect(fetcher).toHaveBeenCalledOnce();
      expect(requestUrl(fetcher.mock.calls[0]![0])).toBe(capabilityUrl);
      expect(fetcher.mock.calls[0]![1]?.signal).toBe(signal);
    }
  });

  it("rechecks owned authority and sends only the current owned bearer", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation((request) =>
        Promise.resolve(
          requestUrl(request) === capabilityUrl
            ? capabilityResponse([domain.capability])
            : new Response("{}", { status: 409 }),
        ),
      );
    const client = elevatedClient(fetcher);
    const signal = new AbortController().signal;

    await expect(domain.can(client, signal)).resolves.toBe(true);
    await expect(domain.mutate(client, signal)).rejects.toMatchObject({
      code: "conflict",
    });

    expect(fetcher.mock.calls.map(([request]) => requestUrl(request))).toEqual([
      capabilityUrl,
      capabilityUrl,
      mutationUrl,
    ]);
    const mutationRequest = fetcher.mock.calls[2]![1];
    expect(new Headers(mutationRequest?.headers).get("authorization")).toBe(
      `Bearer ${ownedToken}`,
    );
    expect(mutationRequest).toMatchObject({
      method: "POST",
      credentials: "omit",
      cache: "no-store",
    });
    const mutationBody = mutationRequest?.body;
    expect(typeof mutationBody).toBe("string");
    if (typeof mutationBody !== "string")
      throw new Error("elevated-mutation-body-missing");
    expect(JSON.parse(mutationBody)).toEqual(domain.expectedBody);
  });

  it.each([
    ["denial", capabilityResponse([]), "forbidden"],
    [
      "capability failure",
      new Response(null, { status: 503 }),
      "request-failed",
    ],
  ])("stops on %s before sending a POST", async (_case, response, code) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response);

    await expect(
      domain.mutate(elevatedClient(fetcher), new AbortController().signal),
    ).rejects.toMatchObject({ code });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(requestUrl(fetcher.mock.calls[0]![0])).toBe(capabilityUrl);
  });

  it.each(["deferred 503", "deferred malformed body"])(
    "cancels a stale %s capability error after account replacement",
    async (failure) => {
      const replacement = {
        token: `fte1.${"replacement".padEnd(40, "x")}.${"c".repeat(64)}`,
        accountId: `account:${"d".repeat(64)}`,
      };
      let current = authorization();
      const authorize = vi.fn(() => Promise.resolve(current));
      const refuse = vi.fn();
      let resolveResponse!: (response: Response) => void;
      const fetcher = vi.fn<typeof fetch>(
        () =>
          new Promise<Response>((resolve) => {
            resolveResponse = resolve;
          }),
      );
      const malformed = deferredJsonResponse({ unexpected: true });
      const pending = domain.mutate(
        elevatedClient(fetcher, { authorize, refuse }),
        new AbortController().signal,
      );
      await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
      if (failure === "deferred 503") {
        current = replacement;
        resolveResponse(new Response(null, { status: 503 }));
      } else {
        resolveResponse(malformed.response);
        await malformed.bodyStarted;
        current = replacement;
        malformed.release();
      }

      await expect(pending).rejects.toMatchObject({ name: "AbortError" });
      expect(fetcher).toHaveBeenCalledOnce();
      expect(refuse).not.toHaveBeenCalled();
    },
  );

  it("aborts an in-flight capability recheck before sending a POST", async () => {
    const controller = new AbortController();
    const reason = new DOMException("Stopped", "AbortError");
    const fetcher = vi.fn<typeof fetch>().mockImplementation(
      (_request, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => {
              // Fetch rejects with the exact AbortSignal reason; preserve that
              // identity so the client cannot replace cancellation with a
              // generic request failure.
              // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
              reject(init.signal?.reason);
            },
            { once: true },
          );
        }),
    );

    const pending = domain
      .mutate(elevatedClient(fetcher), controller.signal)
      .then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      );
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    expect(fetcher.mock.calls[0]![1]?.signal).toBe(controller.signal);
    controller.abort(reason);

    await expect(pending).resolves.toMatchObject({
      ok: false,
      error: { name: "AbortError" },
    });
    expect(requestUrl(fetcher.mock.calls[0]![0])).toBe(capabilityUrl);
  });

  it("uses a same-account token refresh that lands after capability approval", async () => {
    const refreshed = authorization(`${ownedToken}-refreshed`);
    const authorize = vi
      .fn<OwnedSessionTransport["authorize"]>()
      .mockResolvedValueOnce(authorization())
      .mockResolvedValueOnce(authorization())
      .mockResolvedValueOnce(refreshed)
      .mockResolvedValueOnce(refreshed);
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(capabilityResponse([domain.capability]))
      .mockResolvedValueOnce(new Response("{}", { status: 409 }));

    await expect(
      domain.mutate(
        elevatedClient(fetcher, { authorize, refuse: vi.fn() }),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(
      new Headers(fetcher.mock.calls[1]![1]?.headers).get("authorization"),
    ).toBe(`Bearer ${refreshed.token}`);
  });

  it("stops when the owned session changes after capability approval", async () => {
    const replacement = {
      token: "malformed-replacement-token",
      accountId: `account:${"d".repeat(64)}`,
    };
    const authorize = vi
      .fn<OwnedSessionTransport["authorize"]>()
      .mockResolvedValueOnce(authorization())
      .mockResolvedValueOnce(authorization())
      .mockResolvedValueOnce(replacement);
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(capabilityResponse([domain.capability]));
    const refuse = vi.fn();

    await expect(
      domain.mutate(
        elevatedClient(fetcher, { authorize, refuse }),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(requestUrl(fetcher.mock.calls[0]![0])).toBe(capabilityUrl);
    expect(refuse).not.toHaveBeenCalled();
  });

  it.each([
    [401, "authentication", true],
    [402, "payment-required", false],
  ] as const)(
    "preserves the owned %s refusal fence",
    async (status, code, exactToken) => {
      const sent = authorization();
      const terminal = exactToken
        ? sent
        : authorization(`${ownedToken}-refreshed`);
      const authorize = vi
        .fn<OwnedSessionTransport["authorize"]>()
        .mockResolvedValueOnce(sent)
        .mockResolvedValueOnce(sent)
        .mockResolvedValueOnce(sent)
        .mockResolvedValueOnce(terminal);
      const refuse = vi.fn();
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(capabilityResponse([domain.capability]))
        .mockResolvedValueOnce(new Response(null, { status }));

      await expect(
        domain.mutate(
          elevatedClient(fetcher, { authorize, refuse }),
          new AbortController().signal,
        ),
      ).rejects.toMatchObject({ code });
      expect(refuse).toHaveBeenCalledWith(
        sent,
        status === 401 ? "authentication" : "payment-required",
      );
    },
  );

  it.each([401, 402] as const)(
    "does not apply a stale %s refusal after account replacement",
    async (status) => {
      const replacement = {
        token: `fte1.${"replacement".padEnd(40, "x")}.${"c".repeat(64)}`,
        accountId: `account:${"d".repeat(64)}`,
      };
      const authorize = vi
        .fn<OwnedSessionTransport["authorize"]>()
        .mockResolvedValueOnce(authorization())
        .mockResolvedValueOnce(authorization())
        .mockResolvedValueOnce(authorization())
        .mockResolvedValueOnce(replacement);
      const refuse = vi.fn();
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(capabilityResponse([domain.capability]))
        .mockResolvedValueOnce(new Response(null, { status }));

      await expect(
        domain.mutate(
          elevatedClient(fetcher, { authorize, refuse }),
          new AbortController().signal,
        ),
      ).rejects.toMatchObject({ name: "AbortError" });
      expect(refuse).not.toHaveBeenCalled();
    },
  );

  it("does not apply a stale 401 after a same-account token refresh", async () => {
    const authorize = vi
      .fn<OwnedSessionTransport["authorize"]>()
      .mockResolvedValueOnce(authorization())
      .mockResolvedValueOnce(authorization())
      .mockResolvedValueOnce(authorization())
      .mockResolvedValueOnce(authorization(`${ownedToken}-refreshed`));
    const refuse = vi.fn();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(capabilityResponse([domain.capability]))
      .mockResolvedValueOnce(new Response(null, { status: 401 }));

    await expect(
      domain.mutate(
        elevatedClient(fetcher, { authorize, refuse }),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(refuse).not.toHaveBeenCalled();
  });
});

it("sends owned authority for approve, promote, and rollback", async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockImplementation((request) =>
      Promise.resolve(
        requestUrl(request).endsWith("/auth/session/capabilities")
          ? capabilityResponse(["events/strategies:promote"])
          : new Response("{}", { status: 409 }),
      ),
    );
  const client = elevatedClient(fetcher);
  for (const action of ["approve", "promote", "rollback"] as const)
    await expect(
      client.manageExperiment?.(
        experimentId,
        action,
        experimentMutation,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "conflict" });
  const posts = fetcher.mock.calls.filter(
    ([request]) => !requestUrl(request).endsWith("/auth/session/capabilities"),
  );
  expect(posts.map(([request]) => requestUrl(request))).toEqual(
    ["approve", "promote", "rollback"].map(
      (action) =>
        `https://api.example.test/strategy-experiments/${encodeURIComponent(experimentId)}/${action}`,
    ),
  );
  for (const [, init] of posts)
    expect(new Headers(init?.headers).get("authorization")).toBe(
      `Bearer ${ownedToken}`,
    );
});

describe("ranked opportunity client", () => {
  it("keeps the server order and sends the owned session", async () => {
    const body = rankedPage([
      rankedOpportunity("a", 0.12),
      rankedOpportunity("b", 0.08),
    ]);
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify(body)));
    const result = createGamesClient({ ok: true, value: bootstrap() }, fetcher);
    if (!result.ok) throw result.error;
    await expect(
      result.value.listOpportunities!("mlb", new AbortController().signal),
    ).resolves.toMatchObject({
      items: [
        { opportunityId: `opportunity:${"a".repeat(64)}` },
        { opportunityId: `opportunity:${"b".repeat(64)}` },
      ],
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]?.[0]).toBe(
      "https://api.example.test/sports/mlb/opportunities?limit=20",
    );
    expect(fetcher.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
    expect(
      new Headers(fetcher.mock.calls[0]?.[1]?.headers).get("authorization"),
    ).toBe(`Bearer ${ownedToken}`);
    expect(fetcher.mock.calls[0]?.[1]?.credentials).toBeUndefined();
  });

  it.each([
    ["extra page field", { ...rankedPage(), leaked: "pk" }],
    ["wrong sport", rankedPage([rankedOpportunity("a", 0.12, "soccer")])],
    [
      "reordered rank",
      rankedPage([rankedOpportunity("a", 0.08), rankedOpportunity("b", 0.12)]),
    ],
    [
      "nonfinite evidence",
      rankedPage([
        {
          ...rankedOpportunity("a", 0.12),
          expectedValue: Number.POSITIVE_INFINITY,
        },
      ]),
    ],
    [
      "invalid American odds",
      rankedPage([
        {
          ...rankedOpportunity("a", 0.12),
          target: { ...rankedOpportunity("a", 0.12).target, americanOdds: 99 },
        },
      ]),
    ],
    [
      "extended active window",
      rankedPage([
        {
          ...rankedOpportunity("a", 0.12),
          liveFreshness: {
            ...rankedOpportunity("a", 0.12).liveFreshness,
            expiresAt: "2026-08-06T12:30:00.000Z",
          },
        },
      ]),
    ],
    [
      "contradictory comparison coverage",
      rankedPage([
        {
          ...rankedOpportunity("a", 0.12),
          contributingBooks: ["fanduel", "betmgm"],
        },
      ]),
    ],
    [
      "future-dated price evidence",
      rankedPage([
        {
          ...rankedOpportunity("a", 0.12),
          target: {
            ...rankedOpportunity("a", 0.12).target,
            observedAt: "2026-08-06T12:04:00.000Z",
            retrievedAt: "2026-08-06T12:06:00.000Z",
          },
        },
      ]),
    ],
    [
      "wrong Eastern calendar day",
      rankedPage([
        {
          ...rankedOpportunity("a", 0.12),
          event: {
            ...rankedOpportunity("a", 0.12).event,
            eastern: {
              ...rankedOpportunity("a", 0.12).event.eastern,
              calendarDay: "2026-08-07",
            },
          },
        },
      ]),
    ],
  ])("rejects %s", async (_name, body) => {
    const result = createGamesClient(
      { ok: true, value: bootstrap() },
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response(JSON.stringify(body))),
    );
    if (!result.ok) throw result.error;
    await expect(
      result.value.listOpportunities!("mlb", new AbortController().signal),
    ).rejects.toMatchObject({ code: "invalid-response" });
  });

  it("keeps partial metadata and maps temporary unavailability safely", async () => {
    const partial = {
      ...rankedPage(),
      nextCursor: "opaque-cursor",
      evaluationState: "partial",
      hasMoreUnknown: true,
      evaluatedCount: 4,
      filteredCount: 1,
      staleCount: 1,
      joinFailureCount: 1,
    } as const;
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify(partial)))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "temporarily-unavailable" }), {
          status: 503,
        }),
      );
    const result = createGamesClient({ ok: true, value: bootstrap() }, fetcher);
    if (!result.ok) throw result.error;
    await expect(
      result.value.listOpportunities!("mlb", new AbortController().signal),
    ).resolves.toMatchObject({
      evaluationState: "partial",
      hasMoreUnknown: true,
      nextCursor: "opaque-cursor",
      filteredCount: 1,
      staleCount: 1,
      joinFailureCount: 1,
    });
    await expect(
      result.value.listOpportunities!("mlb", new AbortController().signal),
    ).rejects.toMatchObject({
      code: "request-failed",
      message: "Opportunity evidence is temporarily unavailable.",
    });
  });

  it("bounds an opportunity request that never settles", async () => {
    vi.useFakeTimers();
    try {
      const result = createGamesClient(
        { ok: true, value: bootstrap() },
        vi.fn<typeof fetch>(() => new Promise<Response>(() => undefined)),
      );
      if (!result.ok) throw result.error;
      const pending = result.value.listOpportunities!(
        "mlb",
        new AbortController().signal,
      );
      const assertion = expect(pending).rejects.toMatchObject({
        code: "request-failed",
        message: "Opportunities are temporarily unavailable.",
      });
      await vi.advanceTimersByTimeAsync(10_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});

const requestHref = (input: RequestInfo | URL) =>
  typeof input === "string"
    ? input
    : input instanceof URL
      ? input.href
      : input.url;

describe("arbitrage client", () => {
  const finding = {
    findingId: `arb:${"a".repeat(64)}`,
    classification: "arbitrage",
    holdPercentage: -2.07,
    sumInverseDecimal: 0.9793,
    marketKey: "moneyline",
    canonicalEventId: "event-1",
    startsAt: "2026-08-10T22:00:00.000Z",
    evaluatedAt: "2026-08-10T12:00:00.000Z",
    expiresAt: "2026-08-10T12:15:00.000Z",
    legs: [
      {
        selectionKey: "participant:away",
        point: null,
        best: {
          sportsbookId: "novig",
          americanOdds: 125,
          observedAt: "2026-08-10T11:59:00.000Z",
        },
        // Server evidence fields beyond the display projection pass through.
        competing: [{ sportsbookId: "hardrock", americanOdds: 110 }],
      },
      {
        selectionKey: "participant:home",
        point: null,
        best: {
          sportsbookId: "prophetx",
          americanOdds: -115,
          observedAt: "2026-08-10T11:59:00.000Z",
        },
      },
    ],
    excludedBooks: [],
  };
  const arbitragePage = {
    schemaVersion: "arbitrage-page-v1",
    snapshotAt: "2026-08-10T12:00:00.000Z",
    totalCount: 1,
    items: [finding],
  };

  it("carries the resolved matchup and side names", async () => {
    // A finding stores selection KEYS. Without the server-resolved names a
    // card printed "participant%3Amlb%253Amlb%3Aroyals" and never said which
    // game it belonged to.
    const named = structuredClone(arbitragePage) as {
      items: Record<string, unknown>[];
    };
    named.items[0]!["event"] = {
      participants: [{ label: "Kansas City Royals" }, { label: "LA Dodgers" }],
      startsAt: "2026-08-10T22:00:00.000Z",
    };
    (named.items[0]!["legs"] as Record<string, unknown>[])[0]![
      "selectionLabel"
    ] = "Kansas City Royals";
    const client = createGamesClient(
      { ok: true, value: bootstrap() },
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response(JSON.stringify(named))),
    );
    if (!client.ok) throw client.error;
    const page = await client.value.listArbitrage!(
      "mlb",
      new AbortController().signal,
    );
    expect(
      page.items[0]?.event?.participants.map(({ label }) => label),
    ).toEqual(["Kansas City Royals", "LA Dodgers"]);
    expect(page.items[0]?.legs[0]?.selectionLabel).toBe("Kansas City Royals");
    // A finding without event context stays unnamed rather than guessing.
    expect(page.items[0]?.legs[1]?.selectionLabel).toBeUndefined();
  });

  it("parses the display projection and fails closed on contradictions", async () => {
    const client = createGamesClient(
      { ok: true, value: bootstrap() },
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response(JSON.stringify(arbitragePage))),
    );
    if (!client.ok) throw client.error;
    const page = await client.value.listArbitrage!(
      "mlb",
      new AbortController().signal,
    );
    expect(page.totalCount).toBe(1);
    expect(page.items[0]).toMatchObject({
      classification: "arbitrage",
      legs: [
        { best: { sportsbookId: "novig", americanOdds: 125 } },
        { best: { sportsbookId: "prophetx", americanOdds: -115 } },
      ],
    });

    for (const corrupt of [
      { ...arbitragePage, schemaVersion: "arbitrage-page-v2" },
      {
        ...arbitragePage,
        // An "arbitrage" whose sum is not below one contradicts itself.
        items: [{ ...finding, sumInverseDecimal: 1.002 }],
      },
      {
        ...arbitragePage,
        items: [{ ...finding, legs: finding.legs.slice(0, 1) }],
      },
    ]) {
      const failing = createGamesClient(
        { ok: true, value: bootstrap() },
        vi
          .fn<typeof fetch>()
          .mockResolvedValue(new Response(JSON.stringify(corrupt))),
      );
      if (!failing.ok) throw failing.error;
      await expect(
        failing.value.listArbitrage!("mlb", new AbortController().signal),
      ).rejects.toMatchObject({ code: "invalid-response" });
    }
  });
});

describe("soccer selection keys", () => {
  // Captured from staging 2026-08-13. A participant selection key is
  // `participant:` + encodeURIComponent(participant id), and soccer club ids
  // contain spaces, so each space double-encodes to %2520. "Philadelphia
  // Union" produces a 65-character key and "New York City FC" a 71-character
  // one, against a bound of 64 — while every MLB key stayed short because
  // those club keys are single words. One over-length key failed
  // validSelection, which failed validGame, which threw the entire page, so
  // the soccer board rendered nothing while the API served priced games.
  const soccerPage = (away: string, home: string) => {
    const awayId = `participant:soccer%3Amls:${away}`;
    const homeId = `participant:soccer%3Amls:${home}`;
    const price = (key: string, label: string, odds: number) => ({
      marketKey: "moneyline",
      selectionKey: key,
      selectionLabel: label,
      sportsbookId: "fliff",
      sportsbookLabel: "Fliff",
      americanOdds: odds,
      observedAt: "2026-08-01T12:00:00.000Z",
      retrievedAt: "2026-08-01T12:00:00.000Z",
    });
    return {
      ...structuredClone(payload),
      items: [
        {
          ...structuredClone(payload).items[0]!,
          id: "event:soccer%3Amls:fixture-soccer",
          sportKey: "soccer",
          leagueKey: "mls",
          competition: { key: "mls", state: "provisional" },
          participants: [
            { id: awayId, label: "Philadelphia Union" },
            { id: homeId, label: "Santos Laguna" },
          ],
          odds: {
            state: "available",
            selections: [
              price(
                `participant:${encodeURIComponent(awayId)}`,
                "Philadelphia Union",
                -245,
              ),
              price("draw", "Draw", 355),
              price(
                `participant:${encodeURIComponent(homeId)}`,
                "Santos Laguna",
                495,
              ),
            ],
          },
        },
      ],
    };
  };

  it("accepts multi-word club names whose encoded keys exceed 64 characters", async () => {
    const body = soccerPage("philadelphia%20union", "santos%20laguna");
    const key = body.items[0]!.odds.selections[0]!.selectionKey;
    expect(key.length).toBeGreaterThan(64);

    const client = createGamesClient(
      { ok: true, value: bootstrap() },
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response(JSON.stringify(body))),
    );
    if (!client.ok) throw client.error;
    const page = await client.value.list(
      { sport: "soccer", day: "2026-08-01", status: "all" },
      new AbortController().signal,
    );
    expect(page.items).toHaveLength(1);
  });

  it("still rejects a selection key beyond what an encoded id can produce", async () => {
    const body = soccerPage("a".repeat(700), "santos%20laguna");
    const client = createGamesClient(
      { ok: true, value: bootstrap() },
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response(JSON.stringify(body))),
    );
    if (!client.ok) throw client.error;
    await expect(
      client.value.list(
        { sport: "soccer", day: "2026-08-01", status: "all" },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "invalid-response" });
  });
});

describe("board market windows", () => {
  it("accepts markets that moved at different times and rejects a torn one", async () => {
    // Markets move independently: a moneyline can shift long after a total
    // last did. Judging the whole row against one window blanked the entire
    // Events page, so the window is per market — matching the serving join.
    const drifted = structuredClone(payload) as {
      items: { odds: { selections: Record<string, unknown>[] } }[];
    };
    const base = drifted.items[0]!.odds.selections;
    const total = [
      {
        ...base[0]!,
        marketKey: "total",
        selectionKey: "over",
        selectionLabel: "Over",
        point: 8.5,
        observedAt: "2026-08-01T11:40:00.000Z",
        retrievedAt: "2026-08-01T11:40:00.000Z",
      },
      {
        ...base[1]!,
        marketKey: "total",
        selectionKey: "under",
        selectionLabel: "Under",
        point: 8.5,
        observedAt: "2026-08-01T11:40:00.000Z",
        retrievedAt: "2026-08-01T11:40:00.000Z",
      },
    ];
    drifted.items[0]!.odds.selections = [...base, ...total];
    const client = createGamesClient(
      { ok: true, value: bootstrap() },
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response(JSON.stringify(drifted))),
    );
    if (!client.ok) throw client.error;
    const page = await client.value.list(
      { sport: "mlb", day: "2026-08-01", status: "all" },
      new AbortController().signal,
    );
    expect(page.items).toHaveLength(1);

    // A single market whose own sides are hours apart is still refused.
    const torn = structuredClone(drifted);
    torn.items[0]!.odds.selections[3]!["observedAt"] =
      "2026-08-01T06:00:00.000Z";
    torn.items[0]!.odds.selections[3]!["retrievedAt"] =
      "2026-08-01T06:00:00.000Z";
    const failing = createGamesClient(
      { ok: true, value: bootstrap() },
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response(JSON.stringify(torn))),
    );
    if (!failing.ok) throw failing.error;
    await expect(
      failing.value.list(
        { sport: "mlb", day: "2026-08-01", status: "all" },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "invalid-response" });
  });
});

describe("games client", () => {
  it("fails closed when the merged lifecycle response is invalid", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify({ unexpected: true })));
    const client = createGamesClient({ ok: true, value: bootstrap() }, fetcher);
    if (!client.ok) throw client.error;
    await expect(
      client.value.list(
        { sport: "mlb", day: "2026-08-01", status: "all" },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "invalid-response" });
  });

  it("preserves the sharp anchor price and fails closed on a corrupt one", async () => {
    const anchored = structuredClone(payload);
    const selections = anchored.items[0]!.odds.selections as {
      sharpAmericanOdds?: unknown;
    }[];
    selections[0]!.sharpAmericanOdds = 112;
    selections[1]!.sharpAmericanOdds = -124;
    const client = createGamesClient(
      { ok: true, value: bootstrap() },
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response(JSON.stringify(anchored))),
    );
    if (!client.ok) throw client.error;
    const page = await client.value.list(
      { sport: "mlb", day: "2026-08-01", status: "all" },
      new AbortController().signal,
    );
    expect(page.items[0]?.odds).toMatchObject({
      state: "available",
      selections: [
        { americanOdds: 120, sharpAmericanOdds: 112 },
        { americanOdds: -135, sharpAmericanOdds: -124 },
      ],
    });

    for (const corrupt of [5, "112", 112.5] as const) {
      const invalid = structuredClone(anchored);
      (invalid.items[0]!.odds.selections[0] as Record<string, unknown>)[
        "sharpAmericanOdds"
      ] = corrupt;
      const failing = createGamesClient(
        { ok: true, value: bootstrap() },
        vi
          .fn<typeof fetch>()
          .mockResolvedValue(new Response(JSON.stringify(invalid))),
      );
      if (!failing.ok) throw failing.error;
      await expect(
        failing.value.list(
          { sport: "mlb", day: "2026-08-01", status: "all" },
          new AbortController().signal,
        ),
      ).rejects.toMatchObject({ code: "invalid-response" });
    }
  });

  it("bounds a never-settling games request as retryable", async () => {
    vi.useFakeTimers();
    try {
      const fetcher = vi.fn<typeof fetch>(
        () => new Promise<Response>(() => undefined),
      );
      const client = createGamesClient(
        { ok: true, value: bootstrap() },
        fetcher,
      );
      if (!client.ok) throw client.error;
      const expectation = expect(
        client.value.list(
          { sport: "mlb", day: "2026-08-01", status: "all" },
          new AbortController().signal,
        ),
      ).rejects.toMatchObject({ code: "request-failed" });
      await vi.advanceTimersByTimeAsync(10_000);
      await expectation;
    } finally {
      vi.useRealTimers();
    }
  });

  it("loads authoritative detail odds without a prior list cache", async () => {
    const detailItem = detailFixture();
    const fetcher = vi.fn<typeof fetch>((input) =>
      Promise.resolve(
        requestHref(input).includes("/events/")
          ? new Response(
              JSON.stringify({
                projectionState: "ready",
                item: detailItem,
                unavailableReason: null,
              }),
            )
          : new Response(JSON.stringify(payload)),
      ),
    );
    const client = createGamesClient({ ok: true, value: bootstrap() }, fetcher);
    if (!client.ok) throw client.error;
    await expect(
      client.value.detail!(payload.items[0]!.id, new AbortController().signal),
    ).resolves.toMatchObject({ oddsComparison: { targetQualified: true } });
    expect(fetcher.mock.calls[0]?.[0]).toBe(
      `https://api.example.test/events/${encodeURIComponent(payload.items[0]!.id)}`,
    );
  });

  it.each(["mlb", "soccer"] as const)(
    "accepts canonical optional markets for %s",
    async (sportKey) => {
      const detailItem = detailFixture();
      const participants =
        sportKey === "soccer"
          ? [
              { id: "participant:soccer:miami", label: "Miami" },
              { id: "participant:soccer:atlanta", label: "Atlanta" },
            ]
          : payload.items[0]!.participants;
      const eventId =
        sportKey === "soccer"
          ? "event:soccer%3Amls:fixture-1"
          : payload.items[0]!.id;
      detailItem["id"] = eventId;
      detailItem["sportKey"] = sportKey;
      detailItem["leagueKey"] = sportKey === "soccer" ? "mls" : "mlb";
      detailItem["competition"] = {
        key: sportKey === "soccer" ? "mls" : "mlb",
        state: "provisional",
      };
      detailItem["participants"] = participants;
      const comparison = mutableRecord(detailItem["oddsComparison"]);
      const participantIds = participants.map(({ id }) => id as EntityId);
      const sides = participantIds.map((participantId) =>
        participantSelectionKey(participantId),
      );
      const active = (point?: number) => ({
        state: "active",
        eligible: true,
        ...(point === undefined ? {} : { point }),
        americanOdds: 110,
        observedAt: "2026-08-01T12:00:00.000Z",
        retrievedAt: "2026-08-01T12:00:01.000Z",
      });
      const market = (
        marketKey: string,
        selectionKeys: readonly string[],
        point?: number,
      ) => ({
        marketKey,
        selections: selectionKeys.map((selectionKey) => ({
          selectionKey,
          selectionLabel: selectionKey,
          cells: { hardrock: active(point) },
        })),
      });
      comparison["markets"] = [
        market(
          "moneyline",
          sportKey === "soccer" ? [sides[0]!, "draw", sides[1]!] : sides,
        ),
        market("spread", sides, 1.5),
        market("total", ["over", "under"], 8.5),
        ...(sportKey === "soccer" ? [market("btts", ["yes", "no"])] : []),
        market(
          "team_total",
          participantIds.flatMap((participantId) => [
            participantSelectionKey(participantId, "over"),
            participantSelectionKey(participantId, "under"),
          ]),
          2.5,
        ),
      ];
      const client = createGamesClient(
        { ok: true, value: bootstrap() },
        vi.fn<typeof fetch>().mockResolvedValue(
          new Response(
            JSON.stringify({
              projectionState: "ready",
              item: detailItem,
              unavailableReason: null,
            }),
          ),
        ),
      );
      if (!client.ok) throw client.error;

      const detail = await client.value.detail!(
        eventId,
        new AbortController().signal,
      );
      expect(
        detail?.oddsComparison.markets.map(({ marketKey }) => marketKey),
      ).toEqual(
        sportKey === "soccer"
          ? ["moneyline", "spread", "total", "btts", "team_total"]
          : ["moneyline", "spread", "total", "team_total"],
      );
    },
  );

  it("accepts fail-closed target qualification for a non-actionable event", async () => {
    const item = detailFixture();
    item["status"] = "started";
    item["metadata"] = assessEventMetadata(
      "started",
      "2026-08-01T12:30:00.000Z",
      "2026-08-01T12:30:00.000Z",
    );
    mutableRecord(item["oddsComparison"])["targetQualified"] = false;
    const client = createGamesClient(
      { ok: true, value: bootstrap() },
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          JSON.stringify({
            projectionState: "ready",
            item,
            unavailableReason: null,
          }),
        ),
      ),
    );
    if (!client.ok) throw client.error;
    await expect(
      client.value.detail!(String(item["id"]), new AbortController().signal),
    ).resolves.toMatchObject({
      status: "started",
      oddsComparison: { targetQualified: false },
    });
  });

  it("loads strictly ordered immutable multi-book odds history", async () => {
    const eventId = payload.items[0]!.id;
    const history = {
      eventId,
      generatedAt: "2026-08-01T12:30:00.000Z",
      markerScope: "page",
      coverage: [
        {
          sportsbookId: "pinnacle",
          sportsbookLabel: "Pinnacle",
          status: "available",
        },
      ],
      series: [
        {
          marketKey: "moneyline",
          selectionKey: participantSelectionKey(
            payload.items[0]!.participants[0]!.id as EntityId,
          ),
          selectionLabel: "Boston Red Sox",
          sportsbookId: "pinnacle",
          sportsbookLabel: "Pinnacle",
          points: [
            {
              observationId: "observation-one",
              state: "active",
              americanOdds: 125,
              impliedProbability: 100 / 225,
              observedAt: "2026-08-01T11:00:00.000Z",
              retrievedAt: "2026-08-01T11:00:01.000Z",
              isOpening: true,
              isCurrent: false,
            },
          ],
        },
      ],
      nextCursor: "page-two",
    };
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify(history)))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ...history,
            series: [
              {
                ...history.series[0],
                selectionLabel: "Boston Red Sox (corrected)",
                points: [
                  {
                    observationId: "observation-two",
                    state: "active",
                    americanOdds: 115,
                    impliedProbability: 100 / 215,
                    observedAt: "2026-08-01T12:00:00.000Z",
                    retrievedAt: "2026-08-01T12:00:01.000Z",
                    isOpening: false,
                    isCurrent: true,
                  },
                ],
              },
            ],
            nextCursor: null,
          }),
        ),
      );
    const client = createGamesClient({ ok: true, value: bootstrap() }, fetcher);
    if (!client.ok) throw client.error;
    await expect(
      client.value.oddsHistory!(eventId, new AbortController().signal),
    ).resolves.toMatchObject({
      eventId,
      markerScope: "loaded",
      series: [
        {
          sportsbookId: "pinnacle",
          selectionLabel: "Boston Red Sox (corrected)",
          points: [
            { observationId: "observation-one", isOpening: true },
            { observationId: "observation-two", isCurrent: true },
          ],
        },
      ],
    });
    const request = new URL(requestHref(fetcher.mock.calls[0]![0]));
    expect(`${request.origin}${request.pathname}`).toBe(
      `https://api.example.test/games/${encodeURIComponent(eventId)}/odds-history`,
    );
    expect(request.searchParams.get("limit")).toBe("200");
    const from = Date.parse(request.searchParams.get("from") ?? "");
    const to = Date.parse(request.searchParams.get("to") ?? "");
    expect(to - from).toBe(31 * 24 * 60 * 60 * 1_000);
    expect(
      new URL(requestHref(fetcher.mock.calls[1]![0])).searchParams.get(
        "cursor",
      ),
    ).toBe("page-two");
  });

  it("rejects contradictory American-odds and implied-probability evidence", async () => {
    const eventId = payload.items[0]!.id;
    const fetcher = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            eventId,
            generatedAt: "2026-08-01T12:30:00.000Z",
            markerScope: "page",
            coverage: [
              {
                sportsbookId: "pinnacle",
                sportsbookLabel: "Pinnacle",
                status: "available",
              },
            ],
            series: [
              {
                marketKey: "moneyline",
                selectionKey: "away",
                selectionLabel: "Boston",
                sportsbookId: "pinnacle",
                sportsbookLabel: "Pinnacle",
                points: [
                  {
                    observationId: "contradictory",
                    state: "active",
                    americanOdds: 125,
                    impliedProbability: 0.9,
                    observedAt: "2026-08-01T11:00:00.000Z",
                    retrievedAt: "2026-08-01T11:00:01.000Z",
                    isOpening: true,
                    isCurrent: true,
                  },
                ],
              },
            ],
            nextCursor: null,
          }),
        ),
      ),
    );
    const client = createGamesClient({ ok: true, value: bootstrap() }, fetcher);
    if (!client.ok) throw client.error;

    await expect(
      client.value.oddsHistory!(eventId, new AbortController().signal),
    ).rejects.toMatchObject({ code: "invalid-response" });
  });

  it("rejects duplicate observations and malformed market points", async () => {
    const eventId = payload.items[0]!.id;
    const point = {
      observationId: "same-observation",
      state: "active",
      americanOdds: -110,
      impliedProbability: 11 / 21,
      observedAt: "2026-08-01T11:00:00.000Z",
      retrievedAt: "2026-08-01T11:00:01.000Z",
      isOpening: true,
      isCurrent: true,
    };
    for (const series of [
      {
        marketKey: "moneyline",
        selectionKey: "away",
        selectionLabel: "Boston",
        sportsbookId: "pinnacle",
        sportsbookLabel: "Pinnacle",
        points: [point, point],
      },
      {
        marketKey: "spread",
        selectionKey: "away",
        selectionLabel: "Boston",
        sportsbookId: "pinnacle",
        sportsbookLabel: "Pinnacle",
        points: [point],
      },
    ]) {
      const fetcher = vi.fn<typeof fetch>(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              eventId,
              generatedAt: "2026-08-01T12:30:00.000Z",
              markerScope: "page",
              coverage: [],
              series: [series],
              nextCursor: null,
            }),
          ),
        ),
      );
      const client = createGamesClient(
        { ok: true, value: bootstrap() },
        fetcher,
      );
      if (!client.ok) throw client.error;
      await expect(
        client.value.oddsHistory!(eventId, new AbortController().signal),
      ).rejects.toMatchObject({ code: "invalid-response" });
    }
  });

  it("rejects pagination fence and sportsbook identity changes", async () => {
    const eventId = payload.items[0]!.id;
    const page = (
      observationId: string,
      generatedAt: string,
      sportsbookLabel: string,
      nextCursor: string | null,
    ) => ({
      eventId,
      generatedAt,
      markerScope: "page",
      coverage: [
        {
          sportsbookId: "pinnacle",
          sportsbookLabel,
          status: "available",
        },
      ],
      series: [
        {
          marketKey: "moneyline",
          selectionKey: "away",
          selectionLabel: "Boston",
          sportsbookId: "pinnacle",
          sportsbookLabel,
          points: [
            {
              observationId,
              state: "active",
              americanOdds: -110,
              impliedProbability: 11 / 21,
              observedAt:
                observationId === "one"
                  ? "2026-08-01T11:00:00.000Z"
                  : "2026-08-01T12:00:00.000Z",
              retrievedAt:
                observationId === "one"
                  ? "2026-08-01T11:00:01.000Z"
                  : "2026-08-01T12:00:01.000Z",
              isOpening: true,
              isCurrent: true,
            },
          ],
        },
      ],
      nextCursor,
    });
    for (const second of [
      page("two", "2026-08-01T12:31:00.000Z", "Pinnacle", null),
      page("two", "2026-08-01T12:30:00.000Z", "Changed Pinnacle", null),
    ]) {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify(
              page("one", "2026-08-01T12:30:00.000Z", "Pinnacle", "next"),
            ),
          ),
        )
        .mockResolvedValueOnce(new Response(JSON.stringify(second)));
      const client = createGamesClient(
        { ok: true, value: bootstrap() },
        fetcher,
      );
      if (!client.ok) throw client.error;
      await expect(
        client.value.oddsHistory!(eventId, new AbortController().signal),
      ).rejects.toMatchObject({ code: "invalid-response" });
    }
  });

  it("accepts the full cursor contract and returns bounded history instead of discarding it", async () => {
    const eventId = payload.items[0]!.id;
    const longCursor = "c".repeat(4_096);
    const page = (nextCursor: string | null) => ({
      eventId,
      generatedAt: "2026-08-01T12:30:00.000Z",
      markerScope: "page",
      coverage: [],
      series: [],
      nextCursor,
    });
    let call = 0;
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(() =>
        Promise.resolve(
          new Response(
            JSON.stringify(page(call++ === 0 ? longCursor : `cursor-${call}`)),
          ),
        ),
      );
    const client = createGamesClient({ ok: true, value: bootstrap() }, fetcher);
    if (!client.ok) throw client.error;

    const result = await client.value.oddsHistory!(
      eventId,
      new AbortController().signal,
    );

    expect(fetcher).toHaveBeenCalledTimes(512);
    expect(
      new URL(requestHref(fetcher.mock.calls[1]![0])).searchParams.get(
        "cursor",
      ),
    ).toBe(longCursor);
    expect(result).toMatchObject({
      eventId,
      series: [],
      nextCursor: "cursor-512",
    });
  });

  it.each([
    [
      "qualification",
      (item: Record<string, unknown>) => {
        mutableRecord(item["oddsComparison"])["targetQualified"] = false;
      },
    ],
    [
      "duplicate book",
      (item: Record<string, unknown>) => {
        const books = mutableArray(
          mutableRecord(item["oddsComparison"])["sportsbooks"],
        );
        books.push(structuredClone(books[0]));
      },
    ],
    [
      "duplicate market",
      (item: Record<string, unknown>) => {
        const markets = mutableArray(
          mutableRecord(item["oddsComparison"])["markets"],
        );
        mutableRecord(markets[1])["marketKey"] = "moneyline";
      },
    ],
    [
      "wrong selection",
      (item: Record<string, unknown>) => {
        const markets = mutableArray(
          mutableRecord(item["oddsComparison"])["markets"],
        );
        const selections = mutableArray(
          mutableRecord(markets[0])["selections"],
        );
        mutableRecord(selections[0])["selectionKey"] = "participant:intruder";
      },
    ],
    [
      "extra cell",
      (item: Record<string, unknown>) => {
        const markets = mutableArray(
          mutableRecord(item["oddsComparison"])["markets"],
        );
        const selections = mutableArray(
          mutableRecord(markets[0])["selections"],
        );
        const cells = mutableRecord(mutableRecord(selections[0])["cells"]);
        cells["ghost"] = cells["hardrock"];
      },
    ],
    [
      "out-of-domain active American odds",
      (item: Record<string, unknown>) => {
        const markets = mutableArray(
          mutableRecord(item["oddsComparison"])["markets"],
        );
        const selections = mutableArray(
          mutableRecord(markets[0])["selections"],
        );
        const hardrock = mutableRecord(
          mutableRecord(mutableRecord(selections[0])["cells"])["hardrock"],
        );
        hardrock["americanOdds"] = 99;
      },
    ],
    [
      "out-of-domain retained American odds",
      (item: Record<string, unknown>) => {
        const comparison = mutableRecord(item["oddsComparison"]);
        comparison["targetQualified"] = false;
        const markets = mutableArray(comparison["markets"]);
        const selections = mutableArray(
          mutableRecord(markets[0])["selections"],
        );
        const cells = mutableRecord(mutableRecord(selections[0])["cells"]);
        cells["hardrock"] = {
          state: "suspended",
          eligible: false,
          reason: "market-suspended",
          evidenceAt: "2026-08-01T12:01:00.000Z",
          americanOdds: 100_001,
          observedAt: "2026-08-01T12:00:00.000Z",
          retrievedAt: "2026-08-01T12:00:00.000Z",
        };
      },
    ],
    [
      "out-of-domain active point",
      (item: Record<string, unknown>) => {
        const markets = mutableArray(
          mutableRecord(item["oddsComparison"])["markets"],
        );
        const selections = mutableArray(
          mutableRecord(markets[1])["selections"],
        );
        const hardrock = mutableRecord(
          mutableRecord(mutableRecord(selections[0])["cells"])["hardrock"],
        );
        hardrock["point"] = 10_001;
      },
    ],
    [
      "retained point without a price tuple",
      (item: Record<string, unknown>) => {
        const comparison = mutableRecord(item["oddsComparison"]);
        comparison["targetQualified"] = false;
        const markets = mutableArray(comparison["markets"]);
        const selections = mutableArray(
          mutableRecord(markets[0])["selections"],
        );
        mutableRecord(mutableRecord(selections[0])["cells"])["hardrock"] = {
          state: "unavailable",
          eligible: false,
          reason: "price-unavailable",
          evidenceAt: null,
          point: 1.5,
        };
      },
    ],
    [
      "partial retained price tuple",
      (item: Record<string, unknown>) => {
        const comparison = mutableRecord(item["oddsComparison"]);
        comparison["targetQualified"] = false;
        const markets = mutableArray(comparison["markets"]);
        const selections = mutableArray(
          mutableRecord(markets[0])["selections"],
        );
        mutableRecord(mutableRecord(selections[0])["cells"])["hardrock"] = {
          state: "suspended",
          eligible: false,
          reason: "market-suspended",
          evidenceAt: "2026-08-01T12:01:00.000Z",
          americanOdds: 120,
        };
      },
    ],
  ])("rejects inconsistent detail %s", async (_label, mutate) => {
    const item = detailFixture();
    mutate(item);
    const client = createGamesClient(
      { ok: true, value: bootstrap() },
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          JSON.stringify({
            projectionState: "ready",
            item,
            unavailableReason: null,
          }),
        ),
      ),
    );
    if (!client.ok) throw client.error;
    await expect(
      client.value.detail!(payload.items[0]!.id, new AbortController().signal),
    ).rejects.toMatchObject({ code: "invalid-response" });
  });

  it("preserves a typed not-found detail response", async () => {
    const client = createGamesClient(
      { ok: true, value: bootstrap() },
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          new Response(JSON.stringify({ error: "not-found" }), { status: 404 }),
        ),
    );
    if (!client.ok) throw client.error;
    await expect(
      client.value.detail!(payload.items[0]!.id, new AbortController().signal),
    ).rejects.toMatchObject({
      code: "not-found",
      message: "This game was not found.",
    });
  });

  it("rejects an unsupported canonical detail sport key", async () => {
    const detailItem: Record<string, unknown> = { ...payload.items[0]! };
    delete detailItem["odds"];
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          projectionState: "ready",
          item: { ...detailItem, sportKey: "baseball" },
          unavailableReason: null,
        }),
      ),
    );
    const client = createGamesClient({ ok: true, value: bootstrap() }, fetcher);
    if (!client.ok) throw client.error;
    await expect(
      client.value.detail!(payload.items[0]!.id, new AbortController().signal),
    ).rejects.toMatchObject({ code: "invalid-response" });
  });

  it("requests every lifecycle in one server-merged call", async () => {
    const statuses = [
      "scheduled",
      "postponed",
      "started",
      "completed",
      "unknown",
    ] as const;
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      await Promise.resolve();
      const url = new URL(requestHref(input));
      expect(url.searchParams.get("status")).toBe("all");
      const items = statuses.map((status, index) => ({
        ...payload.items[0]!,
        id: `${payload.items[0]!.id}-${status}`,
        startsAt: new Date(
          Date.parse(payload.items[0]!.startsAt) + index * 5 * 60_000,
        ).toISOString(),
        status,
        metadata: assessEventMetadata(
          status,
          payload.freshness,
          payload.snapshotAt,
        ),
      }));
      return new Response(JSON.stringify({ ...payload, items }));
    });
    const client = createGamesClient({ ok: true, value: bootstrap() }, fetcher);
    if (!client.ok) throw client.error;
    const result = await client.value.list(
      { sport: "mlb", day: "2026-08-01", status: "all" },
      new AbortController().signal,
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(result.items).toHaveLength(5);
    expect(result.lifecycleCoverage).toEqual({
      requested: [
        "scheduled",
        "postponed",
        "cancelled",
        "started",
        "completed",
        "unknown",
      ],
      loaded: [
        "scheduled",
        "postponed",
        "cancelled",
        "started",
        "completed",
        "unknown",
      ],
      unavailable: [],
    });
  });

  it("rejects duplicate events inside the merged lifecycle page", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => {
      await Promise.resolve();
      return new Response(
        JSON.stringify({
          ...payload,
          items: [payload.items[0]!, payload.items[0]!],
        }),
      );
    });
    const client = createGamesClient({ ok: true, value: bootstrap() }, fetcher);
    if (!client.ok) throw client.error;
    await expect(
      client.value.list(
        { sport: "mlb", day: "2026-08-01", status: "all" },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "invalid-response" });
  });

  it.each([
    "scheduled",
    "postponed",
    "cancelled",
    "started",
    "completed",
    "unknown",
  ])(
    "recognizes canonical lifecycle %s for reusable event parsing",
    (status) => {
      expect(isCanonicalEventStatus(status)).toBe(true);
    },
  );

  it("accepts structurally valid metadata with reordered object keys", async () => {
    const metadata = payload.items[0]!.metadata;
    const reordered = {
      reasonCodes: metadata.reasonCodes,
      freshness: {
        missingReason: metadata.freshness.missingReason,
        thresholdSeconds: metadata.freshness.thresholdSeconds,
        ageSeconds: metadata.freshness.ageSeconds,
        evidenceAt: metadata.freshness.evidenceAt,
        state: metadata.freshness.state,
      },
      availability: metadata.availability,
      lifecycle: {
        known: metadata.lifecycle.known,
        state: metadata.lifecycle.state,
      },
      evaluatedAt: metadata.evaluatedAt,
      policyVersion: metadata.policyVersion,
    };
    const client = createGamesClient(
      { ok: true, value: bootstrap() },
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          JSON.stringify({
            ...payload,
            items: [{ ...payload.items[0], metadata: reordered }],
          }),
        ),
      ),
    );
    if (!client.ok) throw client.error;
    await expect(
      client.value.list(
        { sport: "mlb", day: "2026-08-01" },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ items: [{ id: payload.items[0]!.id }] });
  });

  it.each([
    ["items", { items: [payload.items[0]] }],
    ["cursor", { nextCursor: "forged" }],
    ["evaluation", { evaluationState: "partial", hasMoreUnknown: true }],
    ["snapshot", { snapshotAt: payload.snapshotAt }],
    ["freshness", { freshness: payload.freshness }],
    ["reason", { unavailableReason: null }],
  ])(
    "rejects contradictory uninitialized envelope %s",
    async (_case, patch) => {
      const body = {
        ...payload,
        items: [],
        nextCursor: null,
        projectionState: "uninitialized",
        evaluationState: "complete",
        hasMoreUnknown: false,
        snapshotAt: null,
        freshness: null,
        unavailableReason: "projection-uninitialized",
        ...patch,
      };
      const client = createGamesClient(
        { ok: true, value: bootstrap() },
        vi
          .fn<typeof fetch>()
          .mockResolvedValue(new Response(JSON.stringify(body))),
      );
      if (!client.ok) throw client.error;
      await expect(
        client.value.list(
          { sport: "mlb", day: "2026-08-01" },
          new AbortController().signal,
        ),
      ).rejects.toMatchObject({ code: "invalid-response" });
    },
  );

  it.each([null, "2026-08-01T12:29:59.000Z"])(
    "rejects ready envelope freshness %s when it differs from item evidence",
    async (freshness) => {
      const client = createGamesClient(
        { ok: true, value: bootstrap() },
        vi
          .fn<typeof fetch>()
          .mockResolvedValue(
            new Response(JSON.stringify({ ...payload, freshness })),
          ),
      );
      if (!client.ok) throw client.error;
      await expect(
        client.value.list(
          { sport: "mlb", day: "2026-08-01" },
          new AbortController().signal,
        ),
      ).rejects.toMatchObject({ code: "invalid-response" });
    },
  );
  it.each([
    ["missing", undefined],
    [
      "contradictory",
      { ...payload.items[0]!.metadata, availability: "partial" },
    ],
    [
      "forged",
      {
        ...payload.items[0]!.metadata,
        evaluatedAt: "2026-08-01T12:29:59.000Z",
      },
    ],
  ])("rejects %s event metadata", async (_label, metadata) => {
    const item = { ...payload.items[0] } as Record<string, unknown>;
    if (metadata === undefined) delete item["metadata"];
    else item["metadata"] = metadata;
    const client = createGamesClient(
      { ok: true, value: bootstrap() },
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          new Response(JSON.stringify({ ...payload, items: [item] })),
        ),
    );
    if (!client.ok) throw client.error;
    await expect(
      client.value.list(
        { sport: "mlb", day: "2026-08-01" },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "invalid-response" });
  });
  it("exhausts retrospective audit pages without dropping decisions", async () => {
    const versionId = `retrospective-version:${"b".repeat(64)}`;
    const base = {
      retrospectiveId: `retrospective:${"a".repeat(64)}`,
      versionId,
      version: 1,
      predecessorVersionId: null,
      cohortId: `cohort:${"c".repeat(64)}`,
      reportId: `performance-report:${"d".repeat(64)}`,
      reportRevision: 1,
      createdAt: "2026-08-04T00:00:00.000Z",
      state: "approved",
      stateVersion: 2,
      taxonomyVersion: "retrospective-taxonomy-v1",
      evidence: {
        evaluationCutoff: "2026-08-03T00:00:00.000Z",
        decisionTime: [],
        postDecision: [],
        decisionTimeDigest: "e".repeat(64),
        postDecisionDigest: "f".repeat(64),
        manifestDigest: "1".repeat(64),
      },
      slices: [],
      observations: [],
      candidates: [],
      memberCount: 1,
      caution: "single-member",
      falseNegativeEvaluation: "not-evaluable",
      contentDigest: "2".repeat(64),
    };
    const decision = (id: string, at: string) => ({
      decisionId: `retrospective-decision:${id.repeat(64)}`,
      versionId,
      fromState: "draft",
      toState: "approved",
      reasonCode: "approve",
      decidedAt: at,
    });
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ...base,
            audit: {
              items: [decision("3", "2026-08-04T01:00:00.000Z")],
              nextCursor: "next",
            },
          }),
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ...base,
            audit: { items: [decision("4", "2026-08-04T02:00:00.000Z")] },
          }),
        ),
      );
    const result = createGamesClient({ ok: true, value: bootstrap() }, fetcher);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const loaded = await result.value.getRetrospective?.(
      versionId,
      new AbortController().signal,
    );
    expect(loaded?.audit?.items).toHaveLength(2);
    expect(
      loaded?.audit?.items.every((item) =>
        /^retrospective-decision:[a-f0-9]{64}$/.test(item.decisionId),
      ),
    ).toBe(true);
    const secondRequest = fetcher.mock.calls[1]?.[0];
    const secondUrl =
      typeof secondRequest === "string"
        ? secondRequest
        : secondRequest instanceof URL
          ? secondRequest.toString()
          : secondRequest?.url;
    expect(secondUrl).toContain("cursor=next");
  });
  it("uses the runtime API base with the owned authorization header", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify(payload)));
    const result = createGamesClient({ ok: true, value: bootstrap() }, fetcher);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    await expect(
      result.value.list(
        { sport: "mlb", day: "2026-08-01" },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ items: [{ id: payload.items[0]!.id }] });
    expect(fetcher.mock.calls[0]?.[0]).toBe(
      "https://api.example.test/games?sport=mlb&league=mlb&status=scheduled&day=2026-08-01&limit=50",
    );
    expect(
      new Headers(fetcher.mock.calls[0]?.[1]?.headers).get("authorization"),
    ).toBe(`Bearer ${ownedToken}`);
  });

  it("accepts a complete ordered soccer three-way market", async () => {
    const soccerPayload = {
      ...payload,
      items: [
        {
          ...payload.items[0],
          id: "event:soccer%3Amls:fixture-1",
          sportKey: "soccer",
          leagueKey: "mls",
          competition: { key: "mls", state: "provisional" },
          participants: [
            { id: "participant:soccer:miami", label: "Miami" },
            { id: "participant:soccer:atlanta", label: "Atlanta" },
          ],
          odds: {
            state: "available",
            selections: [
              {
                ...payload.items[0]!.odds.selections[0],
                marketKey: "moneyline",
                selectionLabel: "Miami",
              },
              {
                ...payload.items[0]!.odds.selections[0],
                marketKey: "moneyline",
                selectionKey: "draw",
                selectionLabel: "Draw",
                americanOdds: 220,
              },
              {
                ...payload.items[0]!.odds.selections[0],
                marketKey: "moneyline",
                selectionKey: "home",
                selectionLabel: "Atlanta",
                americanOdds: 175,
              },
            ],
          },
        },
      ],
    };
    const result = createGamesClient(
      { ok: true, value: bootstrap() },
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response(JSON.stringify(soccerPayload))),
    );
    if (!result.ok) throw result.error;
    await expect(
      result.value.list(
        { sport: "soccer", day: "2026-08-01" },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({
      items: [
        {
          odds: {
            selections: [
              { selectionKey: "away" },
              { selectionKey: "draw" },
              { selectionKey: "home" },
            ],
          },
        },
      ],
    });
  });

  it("accepts coherent spread and total lines with their prices", async () => {
    const base = payload.items[0]!.odds.selections[0]!;
    const selections: GameOddsSelectionDto[] = [
      ...payload.items[0]!.odds.selections,
      {
        ...base,
        marketKey: "spread",
        selectionKey: "away",
        point: 1.5,
        americanOdds: -110,
      },
      {
        ...base,
        marketKey: "spread",
        selectionKey: "home",
        selectionLabel: "New York Yankees",
        point: -1.5,
        americanOdds: -110,
      },
      {
        ...base,
        marketKey: "total",
        selectionKey: "over",
        selectionLabel: "Over",
        point: 8.5,
        americanOdds: -105,
      },
      {
        ...base,
        marketKey: "total",
        selectionKey: "under",
        selectionLabel: "Under",
        point: 8.5,
        americanOdds: -115,
      },
    ];
    const fullMarketPayload = {
      ...payload,
      items: [
        {
          ...payload.items[0]!,
          odds: { state: "available", selections },
        },
      ],
    };
    const result = createGamesClient(
      { ok: true, value: bootstrap() },
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response(JSON.stringify(fullMarketPayload))),
    );
    if (!result.ok) throw result.error;
    const page = await result.value.list(
      { sport: "mlb", day: "2026-08-01" },
      new AbortController().signal,
    );
    const odds = page.items[0]?.odds;
    expect(odds?.state).toBe("available");
    if (!odds || odds.state !== "available") return;
    expect(odds.selections).toHaveLength(6);
    expect(odds.selections).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ marketKey: "spread", point: 1.5 }),
        expect.objectContaining({ marketKey: "total", point: 8.5 }),
      ]),
    );
  });

  it.each(["games", "splits"] as const)(
    "exhausts ordered %s pages and forwards the opaque cursor",
    async (endpoint) => {
      const secondGame = {
        ...payload.items[0]!,
        id: "event:mlb%3Amlb:fixture-2",
        startsAt: "2026-08-02T00:05:00.000Z",
        eastern: {
          ...payload.items[0]!.eastern,
          display: "Aug 1, 2026, 8:05 PM",
        },
        freshness: "2026-08-01T12:00:00.000Z",
        metadata: assessEventMetadata(
          "scheduled",
          "2026-08-01T12:00:00.000Z",
          payload.snapshotAt,
        ),
      };
      const withSplits = (item: (typeof payload.items)[0]) => ({
        ...item,
        splits: [
          {
            id: `split:${item.id}`,
            providerId: "sharpapi",
            providerEventId: "provider-event",
            canonicalEventId: item.id,
            canonicalEventVersion: item.version,
            sportKey: "mlb",
            leagueKey: "mlb",
            marketKey: "moneyline",
            selectionKey: "away",
            americanOdds: 145,
            betPercent: 45,
            moneyPercent: 55,
            betCount: 12_345,
            moneyAmount: 987_654.32,
            providerTimestamp: "2026-08-01T12:30:00.000Z",
            retrievedAt: "2026-08-01T12:30:00.000Z",
            scope: "consensus",
          },
        ],
      });
      const first = {
        ...payload,
        items:
          endpoint === "splits"
            ? [withSplits(payload.items[0]!)]
            : payload.items,
        nextCursor: "opaque+/= cursor",
        evaluationState: "partial",
        hasMoreUnknown: true,
      };
      const second = {
        ...payload,
        items: endpoint === "splits" ? [withSplits(secondGame)] : [secondGame],
        freshness: secondGame.freshness,
      };
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(new Response(JSON.stringify(first)))
        .mockResolvedValueOnce(new Response(JSON.stringify(second)));
      const result = createGamesClient(
        { ok: true, value: bootstrap() },
        fetcher,
      );
      if (!result.ok) throw result.error;
      const page = await (endpoint === "games"
        ? result.value.list(
            { sport: "mlb", day: "2026-08-01" },
            new AbortController().signal,
          )
        : result.value.listSplits!(
            { sport: "mlb", day: "2026-08-01" },
            new AbortController().signal,
          ));
      expect(page).toMatchObject({
        items: [{ id: payload.items[0]!.id }, { id: secondGame.id }],
        nextCursor: null,
        evaluationState: "complete",
        hasMoreUnknown: false,
        freshness: "2026-08-01T12:00:00.000Z",
      });
      if (endpoint === "splits") {
        const splitItem = page.items[0] as (typeof payload.items)[0] & {
          readonly splits: readonly {
            readonly americanOdds?: number;
            readonly betCount?: number;
            readonly moneyAmount?: number;
          }[];
        };
        expect(splitItem.splits[0]).toMatchObject({
          americanOdds: 145,
          betCount: 12_345,
          moneyAmount: 987_654.32,
        });
      }
      const secondRequest = fetcher.mock.calls[1]?.[0];
      if (typeof secondRequest !== "string")
        throw new Error("Expected a string request URL.");
      const secondUrl = new URL(secondRequest);
      expect(secondUrl.searchParams.get("cursor")).toBe("opaque+/= cursor");
      expect(secondUrl.searchParams.get("sport")).toBe("mlb");
      expect(secondUrl.searchParams.get("day")).toBe("2026-08-01");
      expect(secondUrl.searchParams.get("limit")).toBe("50");
    },
  );

  it("accepts current split evidence from an earlier canonical schedule version", async () => {
    const game = payload.items[0]!;
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          ...payload,
          items: [
            {
              ...game,
              version: 10,
              splits: [
                {
                  id: "split:older-event-version",
                  providerId: "sharpapi",
                  providerEventId: "provider-event",
                  canonicalEventId: game.id,
                  canonicalEventVersion: 9,
                  sportKey: "mlb",
                  leagueKey: "mlb",
                  marketKey: "moneyline",
                  selectionKey: "away",
                  betPercent: 45,
                  moneyPercent: 55,
                  providerTimestamp: "2026-08-01T12:30:00.000Z",
                  retrievedAt: "2026-08-01T12:30:01.000Z",
                  scope: "consensus",
                },
              ],
            },
          ],
        }),
      ),
    );
    const client = createGamesClient({ ok: true, value: bootstrap() }, fetcher);
    if (!client.ok) throw client.error;
    await expect(
      client.value.listSplits!(
        { sport: "mlb", day: "2026-08-01" },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({
      items: [{ version: 10, splits: [{ canonicalEventVersion: 9 }] }],
    });
  });

  it("continues after a complete page when its authoritative cursor is non-null", async () => {
    const secondGame = {
      ...payload.items[0]!,
      id: "event:mlb%3Amlb:fixture-after-limit",
      startsAt: "2026-08-02T00:05:00.000Z",
      eastern: {
        ...payload.items[0]!.eastern,
        display: "Aug 1, 2026, 8:05 PM",
      },
    };
    const first = { ...payload, nextCursor: "more-physical-rows" };
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify(first)))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ...payload, items: [secondGame] })),
      );
    const result = createGamesClient({ ok: true, value: bootstrap() }, fetcher);
    if (!result.ok) throw result.error;
    await expect(
      result.value.list(
        { sport: "mlb", day: "2026-08-01" },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({
      items: [{ id: payload.items[0]!.id }, { id: secondGame.id }],
      nextCursor: null,
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["negative bet count", { betCount: -1 }],
    ["fractional bet count", { betCount: 1.5 }],
    ["infinite money amount", { moneyAmount: Number.POSITIVE_INFINITY }],
    ["negative money amount", { moneyAmount: -0.01 }],
    ["zero American odds", { americanOdds: 0 }],
    ["out-of-range American odds", { americanOdds: 99 }],
    ["fractional American odds", { americanOdds: 145.5 }],
  ])("rejects splits with %s", async (_name, sample) => {
    const split = {
      id: "split:invalid-sample",
      providerId: "sharpapi",
      providerEventId: "provider-event",
      canonicalEventId: payload.items[0]!.id,
      canonicalEventVersion: 1,
      sportKey: "mlb",
      leagueKey: "mlb",
      marketKey: "moneyline",
      selectionKey: "away",
      betPercent: 45,
      moneyPercent: 55,
      providerTimestamp: "2026-08-01T12:30:00.000Z",
      retrievedAt: "2026-08-01T12:30:00.000Z",
      ...sample,
    };
    const result = createGamesClient(
      { ok: true, value: bootstrap() },
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          JSON.stringify({
            ...payload,
            items: [{ ...payload.items[0]!, splits: [split] }],
          }),
        ),
      ),
    );
    if (!result.ok) throw result.error;
    await expect(
      result.value.listSplits!(
        { sport: "mlb", day: "2026-08-01" },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "invalid-response" });
  });

  it.each([
    [
      "cursor cycle",
      (page: typeof payload) => ({
        ...page,
        nextCursor: "again",
        evaluationState: "partial",
        hasMoreUnknown: true,
      }),
    ],
    [
      "snapshot mismatch",
      (page: typeof payload) => ({
        ...page,
        snapshotAt: "2026-08-01T12:31:00.000Z",
      }),
    ],
    ["duplicate game", (page: typeof payload) => page],
  ])("rejects a paginated %s", async (_name, secondPage) => {
    const first = {
      ...payload,
      nextCursor: "again",
      evaluationState: "partial",
      hasMoreUnknown: true,
    };
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify(first)))
      .mockResolvedValueOnce(new Response(JSON.stringify(secondPage(payload))));
    const result = createGamesClient({ ok: true, value: bootstrap() }, fetcher);
    if (!result.ok) throw result.error;
    await expect(
      result.value.list(
        { sport: "mlb", day: "2026-08-01" },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "invalid-response" });
  });

  it("rejects incoherent pagination metadata", async () => {
    const result = createGamesClient(
      { ok: true, value: bootstrap() },
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          JSON.stringify({
            ...payload,
            evaluationState: "partial",
            hasMoreUnknown: false,
            nextCursor: "cursor",
          }),
        ),
      ),
    );
    if (!result.ok) throw result.error;
    await expect(
      result.value.list(
        { sport: "mlb", day: "2026-08-01" },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "invalid-response" });
  });

  it("bounds pagination and preserves abort errors", async () => {
    const partial = {
      ...payload,
      items: [],
      freshness: null,
      evaluationState: "partial",
      hasMoreUnknown: true,
    };
    let call = 0;
    const boundedFetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({ ...partial, nextCursor: `cursor-${call++}` }),
          ),
        ),
      );
    const bounded = createGamesClient(
      { ok: true, value: bootstrap() },
      boundedFetcher,
    );
    if (!bounded.ok) throw bounded.error;
    await expect(
      bounded.value.list(
        { sport: "mlb", day: "2026-08-01" },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "invalid-response" });
    expect(boundedFetcher).toHaveBeenCalledTimes(100);

    const controller = new AbortController();
    const abortError = new DOMException("Aborted", "AbortError");
    const abortFetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ...partial, nextCursor: "abort-next" })),
      )
      .mockImplementationOnce(() => {
        controller.abort();
        return Promise.reject(abortError);
      });
    const aborted = createGamesClient(
      { ok: true, value: bootstrap() },
      abortFetcher,
    );
    if (!aborted.ok) throw aborted.error;
    await expect(
      aborted.value.list(
        { sport: "mlb", day: "2026-08-01" },
        controller.signal,
      ),
    ).rejects.toBe(abortError);
    expect(abortFetcher).toHaveBeenCalledTimes(2);
  });

  it.each([
    [
      "wrong sport",
      { ...payload, items: [{ ...payload.items[0], sportKey: "soccer" }] },
    ],
    [
      "wrong day",
      {
        ...payload,
        items: [{ ...payload.items[0], startsAt: "2026-08-02T17:10:00.000Z" }],
      },
    ],
    ["extra key", { ...payload, unexpected: true }],
    [
      "extra participant",
      {
        ...payload,
        items: [
          {
            ...payload.items[0],
            participants: [
              ...payload.items[0]!.participants,
              { id: "participant:mlb:extra", label: "Extra" },
            ],
          },
        ],
      },
    ],
    [
      "duplicate participant",
      {
        ...payload,
        items: [
          {
            ...payload.items[0],
            participants: [
              payload.items[0]!.participants[0]!,
              payload.items[0]!.participants[0]!,
            ],
          },
        ],
      },
    ],
    ["pagination", { ...payload, nextCursor: "hidden-page" }],
    [
      "unrelated market",
      {
        ...payload,
        items: [
          {
            ...payload.items[0],
            odds: {
              ...payload.items[0]!.odds,
              selections: [
                {
                  ...payload.items[0]!.odds.selections[0],
                  marketKey: "run_line",
                },
              ],
            },
          },
        ],
      },
    ],
    [
      "unrelated sportsbook",
      {
        ...payload,
        items: [
          {
            ...payload.items[0],
            odds: {
              ...payload.items[0]!.odds,
              selections: [
                {
                  ...payload.items[0]!.odds.selections[0],
                  sportsbookId: "other-book",
                },
              ],
            },
          },
        ],
      },
    ],
    [
      "selection label not bound to away participant",
      {
        ...payload,
        items: [
          {
            ...payload.items[0],
            odds: {
              ...payload.items[0]!.odds,
              selections: [
                {
                  ...payload.items[0]!.odds.selections[0],
                  selectionLabel: "New York Yankees",
                },
              ],
            },
          },
        ],
      },
    ],
    [
      "incomplete market",
      {
        ...payload,
        items: [
          {
            ...payload.items[0],
            odds: {
              ...payload.items[0]!.odds,
              selections: [payload.items[0]!.odds.selections[0]],
            },
          },
        ],
      },
    ],
    [
      "wrong market order",
      {
        ...payload,
        items: [
          {
            ...payload.items[0],
            odds: {
              ...payload.items[0]!.odds,
              selections: [...payload.items[0]!.odds.selections].reverse(),
            },
          },
        ],
      },
    ],
  ])("rejects %s response binding", async (_name, body) => {
    const result = createGamesClient(
      { ok: true, value: bootstrap() },
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response(JSON.stringify(body))),
    );
    if (!result.ok) throw result.error;
    await expect(
      result.value.list(
        { sport: "mlb", day: "2026-08-01" },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "invalid-response" });
  });

  it("returns bootstrap failures without a client", () => {
    const result = createGamesClient({
      ok: false,
      error: {
        kind: "runtime-config-error",
        code: "missing-config",
        message: "Runtime configuration has not been installed.",
      },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeInstanceOf(GamesClientError);
    expect(result.error.code).toBe("configuration");
  });
});

describe("watchlist browser client", () => {
  const entry = {
    schemaVersion: "watchlist-entry-v1",
    eventId: "event:mlb%3Amlb:fixture-1",
    eventVersion: 1,
    sportKey: "mlb",
    leagueKey: "mlb",
    startsAt: "2026-08-01T23:05:00.000Z",
    addedAt: "2026-07-30T12:00:00.000Z",
  };
  const laterEntry = {
    ...entry,
    eventId: "event:mlb%3Amlb:fixture-2",
    startsAt: "2026-08-02T23:05:00.000Z",
  };
  afterEach(() => {
    Reflect.deleteProperty(globalThis, "__FTE_TOKEN_PROVIDERS__");
    Reflect.deleteProperty(globalThis, "__FTE_TOKEN_INVALIDATORS__");
  });

  const client = (
    fetcher: typeof fetch,
    session: OwnedSessionTransport = ownedSession(),
  ) => {
    const result = createGamesClient(
      { ok: true, value: bootstrap() },
      fetcher,
      session,
    );
    if (!result.ok) throw result.error;
    return result.value;
  };

  it("lists a watchlist without asking for a scouting scope", async () => {
    const fetcher = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            schemaVersion: "watchlist-page-v1",
            items: [entry, laterEntry],
          }),
        ),
      ),
    );
    const page = await client(fetcher).listWatchlist?.(
      new AbortController().signal,
    );
    expect(page?.items.map((item) => item.eventId)).toEqual([
      entry.eventId,
      laterEntry.eventId,
    ]);
    const [url, init] = fetcher.mock.calls[0] ?? [];
    expect(url).toBe("https://api.example.test/watchlist");
    expect(init?.method).toBe("GET");
    expect(new Headers(init?.headers).get("authorization")).toBe(
      `Bearer ${ownedToken}`,
    );
  });

  it.each([
    ["a broken kickoff ordering", [laterEntry, entry]],
    ["a repeated event", [entry, entry]],
    ["an unknown entry schema", [{ ...entry, schemaVersion: "v2" }]],
    ["a missing field", [{ ...entry, addedAt: undefined }]],
    ["an unexpected field", [{ ...entry, requesterId: "someone" }]],
  ])("fails closed on %s", async (_label, items) => {
    const fetcher = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({ schemaVersion: "watchlist-page-v1", items }),
        ),
      ),
    );
    await expect(
      client(fetcher).listWatchlist?.(new AbortController().signal),
    ).rejects.toBeInstanceOf(GamesClientError);
  });

  it("accepts a first add and a repeat add and keeps the stored addedAt", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify(entry), { status: 201 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(entry), { status: 200 }),
      );
    const first = await client(fetcher).addToWatchlist?.(
      entry.eventId,
      new AbortController().signal,
    );
    const repeat = await client(fetcher).addToWatchlist?.(
      entry.eventId,
      new AbortController().signal,
    );
    expect(first?.addedAt).toBe(entry.addedAt);
    expect(repeat).toEqual(first);
    const [, init] = fetcher.mock.calls[0] ?? [];
    expect(init?.method).toBe("POST");
    expect(init?.body).toBe(JSON.stringify({ eventId: entry.eventId }));
  });

  it("treats an unknown event as a neutral not-found", async () => {
    const fetcher = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response("", { status: 404 })),
    );
    await expect(
      client(fetcher).addToWatchlist?.(
        entry.eventId,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "not-found" });
  });

  it("removes with no content and rejects a removal that answers with a body", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify(entry), { status: 200 }),
      );
    await expect(
      client(fetcher).removeFromWatchlist?.(
        entry.eventId,
        new AbortController().signal,
      ),
    ).resolves.toBeUndefined();
    const [url, init] = fetcher.mock.calls[0] ?? [];
    expect(url).toBe(
      `https://api.example.test/watchlist/${encodeURIComponent(entry.eventId)}`,
    );
    expect(init?.method).toBe("DELETE");
    await expect(
      client(fetcher).removeFromWatchlist?.(
        entry.eventId,
        new AbortController().signal,
      ),
    ).rejects.toBeInstanceOf(GamesClientError);
  });

  it("refuses the current owned session when the API answers 401", async () => {
    const session = ownedSession();
    const fetcher = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response("", { status: 401 })),
    );
    await expect(
      client(fetcher, session).listWatchlist?.(new AbortController().signal),
    ).rejects.toMatchObject({ code: "authentication" });
    expect(session.refuse).toHaveBeenCalledWith(
      authorization(),
      "authentication",
    );
  });

  it("exposes owned watchlist methods without Cognito launch configuration", () => {
    const result = createGamesClient({
      ok: true,
      value: {
        config: {
          schemaVersion: 1,
          apiBase: "https://api.example.test",
          tokenProviderKey: "session",
        },
      },
    });
    if (!result.ok) throw result.error;
    expect("listWatchlist" in result.value).toBe(true);
    expect("addToWatchlist" in result.value).toBe(true);
    expect("removeFromWatchlist" in result.value).toBe(true);
  });
});

describe("identity browser client", () => {
  const token = `fte1.${"payload".padEnd(40, "x")}.${"a".repeat(64)}`;
  const accountId = `account:${"b".repeat(64)}`;
  const session = {
    schemaVersion: "auth-session-v1",
    token,
    expiresAt: "2026-08-11T13:00:00.000Z",
    accountId,
  };
  const client = (fetcher: typeof fetch) => {
    const result = createGamesClient({ ok: true, value: bootstrap() }, fetcher);
    if (!result.ok) throw result.error;
    return result.value;
  };
  const json = (body: unknown, status: number, headers?: HeadersInit) =>
    vi.fn<typeof fetch>(() =>
      Promise.resolve(
        new Response(JSON.stringify(body), {
          status,
          ...(headers ? { headers } : {}),
        }),
      ),
    );

  it("asks for a code with the number in the body and nothing else", async () => {
    const fetcher = json(
      {
        schemaVersion: "auth-otp-request-v1",
        status: "accepted",
        expiresInSeconds: 300,
        resendAfterSeconds: 30,
      },
      202,
    );
    await expect(
      client(fetcher).requestOtp?.(
        "+15551234567",
        new AbortController().signal,
      ),
    ).resolves.toEqual({
      schemaVersion: "auth-otp-request-v1",
      status: "accepted",
      expiresInSeconds: 300,
      resendAfterSeconds: 30,
    });
    expect(fetcher.mock.calls[0]?.[0]).toBe(
      "https://api.example.test/auth/otp/request",
    );
    const request = fetcher.mock.calls[0]?.[1];
    expect(request).toMatchObject({
      method: "POST",
      credentials: "omit",
      cache: "no-store",
      body: JSON.stringify({ phone: "+15551234567" }),
    });
    // Identity calls carry no session of their own.
    expect(new Headers(request?.headers).get("authorization")).toBeNull();
  });

  it("refuses a number that is not E.164 without asking the API", async () => {
    const fetcher = json({}, 202);
    await expect(
      client(fetcher).requestOtp?.("5551234567", new AbortController().signal),
    ).rejects.toMatchObject({ code: "invalid-request" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("carries the retry budget from a rate-limited refusal", async () => {
    const fetcher = json(
      { error: "rate-limited", retryAfterSeconds: 42 },
      429,
      {
        "retry-after": "42",
      },
    );
    await expect(
      client(fetcher).requestOtp?.(
        "+15551234567",
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "rate-limited", retryAfterSeconds: 42 });
  });

  it("falls back to the retry-after header, then to a default", async () => {
    await expect(
      client(
        json({ error: "rate-limited" }, 429, { "retry-after": "17" }),
      ).verifyOtp?.("+15551234567", "123456", new AbortController().signal),
    ).rejects.toMatchObject({ retryAfterSeconds: 17 });
    await expect(
      client(json({ error: "rate-limited" }, 429)).verifyOtp?.(
        "+15551234567",
        "123456",
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ retryAfterSeconds: 30 });
  });

  it("verifies a code into a session and says one thing about every failure", async () => {
    await expect(
      client(json(session, 200)).verifyOtp?.(
        "+15551234567",
        "123456",
        new AbortController().signal,
      ),
    ).resolves.toEqual(session);
    await expect(
      client(json({ error: "invalid-credentials" }, 400)).verifyOtp?.(
        "+15551234567",
        "123456",
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({
      code: "invalid-credentials",
      message: "That code did not work.",
    });
  });

  it("rejects a session response that does not match the published contract", async () => {
    for (const body of [
      { ...session, schemaVersion: "auth-session-v2" },
      { ...session, token: `x.${"y".repeat(40)}.z` },
      { ...session, accountId: "account:+15551234567" },
      { ...session, expiresAt: "not-a-time" },
      { ...session, scope: "admin" },
    ])
      await expect(
        client(json(body, 200)).verifyOtp?.(
          "+15551234567",
          "123456",
          new AbortController().signal,
        ),
      ).rejects.toMatchObject({ code: "invalid-response" });
  });

  it("renews from a live token and treats a refusal as the end of the session", async () => {
    const fetcher = json(session, 200);
    await expect(
      client(fetcher).refreshSession?.(token, new AbortController().signal),
    ).resolves.toEqual(session);
    expect(
      new Headers(fetcher.mock.calls[0]?.[1]?.headers).get("authorization"),
    ).toBe(`Bearer ${token}`);
    await expect(
      client(json({ error: "unauthorized" }, 401)).refreshSession?.(
        token,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "unauthorized" });
    await expect(
      client(json({}, 200)).refreshSession?.(
        "not-our-token",
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "unauthorized" });
  });

  it("reports a service failure as temporary rather than as a bad code", async () => {
    await expect(
      client(
        vi.fn<typeof fetch>(() => Promise.reject(new Error("offline"))),
      ).verifyOtp?.("+15551234567", "123456", new AbortController().signal),
    ).rejects.toMatchObject({ code: "request-failed" });
    await expect(
      client(json({}, 503)).verifyOtp?.(
        "+15551234567",
        "123456",
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "request-failed" });
  });
});
