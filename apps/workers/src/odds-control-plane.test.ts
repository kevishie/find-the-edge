import { describe, expect, it, vi } from "vitest";
import {
  approvedSportsbookCollection,
  oddsCollectionPolicyVersion,
  productionOddsCollectionPolicies,
} from "@find-the-edge/config";
import {
  MemoryOddsControlPlaneStore,
  type OddsRunRecord,
  type SealedOddsPage,
} from "@find-the-edge/database";
import {
  classifyOddsControlPlaneFailure,
  deduplicateProviderBookEvidence,
  decideOddsRetry,
  healthyOddsProviderState,
  oddsFailureDiagnostic,
  unhealthyOddsProviderState,
  runDueOddsLeagues,
  runOddsLeague,
  withPaidLeaseHeartbeat,
  embeddedOddsControlPlaneMetrics,
  type ControlPlaneProvider,
} from "./odds-control-plane";
const now = new Date("2026-08-03T12:00:00.000Z");

class CountingOddsControlPlaneStore extends MemoryOddsControlPlaneStore {
  runAccesses = 0;
  pageReads = 0;

  override getRun(id: string) {
    this.runAccesses += 1;
    return super.getRun(id);
  }

  override transitionRun(previous: OddsRunRecord | null, value: OddsRunRecord) {
    this.runAccesses += 1;
    return super.transitionRun(previous, value);
  }

  override getPage(
    runId: string,
    token: string,
  ): Promise<SealedOddsPage | null> {
    this.pageReads += 1;
    return super.getPage(runId, token);
  }
}

it("preserves the last success when a later provider attempt fails", () => {
  const healthy = healthyOddsProviderState(null, {
    providerId: "sharpapi",
    healthKey: "sharpapi:mlb:odds",
    updatedAt: "2026-08-03T11:59:00.000Z",
    consecutiveSuccesses: 1,
  });
  const failed = unhealthyOddsProviderState(healthy, {
    providerId: "sharpapi",
    healthKey: "sharpapi:mlb:odds",
    now,
    decision: decideOddsRetry({
      error: new Error("provider-unavailable"),
      attempt: 1,
      now,
      jitter: () => 0,
    }),
    cooldownSeconds: 900,
  });
  expect(failed.lastSuccessfulAt).toBe("2026-08-03T11:59:00.000Z");
  expect(failed.updatedAt).toBe(now.toISOString());
});

it("clears prior partial evidence when a later successful run is complete", () => {
  const recovered = healthyOddsProviderState(
    {
      providerId: "sharpapi",
      healthKey: "sharpapi:mlb:odds",
      healthy: true,
      status: "healthy",
      consecutiveSuccesses: 1,
      partialEvidenceCount: 4,
      updatedAt: "2026-08-03T11:50:00.000Z",
    },
    {
      providerId: "sharpapi",
      healthKey: "sharpapi:mlb:odds",
      updatedAt: "2026-08-03T11:59:00.000Z",
      consecutiveSuccesses: 2,
    },
  );
  expect(recovered.partialEvidenceCount).toBeUndefined();
  expect(recovered.lastSuccessfulAt).toBe("2026-08-03T11:59:00.000Z");
});

