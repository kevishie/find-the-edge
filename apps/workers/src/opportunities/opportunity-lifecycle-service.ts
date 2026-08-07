import type {
  OpportunityCandidateRepository,
  OpportunityLifecycleApplyResult,
  OpportunityLifecycleEventEvidenceSource,
  OpportunityLifecycleRepository,
} from "@find-the-edge/database";
import type {
  OpportunityCandidate,
  OpportunityLifecycleHead,
} from "@find-the-edge/domain";

export interface OpportunityLifecycleTelemetry {
  emit(event: {
    readonly outcome:
      "transition" | "duplicate" | "ignored" | "conflict" | "failure";
    readonly cause: "candidate" | "sweep";
    readonly sportKey: string;
    readonly fromState: string | null;
    readonly toState: string | null;
    readonly staleActiveCount: number;
    readonly transitionCount?: number;
    readonly expirationCount?: number;
    readonly conflictCount?: number;
    readonly failureCount?: number;
  }): void;
}
const silent: OpportunityLifecycleTelemetry = { emit() {} };
const safeEmit = (
  telemetry: OpportunityLifecycleTelemetry,
  event: Parameters<OpportunityLifecycleTelemetry["emit"]>[0],
) => {
  try {
    telemetry.emit(event);
  } catch {
    // Metrics never change an authoritative lifecycle result.
  }
};

export class OpportunityLifecycleService {
  constructor(
    private readonly dependencies: {
      readonly lifecycle: OpportunityLifecycleRepository;
      readonly events: OpportunityLifecycleEventEvidenceSource;
      readonly candidates: OpportunityCandidateRepository;
      readonly telemetry?: OpportunityLifecycleTelemetry;
    },
  ) {}
  async projectCandidate(
    candidate: OpportunityCandidate,
    occurredAt: string,
  ): Promise<OpportunityLifecycleApplyResult> {
    const current = await this.dependencies.lifecycle.get(
      candidate.logicalOpportunityId,
    );
    try {
      const event = await this.dependencies.events.read(
        candidate.logicalIdentity.canonicalEventId,
        occurredAt,
      );
      const result = await this.dependencies.lifecycle.apply(
        {
          commandId: `candidate:${candidate.occurrenceId}:${event.evidence.evidenceId}`,
          cause: "candidate",
          candidate,
          eventEvidence: event.evidence,
          occurredAt,
        },
        event.fence,
      );
      safeEmit(this.dependencies.telemetry ?? silent, {
        outcome:
          result.outcome === "applied"
            ? "transition"
            : result.outcome === "duplicate"
              ? "duplicate"
              : "ignored",
        cause: "candidate",
        sportKey: candidate.logicalIdentity.sportKey,
        fromState: current?.state ?? null,
        toState: result.head.state,
        staleActiveCount: 0,
        transitionCount: result.outcome === "applied" ? 1 : 0,
        expirationCount: 0,
        conflictCount: 0,
        failureCount: 0,
      });
      return result;
    } catch (error) {
      safeEmit(this.dependencies.telemetry ?? silent, {
        outcome:
          error instanceof Error &&
          error.name === "OpportunityLifecycleConflictError"
            ? "conflict"
            : "failure",
        cause: "candidate",
        sportKey: candidate.logicalIdentity.sportKey,
        fromState: current?.state ?? null,
        toState: null,
        staleActiveCount: 0,
        transitionCount: 0,
        expirationCount: 0,
        conflictCount:
          error instanceof Error &&
          error.name === "OpportunityLifecycleConflictError"
            ? 1
            : 0,
        failureCount:
          error instanceof Error &&
          error.name === "OpportunityLifecycleConflictError"
            ? 0
            : 1,
      });
      throw error;
    }
  }
  async projectCandidates(
    candidates: readonly OpportunityCandidate[],
    occurredAt: string,
  ) {
    const results: OpportunityLifecycleApplyResult[] = [];
    for (const candidate of candidates)
      results.push(await this.projectCandidate(candidate, occurredAt));
    return Object.freeze(results);
  }
  async sweepHead(
    head: OpportunityLifecycleHead,
    asOf: string,
  ): Promise<OpportunityLifecycleApplyResult> {
    const candidate = await this.dependencies.candidates.get(
      head.latestCandidateOccurrenceId,
    );
    if (
      !candidate ||
      candidate.logicalOpportunityId !== head.logicalOpportunityId
    )
      throw new Error("opportunity-lifecycle-candidate-missing");
    const event = await this.dependencies.events.read(
      head.canonicalEventId,
      asOf,
    );
    return this.dependencies.lifecycle.apply(
      {
        commandId: `sweep:${asOf}:${head.lastTransitionId}:${event.evidence.evidenceId}`,
        cause: "sweep",
        candidate,
        eventEvidence: event.evidence,
        occurredAt: asOf,
      },
      event.fence,
    );
  }
}
