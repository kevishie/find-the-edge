import {
  MemoryScoutingJobRepository,
  MemoryScoutingReportRepository,
  ScoutingReportRepositoryError,
  type ScoutingJobRepository,
} from "@find-the-edge/database";
import {
  createScoutingReportId,
  type ScoutingJobCommand,
} from "@find-the-edge/domain";
import type {
  AnalysisPolicyLike,
  ScoutingReportProvenanceSource,
} from "@find-the-edge/scouting";
import { describe, expect, it, vi } from "vitest";

import {
  createScoutingWorkflow,
  ScoutingFixtureFailure,
  type ScoutingAnalysisMaterial,
  type ScoutingFixtureWorkflow,
  type ScoutingWorkflowReportStore,
} from "./scouting-workflow";

const T0 = "2026-08-07T12:00:00.000Z";
const T1 = "2026-08-07T12:01:00.000Z";
const T2 = "2026-08-07T12:02:00.000Z";
const T3 = "2026-08-07T12:03:00.000Z";

const requesterId = "requester-1";
const eventId = "event-1";

/** Verbatim FTE-041 fixture policy so revalidation runs the real contract. */
const fixturePolicy: AnalysisPolicyLike = {
  enabled: true,
  sportKey: "mlb",
  leagueKeys: ["mlb"],
  markets: [
    {
      marketKey: "moneyline",
      outcomeStructure: "two-way",
      selectionKinds: ["participant"],
      requiresPoint: false,
      legacyMarketAliases: [],
    },
  ],
  evidenceRequirements: [
    { category: "form", level: "hard", maximumAgeMinutes: 60 },
    {
      category: "lineup",
      level: "conditional",
      enforceWithinMinutes: 60,
      maximumAgeMinutes: 60,
    },
    { category: "weather", level: "optional", maximumAgeMinutes: 120 },
  ],
  probability: {
    minimum: 0.05,
    maximum: 0.95,
    maximumRangeWidth: 0.2,
    maximumUncertainty: 0.2,
  },
  contraindications: [],
  prohibitedClaims: ["lock", "guarantee", "risk-free"],
  versions: {
    contractVersion: "fixture@1",
    promptBundleId: "analysis",
    promptBundleVersion: "1",
    promptSections: {
      shared: { id: "safety", version: "1" },
      sport: { id: "sport", version: "2" },
      strategy: { id: "strategy", version: "1" },
      analysis: { id: "analysis", version: "1" },
    },
    inputSchemaId: "input/fixture",
    inputSchemaVersion: "1",
    outputSchemaId: "output/fixture",
    outputSchemaVersion: "1",
    modelId: "model-1",
    modelVersion: "model-1",
  },
};

const completeRequest = {
  sportKey: "mlb",
  leagueKey: "mlb",
  eventId: "event-1",
  participantIds: ["away", "home"],
  startsAt: "2026-08-08T00:00:00.000Z",
  asOf: "2026-08-07T11:00:00.000Z",
  candidate: {
    marketKey: "moneyline",
    outcomeStructure: "two-way",
    selection: { kind: "participant", participantId: "home" },
  },
  evidence: [
    {
      id: "form-1",
      category: "form",
      status: "verified",
      observedAt: "2026-08-07T10:55:00.000Z",
      facts: { description: "Home form is above baseline", rating: 0.62 },
    },
    {
      id: "lineup-1",
      category: "lineup",
      status: "verified",
      observedAt: "2026-08-07T10:56:00.000Z",
      facts: { confirmed: true },
    },
  ],
} as const;

const completeOutput = {
  candidate: completeRequest.candidate,
  versions: fixturePolicy.versions,
  probability: { estimate: 0.57, low: 0.51, high: 0.63, uncertainty: 0.06 },
  status: "complete",
  abstentionCodes: [],
  summary: "Home form is above baseline.",
  assertions: [
    {
      text: "Home form is above baseline.",
      classification: "factual",
      citationIds: ["form-1"],
    },
  ],
} as const;

