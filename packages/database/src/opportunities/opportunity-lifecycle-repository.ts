import {
  createRankedOpportunityProjection,
  isOpportunityLifecycleHeadActive,
  reduceOpportunityLifecycle,
  type OpportunityCandidate,
  type OpportunityLifecycleCommand,
  type OpportunityLifecycleDecision,
  type OpportunityLifecycleHead,
  type OpportunityLifecycleTransition,
  type OpportunityRankingPolicyContract,
  type RankedOpportunityProjection,
} from "@find-the-edge/domain";

export interface OpportunityLifecycleEventFence {
  readonly pk: string;
  readonly sk: string;
  readonly expectedMaterialVersion: number | null;
}
export interface OpportunityLifecycleApplyResult {
  readonly outcome: OpportunityLifecycleDecision["outcome"];
  readonly head: OpportunityLifecycleHead;
  readonly transition?: OpportunityLifecycleTransition;
}
export interface OpportunityLifecycleDiscoveryPage {
  readonly items: readonly OpportunityLifecycleHead[];
  readonly nextCursor: string | null;
  readonly staleActiveCount: number;
  readonly staleActiveKeys: readonly string[];
  readonly discoveryFailureCount: number;
  readonly discoveryFailureKeys: readonly string[];
}
export type OpportunityLifecycleSweepMode = "due" | "fresh";
export interface OpportunityLifecycleRepository {
  apply(
    command: OpportunityLifecycleCommand,
    fence: OpportunityLifecycleEventFence,
    rankingPolicy?: OpportunityRankingPolicyContract,
  ): Promise<OpportunityLifecycleApplyResult>;
  get(logicalOpportunityId: string): Promise<OpportunityLifecycleHead | null>;
  history(
    logicalOpportunityId: string,
  ): Promise<readonly OpportunityLifecycleTransition[]>;
  discoverActive(input: {
    readonly sportKey: string;
    readonly asOf: string;
    readonly through?: string;
    readonly limit: number;
    readonly cursor?: string;
  }): Promise<OpportunityLifecycleDiscoveryPage>;
  getSweepCursor(
    sportKey: string,
    mode: OpportunityLifecycleSweepMode,
  ): Promise<string | null>;
  setSweepCursor(input: {
    readonly sportKey: string;
    readonly mode: OpportunityLifecycleSweepMode;
    readonly cursor: string | null;
    readonly updatedAt: string;
  }): Promise<void>;
  reconcileRankProjection(input: {
    readonly head: OpportunityLifecycleHead;
    readonly candidate: OpportunityCandidate;
    readonly fence: OpportunityLifecycleEventFence;
    readonly rankingPolicy: OpportunityRankingPolicyContract;
  }): Promise<"projected" | "inactive" | "conflict">;
}
export class OpportunityLifecycleConflictError extends Error {
  override readonly name = "OpportunityLifecycleConflictError";
}

export class MemoryOpportunityLifecycleRepository implements OpportunityLifecycleRepository {
  private readonly heads = new Map<string, OpportunityLifecycleHead>();
  private readonly transitions = new Map<
    string,
    OpportunityLifecycleTransition[]
  >();
  private readonly sweepCursors = new Map<string, string>();
  private readonly rankProjections = new Map<
    string,
    RankedOpportunityProjection
  >();

