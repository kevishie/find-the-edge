import type {
  OpportunityCandidateRepository,
  OpportunityLifecycleApplyResult,
  OpportunityLifecycleEventEvidenceSource,
  OpportunityLifecycleRepository,
  RankedOpportunityRepository,
} from "@find-the-edge/database";
import { OpportunityLifecycleConflictError } from "@find-the-edge/database";
import { defaultOpportunityRankingPolicy } from "@find-the-edge/config";
import type {
  OpportunityCandidate,
  OpportunityLifecycleHead,
  OpportunityRankingPolicyContract,
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
      readonly rankingPolicy?: OpportunityRankingPolicyContract;
      readonly rankedOpportunities?: Pick<
        RankedOpportunityRepository,
        "reconcileActive"
      >;
      readonly telemetry?: OpportunityLifecycleTelemetry;
    },
  ) {}
  private async healRankProjectionAfterReplay(input: {
    readonly result: OpportunityLifecycleApplyResult;
    readonly candidate: OpportunityCandidate;
    readonly fence: Parameters<
      OpportunityLifecycleRepository["reconcileRankProjection"]
    >[0]["fence"];
    readonly rankingPolicy: OpportunityRankingPolicyContract;
  }) {
    if (
      input.result.outcome === "applied" ||
      input.result.head.state !== "active" ||
      input.result.head.latestCandidateOccurrenceId !==
        input.candidate.occurrenceId
    )
      return;
    const outcome = await this.dependencies.lifecycle.reconcileRankProjection({
      head: input.result.head,
      candidate: input.candidate,
      fence: input.fence,
      rankingPolicy: input.rankingPolicy,
    });
    if (outcome === "conflict")
      throw new OpportunityLifecycleConflictError(
        "opportunity-rank-projection-conflict",
      );
  }
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
      const rankingPolicy =
        this.dependencies.rankingPolicy ?? defaultOpportunityRankingPolicy;
      const result = await this.dependencies.lifecycle.apply(
        {
          commandId: `candidate:${candidate.occurrenceId}:${event.evidence.evidenceId}`,
          cause: "candidate",
          candidate,
          eventEvidence: event.evidence,
          occurredAt,
        },
        event.fence,
        rankingPolicy,
      );
      await this.healRankProjectionAfterReplay({
        result,
        candidate,
        fence: event.fence,
        rankingPolicy,
      });
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
    const rankingPolicy =
      this.dependencies.rankingPolicy ?? defaultOpportunityRankingPolicy;
    const result = await this.dependencies.lifecycle.apply(
      {
        commandId: `sweep:${asOf}:${head.lastTransitionId}:${event.evidence.evidenceId}`,
        cause: "sweep",
        candidate,
        eventEvidence: event.evidence,
        occurredAt: asOf,
      },
      event.fence,
      rankingPolicy,
    );
    await this.healRankProjectionAfterReplay({
      result,
      candidate,
      fence: event.fence,
      rankingPolicy,
    });
    return result;
  }
  async reconcileRankProjections(input: {
    readonly sportKey: string;
    readonly asOf: string;
    readonly pageLimit?: number;
    readonly maximumPages?: number;
    readonly cursor?: string;
  }) {
    if (!this.dependencies.rankedOpportunities)
      throw new Error("ranked-opportunity-repository-not-configured");
    const pageLimit = input.pageLimit ?? 100;
    const maximumPages = input.maximumPages ?? 10;
    if (
      new Date(input.asOf).toISOString() !== input.asOf ||
      !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(input.sportKey) ||
      !Number.isSafeInteger(pageLimit) ||
      pageLimit < 1 ||
      pageLimit > 100 ||
      !Number.isSafeInteger(maximumPages) ||
      maximumPages < 1 ||
      maximumPages > 100 ||
      (input.cursor !== undefined &&
        (input.cursor.length < 1 || input.cursor.length > 1_024))
    )
      throw new Error("ranked-opportunity-reconciliation-invalid");
    const totals = {
      discoveredCount: 0,
      projectedCount: 0,
      inactiveCount: 0,
      conflictCount: 0,
      failureCount: 0,
      nextCursor: null as string | null,
    };
    const seen = new Set<string>(input.cursor ? [input.cursor] : []);
    let cursor = input.cursor;
    for (let pageNumber = 0; pageNumber < maximumPages; pageNumber += 1) {
      const page = await this.dependencies.rankedOpportunities.reconcileActive({
        sportKey: input.sportKey,
        asOf: input.asOf,
        limit: pageLimit,
        ...(cursor ? { cursor } : {}),
      });
      totals.discoveredCount += page.discoveredCount;
      totals.projectedCount += page.projectedCount;
      totals.inactiveCount += page.inactiveCount;
      totals.conflictCount += page.conflictCount;
      totals.failureCount += page.failureCount;
      totals.nextCursor = page.nextCursor;
      if (!page.nextCursor) break;
      if (seen.has(page.nextCursor))
        throw new Error("ranked-opportunity-reconciliation-cursor-stalled");
      seen.add(page.nextCursor);
      cursor = page.nextCursor;
    }
    return Object.freeze(totals);
  }
}