const provenanceSource: ScoutingReportProvenanceSource = {
  providerObservations: [
    {
      providerId: "sharpapi",
      observationId: "form-1",
      observedAt: "2026-08-07T10:55:00.000Z",
    },
  ],
  evidenceReferences: [
    {
      sourceId: "sharpapi",
      observedAt: "2026-08-07T10:55:00.000Z",
      retrievedAt: "2026-08-07T10:56:00.000Z",
      verification: "verified",
    },
  ],
  calculationVersions: [{ id: "no-vig-fair-line", version: "1" }],
  referenceHashes: ["ab".repeat(32)],
  oddsSnapshotIds: ["snap-1"],
};

const analysisMaterial: ScoutingAnalysisMaterial = {
  request: completeRequest,
  output: completeOutput,
  policy: fixturePolicy,
  provenanceSource,
};

const analysisFixture: ScoutingFixtureWorkflow = {
  run: () => Promise.resolve(analysisMaterial),
};

const command = (
  idempotencyKey: string,
  eventVersion: number,
): ScoutingJobCommand => ({
  schemaVersion: 1,
  requesterId,
  idempotencyKey,
  eventId,
  eventVersion,
  workflowIntent: "fixture-v1",
});

/**
 * Composes the memory job repository with the memory report repository the
 * way DynamoDB shares one table: a successful claim seeds the report
 * repository's job, attempt, and active-lock state.
 */
const createHarness = () => {
  const jobs = new MemoryScoutingJobRepository();
  const reports = new MemoryScoutingReportRepository();
  const composed: Pick<
    ScoutingJobRepository,
    "claimAttempt" | "finishAttempt"
  > = {
    claimAttempt: async (input) => {
      const claim = await jobs.claimAttempt(input);
      if (claim.outcome === "claimed") {
        reports.seedJob(claim.job);
        reports.seedAttempt(claim.attempt);
        reports.setActiveLock(
          claim.job.semanticDigest,
          claim.job.jobId,
          claim.attempt.attemptId,
        );
      }
      return claim;
    },
    finishAttempt: (input) => jobs.finishAttempt(input),
  };
  return { jobs, reports, composed };
};

const unusedReports: ScoutingWorkflowReportStore = {
  getHead: () => Promise.reject(new Error("unexpected-report-read")),
  getVersion: () => Promise.reject(new Error("unexpected-report-read")),
  completeWithReport: () => Promise.reject(new Error("unexpected-completion")),
};