it("publishes bounded EMF dimensions instead of an empty dimension set", () => {
  const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  embeddedOddsControlPlaneMetrics.emit("OddsSnapshotCreated", 1, {
    provider: "sharpapi",
    league: "mlb",
    reason: "created",
  });
  const payload = JSON.parse(String(write.mock.calls[0]?.[0])) as {
    _aws: { CloudWatchMetrics: { Dimensions: string[][] }[] };
  };
  expect(payload._aws.CloudWatchMetrics[0]?.Dimensions).toEqual([
    ["provider", "league", "reason"],
  ]);
  write.mockRestore();
});
// The generic control-plane retains explicit failover behavior for reusable
// callers. Production policy is SharpAPI-only, so these unit tests opt into a
// secondary provider locally when exercising the generic state machine.
const policy = {
  ...productionOddsCollectionPolicies[0]!,
  providers: [
    ...productionOddsCollectionPolicies[0]!.providers,
    {
      providerId: "the-odds-api" as const,
      role: "fallback" as const,
      active: true,
      quotaReserve: 50,
      cooldownSeconds: 1_800,
      failbackSuccesses: 1,
      books: { draftkings: "offered" as const, circa: "comparison" as const },
    },
  ],
};
const provider = (
  id: "sharpapi" | "the-odds-api",
  fetchPage: ControlPlaneProvider["fetchPage"],
): ControlPlaneProvider => ({ providerId: id, fetchPage });
describe("odds collection control plane", () => {
  it("records an overlapping schedule owner as a recoverable skip", async () => {
    const store = new MemoryOddsControlPlaneStore();
    const metrics = { emit: vi.fn() };

    await expect(
      runOddsLeague({
        policy,
        store,
        providers: new Map(),
        committer: { commit: vi.fn() },
        now,
        dependencyFailure: "schedule-provider-recovering",
        metrics,
      }),
    ).resolves.toEqual({
      leagueKey: policy.leagueKey,
      status: "skipped",
      reason: "schedule-provider-recovering",
      pages: 0,
      quotaCost: 0,
    });

    expect(store.runs.size).toBe(0);
    expect(metrics.emit).toHaveBeenCalledWith("OddsPassAudit", 1, {
      status: "skipped",
      reason: "schedule-provider-recovering",
      league: "mlb",
      provider: "none",
      policyVersion: oddsCollectionPolicyVersion,
    });
  });

  it("retries only safe transient failures and reconciles ambiguous paid calls", () => {
    expect(
      decideOddsRetry({
        error: new Error("rate-limited"),
        attempt: 1,
        now,
        providerRetryAt: "2026-08-03T12:02:00.000Z",
        jitter: () => 0,
      }),
    ).toMatchObject({
      class: "transient",
      action: "retry",
      retryAt: "2026-08-03T12:02:00.000Z",
    });
    expect(
      decideOddsRetry({ error: new Error("unauthorized"), attempt: 1, now }),
    ).toMatchObject({ class: "terminal", action: "stop" });
    expect(
      decideOddsRetry({
        error: Object.assign(new Error("socket closed"), { name: "Error" }),
        attempt: 1,
        now,
      }),
    ).toMatchObject({ class: "ambiguous", action: "reconcile" });
    expect(
      decideOddsRetry({
        error: new Error("provider-unavailable"),
        attempt: 5,
        now,
      }),
    ).toMatchObject({ class: "transient", action: "exhausted" });
    expect(
      decideOddsRetry({
        error: new Error("conflict-metric-pending"),
        attempt: 1,
        now,
        jitter: () => 0,
      }),
    ).toMatchObject({ class: "transient", action: "retry" });
    expect(
      classifyOddsControlPlaneFailure(new Error("conflict-metric-pending")),
    ).toBe("conflict-metric-pending");
  });
  it("expires only transient health and heals without deleting audit state", () => {
    const transient = unhealthyOddsProviderState(null, {
      providerId: "sharpapi",
      healthKey: "sharpapi:mlb:odds",
      now,
      cooldownSeconds: 60,
      decision: decideOddsRetry({
        error: new Error("rate-limited"),
        attempt: 1,
        now,
        jitter: () => 0,
      }),
    });
    expect(transient).toMatchObject({
      failureClass: "transient",
      failureReason: "rate-limited",
    });
    expect(typeof transient.expiresAt).toBe("number");
    const terminal = unhealthyOddsProviderState(null, {
      providerId: "sharpapi",
      healthKey: "sharpapi:mlb:odds",
      now,
      cooldownSeconds: 60,
      decision: decideOddsRetry({
        error: new Error("unauthorized"),
        attempt: 1,
        now,
      }),
    });
    expect(terminal).not.toHaveProperty("expiresAt");
    const unstaged = unhealthyOddsProviderState(
      { ...terminal, failureStage: "odds:old-stage" },
      {
        providerId: "sharpapi",
        healthKey: "sharpapi:mlb:odds",
        now,
        cooldownSeconds: 60,
        decision: decideOddsRetry({
          error: new Error("provider-rejected"),
          attempt: 1,
          now,
        }),
      },
    );
    expect(unstaged).not.toHaveProperty("failureStage");
    expect(
      healthyOddsProviderState(transient, {
        providerId: "sharpapi",
        healthKey: "sharpapi:mlb:odds",
        updatedAt: "2026-08-03T12:02:00.000Z",
        consecutiveSuccesses: 1,
      }),
    ).not.toHaveProperty("failureReason");
  });
  it("classifies bounded recovery and pagination failures without raw errors", () => {
    expect(classifyOddsControlPlaneFailure(new Error("run-owned"))).toBe(
      "provider-recovering",
    );
    expect(
      classifyOddsControlPlaneFailure(new Error("page-limit-exceeded")),
    ).toBe("pagination-invalid");
    expect(
      classifyOddsControlPlaneFailure(new Error("sealed-page-conflict")),
    ).toBe("provider-response-unsealed");
    const storageFailure = new Error("redacted provider storage detail");
    storageFailure.name = "ValidationException";
    expect(classifyOddsControlPlaneFailure(storageFailure)).toBe(
      "storage-validation",
    );
    for (const reason of [
      "sharpapi-odds-mapping-no-candidate",
      "sharpapi-odds-mapping-ambiguous-candidates",
      "sharpapi-odds-mapping-participant-mismatch",
      "sharpapi-odds-mapping-start-mismatch",
      "mapping-canonical-missing",
      "mapping-canonical-scope-mismatch",
      "mapping-scope-mismatch",
    ])
      expect(classifyOddsControlPlaneFailure(new Error(reason))).toBe(reason);
    expect(
      classifyOddsControlPlaneFailure(new Error("sensitive mapping detail")),
    ).toBe("mapping-quarantine");
    expect(
      classifyOddsControlPlaneFailure(new Error("sensitive unknown detail")),
    ).toBe("internal-failure");
  });
  it("bounds and redacts unexpected failure diagnostics", () => {
    const error = new Error(
      `Validation failed token=do-not-log ${"x".repeat(300)}`,
    );
    error.name = "TypeError";
    Object.assign(error, { stage: "odds-page-envelope" });
    const diagnostic = oddsFailureDiagnostic(error);
    expect(diagnostic.errorName).toBe("TypeError");
    expect(diagnostic.errorStage).toBe("odds-page-envelope");
    expect(diagnostic.errorMessage).toMatch(
      /^Validation failed token=\[redacted\] x+$/,
    );
    expect(diagnostic.errorMessage).toHaveLength(240);
  });
  it("waits for an in-flight heartbeat before accepting a paid response", async () => {
    let releaseHeartbeat!: () => void;
    const heartbeatGate = new Promise<void>((resolve) => {
      releaseHeartbeat = resolve;
    });
    let heartbeatStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      heartbeatStarted = resolve;
    });
    let releaseCall!: () => void;
    const callGate = new Promise<void>((resolve) => {
      releaseCall = resolve;
    });
    const result = withPaidLeaseHeartbeat(
      async () => {
        await callGate;
        return "paid-response";
      },
      async () => {
        heartbeatStarted();
        await heartbeatGate;
      },
      1,
    );
    await started;
    releaseCall();
    let settled = false;
    void result.finally(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    releaseHeartbeat();
    await expect(result).resolves.toBe("paid-response");
  });

  it("deterministically fences a response when its in-flight renewal fails", async () => {
    let failHeartbeat!: () => void;
    const heartbeatGate = new Promise<void>((_resolve, reject) => {
      failHeartbeat = () => reject(new Error("lost-owner"));
    });
    let heartbeatStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      heartbeatStarted = resolve;
    });
    let releaseCall!: () => void;
    const callGate = new Promise<void>((resolve) => {
      releaseCall = resolve;
    });
    const result = withPaidLeaseHeartbeat(
      async () => {
        await callGate;
        return "must-not-commit";
      },
      async () => {
        heartbeatStarted();
        await heartbeatGate;
      },
      1,
    );
    await started;
    releaseCall();
    failHeartbeat();
    await expect(result).rejects.toThrow("run-owned");
  });
  it("durably skips calls when cadence is not due", async () => {
    const store = new MemoryOddsControlPlaneStore();
    const metrics = { emit: vi.fn() };
    await store.putCheckpoint({
      leagueKey: "mlb",
      providerId: "sharpapi",
      completedAt: now.toISOString(),
      nextDueAt: "2026-08-03T13:00:00.000Z",
      runId: "old",
    });
    const fetchPage = vi.fn();
    const result = await runOddsLeague({
      policy,
      store,
      providers: new Map([["sharpapi", provider("sharpapi", fetchPage)]]),
      committer: { commit: vi.fn() },
      now,
      metrics,
    });
    expect(result.status).toBe("skipped");
    expect(fetchPage).not.toHaveBeenCalled();
    expect(store.runs.size).toBe(0);
    expect(metrics.emit).toHaveBeenCalledWith("OddsPassAudit", 1, {
      status: "skipped",
      reason: "cadence-not-due",
      league: "mlb",
      provider: "none",
      policyVersion: oddsCollectionPolicyVersion,
    });
  });
  it("honors an operator force refresh even when cadence is not due", async () => {
    const store = new MemoryOddsControlPlaneStore();
    await store.putCheckpoint({
      leagueKey: "mlb",
      providerId: "sharpapi",
      completedAt: now.toISOString(),
      nextDueAt: "2026-08-03T13:00:00.000Z",
      runId: "old",
    });
    const fetchPage = vi.fn().mockResolvedValue({
      items: [{ id: 1 }],
      gaps: [],
      quotaCost: 1,
      digest: "forced",
    });
    const result = await runOddsLeague({
      policy,
      store,
      providers: new Map([["sharpapi", provider("sharpapi", fetchPage)]]),
      committer: { commit: vi.fn().mockResolvedValue(true) },
      now,
      forceRefresh: true,
    });
    expect(result.status).toBe("completed");
    expect(fetchPage).toHaveBeenCalledOnce();
  });
  it("safely skips when another invocation owns the league before evidence", async () => {
    const store = new CountingOddsControlPlaneStore();
    await store.claimContinuation({
      leagueKey: policy.leagueKey,
      runId: "active-run",
      providerId: "sharpapi",
      updatedAt: now.toISOString(),
      startedAt: now.toISOString(),
      capability: "odds",
      evidenceCommitted: false,
      quotaCost: 0,
      ownerId: "other-owner",
      leaseUntil: "2026-08-03T12:05:00.000Z",
    });
    store.runAccesses = 0;
    store.pageReads = 0;
    const fetchPage = vi.fn();
    const result = await runOddsLeague({
      policy,
      store,
      providers: new Map([["sharpapi", provider("sharpapi", fetchPage)]]),
      committer: { commit: vi.fn() },
      now,
      forceRefresh: true,
    });
    expect(result).toMatchObject({
      status: "skipped",
      reason: "provider-recovering",
      pages: 0,
    });
    expect(fetchPage).not.toHaveBeenCalled();
    expect(store.runAccesses).toBe(0);
    expect(store.pageReads).toBe(0);
  });
  it("reclaims an owned continuation whose lease timestamps are malformed", async () => {
    const store = new MemoryOddsControlPlaneStore();
    store.continuations.set(policy.leagueKey, {
      leagueKey: policy.leagueKey,
      runId: "malformed-lease-run",
      providerId: "sharpapi",
      updatedAt: "not-a-time",
      startedAt: now.toISOString(),
      capability: "odds",
      evidenceCommitted: false,
      quotaCost: 0,
      ownerId: "vanished-owner",
      leaseUntil: "also-not-a-time",
      version: 1,
    });
    const fetchPage = vi.fn().mockResolvedValue({
      items: [],
      gaps: [],
      quotaCost: 1,
      digest: "reclaimed",
    });

    const result = await runOddsLeague({
      policy,
      store,
      providers: new Map([["sharpapi", provider("sharpapi", fetchPage)]]),
      committer: { commit: vi.fn().mockResolvedValue(false) },
      now,
      forceRefresh: true,
    });

    expect(result).toMatchObject({ status: "completed", pages: 1 });
    expect(fetchPage).toHaveBeenCalledOnce();
  });
  it("starts a newly claimed lease from the live clock, not invocation time", async () => {
    const store = new MemoryOddsControlPlaneStore();
    const liveClaimTime = new Date("2026-08-03T13:00:00.000Z");
    const result = await runOddsLeague({
      policy,
      store,
      providers: new Map([
        [
          "sharpapi",
          provider(
            "sharpapi",
            vi.fn().mockRejectedValue(new Error("provider-unavailable")),
          ),
        ],
      ]),
      committer: { commit: vi.fn() },
      now,
      clock: () => liveClaimTime,
    });
    expect(result.status).toBe("failed");
    const continuation = await store.getContinuation(policy.leagueKey);
    expect(continuation?.updatedAt).toBe(liveClaimTime.toISOString());
    expect(continuation?.leaseUntil).toBe("2026-08-03T13:05:00.000Z");
  });
  it.each(["provider-rejected", "invalid-response"])(
    "starts terminal cursor failures from page one after the lease expires: %s",
    async (failureReason) => {
      const store = new MemoryOddsControlPlaneStore();
      const staleRunId = "mlb:sharpapi:stale-cursor-run";
      await store.putRun({
        runId: staleRunId,
        leagueKey: policy.leagueKey,
        providerId: "sharpapi",
        policyVersion: "test",
        status: "failed",
        startedAt: "2026-08-03T10:00:00.000Z",
        updatedAt: "2026-08-03T10:05:00.000Z",
        failureReason,
        evidenceCommitted: false,
        quotaCost: 7,
      });
      await store.claimContinuation({
        leagueKey: policy.leagueKey,
        runId: staleRunId,
        providerId: "sharpapi",
        updatedAt: "2026-08-03T10:05:00.000Z",
        startedAt: "2026-08-03T10:00:00.000Z",
        capability: "odds",
        evidenceCommitted: false,
        quotaCost: 7,
        ownerId: "finished-worker",
        leaseUntil: "2026-08-03T10:10:00.000Z",
      });
      await store.sealPage({
        runId: staleRunId,
        pageToken: "start",
        nextPageToken: "expired-provider-cursor",
        responseDigest: "stale-page",
        normalizedItems: [],
        gaps: [],
        quotaCost: 1,
        sealedAt: "2026-08-03T10:01:00.000Z",
        committedAt: "2026-08-03T10:01:01.000Z",
      });
      const fetchPage = vi.fn().mockResolvedValue({
        items: [],
        gaps: [],
        quotaCost: 1,
        digest: "fresh-terminal-page",
      });

      const result = await runOddsLeague({
        policy,
        store,
        providers: new Map([
          [
            "sharpapi",
            {
              ...provider("sharpapi", fetchPage),
              restartTerminalCursorRun: true,
            },
          ],
        ]),
        committer: { commit: vi.fn() },
        now,
        clock: () => now,
        forceRefresh: true,
      });

      expect(result).toMatchObject({
        status: "completed",
        providerId: "sharpapi",
        pages: 1,
        quotaCost: 1,
      });
      expect(fetchPage).toHaveBeenCalledWith(
        expect.objectContaining({ pageToken: "start" }),
      );
      expect(fetchPage).not.toHaveBeenCalledWith(
        expect.objectContaining({ pageToken: "expired-provider-cursor" }),
      );
      expect(await store.getContinuation(policy.leagueKey)).toBeNull();
      expect(await store.getRun(staleRunId)).toMatchObject({
        status: "failed",
        failureReason,
        quotaCost: 7,
      });
    },
  );
  it.each([
    {
      name: "unwedges a lapsed ambiguity",
      minutesAgo: 90,
      intent: false,
      fenced: false,
    },
    {
      name: "keeps fencing while the window is open",
      minutesAgo: 2,
      intent: false,
      fenced: true,
    },
    {
      name: "keeps fencing when the ledger shows evidence beyond recall",
      minutesAgo: 90,
      intent: true,
      fenced: true,
    },
  ])("ambiguity ceiling: $name", async ({ minutesAgo, intent, fenced }) => {
    // MLS answered provider-request-ambiguous on every pass for eleven hours
    // because the fence had no exit; an operator deleting the row was the
    // only way out. The ceiling automates exactly that, and only that.
    const store = new MemoryOddsControlPlaneStore();
    const runId = "mlb:sharpapi:ambiguous-run";
    const stamped = new Date(now.getTime() - minutesAgo * 60_000).toISOString();
    await store.putRun({
      runId,
      leagueKey: policy.leagueKey,
      providerId: "sharpapi",
      policyVersion: "test",
      status: "failed",
      startedAt: stamped,
      updatedAt: stamped,
      failureReason: "provider-request-ambiguous",
      evidenceCommitted: false,
      quotaCost: 1,
    });
    await store.claimContinuation({
      leagueKey: policy.leagueKey,
      runId,
      providerId: "sharpapi",
      updatedAt: stamped,
      startedAt: stamped,
      capability: "odds",
      evidenceCommitted: false,
      quotaCost: 1,
      ownerId: "vanished-worker",
      leaseUntil: stamped,
      ambiguousUntil: stamped,
    });
    await store.sealPage({
      runId,
      pageToken: "start",
      responseDigest: "d",
      normalizedItems: [],
      gaps: [],
      quotaCost: 1,
      sealedAt: stamped,
      ...(intent ? { evidenceIntentAt: stamped } : {}),
    });
    const fetchPage = vi.fn();

    const result = await runOddsLeague({
      policy,
      store,
      providers: new Map([["sharpapi", provider("sharpapi", fetchPage)]]),
      committer: { commit: vi.fn() },
      now,
      clock: () => now,
    });

    // Either way the ambiguous request is never blindly reissued in the same
    // pass; the fence only decides whether the league stays stuck forever.
    expect(fetchPage).not.toHaveBeenCalled();
    if (fenced) {
      expect(result.reason).toBe("provider-request-ambiguous");
      expect(await store.getContinuation(policy.leagueKey)).not.toBeNull();
    } else {
      expect(result).toMatchObject({ status: "skipped" });
      // The poisoned row is gone, so the next pass starts a fresh run.
      expect(await store.getContinuation(policy.leagueKey)).toBeNull();
    }
  });

  it.each([
    {
      name: "abandons an aged run with no committed evidence",
      aged: true,
      committed: false,
      resumes: false,
    },
    {
      name: "keeps an aged run that already committed evidence",
      aged: true,
      committed: true,
      resumes: true,
    },
    // A young run is left to the existing rules, which already restart an
    // expired provider cursor on their own; the ceiling decides only the two
    // aged cases above.
  ])("age ceiling: $name", async ({ aged, committed, resumes }) => {
    // SharpAPI is the only odds provider, so a retryable failure keeps the
    // continuation and every later pass resumes the same runId. MLS sat on
    // one run for ten hours with an empty board and green provider health.
    // The ceiling breaks that — except where evidence is already committed,
    // because re-walking those pages would commit the same evidence twice.
    const store = new MemoryOddsControlPlaneStore();
    const startedAt = new Date(now.getTime() - (aged ? 90 : 5) * 60_000);
    const staleRunId = `${policy.leagueKey}:sharpapi:${startedAt.toISOString()}`;
    await store.putRun({
      runId: staleRunId,
      leagueKey: policy.leagueKey,
      providerId: "sharpapi",
      policyVersion: "test",
      status: "failed",
      startedAt: startedAt.toISOString(),
      updatedAt: startedAt.toISOString(),
      failureReason: "provider-rejected",
      evidenceCommitted: committed,
      quotaCost: 7,
    });
    await store.claimContinuation({
      leagueKey: policy.leagueKey,
      runId: staleRunId,
      providerId: "sharpapi",
      updatedAt: startedAt.toISOString(),
      startedAt: startedAt.toISOString(),
      capability: "odds",
      evidenceCommitted: committed,
      quotaCost: 7,
      ownerId: "finished-worker",
      leaseUntil: startedAt.toISOString(),
    });
    await store.sealPage({
      runId: staleRunId,
      pageToken: "start",
      nextPageToken: "wedged-cursor",
      responseDigest: "committed-page",
      normalizedItems: [],
      gaps: [],
      quotaCost: 1,
      sealedAt: startedAt.toISOString(),
      committedAt: startedAt.toISOString(),
    });
    const fetchPage = vi
      .fn()
      .mockResolvedValue({ items: [], gaps: [], quotaCost: 1, digest: "d" });

    await runOddsLeague({
      policy,
      store,
      providers: new Map([
        [
          "sharpapi",
          {
            ...provider("sharpapi", fetchPage),
            restartTerminalCursorRun: true,
          },
        ],
      ]),
      committer: { commit: vi.fn() },
      now,
      clock: () => now,
      forceRefresh: true,
    });

    const wedged = () =>
      expect.objectContaining({ pageToken: "wedged-cursor" }) as unknown;
    if (resumes) expect(fetchPage).toHaveBeenCalledWith(wedged());
    else {
      // A fresh run walking from the beginning, with the quota ratchet reset:
      // a carried-over cost would starve the league the restart just freed.
      expect(fetchPage).not.toHaveBeenCalledWith(wedged());
      expect(fetchPage).toHaveBeenCalledWith(
        expect.objectContaining({ pageToken: "start" }),
      );
    }
  });

  it.each([
    {
      name: "durable committed evidence",
      runCommitted: true,
      pageIntent: false,
    },
    {
      name: "recovered page evidence intent",
      runCommitted: false,
      pageIntent: true,
      pageEvidenceCommit: false,
    },
    {
      name: "recovered empty-page evidence commit",
      runCommitted: false,
      pageIntent: false,
      pageEvidenceCommit: true,
    },
  ])(
    "never restarts a terminal cursor after $name",
    async ({ runCommitted, pageIntent, pageEvidenceCommit = false }) => {
      const store = new MemoryOddsControlPlaneStore();
      const staleRunId = "mlb:sharpapi:committed-cursor-run";
      await store.putRun({
        runId: staleRunId,
        leagueKey: policy.leagueKey,
        providerId: "sharpapi",
        policyVersion: "test",
        status: "failed",
        startedAt: "2026-08-03T10:00:00.000Z",
        updatedAt: "2026-08-03T10:05:00.000Z",
        failureReason: "provider-rejected",
        evidenceCommitted: runCommitted,
        quotaCost: 7,
      });
      await store.claimContinuation({
        leagueKey: policy.leagueKey,
        runId: staleRunId,
        providerId: "sharpapi",
        updatedAt: "2026-08-03T10:05:00.000Z",
        startedAt: "2026-08-03T10:00:00.000Z",
        capability: "odds",
        evidenceCommitted: runCommitted,
        quotaCost: 7,
        ownerId: "finished-worker",
        leaseUntil: "2026-08-03T10:10:00.000Z",
      });
      await store.sealPage({
        runId: staleRunId,
        pageToken: "start",
        nextPageToken: "expired-provider-cursor",
        responseDigest: "committed-page",
        normalizedItems: [],
        gaps: [],
        quotaCost: 1,
        sealedAt: "2026-08-03T10:01:00.000Z",
        ...(pageIntent ? { evidenceIntentAt: "2026-08-03T10:01:00.500Z" } : {}),
        ...(pageEvidenceCommit
          ? { evidenceCommittedAt: "2026-08-03T10:01:01.000Z" }
          : {}),
        committedAt: "2026-08-03T10:01:01.000Z",
      });
      const fetchPage = vi.fn().mockResolvedValue({
        items: [],
        gaps: [],
        quotaCost: 1,
        digest: "resumed-terminal-page",
      });

      const result = await runOddsLeague({
        policy,
        store,
        providers: new Map([
          [
            "sharpapi",
            {
              ...provider("sharpapi", fetchPage),
              restartTerminalCursorRun: true,
            },
          ],
        ]),
        committer: { commit: vi.fn() },
        now,
        clock: () => now,
        forceRefresh: true,
      });

      expect(result.status).toBe("completed");
      expect(fetchPage).toHaveBeenCalledWith(
        expect.objectContaining({ pageToken: "expired-provider-cursor" }),
      );
      expect(fetchPage).not.toHaveBeenCalledWith(
        expect.objectContaining({ pageToken: "start" }),
      );
      expect(await store.getRun(staleRunId)).toMatchObject({
        status: "completed",
        evidenceCommitted: true,
      });
    },
  );
  it("replays a sealed many-book page after a commit interruption without a second paid call", async () => {
    const store = new MemoryOddsControlPlaneStore();
    const normalizedItems = Object.keys(approvedSportsbookCollection).map(
      (sportsbookId) => ({ sportsbookId }),
    );
    const fetchPage = vi.fn().mockResolvedValue({
      items: normalizedItems,
      gaps: [],
      quotaCost: 1,
      digest: "many-books",
    });
    const commit = vi
      .fn()
      .mockRejectedValueOnce(new Error("crash"))
      .mockResolvedValue(undefined);
    const input = {
      policy,
      store,
      providers: new Map([["sharpapi", provider("sharpapi", fetchPage)]]),
      committer: { commit },
      now,
    };
    expect((await runOddsLeague(input)).status).toBe("failed");
    await store.putHealth({
      providerId: "sharpapi",
      healthy: true,
      consecutiveSuccesses: 2,
      updatedAt: now.toISOString(),
    });
    const lower = await runOddsLeague({
      ...input,
      now: new Date("2026-08-03T12:05:00.000Z"),
    });
    expect(lower).toMatchObject({ status: "completed", quotaCost: 1 });
    expect(fetchPage).toHaveBeenCalledTimes(1);
    expect(commit).toHaveBeenCalledTimes(2);
    expect(commit.mock.calls[0]?.[0]).toMatchObject({ items: normalizedItems });
    expect(commit.mock.calls[1]?.[0]).toEqual(commit.mock.calls[0]?.[0]);
  });
  it("recovers a sealed response when post-fetch bookkeeping fails", async () => {
    const store = new MemoryOddsControlPlaneStore();
    const originalPutHealth = store.putHealth.bind(store);
    let failed = false;
    store.putHealth = async (health) => {
      if (!failed && health.quotaRemaining === 99) {
        failed = true;
        throw new Error("storage-interruption-after-seal");
      }
      return originalPutHealth(health);
    };
    const fetchPage = vi.fn().mockResolvedValue({
      items: [{ id: 1 }],
      gaps: [],
      quotaCost: 1,
      quotaRemaining: 99,
      digest: "sealed-before-failure",
    });
    const result = await runOddsLeague({
      policy,
      store,
      providers: new Map([["sharpapi", provider("sharpapi", fetchPage)]]),
      committer: { commit: vi.fn() },
      now,
    });
    expect(result.status).toBe("completed");
    expect(fetchPage).toHaveBeenCalledOnce();
    expect([...store.attempts.values()][0]?.state).toBe("succeeded");
  });
  it("fails over only before primary evidence commits and keeps budgets independent", async () => {
    const store = new MemoryOddsControlPlaneStore();
    const primary = vi
      .fn()
      .mockRejectedValue(new Error("provider-unavailable"));
    const fallback = vi.fn().mockResolvedValue({
      items: [{ id: 2 }],
      gaps: [],
      quotaCost: 2,
      digest: "two",
      quotaRemaining: 500,
    });
    const result = await runOddsLeague({
      policy,
      store,
      providers: new Map([
        ["sharpapi", provider("sharpapi", primary)],
        ["the-odds-api", provider("the-odds-api", fallback)],
      ]),
      committer: { commit: vi.fn() },
      now,
    });
    expect(result).toMatchObject({
      status: "completed",
      providerId: "the-odds-api",
      quotaCost: 2,
    });
    expect(primary).toHaveBeenCalledOnce();
    expect(fallback).toHaveBeenCalledOnce();
    expect(
      [...store.attempts.values()].map((attempt) => attempt.state),
    ).toEqual(["failed", "succeeded"]);
  });
  it("reconciles a two-call reserve to one terminal request and retains its stage", async () => {
    const store = new MemoryOddsControlPlaneStore();
    await store.putHealth({
      providerId: "sharpapi",
      healthKey: "sharpapi:mlb:odds",
      healthy: true,
      consecutiveSuccesses: 1,
      quotaRemaining: 1_000,
      updatedAt: now.toISOString(),
    });
    const failure = Object.assign(new Error("provider-rejected"), {
      stage: "odds:provider-error",
    });
    const result = await runOddsLeague({
      policy,
      store,
      providers: new Map([
        [
          "sharpapi",
          {
            providerId: "sharpapi",
            requestCost: 2,
            failureRequestCost: () => 1,
            fetchPage: vi.fn().mockRejectedValue(failure),
          },
        ],
      ]),
      committer: { commit: vi.fn() },
      now,
    });
    expect(result).toMatchObject({
      status: "failed",
      reason: "provider-rejected",
      quotaCost: 1,
    });
    expect([...store.attempts.values()][0]).toMatchObject({
      state: "failed",
      quotaCost: 1,
      failureReason: "provider-rejected",
      failureStage: "odds:provider-error",
    });
    expect([...store.runs.values()].at(-1)).toMatchObject({
      failureReason: "provider-rejected",
      failureStage: "odds:provider-error",
      quotaCost: 1,
    });
    expect(await store.getHealth("sharpapi:mlb:odds")).toMatchObject({
      healthy: false,
      quotaRemaining: 999,
      failureReason: "provider-rejected",
      failureStage: "odds:provider-error",
    });
  });
  it("reconciles a known one-call dispatch while fencing an ambiguous outcome", async () => {
    const store = new MemoryOddsControlPlaneStore();
    await store.putHealth({
      providerId: "sharpapi",
      healthKey: "sharpapi:mlb:odds",
      healthy: true,
      consecutiveSuccesses: 1,
      quotaRemaining: 1_000,
      updatedAt: now.toISOString(),
    });
    const timeout = new Error("network timeout");
    const result = await runOddsLeague({
      policy,
      store,
      providers: new Map([
        [
          "sharpapi",
          {
            providerId: "sharpapi",
            requestCost: 2,
            failureRequestCost: () => 1,
            fetchPage: vi.fn().mockRejectedValue(timeout),
          },
        ],
      ]),
      committer: { commit: vi.fn() },
      now,
    });
    expect(result).toMatchObject({
      status: "failed",
      reason: "provider-request-ambiguous",
      quotaCost: 1,
    });
    expect([...store.attempts.values()][0]).toMatchObject({
      state: "ambiguous",
      quotaCost: 1,
      failureReason: "provider-request-ambiguous",
    });
    expect(await store.getHealth("sharpapi:mlb:odds")).toMatchObject({
      quotaRemaining: 999,
    });
  });
  it("leaves an unsealed paid response terminally ambiguous and blocks recall during its lease", async () => {
    const store = new MemoryOddsControlPlaneStore();
    const originalSeal = store.sealPage.bind(store);
    let failSeal = true;
    store.sealPage = async (page) => {
      if (failSeal) {
        failSeal = false;
        throw new Error("storage-unavailable");
      }
      return originalSeal(page);
    };
    const fetchPage = vi.fn().mockResolvedValue({
      items: [],
      gaps: [],
      quotaCost: 1,
      digest: "paid-response",
    });
    const input = {
      policy,
      store,
      providers: new Map([["sharpapi", provider("sharpapi", fetchPage)]]),
      committer: { commit: vi.fn() },
      now,
    };
    expect((await runOddsLeague(input)).status).toBe("failed");
    expect([...store.attempts.values()][0]).toMatchObject({
      state: "ambiguous",
      failureReason: "provider-response-unsealed",
    });
    expect(
      (
        await runOddsLeague({
          ...input,
          now: new Date("2026-08-03T12:01:00.000Z"),
        })
      ).reason,
    ).toBe("provider-request-ambiguous");
    expect(fetchPage).toHaveBeenCalledOnce();
  });
  it("fences ambiguous transport and blocks fallback or paid recall", async () => {
    const store = new MemoryOddsControlPlaneStore();
    const primary = vi.fn().mockRejectedValue(new Error("network timeout"));
    const fallback = vi.fn();
    const input = {
      policy,
      store,
      providers: new Map([
        ["sharpapi", provider("sharpapi", primary)],
        ["the-odds-api", provider("the-odds-api", fallback)],
      ]),
      committer: { commit: vi.fn() },
      now,
    };
    expect(await runOddsLeague(input)).toMatchObject({
      status: "failed",
      reason: "provider-request-ambiguous",
    });
    expect(fallback).not.toHaveBeenCalled();
    expect(
      await runOddsLeague({
        ...input,
        now: new Date("2026-08-03T12:10:00.000Z"),
      }),
    ).toMatchObject({ reason: "provider-request-ambiguous" });
    expect(primary).toHaveBeenCalledOnce();
  });
  it("persists ambiguity after heartbeat version advances and blocks recall", async () => {
    const store = new MemoryOddsControlPlaneStore();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetchPage = vi.fn(async () => {
      await gate;
      throw new Error("network timeout after request");
    });
    let liveMs = now.getTime();
    const first = runOddsLeague({
      policy,
      store,
      providers: new Map([["sharpapi", provider("sharpapi", fetchPage)]]),
      committer: { commit: vi.fn() },
      now,
      clock: () => new Date((liveMs += 1)),
      heartbeatIntervalMs: 1,
    });
    await vi.waitFor(() => expect(fetchPage).toHaveBeenCalledOnce());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(
      (await store.getContinuation(policy.leagueKey))?.version,
    ).toBeGreaterThan(1);
    release();
    expect((await first).status).toBe("failed");
    expect(
      (await store.getContinuation(policy.leagueKey))?.ambiguousUntil,
    ).toBeDefined();
    const second = await runOddsLeague({
      policy,
      store,
      providers: new Map([["sharpapi", provider("sharpapi", fetchPage)]]),
      committer: { commit: vi.fn() },
      now: new Date(now.getTime() + 10 * 60_000),
      clock: () => new Date(now.getTime() + 10 * 60_000),
      heartbeatIntervalMs: 1,
    });
    expect(second.reason).toBe("provider-request-ambiguous");
    expect(fetchPage).toHaveBeenCalledOnce();
  });
  it("fences fallback across snapshot, gap, and marker crash windows", async () => {
    for (const mode of ["snapshot", "gap", "marker"] as const) {
      const store = new MemoryOddsControlPlaneStore();
      const fallback = vi.fn();
      const gap = {
        gapId: `gap-${mode}`,
        runId: "pending",
        leagueKey: "mlb",
        providerId: "sharpapi",
        policyVersion: "v1",
        bookRole: "offered" as const,
        sourceState: "missing" as const,
        reason: "missing" as const,
        observedAt: now.toISOString(),
      };
      if (mode === "gap")
        vi.spyOn(store, "putGap").mockImplementationOnce((value) => {
          store.gaps.set(value.gapId, structuredClone(value));
          return Promise.reject(new Error("gap-write-crash"));
        });
      let snapshotWritten = false;
      const result = await runOddsLeague({
        policy,
        store,
        providers: new Map([
          [
            "sharpapi",
            provider(
              "sharpapi",
              vi.fn().mockResolvedValue({
                items: mode === "gap" ? [] : [{}],
                gaps: mode === "gap" ? [gap] : [],
                quotaCost: 1,
                digest: mode,
              }),
            ),
          ],
          ["the-odds-api", provider("the-odds-api", fallback)],
        ]),
        committer: {
          commit: vi.fn(() => {
            if (mode === "snapshot") snapshotWritten = true;
            if (mode !== "gap")
              return Promise.reject(new Error(`${mode}-crash`));
            return Promise.resolve(false);
          }),
        },
        now,
      });
      expect(result.status).toBe("failed");
      expect(fallback).not.toHaveBeenCalled();
      expect(
        [...store.runs.values()].some((run) => run.evidenceCommitted),
      ).toBe(true);
      if (mode === "snapshot") expect(snapshotWritten).toBe(true);
      if (mode === "gap") expect(store.gaps.has(gap.gapId)).toBe(true);
    }
  });
  it("does not call a provider below reserve and durably records the skip", async () => {
    const store = new MemoryOddsControlPlaneStore();
    const metrics = { emit: vi.fn() };
    await store.putHealth({
      providerId: "sharpapi",
      healthy: true,
      consecutiveSuccesses: 4,
      quotaRemaining: 100,
      updatedAt: now.toISOString(),
    });
    await store.putHealth({
      providerId: "the-odds-api",
      healthy: true,
      consecutiveSuccesses: 4,
      quotaRemaining: 50,
      updatedAt: now.toISOString(),
    });
    const fetchPage = vi.fn();
    const result = await runOddsLeague({
      policy,
      store,
      providers: new Map([
        ["sharpapi", provider("sharpapi", fetchPage)],
        ["the-odds-api", provider("the-odds-api", fetchPage)],
      ]),
      committer: { commit: vi.fn() },
      now,
      metrics,
    });
    expect(result).toMatchObject({ status: "failed", reason: "quota-reserve" });
    expect(fetchPage).not.toHaveBeenCalled();
    expect(store.runs.size).toBe(0);
    expect(
      metrics.emit.mock.calls.filter(([name]) => name === "OddsPassAudit"),
    ).toEqual([
      [
        "OddsPassAudit",
        1,
        expect.objectContaining({
          status: "skipped",
          reason: "quota-reserve",
          provider: "sharpapi",
        }),
      ],
      [
        "OddsPassAudit",
        1,
        expect.objectContaining({
          status: "skipped",
          reason: "quota-reserve",
          provider: "the-odds-api",
        }),
      ],
    ]);
  });
  it("persists explicit gaps and never falls back after a primary page commits", async () => {
    const store = new MemoryOddsControlPlaneStore();
    const gap = {
      gapId: "gap-1",
      runId: "logical",
      leagueKey: "mlb",
      providerId: "sharpapi",
      policyVersion: "v1",
      bookRole: "offered" as const,
      sourceState: "missing" as const,
      reason: "missing" as const,
      observedAt: now.toISOString(),
    };
    const sharp = vi
      .fn()
      .mockResolvedValueOnce({
        items: [{ id: 1 }],
        gaps: [gap],
        quotaCost: 1,
        digest: "first",
        nextPageToken: "second",
      })
      .mockRejectedValueOnce(new Error("provider-unavailable"));
    const fallback = vi.fn();
    const result = await runOddsLeague({
      policy,
      store,
      providers: new Map([
        ["sharpapi", provider("sharpapi", sharp)],
        ["the-odds-api", provider("the-odds-api", fallback)],
      ]),
      committer: { commit: vi.fn() },
      now,
    });
    expect(result.status).toBe("failed");
    expect(store.gaps.get("gap-1")).toEqual(gap);
    expect(fallback).not.toHaveBeenCalled();
  });
  it("isolates league failures", async () => {
    const store = new MemoryOddsControlPlaneStore();
    const bad = { ...policy, leagueKey: "mls" as const };
    const results = await runDueOddsLeagues([
      {
        policy,
        store,
        providers: new Map(),
        committer: { commit: vi.fn() },
        now,
      },
      {
        policy: bad,
        store,
        providers: new Map([
          [
            "sharpapi",
            provider(
              "sharpapi",
              vi.fn().mockResolvedValue({
                items: [],
                gaps: [],
                quotaCost: 0,
                digest: "ok",
              }),
            ),
          ],
        ]),
        committer: { commit: vi.fn() },
        now,
      },
    ]);
    expect(results.map((r) => r.status)).toEqual(["failed", "completed"]);
  });
  it("does not suppress another league with provider health from a failed league", async () => {
    const store = new MemoryOddsControlPlaneStore();
    await store.putHealth({
      providerId: "sharpapi",
      healthKey: "sharpapi:mlb:odds",
      healthy: false,
      consecutiveSuccesses: 0,
      cooldownUntil: "2026-08-03T13:00:00.000Z",
      updatedAt: now.toISOString(),
    });
    const fetchPage = vi.fn().mockResolvedValue({
      items: [],
      gaps: [],
      quotaCost: 1,
      digest: "mls-ok",
    });
    const result = await runOddsLeague({
      policy: { ...policy, leagueKey: "mls" },
      store,
      providers: new Map([["sharpapi", provider("sharpapi", fetchPage)]]),
      committer: { commit: vi.fn() },
      now,
    });
    expect(result.status).toBe("completed");
    expect(fetchPage).toHaveBeenCalledOnce();
  });
  it("holds primary failback until the configured success threshold", async () => {
    const store = new MemoryOddsControlPlaneStore();
    await store.putHealth({
      providerId: "sharpapi",
      healthKey: "sharpapi:mlb:odds",
      healthy: false,
      consecutiveSuccesses: 1,
      cooldownUntil: "2026-08-03T11:59:00.000Z",
      updatedAt: now.toISOString(),
    });
    const sharp = vi.fn();
    const fallback = vi.fn().mockResolvedValue({
      items: [],
      gaps: [],
      quotaCost: 1,
      digest: "fallback",
    });
    const result = await runOddsLeague({
      policy,
      store,
      providers: new Map([
        ["sharpapi", provider("sharpapi", sharp)],
        ["the-odds-api", provider("the-odds-api", fallback)],
      ]),
      committer: { commit: vi.fn() },
      now,
    });
    expect(result.providerId).toBe("the-odds-api");
    expect(sharp).not.toHaveBeenCalled();
  });
  it("uses bounded recovery probes without serving primary evidence prematurely", async () => {
    const store = new MemoryOddsControlPlaneStore();
    const reserveQuotaAttempt = vi.spyOn(store, "reserveQuotaAttempt");
    const reconcileQuota = vi.spyOn(store, "reconcileQuota");
    await store.putHealth({
      providerId: "sharpapi",
      healthKey: "sharpapi:mlb:odds",
      healthy: false,
      consecutiveSuccesses: 0,
      cooldownUntil: "2026-08-03T11:59:00.000Z",
      updatedAt: now.toISOString(),
    });
    const sharpFetch = vi.fn();
    const probe = vi.fn().mockResolvedValue({
      quotaCost: 1,
      rateWindow: { limit: 60, remaining: 47 },
    });
    const fallback = vi.fn().mockResolvedValue({
      items: [],
      gaps: [],
      quotaCost: 1,
      digest: "fallback",
    });
    const result = await runOddsLeague({
      policy,
      store,
      providers: new Map([
        [
          "sharpapi",
          {
            providerId: "sharpapi",
            requestCost: 2,
            probeRequestCost: 1,
            probe,
            fetchPage: sharpFetch,
          },
        ],
        ["the-odds-api", provider("the-odds-api", fallback)],
      ]),
      committer: { commit: vi.fn() },
      now,
    });
    expect(result.providerId).toBe("the-odds-api");
    expect(probe).toHaveBeenCalledOnce();
    expect(reserveQuotaAttempt).toHaveBeenCalledWith(
      "sharpapi:mlb:odds",
      expect.any(Number),
      1,
      expect.objectContaining({ capability: "odds", pageToken: "probe" }),
    );
    expect(reconcileQuota).toHaveBeenCalledWith(
      "sharpapi:mlb:odds",
      1,
      1,
      undefined,
      now.toISOString(),
    );
    expect(sharpFetch).not.toHaveBeenCalled();
    expect(await store.getHealth("sharpapi:mlb:odds")).toMatchObject({
      healthy: false,
      consecutiveSuccesses: 1,
      rateWindow: { limit: 60, remaining: 47 },
    });
  });

  it("ignores stale legacy quota when an authoritative rate window exists", async () => {
    const store = new MemoryOddsControlPlaneStore();
    await store.putHealth({
      providerId: "sharpapi",
      healthKey: "sharpapi:mlb:odds",
      healthy: true,
      consecutiveSuccesses: 1,
      quotaRemaining: 0,
      rateWindow: { limit: 1_000, remaining: 900 },
      updatedAt: now.toISOString(),
    });
    const fetchPage = vi.fn().mockResolvedValue({
      items: [],
      gaps: [],
      quotaCost: 1,
      digest: "authoritative-window",
    });
    expect(
      await runOddsLeague({
        policy,
        store,
        providers: new Map([["sharpapi", provider("sharpapi", fetchPage)]]),
        committer: { commit: vi.fn().mockResolvedValue(false) },
        now,
      }),
    ).toMatchObject({ status: "completed", providerId: "sharpapi" });
    expect(fetchPage).toHaveBeenCalledOnce();
  });
  it("leases recovery probes so concurrent unhealthy ticks spend once", async () => {
    const store = new MemoryOddsControlPlaneStore();
    await store.putHealth({
      providerId: "sharpapi",
      healthKey: "sharpapi:mlb:odds",
      healthy: false,
      consecutiveSuccesses: 0,
      cooldownUntil: "2026-08-03T11:59:00.000Z",
      updatedAt: now.toISOString(),
    });
    let releaseProbe!: () => void;
    const probeGate = new Promise<void>((resolve) => {
      releaseProbe = resolve;
    });
    const probe = vi.fn(() => probeGate.then(() => ({ quotaCost: 1 })));
    const configured: ControlPlaneProvider = {
      providerId: "sharpapi",
      requestCost: 1,
      probe,
      fetchPage: vi.fn(),
    };
    const input = {
      policy,
      store,
      providers: new Map([["sharpapi", configured]]),
      committer: { commit: vi.fn() },
      now,
    };
    const first = runOddsLeague(input);
    await vi.waitFor(() => expect(probe).toHaveBeenCalledOnce());
    const second = runOddsLeague(input);
    await Promise.resolve();
    expect(probe).toHaveBeenCalledOnce();
    releaseProbe();
    await Promise.all([first, second]);
    expect(probe).toHaveBeenCalledOnce();
  });
  it("allows fallback after sealed no-evidence pages but blocks ambiguous commits", async () => {
    const store = new MemoryOddsControlPlaneStore();
    const primary = vi
      .fn()
      .mockResolvedValueOnce({
        items: [],
        gaps: [],
        nextPageToken: "two",
        quotaCost: 1,
        digest: "empty",
      })
      .mockRejectedValueOnce(new Error("provider-unavailable"));
    const fallback = vi.fn().mockResolvedValue({
      items: [],
      gaps: [],
      quotaCost: 1,
      digest: "fallback",
    });
    const result = await runOddsLeague({
      policy,
      store,
      providers: new Map([
        ["sharpapi", provider("sharpapi", primary)],
        ["the-odds-api", provider("the-odds-api", fallback)],
      ]),
      committer: {
        commit: vi.fn(({ providerId }) =>
          Promise.resolve(providerId !== "sharpapi"),
        ),
      },
      now,
    });
    expect(result.providerId).toBe("the-odds-api");
    expect(fallback).toHaveBeenCalledOnce();

    const ambiguousStore = new MemoryOddsControlPlaneStore();
    const ambiguousFallback = vi.fn();
    const ambiguous = await runOddsLeague({
      policy,
      store: ambiguousStore,
      providers: new Map([
        [
          "sharpapi",
          provider(
            "sharpapi",
            vi.fn().mockResolvedValue({
              items: [{}],
              gaps: [],
              quotaCost: 1,
              digest: "one",
            }),
          ),
        ],
        ["the-odds-api", provider("the-odds-api", ambiguousFallback)],
      ]),
      committer: {
        commit: vi.fn().mockRejectedValue(new Error("commit-crash")),
      },
      now,
    });
    expect(ambiguous.status).toBe("failed");
    expect(ambiguousFallback).not.toHaveBeenCalled();
  });
  it("reconstructs seen event ids across sealed pages before missing reconciliation", async () => {
    const store = new MemoryOddsControlPlaneStore();
    const fetchPage = vi
      .fn()
      .mockResolvedValueOnce({
        items: [],
        gaps: [],
        seenProviderEventIds: ["event-a"],
        nextPageToken: "two",
        quotaCost: 1,
        digest: "one",
      })
      .mockRejectedValueOnce(new Error("provider-unavailable"))
      .mockResolvedValueOnce({
        items: [],
        gaps: [],
        seenProviderEventIds: ["event-b"],
        quotaCost: 1,
        digest: "two",
      });
    let reconciledIds: string[] = [];
    const reconcileMissing = vi.fn(
      (input: { readonly seenProviderEventIds: ReadonlySet<string> }) => {
        reconciledIds = [...input.seenProviderEventIds].sort();
        return Promise.resolve([]);
      },
    );
    const configured = {
      providerId: "sharpapi" as const,
      fetchPage,
      reconcileMissing,
    };
    const input = {
      policy,
      store,
      providers: new Map([["sharpapi", configured]]),
      committer: { commit: vi.fn().mockResolvedValue(false) },
      now,
    };
    expect((await runOddsLeague(input)).status).toBe("failed");
    expect([...store.pages.values()][0]?.seenProviderEventIds).toEqual([
      "event-a",
    ]);
    expect(await store.getContinuation("mlb")).not.toBeNull();
    const recoveredHealth = {
      ...(await store.getHealth("sharpapi:mlb:odds"))!,
    };
    delete recoveredHealth.cooldownUntil;
    await store.putHealth({
      ...recoveredHealth,
      providerId: "sharpapi",
      healthKey: "sharpapi:mlb:odds",
      healthy: true,
      consecutiveSuccesses: 2,
      updatedAt: "2026-08-03T12:05:00.000Z",
    });
    expect(
      await runOddsLeague({
        ...input,
        now: new Date("2026-08-03T12:05:00.000Z"),
      }),
    ).toMatchObject({ status: "completed" });
    expect(reconcileMissing).toHaveBeenCalledOnce();
    expect(reconciledIds).toEqual(["event-a", "event-b"]);
  });
  it("heartbeats a live owner clock across a long paginated run", async () => {
    const store = new MemoryOddsControlPlaneStore();
    let liveNow = new Date(now);
    const fetchPage = vi.fn(({ pageToken }: { pageToken: string }) => {
      liveNow = new Date(liveNow.getTime() + 4 * 60_000);
      return Promise.resolve({
        items: [],
        gaps: [],
        ...(pageToken === "start" ? { nextPageToken: "two" } : {}),
        quotaCost: 1,
        digest: pageToken,
      });
    });
    const result = await runOddsLeague({
      policy,
      store,
      providers: new Map([["sharpapi", provider("sharpapi", fetchPage)]]),
      committer: { commit: vi.fn().mockResolvedValue(false) },
      now,
      clock: () => liveNow,
    });
    expect(result).toMatchObject({ status: "completed", pages: 2 });
    expect(fetchPage).toHaveBeenCalledTimes(2);
  });

  it("bounds a fresh 100-page pass to exactly two RUN accesses", async () => {
    const store = new CountingOddsControlPlaneStore();
    const commit = vi.fn().mockResolvedValue(true);
    const fetchPage = vi.fn(({ pageToken }: { pageToken: string }) => {
      const pageIndex = pageToken === "start" ? 0 : Number(pageToken.slice(5));
      return Promise.resolve({
        items: [{ pageIndex }],
        gaps: [],
        ...(pageIndex < 99 ? { nextPageToken: `page-${pageIndex + 1}` } : {}),
        quotaCost: 1,
        digest: `digest-${pageIndex}`,
      });
    });

    const result = await runOddsLeague({
      policy,
      store,
      providers: new Map([["sharpapi", provider("sharpapi", fetchPage)]]),
      committer: { commit },
      now,
    });

    expect(result).toMatchObject({ status: "completed", pages: 100 });
    expect(fetchPage).toHaveBeenCalledTimes(100);
    expect(commit).toHaveBeenCalledTimes(100);
    expect(store.runAccesses).toBe(2);
  });

  it("bounds a resumed pass to three RUN accesses", async () => {
    const store = new CountingOddsControlPlaneStore();
    const runId = `mlb:sharpapi:${now.toISOString()}`;
    await store.transitionRun(null, {
      runId,
      leagueKey: policy.leagueKey,
      providerId: "sharpapi",
      policyVersion: oddsCollectionPolicyVersion,
      status: "running",
      startedAt: now.toISOString(),
      updatedAt: now.toISOString(),
      evidenceCommitted: false,
      quotaCost: 0,
    });
    await store.claimContinuation({
      leagueKey: policy.leagueKey,
      runId,
      providerId: "sharpapi",
      updatedAt: now.toISOString(),
      startedAt: now.toISOString(),
      capability: "odds",
      evidenceCommitted: false,
      quotaCost: 0,
    });
    store.runAccesses = 0;

    const result = await runOddsLeague({
      policy,
      store,
      providers: new Map([
        [
          "sharpapi",
          provider(
            "sharpapi",
            vi.fn().mockResolvedValue({
              items: [],
              gaps: [],
              quotaCost: 1,
              digest: "resumed",
            }),
          ),
        ],
      ]),
      committer: { commit: vi.fn().mockResolvedValue(false) },
      now,
    });

    expect(result).toMatchObject({ status: "completed", pages: 1 });
    expect(store.runAccesses).toBe(3);
  });

  it("reconciles reserved quota to provider authoritative usage", async () => {
    const store = new MemoryOddsControlPlaneStore();
    await store.putHealth({
      providerId: "sharpapi",
      healthKey: "sharpapi:mlb:odds",
      healthy: true,
      consecutiveSuccesses: 1,
      quotaRemaining: 1000,
      updatedAt: now.toISOString(),
    });
    const configured: ControlPlaneProvider = {
      providerId: "sharpapi",
      requestCost: 3,
      fetchPage: vi.fn().mockResolvedValue({
        items: [],
        gaps: [],
        quotaCost: 1,
        quotaRemaining: 900,
        digest: "quota",
      }),
    };
    const lowerCost = await runOddsLeague({
      policy,
      store,
      providers: new Map([["sharpapi", configured]]),
      committer: { commit: vi.fn().mockResolvedValue(false) },
      now,
    });
    expect(lowerCost).toMatchObject({ status: "completed", quotaCost: 1 });
    expect((await store.getHealth("sharpapi:mlb:odds"))?.quotaRemaining).toBe(
      900,
    );
    const higherStore = new MemoryOddsControlPlaneStore();
    await higherStore.putHealth({
      providerId: "sharpapi",
      healthKey: "sharpapi:mlb:odds",
      healthy: true,
      consecutiveSuccesses: 1,
      quotaRemaining: 1000,
      updatedAt: now.toISOString(),
    });
    const higher = await runOddsLeague({
      policy,
      store: higherStore,
      providers: new Map([
        [
          "sharpapi",
          {
            providerId: "sharpapi",
            requestCost: 1,
            fetchPage: vi.fn().mockResolvedValue({
              items: [],
              gaps: [],
              quotaCost: 4,
              digest: "higher",
            }),
          } satisfies ControlPlaneProvider,
        ],
      ]),
      committer: { commit: vi.fn().mockResolvedValue(false) },
      now,
    });
    expect(higher).toMatchObject({ status: "completed", quotaCost: 4 });
    expect(
      (await higherStore.getHealth("sharpapi:mlb:odds"))?.quotaRemaining,
    ).toBe(996);
  });
  it("chooses one configured consensus source for a shared book", () => {
    const common = {
      sportsbookId: "draftkings",
      marketKey: "moneyline",
      selectionKey: "home",
    };
    expect(
      deduplicateProviderBookEvidence(
        [
          { ...common, providerId: "the-odds-api", price: -105 },
          { ...common, providerId: "sharpapi", price: -110 },
        ],
        ["sharpapi", "the-odds-api"],
      ),
    ).toEqual([{ ...common, providerId: "sharpapi", price: -110 }]);
  });
});
