import {
  ScoutingReportRepositoryError,
  type ScoutingJobRepository,
  type ScoutingReportRepository,
  type StoredScoutingAttempt,
  type StoredScoutingJob,
} from "@find-the-edge/database";
import {
  createScoutingReportId,
  isRetryableScoutingFailure,
  isRetryableScoutingReportFailure,
  validateScoutingDispatchCommand,
  type ScoutingDispatchCommand,
  type ScoutingFailureCode,
  type ScoutingReportFailureCode,
} from "@find-the-edge/domain";
import {
  ScoutingReportPersistenceError,
  assembleFirstScoutingReportVersion,
  assembleSuccessorScoutingReportVersion,
  projectValidatedReport,
  type AnalysisPolicyLike,
  type AnalysisStrategyLike,
  type ScoutingReportCompletionContext,
  type ScoutingReportCompletionMaterial,
  type ScoutingReportProjection,
  type ScoutingReportProvenanceSource,
} from "@find-the-edge/scouting";

/**
 * FTE-042 stage 4: the workflow persists a validated report or fails
 * honestly. A successful run projects the raw FTE-041 analysis material into
 * the canonical persistence projection, assembles the first or successor
 * version against the current head, and commits everything through the report
 * repository's single atomic transaction — there is no other way to reach a
 * completed job or attempt.
 */

/**
 * Raw FTE-041 analysis material plus the FTE-040 provenance source gathered
 * by the worker from the scouting input. Everything is revalidated from
 * scratch by the persistence projection before anything is stored.
 */
export interface ScoutingAnalysisMaterial {
  readonly request: unknown;
  readonly output: unknown;
  readonly policy: AnalysisPolicyLike;
  readonly strategy?: AnalysisStrategyLike;
  readonly provenanceSource: ScoutingReportProvenanceSource;
}

export interface ScoutingFixtureWorkflow {
  run(command: ScoutingDispatchCommand): Promise<ScoutingAnalysisMaterial>;
}

/** The report persistence surface the workflow composes. */
export type ScoutingWorkflowReportStore = Pick<
  ScoutingReportRepository,
  "completeWithReport" | "getHead" | "getVersion"
>;

export type ScoutingWorkflowMetricName =
  | "AttemptClaimed"
  | "AttemptDuplicate"
  | "AttemptStale"
  | "AttemptEventInvalid"
  | "AttemptCompleted"
  | "AttemptReplayResolved"
  | "AttemptFailedRetryable"
  | "AttemptFailedTerminal";

export interface ScoutingWorkflowMetricSink {
  emit(name: ScoutingWorkflowMetricName): void;
}

/** Metadata-only operational signal: identities and outcome, never payload. */
export interface ScoutingWorkflowReportSignal {
  readonly reportId: string;
  readonly reportVersionId: string;
  readonly reportVersionNumber: number;
  readonly persistence: "completed" | "replayed";
}

export type ScoutingWorkflowResult =
  | {
      readonly outcome: "completed";
      readonly report: ScoutingWorkflowReportSignal;
    }
  | {
      readonly outcome: "failed_retryable" | "failed_terminal";
      readonly failureCode: ScoutingFailureCode;
    }
  | { readonly outcome: "stale" };

export class ScoutingFixtureFailure extends Error {
  override readonly name = "ScoutingFixtureFailure";
  constructor(readonly code: ScoutingFailureCode) {
    super(code);
  }
}

export class ScoutingWorkflowAmbiguousClaimError extends Error {
  override readonly name = "ScoutingWorkflowAmbiguousClaimError";
  constructor() {
    super("scouting-workflow-claim-ambiguous");
  }
}

export const scoutingWorkflowMetrics: ScoutingWorkflowMetricSink = {
  emit(name) {
    console.log(
      JSON.stringify({
        _aws: {
          Timestamp: Date.now(),
          CloudWatchMetrics: [
            {
              Namespace: "FindTheEdge/Scouting",
              Dimensions: [["Component"]],
              Metrics: [{ Name: name, Unit: "Count" }],
            },
          ],
        },
        Component: "workflow",
        [name]: 1,
      }),
    );
  },
};