describe("scouting workflow report completion", () => {
  it("persists a validated report end to end and completes atomically (cross-package conformance)", async () => {
    const { jobs, reports, composed } = createHarness();
    const records = await jobs.createJob({
      command: command("request-1", 3),
      createdAt: T0,
    });
    const run = createScoutingWorkflow(
      composed,
      reports,
      analysisFixture,
      () => T1,
    );

    const result = await run(records.outbox.command);
    const reportId = createScoutingReportId(requesterId, eventId);
    expect(result.outcome).toBe("completed");
    if (result.outcome !== "completed")
      throw new Error("expected a completed workflow result");
    expect(result.report).toMatchObject({
      reportId,
      reportVersionNumber: 1,
      persistence: "completed",
    });
    expect(result.report.reportVersionId).toMatch(
      /^scout-report-version:[a-f0-9]{64}$/,
    );

    const stored = await reports.getByJobBinding(
      records.job.jobId,
      requesterId,
    );
    expect(stored).not.toBeNull();
    expect(stored).toMatchObject({
      versionNumber: 1,
      jobId: records.job.jobId,
      attemptId: records.attempt.attemptId,
      eventId,
      eventVersion: 3,
      generatedAt: T1,
      predecessor: null,
    });
    expect(stored?.payload.summary).toBe(completeOutput.summary);
    expect(stored?.provenance.citedSourceObservations).toEqual([
      {
        observationId: "form-1",
        category: "form",
        status: "verified",
        observedAt: "2026-08-07T10:55:00.000Z",
      },
    ]);
    await expect(reports.getHead(reportId, requesterId)).resolves.toMatchObject(
      { latestVersionNumber: 1, stateVersion: 1 },
    );
    // Owner scoping: a foreign requester sees neutral missing results.
    await expect(
      reports.getByJobBinding(records.job.jobId, "someone-else"),
    ).resolves.toBeNull();
    // The lifecycle completed atomically with the report pointer.
    const jobRead = reports.readJob(records.job.jobId);
    expect(jobRead?.kind).toBe("current");
    expect(jobRead?.job).toMatchObject({
      status: "completed",
      reportPointer: {
        reportId,
        reportVersionNumber: 1,
      },
    });
    expect(reports.hasActiveLock(records.job.semanticDigest)).toBe(false);
  });

  it("assembles the successor against the current head and fences the predecessor", async () => {
    const { jobs, reports, composed } = createHarness();
    const first = await jobs.createJob({
      command: command("request-1", 3),
      createdAt: T0,
    });
    await createScoutingWorkflow(
      composed,
      reports,
      analysisFixture,
      () => T1,
    )(first.outbox.command);

    const second = await jobs.createJob({
      command: command("request-2", 4),
      createdAt: T2,
    });
    const result = await createScoutingWorkflow(
      composed,
      reports,
      analysisFixture,
      () => T3,
    )(second.outbox.command);

    expect(result).toMatchObject({
      outcome: "completed",
      report: { reportVersionNumber: 2, persistence: "completed" },
    });
    const reportId = createScoutingReportId(requesterId, eventId);
    const versions = await reports.listVersions(reportId, requesterId);
    expect(versions.map((version) => version.versionNumber)).toEqual([1, 2]);
    const [one, two] = versions;
    expect(two?.predecessor).toMatchObject({
      reportVersionId: one?.reportVersionId,
      versionNumber: 1,
      draftHash: one?.draftHash,
    });
    await expect(reports.getHead(reportId, requesterId)).resolves.toMatchObject(
      { latestVersionNumber: 2, latestVersionId: two?.reportVersionId },
    );
  });

  it("bounds the trusted generatedAt by attempt chronology", async () => {
    const { jobs, reports, composed } = createHarness();
    const records = await jobs.createJob({
      command: command("request-1", 3),
      createdAt: T0,
    });
    // Claim happens at T1; the report clock then reads an earlier T0 and must
    // be clamped forward to the attempt start (and completion to generation).
    const times = [T1, T0, T0];
    const run = createScoutingWorkflow(
      composed,
      reports,
      analysisFixture,
      () => times.shift() ?? T0,
    );

    await expect(run(records.outbox.command)).resolves.toMatchObject({
      outcome: "completed",
    });
    const stored = await reports.getByJobBinding(
      records.job.jobId,
      requesterId,
    );
    expect(stored?.generatedAt).toBe(T1);
  });

  it("resolves an idempotent replay outcome without touching the lifecycle again", async () => {
    const { jobs, reports, composed } = createHarness();
    const first = await jobs.createJob({
      command: command("request-1", 3),
      createdAt: T0,
    });
    await createScoutingWorkflow(
      composed,
      reports,
      analysisFixture,
      () => T1,
    )(first.outbox.command);
    const reportId = createScoutingReportId(requesterId, eventId);
    const version = await reports.getVersion(reportId, 1, requesterId);
    const head = await reports.getHead(reportId, requesterId);
    if (!version || !head) throw new Error("expected stored version and head");

    const second = await jobs.createJob({
      command: command("request-2", 4),
      createdAt: T2,
    });
    const finishAttempt = vi.spyOn(jobs, "finishAttempt");
    const emit = vi.fn();
    const replayStore: ScoutingWorkflowReportStore = {
      getHead: () => Promise.resolve(null),
      getVersion: () => Promise.resolve(null),
      completeWithReport: () =>
        Promise.resolve({ outcome: "replayed", version, head }),
    };

    await expect(
      createScoutingWorkflow(composed, replayStore, analysisFixture, () => T3, {
        emit,
      })(second.outbox.command),
    ).resolves.toEqual({
      outcome: "completed",
      report: {
        reportId,
        reportVersionId: version.reportVersionId,
        reportVersionNumber: 1,
        persistence: "replayed",
      },
    });
    expect(emit).toHaveBeenLastCalledWith("AttemptReplayResolved");
    expect(finishAttempt).not.toHaveBeenCalled();
  });

  it.each([
    [
      "report-head-cas-conflict",
      "failed_retryable",
      "workflow-temporarily-unavailable",
    ],
    [
      "report-event-version-changed",
      "failed_terminal",
      "event-version-changed",
    ],
    [
      "report-validation-invalid",
      "failed_terminal",
      "workflow-terminal-failure",
    ],
    ["report-replay-conflict", "failed_terminal", "workflow-terminal-failure"],
    ["report-stale-attempt", "failed_terminal", "workflow-terminal-failure"],
    ["report-storage-corrupt", "failed_terminal", "workflow-terminal-failure"],
  ] as const)(
    "maps a %s completion failure to %s/%s without claiming completion",
    async (code, outcome, failureCode) => {
      const { jobs, composed } = createHarness();
      const records = await jobs.createJob({
        command: command("request-1", 3),
        createdAt: T0,
      });
      const failingStore: ScoutingWorkflowReportStore = {
        getHead: () => Promise.resolve(null),
        getVersion: () => Promise.resolve(null),
        completeWithReport: () =>
          Promise.reject(new ScoutingReportRepositoryError(code)),
      };

      await expect(
        createScoutingWorkflow(
          composed,
          failingStore,
          analysisFixture,
          () => T1,
        )(records.outbox.command),
      ).resolves.toEqual({ outcome, failureCode });
      await expect(jobs.getJob(records.job.jobId)).resolves.toMatchObject({
        status: outcome,
        failureCode,
      });
    },
  );

  it("classifies a transient report read failure as retryable", async () => {
    const { jobs, composed } = createHarness();
    const records = await jobs.createJob({
      command: command("request-1", 3),
      createdAt: T0,
    });
    const store: ScoutingWorkflowReportStore = {
      getHead: () => Promise.reject(new Error("dynamo-unavailable")),
      getVersion: () => Promise.reject(new Error("dynamo-unavailable")),
      completeWithReport: () =>
        Promise.reject(new Error("unexpected-completion")),
    };

    await expect(
      createScoutingWorkflow(
        composed,
        store,
        analysisFixture,
        () => T1,
      )(records.outbox.command),
    ).resolves.toEqual({
      outcome: "failed_retryable",
      failureCode: "workflow-temporarily-unavailable",
    });
    await expect(jobs.getJob(records.job.jobId)).resolves.toMatchObject({
      status: "failed_retryable",
    });
  });

  it("rethrows an ambiguous completion transport failure without marking any outcome", async () => {
    const { jobs, composed } = createHarness();
    const records = await jobs.createJob({
      command: command("request-1", 3),
      createdAt: T0,
    });
    const transportError = new Error("socket hang up");
    const store: ScoutingWorkflowReportStore = {
      getHead: () => Promise.resolve(null),
      getVersion: () => Promise.resolve(null),
      completeWithReport: () => Promise.reject(transportError),
    };

    await expect(
      createScoutingWorkflow(
        composed,
        store,
        analysisFixture,
        () => T1,
      )(records.outbox.command),
    ).rejects.toBe(transportError);
    // The transaction may have committed: the attempt stays leased so replay
    // can resolve through the binding — never a claimed completion/failure.
    await expect(jobs.getJob(records.job.jobId)).resolves.toMatchObject({
      status: "in_progress",
    });
  });

  it("fails honestly when the default fixture produces no analysis material", async () => {
    const { jobs, reports, composed } = createHarness();
    const records = await jobs.createJob({
      command: command("request-1", 3),
      createdAt: T0,
    });
    const run = createScoutingWorkflow(composed, reports, undefined, () => T1);

    await expect(run(records.outbox.command)).resolves.toEqual({
      outcome: "failed_terminal",
      failureCode: "fixture-contract-invalid",
    });
    await expect(jobs.getJob(records.job.jobId)).resolves.toMatchObject({
      status: "failed_terminal",
      failureCode: "fixture-contract-invalid",
    });
    await expect(
      reports.getByJobBinding(records.job.jobId, requesterId),
    ).resolves.toBeNull();
  });
});

