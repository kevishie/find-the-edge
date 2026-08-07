import type { ScoutingJobRepository } from "@find-the-edge/database";
import {
  isRetryableScoutingFailure,
  validateScoutingDispatchCommand,
  type ScoutingDispatchCommand,
  type ScoutingFailureCode,
} from "@find-the-edge/domain";

export interface ScoutingFixtureWorkflow {
  run(command: ScoutingDispatchCommand): Promise<void>;
}

export type ScoutingWorkflowMetricName =
  | "AttemptClaimed"
  | "AttemptDuplicate"
  | "AttemptStale"
  | "AttemptEventInvalid"
  | "AttemptCompleted"
  | "AttemptFailedRetryable"
  | "AttemptFailedTerminal";

export interface ScoutingWorkflowMetricSink {
  emit(name: ScoutingWorkflowMetricName): void;
}

export type ScoutingWorkflowResult =
  | { readonly outcome: "completed" }
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
    | "failed_retryable"
    | "failed_terminal";
  readonly jobId: string;
  readonly attemptId: string;
  readonly failureCode?: ScoutingFailureCode;
}) => {
  console.log(
    JSON.stringify({
      event: "ScoutingWorkflowLifecycle",
      outcome: input.outcome,
      jobId: input.jobId,
      attemptId: input.attemptId,
      ...(input.failureCode ? { failureCode: input.failureCode } : {}),
    }),
  );
};

const fixtureFailureCode = (error: unknown): ScoutingFailureCode => {
  if (error instanceof ScoutingFixtureFailure) return error.code;
  return "workflow-terminal-failure";
};

const fixture: ScoutingFixtureWorkflow = {
  async run() {
    // FTE-038 intentionally proves orchestration only. It does not fabricate
    // provider inputs, analysis, evidence, or a scouting report.
  },
};

export const createScoutingWorkflow =
  (
    repository: Pick<ScoutingJobRepository, "claimAttempt" | "finishAttempt">,
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

    let failureCode: ScoutingFailureCode | undefined;
    try {
      await workflow.run(command);
    } catch (error) {
      failureCode = fixtureFailureCode(error);
    }

    if (!failureCode) {
      const finish = await repository.finishAttempt({
        jobId: command.jobId,
        attemptId: command.attemptId,
        status: "completed",
        finishedAt: now(),
      });
      if (finish.outcome === "stale") {
        metricSink.emit("AttemptStale");
        return { outcome: "stale" };
      }
      metricSink.emit("AttemptCompleted");
      logScoutingWorkflowLifecycle({
        outcome: "completed",
        jobId: command.jobId,
        attemptId: command.attemptId,
      });
      return { outcome: "completed" };
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
    });
    return { outcome: status, failureCode };
  };