export const logScoutingWorkflowLifecycle = (input: {
  readonly outcome:
    | "claimed"
    | "duplicate"
    | "stale"
    | "event-invalid"
    | "completed"
    | "replayed"
    | "failed_retryable"
    | "failed_terminal";
  readonly jobId: string;
  readonly attemptId: string;
  readonly failureCode?: ScoutingFailureCode;
  readonly reportFailureCode?: ScoutingReportFailureCode;
  readonly report?: ScoutingWorkflowReportSignal;
}) => {
  console.log(
    JSON.stringify({
      event: "ScoutingWorkflowLifecycle",
      outcome: input.outcome,
      jobId: input.jobId,
      attemptId: input.attemptId,
      ...(input.failureCode ? { failureCode: input.failureCode } : {}),
      ...(input.reportFailureCode
        ? { reportFailureCode: input.reportFailureCode }
        : {}),
      ...(input.report
        ? {
            reportId: input.report.reportId,
            reportVersionId: input.report.reportVersionId,
            reportVersionNumber: input.report.reportVersionNumber,
            reportPersistence: input.report.persistence,
          }
        : {}),
    }),
  );
};

const fixtureFailureCode = (error: unknown): ScoutingFailureCode => {
  if (error instanceof ScoutingFixtureFailure) return error.code;
  return "workflow-terminal-failure";
};

const fixture: ScoutingFixtureWorkflow = {
  // FTE-038 proves orchestration only and never fabricates provider inputs,
  // analysis, evidence, or a report. FTE-042 makes reportless completion
  // impossible, so without validated analysis material the fixture fails
  // honestly instead of claiming an empty success.
  run: (): Promise<ScoutingAnalysisMaterial> =>
    Promise.reject(new ScoutingFixtureFailure("fixture-contract-invalid")),
};

/** Marks a raw failure from a pre-transaction read as safely retryable. */
class ScoutingWorkflowTransientDependencyError extends Error {
  override readonly name = "ScoutingWorkflowTransientDependencyError";
  constructor(cause: unknown) {
    super("scouting-workflow-report-read-unavailable", { cause });
  }
}

const persistedReportFailureCode = (
  error: unknown,
): ScoutingReportFailureCode | null =>
  error instanceof ScoutingReportRepositoryError ||
  error instanceof ScoutingReportPersistenceError
    ? error.code
    : null;

/**
 * Maps the stable report failure taxonomy onto the scouting lifecycle
 * taxonomy: exhausted head-CAS retries stay retryable, a moved event version
 * keeps its dedicated terminal code, and every other validation/replay/stale/
 * storage failure is a terminal workflow failure.
 */
const toScoutingFailureCode = (
  code: ScoutingReportFailureCode,
): ScoutingFailureCode =>
  isRetryableScoutingReportFailure(code)
    ? "workflow-temporarily-unavailable"
    : code === "report-event-version-changed"
      ? "event-version-changed"
      : "workflow-terminal-failure";

const guardTransientRead = async <T>(work: () => Promise<T>): Promise<T> => {
  try {
    return await work();
  } catch (error) {
    throw persistedReportFailureCode(error) === null
      ? new ScoutingWorkflowTransientDependencyError(error)
      : error;
  }
};

/** Never earlier than the lower bound; keeps trusted clocks monotone. */
const clampToChronology = (
  value: string,
  lowerBound: string | undefined,
): string =>
  lowerBound !== undefined && value < lowerBound ? lowerBound : value;

type ScoutingReportPersistenceOutcome =
  | {
      readonly kind: "persisted";
      readonly report: ScoutingWorkflowReportSignal;
    }
  | {
      readonly kind: "failed";
      readonly failureCode: ScoutingFailureCode;
      readonly reportFailureCode: ScoutingReportFailureCode | null;
    };