describe("scouting workflow orchestration", () => {
  it("acknowledges stale attempts without running the fixture", async () => {
    const { jobs, reports, composed } = createHarness();
    const records = await jobs.createJob({
      command: command("request-1", 3),
      createdAt: T0,
    });
    await jobs.claimAttempt({
      ...records.outbox.command,
      claimedAt: T1,
    });
    await jobs.finishAttempt({
      jobId: records.job.jobId,
      attemptId: records.attempt.attemptId,
      status: "failed_terminal",
      failureCode: "workflow-terminal-failure",
      finishedAt: T2,
    });
    const fixture = { run: vi.fn(() => Promise.resolve(analysisMaterial)) };

    await expect(
      createScoutingWorkflow(
        composed,
        reports,
        fixture,
      )(records.outbox.command),
    ).resolves.toEqual({ outcome: "stale" });
    expect(fixture.run).not.toHaveBeenCalled();
  });

  it("fails an ambiguous duplicate claim so the state machine finalizer runs", async () => {
    const { jobs, reports, composed } = createHarness();
    const records = await jobs.createJob({
      command: command("request-1", 3),
      createdAt: T0,
    });
    await jobs.claimAttempt({
      jobId: records.job.jobId,
      attemptId: records.attempt.attemptId,
      eventId: records.job.eventId,
      eventVersion: records.job.eventVersion,
      claimedAt: T1,
    });
    const fixture = { run: vi.fn(() => Promise.resolve(analysisMaterial)) };

    await expect(
      createScoutingWorkflow(
        composed,
        reports,
        fixture,
      )(records.outbox.command),
    ).rejects.toMatchObject({
      name: "ScoutingWorkflowAmbiguousClaimError",
      message: "scouting-workflow-claim-ambiguous",
    });
    expect(fixture.run).not.toHaveBeenCalled();
    await expect(jobs.getJob(records.job.jobId)).resolves.toMatchObject({
      status: "in_progress",
    });
  });

  it("terminalizes a queued attempt when its exact event fence is no longer valid", async () => {
    let eventVersion = 3;
    const jobs = new MemoryScoutingJobRepository({
      verifyScheduled: (_eventId, expectedVersion) =>
        Promise.resolve(expectedVersion === eventVersion),
    });
    const records = await jobs.createJob({
      command: command("request-1", 3),
      createdAt: T0,
    });
    eventVersion += 1;
    const fixture = { run: vi.fn(() => Promise.resolve(analysisMaterial)) };

    await expect(
      createScoutingWorkflow(
        jobs,
        unusedReports,
        fixture,
        () => T1,
      )(records.outbox.command),
    ).resolves.toEqual({
      outcome: "failed_terminal",
      failureCode: "event-version-changed",
    });
    expect(fixture.run).not.toHaveBeenCalled();
    await expect(jobs.getJob(records.job.jobId)).resolves.toMatchObject({
      status: "failed_terminal",
      failureCode: "event-version-changed",
    });
  });

  it("emits bounded lifecycle metrics without using job identities as dimensions", async () => {
    const { jobs, reports, composed } = createHarness();
    const records = await jobs.createJob({
      command: command("request-1", 3),
      createdAt: T0,
    });
    const emit = vi.fn();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      await createScoutingWorkflow(
        composed,
        reports,
        analysisFixture,
        () => T1,
        { emit },
      )(records.outbox.command);
      expect(emit).toHaveBeenNthCalledWith(1, "AttemptClaimed");
      expect(emit).toHaveBeenNthCalledWith(2, "AttemptCompleted");
      expect(emit).toHaveBeenCalledTimes(2);
      const rendered = log.mock.calls.join("\n");
      expect(rendered).toContain('"event":"ScoutingWorkflowLifecycle"');
      expect(rendered).toContain('"reportVersionNumber":1');
      // Metadata-only signals: no requester identity, no payload contents.
      expect(rendered).not.toContain(requesterId);
      expect(rendered).not.toContain(completeOutput.summary);
    } finally {
      log.mockRestore();
    }
  });

  it.each([
    ["fixture-transient-failure", "failed_retryable"],
    ["fixture-contract-invalid", "failed_terminal"],
  ] as const)("persists the safe %s classification", async (code, status) => {
    const { jobs, reports, composed } = createHarness();
    const records = await jobs.createJob({
      command: command("request-1", 3),
      createdAt: T0,
    });
    const run = createScoutingWorkflow(
      composed,
      reports,
      { run: () => Promise.reject(new ScoutingFixtureFailure(code)) },
      () => T1,
    );

    await expect(run(records.outbox.command)).resolves.toEqual({
      outcome: status,
      failureCode: code,
    });
    await expect(
      jobs.getAttempt(records.attempt.attemptId),
    ).resolves.toMatchObject({
      status,
      failureCode: code,
    });
  });

  it("redacts an unrecognized fixture exception into a safe terminal code", async () => {
    const { jobs, reports, composed } = createHarness();
    const records = await jobs.createJob({
      command: command("request-1", 3),
      createdAt: T0,
    });
    const run = createScoutingWorkflow(
      composed,
      reports,
      { run: () => Promise.reject(new Error("provider-secret")) },
      () => T1,
    );

    await expect(run(records.outbox.command)).resolves.toEqual({
      outcome: "failed_terminal",
      failureCode: "workflow-terminal-failure",
    });
  });

  it("does not misclassify repository failures as fixture failures", async () => {
    const { jobs } = createHarness();
    const records = await jobs.createJob({
      command: command("request-1", 3),
      createdAt: T0,
    });
    const persistenceError = new Error("database-unavailable");
    const claimAttempt = vi.fn(() => Promise.reject(persistenceError));
    const run = createScoutingWorkflow(
      {
        claimAttempt,
        finishAttempt: jobs.finishAttempt.bind(jobs),
      },
      unusedReports,
    );

    await expect(run(records.outbox.command)).rejects.toBe(persistenceError);
  });

  it("propagates terminal persistence failures instead of rewriting them", async () => {
    const { jobs } = createHarness();
    const records = await jobs.createJob({
      command: command("request-1", 3),
      createdAt: T0,
    });
    const persistenceError = new Error("database-unavailable");
    const finishAttempt = vi.fn(() => Promise.reject(persistenceError));
    const run = createScoutingWorkflow(
      {
        claimAttempt: vi.fn(() =>
          Promise.resolve({
            outcome: "claimed" as const,
            job: records.job,
            attempt: records.attempt,
          }),
        ),
        finishAttempt,
      },
      unusedReports,
      {
        run: () =>
          Promise.reject(
            new ScoutingFixtureFailure("fixture-contract-invalid"),
          ),
      },
    );

    await expect(run(records.outbox.command)).rejects.toBe(persistenceError);
    expect(finishAttempt).toHaveBeenCalledOnce();
  });
});