  apply(
    command: OpportunityLifecycleCommand,
    fence: OpportunityLifecycleEventFence,
    rankingPolicy?: OpportunityRankingPolicyContract,
  ): Promise<OpportunityLifecycleApplyResult> {
    void fence;
    const existing =
      this.heads.get(command.candidate.logicalOpportunityId) ?? null;
    const decision = reduceOpportunityLifecycle(existing, command);
    if (decision.outcome !== "applied")
      return Promise.resolve({
        outcome: decision.outcome,
        head: structuredClone(decision.head),
      });
    if (decision.head.state === "active" && !rankingPolicy)
      return Promise.reject(new Error("opportunity-ranking-policy-required"));
    const rankProjection =
      decision.head.state === "active"
        ? createRankedOpportunityProjection(
            command.candidate,
            decision.head,
            rankingPolicy!,
          )
        : null;
    this.heads.set(
      decision.head.logicalOpportunityId,
      structuredClone(decision.head),
    );
    const history =
      this.transitions.get(decision.head.logicalOpportunityId) ?? [];
    if (
      !history.some(
        ({ transitionId }) => transitionId === decision.transition.transitionId,
      )
    )
      history.push(structuredClone(decision.transition));
    this.transitions.set(decision.head.logicalOpportunityId, history);
    if (rankProjection) {
      this.rankProjections.set(
        decision.head.logicalOpportunityId,
        rankProjection,
      );
    } else this.rankProjections.delete(decision.head.logicalOpportunityId);
    return Promise.resolve({
      outcome: "applied",
      head: structuredClone(decision.head),
      transition: structuredClone(decision.transition),
    });
  }
  get(logicalOpportunityId: string) {
    const value = this.heads.get(logicalOpportunityId);
    return Promise.resolve(value ? structuredClone(value) : null);
  }
  history(logicalOpportunityId: string) {
    return Promise.resolve(
      Object.freeze(
        (this.transitions.get(logicalOpportunityId) ?? [])
          .map((value) => structuredClone(value))
          .sort((left, right) => left.stateVersion - right.stateVersion),
      ),
    );
  }
  discoverActive(input: {
    readonly sportKey: string;
    readonly asOf: string;
    readonly through?: string;
    readonly limit: number;
    readonly cursor?: string;
  }): Promise<OpportunityLifecycleDiscoveryPage> {
    if (
      !Number.isSafeInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > 100 ||
      new Date(input.asOf).toISOString() !== input.asOf ||
      (input.through !== undefined &&
        new Date(input.through).toISOString() !== input.through)
    )
      return Promise.reject(new Error("opportunity-lifecycle-limit-invalid"));
    const rows = [...this.heads.values()]
      .filter(
        (head) =>
          head.sportKey === input.sportKey &&
          head.activeSk &&
          (!input.through || head.expiresAt! <= input.through),
      )
      .sort((left, right) => left.activeSk!.localeCompare(right.activeSk!));
    const matchedStart = input.cursor
      ? rows.findIndex(({ activeSk }) => activeSk! > input.cursor!)
      : 0;
    const start = matchedStart < 0 ? rows.length : matchedStart;
    const physical = rows.slice(
      Math.max(0, start),
      Math.max(0, start) + input.limit,
    );
    const items = physical.filter((value) =>
      input.through
        ? true
        : isOpportunityLifecycleHeadActive(value, input.asOf),
    );
    const last = physical.at(-1)?.activeSk ?? null;
    return Promise.resolve({
      items: Object.freeze(items.map((value) => structuredClone(value))),
      nextCursor:
        last && rows.some(({ activeSk }) => activeSk! > last) ? last : null,
      staleActiveCount: physical.length - items.length,
      staleActiveKeys: Object.freeze(
        physical
          .filter((value) => !items.includes(value))
          .map(
            (value) =>
              `${value.logicalOpportunityId}\0${value.activeSk ?? "missing"}`,
          ),
      ),
      discoveryFailureCount: 0,
      discoveryFailureKeys: Object.freeze([]),
    });
  }
  getSweepCursor(sportKey: string, mode: OpportunityLifecycleSweepMode) {
    return Promise.resolve(
      this.sweepCursors.get(`${sportKey}\0${mode}`) ?? null,
    );
  }
  setSweepCursor(input: {
    readonly sportKey: string;
    readonly mode: OpportunityLifecycleSweepMode;
    readonly cursor: string | null;
    readonly updatedAt: string;
  }) {
    if (new Date(input.updatedAt).toISOString() !== input.updatedAt)
      return Promise.reject(new Error("opportunity-sweep-checkpoint-invalid"));
    const key = `${input.sportKey}\0${input.mode}`;
    if (input.cursor === null) this.sweepCursors.delete(key);
    else this.sweepCursors.set(key, input.cursor);
    return Promise.resolve();
  }
  reconcileRankProjection(input: {
    readonly head: OpportunityLifecycleHead;
    readonly candidate: OpportunityCandidate;
    readonly fence: OpportunityLifecycleEventFence;
    readonly rankingPolicy: OpportunityRankingPolicyContract;
  }): Promise<"projected" | "inactive" | "conflict"> {
    void input.fence;
    const current = this.heads.get(input.head.logicalOpportunityId);
    if (
      !current ||
      current.stateVersion !== input.head.stateVersion ||
      current.latestCandidateOccurrenceId !== input.candidate.occurrenceId
    )
      return Promise.resolve("conflict");
    if (
      !isOpportunityLifecycleHeadActive(current, input.candidate.evaluatedAt)
    ) {
      this.rankProjections.delete(current.logicalOpportunityId);
      return Promise.resolve("inactive");
    }
    this.rankProjections.set(
      current.logicalOpportunityId,
      createRankedOpportunityProjection(
        input.candidate,
        current,
        input.rankingPolicy,
      ),
    );
    return Promise.resolve("projected");
  }
  getRankProjection(logicalOpportunityId: string) {
    const value = this.rankProjections.get(logicalOpportunityId);
    return value ? structuredClone(value) : null;
  }
}