/**
 * Projection → assembly → atomic completion. Unambiguous failures are mapped
 * onto the lifecycle taxonomy; a raw transport failure thrown by the
 * completion transaction is rethrown untouched because the transaction may
 * have committed — the attempt lease then expires and a replay resolves
 * through the immutable job binding without ever claiming completion.
 */
const persistValidatedReport = async (input: {
  readonly reports: ScoutingWorkflowReportStore;
  readonly command: ScoutingDispatchCommand;
  readonly job: StoredScoutingJob;
  readonly attempt: StoredScoutingAttempt;
  readonly material: ScoutingAnalysisMaterial;
  readonly now: () => string;
}): Promise<ScoutingReportPersistenceOutcome> => {
  const { reports, command, job, attempt, material, now } = input;
  let projection: ScoutingReportProjection;
  let context: ScoutingReportCompletionContext;
  let assembled: ScoutingReportCompletionMaterial;
  try {
    projection = projectValidatedReport({
      request: material.request,
      output: material.output,
      policy: material.policy,
      ...(material.strategy === undefined
        ? {}
        : { strategy: material.strategy }),
      provenanceSource: material.provenanceSource,
    });
    // Trusted worker clock bounded by attempt chronology: generation never
    // precedes the claimed attempt start and never follows completion.
    context = {
      requesterId: job.requesterId,
      eventId: command.eventId,
      eventVersion: command.eventVersion,
      jobId: command.jobId,
      attemptId: command.attemptId,
      generatedAt: clampToChronology(now(), attempt.startedAt),
    };
    const reportId = createScoutingReportId(job.requesterId, command.eventId);
    const head = await guardTransientRead(() =>
      reports.getHead(reportId, job.requesterId),
    );
    if (head === null) {
      assembled = assembleFirstScoutingReportVersion(projection, context);
    } else {
      const predecessor = await guardTransientRead(() =>
        reports.getVersion(reportId, head.latestVersionNumber, job.requesterId),
      );
      if (predecessor === null)
        throw new ScoutingReportRepositoryError("report-storage-corrupt");
      assembled = assembleSuccessorScoutingReportVersion(
        projection,
        context,
        head,
        predecessor,
      );
    }
  } catch (error) {
    if (error instanceof ScoutingWorkflowTransientDependencyError)
      return {
        kind: "failed",
        failureCode: "workflow-temporarily-unavailable",
        reportFailureCode: null,
      };
    const code = persistedReportFailureCode(error);
    return {
      kind: "failed",
      failureCode:
        code === null
          ? "workflow-terminal-failure"
          : toScoutingFailureCode(code),
      reportFailureCode: code,
    };
  }
  try {
    const result = await reports.completeWithReport({
      material: assembled,
      completedAt: clampToChronology(now(), context.generatedAt),
      recompute: (winningHead, winningPredecessor) =>
        assembleSuccessorScoutingReportVersion(
          projection,
          context,
          winningHead,
          winningPredecessor,
        ),
    });
    return {
      kind: "persisted",
      report: Object.freeze({
        reportId: result.version.reportId,
        reportVersionId: result.version.reportVersionId,
        reportVersionNumber: result.version.versionNumber,
        persistence: result.outcome,
      }),
    };
  } catch (error) {
    const code = persistedReportFailureCode(error);
    // Ambiguous transport outcome: the transaction may have committed, so
    // neither completion nor failure may be claimed here.
    if (code === null) throw error;
    return {
      kind: "failed",
      failureCode: toScoutingFailureCode(code),
      reportFailureCode: code,
    };
  }
};

export const createScoutingWorkflow =
  (
    repository: Pick<ScoutingJobRepository, "claimAttempt" | "finishAttempt">,
    reports: ScoutingWorkflowReportStore,
    workflow: ScoutingFixtureWorkflow = fixture,
    now: () => string = () => new Date().toISOString(),
    metricSink: ScoutingWorkflowMetricSink = scoutingWorkflowMetrics,
  ) =>
  async (rawCommand: unknown): Promise<ScoutingWorkflowResult> => {
    const command = validateScoutingDispatchCommand(rawCommand);
    const claim = await repository.claimAttempt({
      jobId: command.jobId,
      attemptId: command.attemptId,
      eventId: command.eventId,
      eventVersion: command.eventVersion,
      claimedAt: now(),
    });
    if (claim.outcome === "event-invalid") {
      metricSink.emit("AttemptEventInvalid");
      logScoutingWorkflowLifecycle({
        outcome: "event-invalid",
        jobId: command.jobId,
        attemptId: command.attemptId,
        failureCode: claim.failureCode,
      });
      const finish = await repository.finishAttempt({
        jobId: command.jobId,
        attemptId: command.attemptId,
        status: "failed_terminal",
        failureCode: claim.failureCode,
        finishedAt: now(),
      });
      if (finish.outcome === "stale") {
        metricSink.emit("AttemptStale");
        return { outcome: "stale" };
      }
      metricSink.emit("AttemptFailedTerminal");
      logScoutingWorkflowLifecycle({
        outcome: "failed_terminal",
        jobId: command.jobId,
        attemptId: command.attemptId,
        failureCode: claim.failureCode,
      });
      return { outcome: "failed_terminal", failureCode: claim.failureCode };
    }
    if (claim.outcome === "duplicate") {
      metricSink.emit("AttemptDuplicate");
      logScoutingWorkflowLifecycle({
        outcome: "duplicate",
        jobId: command.jobId,
        attemptId: command.attemptId,
      });
      throw new ScoutingWorkflowAmbiguousClaimError();
    }
    if (claim.outcome === "stale") {
      metricSink.emit("AttemptStale");
      logScoutingWorkflowLifecycle({
        outcome: "stale",
        jobId: command.jobId,
        attemptId: command.attemptId,
      });
      return { outcome: "stale" };
    }
    metricSink.emit("AttemptClaimed");
    logScoutingWorkflowLifecycle({
      outcome: "claimed",
      jobId: command.jobId,
      attemptId: command.attemptId,
    });

    let material: ScoutingAnalysisMaterial | undefined;
    let failureCode: ScoutingFailureCode | undefined;
    let reportFailureCode: ScoutingReportFailureCode | null = null;
    try {
      material = await workflow.run(command);
    } catch (error) {
      failureCode = fixtureFailureCode(error);
    }

    if (failureCode === undefined) {
      if (material === undefined) {
        // An untyped fixture yielded nothing: without validated analysis
        // material an empty successful completion is impossible.
        failureCode = "fixture-contract-invalid";
      } else {
        const persisted = await persistValidatedReport({
          reports,
          command,
          job: claim.job,
          attempt: claim.attempt,
          material,
          now,
        });
        if (persisted.kind === "persisted") {
          const replayed = persisted.report.persistence === "replayed";
          metricSink.emit(
            replayed ? "AttemptReplayResolved" : "AttemptCompleted",
          );
          logScoutingWorkflowLifecycle({
            outcome: replayed ? "replayed" : "completed",
            jobId: command.jobId,
            attemptId: command.attemptId,
            report: persisted.report,
          });
          return { outcome: "completed", report: persisted.report };
        }
        failureCode = persisted.failureCode;
        reportFailureCode = persisted.reportFailureCode;
      }
    }

    const status = isRetryableScoutingFailure(failureCode)
      ? "failed_retryable"
      : "failed_terminal";
    const finish = await repository.finishAttempt({
      jobId: command.jobId,
      attemptId: command.attemptId,
      status,
      failureCode,
      finishedAt: now(),
    });
    if (finish.outcome === "stale") {
      metricSink.emit("AttemptStale");
      return { outcome: "stale" };
    }
    metricSink.emit(
      status === "failed_retryable"
        ? "AttemptFailedRetryable"
        : "AttemptFailedTerminal",
    );
    logScoutingWorkflowLifecycle({
      outcome: status,
      jobId: command.jobId,
      attemptId: command.attemptId,
      failureCode,
      ...(reportFailureCode === null ? {} : { reportFailureCode }),
    });
    return { outcome: status, failureCode };
  };
