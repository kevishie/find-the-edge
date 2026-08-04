import {
  validatePaperPickSchedulePolicy,
  type PaperPickAllowlistTuple,
  type PaperPickSchedulePolicy,
} from "@find-the-edge/config";
import {
  type EvaluationCandidate,
  type EvaluationCandidateRepository,
  type PaperPickRunRepository,
} from "@find-the-edge/database";
import type {
  PickEvaluationInput,
  PickEvaluationResult,
} from "./pick-evaluation";
import type { PickEvaluationService } from "./pick-evaluation";

export type PaperPickStopReason =
  | "disabled"
  | "killed"
  | "empty-allowlist"
  | "policy-invalid"
  | "policy-changed"
  | "event-limit"
  | "concurrency-limit"
  | "model-call-limit"
  | "token-limit"
  | "cost-limit"
  | "model-disabled"
  | "strategy-unavailable"
  | "event-ineligible";
export interface PaperPickSchedulerTelemetry {
  emit(event: {
    readonly metric: "run" | "terminal" | "limit" | "failure";
    readonly mode?: "shadow" | "paper";
    readonly reasonCode?: string;
    readonly count: number;
  }): void;
}
export interface PaperPickSchedulerResult {
  readonly runIds: readonly string[];
  readonly discovered: number;
  readonly terminal: number;
  readonly limits: number;
  readonly reasonCode?: PaperPickStopReason;
}
type ServerOwnedAssembler = (
  candidate: EvaluationCandidate,
  tuple: PaperPickAllowlistTuple,
  scheduledFor: string,
) => Promise<PickEvaluationInput>;
const safeTelemetry: PaperPickSchedulerTelemetry = { emit() {} };
const terminalDetails = (result: PickEvaluationResult) =>
  result.terminal === "evaluation"
    ? {
        terminal: "evaluation" as const,
        reason: result.pair.evaluation.decision,
        id: result.pair.evaluation.evaluationId,
      }
    : {
        terminal: "attempt" as const,
        reason: result.reasonCode,
        id: result.attemptId,
      };

export class PaperPickScheduler {
  constructor(
    private readonly dependencies: {
      readonly policy: () => Promise<PaperPickSchedulePolicy>;
      readonly candidates: EvaluationCandidateRepository;
      readonly runs: PaperPickRunRepository;
      readonly evaluator: PickEvaluationService;
      readonly assemble: ServerOwnedAssembler;
      readonly modelCapability: "disabled" | "approved";
      /** Conservative maximum charge for one adapter invocation. */
      readonly reservation: {
        readonly inputTokens: number;
        readonly outputTokens: number;
        readonly costMicros: number;
      };
      readonly telemetry?: PaperPickSchedulerTelemetry;
      readonly owner?: string;
      readonly now?: () => Date;
      /** Resolves the approved future-effective version frozen into a new run. */
      readonly resolveStrategyVersion: (
        strategyId: string,
        scheduledFor: string,
      ) => Promise<string | null>;
    },
  ) {}
  private emit(event: Parameters<PaperPickSchedulerTelemetry["emit"]>[0]) {
    try {
      (this.dependencies.telemetry ?? safeTelemetry).emit(event);
    } catch {
      /* metrics cannot affect execution */
    }
  }
  async generate(scheduledFor: string): Promise<PaperPickSchedulerResult> {
    let policy: PaperPickSchedulePolicy;
    try {
      policy = validatePaperPickSchedulePolicy(
        await this.dependencies.policy(),
      );
    } catch {
      this.emit({ metric: "failure", reasonCode: "policy-invalid", count: 1 });
      return {
        runIds: [],
        discovered: 0,
        terminal: 0,
        limits: 0,
        reasonCode: "policy-invalid",
      };
    }
    if (!policy.enabled)
      return {
        runIds: [],
        discovered: 0,
        terminal: 0,
        limits: 0,
        reasonCode: "disabled",
      };
    if (policy.killSwitch !== "open")
      return {
        runIds: [],
        discovered: 0,
        terminal: 0,
        limits: 0,
        reasonCode: "killed",
      };
    if (!policy.allowlist.length)
      return {
        runIds: [],
        discovered: 0,
        terminal: 0,
        limits: 0,
        reasonCode: "empty-allowlist",
      };
    if (new Date(scheduledFor).toISOString() !== scheduledFor)
      return {
        runIds: [],
        discovered: 0,
        terminal: 0,
        limits: 0,
        reasonCode: "policy-invalid",
      };
    if (new Date(scheduledFor).getUTCMinutes() % policy.generationMinutes !== 0)
      return {
        runIds: [],
        discovered: 0,
        terminal: 0,
        limits: 0,
        reasonCode: "policy-invalid",
      };
    const generationId = await this.dependencies.runs.createGeneration(
      policy.id,
      policy.version,
      scheduledFor,
      policy.limits,
    );
    const runIds: string[] = [];
    let discovered = 0,
      terminal = 0,
      limitCount = 0;
    for (const configuredTuple of policy.allowlist) {
      const activeVersion = await this.dependencies.resolveStrategyVersion(
        configuredTuple.strategyId,
        scheduledFor,
      );
      if (!activeVersion) {
        this.emit({
          metric: "failure",
          reasonCode: "strategy-unavailable",
          count: 1,
        });
        continue;
      }
      const tuple = Object.freeze({
        ...configuredTuple,
        strategyVersion: activeVersion,
      });
      const identity = {
        policyId: policy.id,
        policyVersion: policy.version,
        scheduledFor,
        ...tuple,
      };
      const from = new Date(
        Date.parse(scheduledFor) +
          policy.candidateWindowMinutes.minimum * 60_000,
      ).toISOString();
      const until = new Date(
        Date.parse(scheduledFor) +
          policy.candidateWindowMinutes.maximum * 60_000,
      ).toISOString();
      const offeredCandidates = await this.dependencies.candidates.listEligible(
        {
          sportKey: tuple.sportKey,
          leagueKey: tuple.leagueKey,
          from,
          until,
          limit: policy.limits.events,
        },
      );
      const discoveredCandidates: EvaluationCandidate[] = [];
      for (const candidate of offeredCandidates) {
        const admission = await this.dependencies.runs.admitEvent(
          generationId,
          candidate.eventId,
          candidate.eventVersion,
          policy.limits.events,
        );
        if (admission === "event-limit") {
          limitCount++;
          this.emit({
            metric: "limit",
            mode: tuple.mode,
            reasonCode: "event-limit",
            count: 1,
          });
          continue;
        }
        discoveredCandidates.push(candidate);
      }
      const { run } = await this.dependencies.runs.createRun(
        identity,
        scheduledFor,
        discoveredCandidates,
        generationId,
      );
      runIds.push(run.runId);
      const candidates = run.candidateManifest.map((candidate) => ({
        ...candidate,
        status: "scheduled" as const,
      }));
      discovered += candidates.length;
      const items = await Promise.all(
        candidates.map((candidate) =>
          this.dependencies.runs
            .createItem(run.runId, candidate, tuple.mode)
            .then((item) => ({ item, candidate })),
        ),
      );
      let cursor = 0;
      const workers = Array.from(
        { length: Math.min(policy.limits.concurrency, items.length) },
        async () => {
          while (cursor < items.length) {
            const entry = items[cursor++];
            if (!entry) break;
            const existing = await this.dependencies.runs.getItem(
              entry.item.itemId,
            );
            if (existing?.state === "terminal") {
              terminal++;
              continue;
            }
            const now = () =>
              (this.dependencies.now ?? (() => new Date()))().toISOString();
            const claim = await this.dependencies.runs.claimItem(
              entry.item.itemId,
              this.dependencies.owner ?? "paper-pick-worker",
              now(),
              60_000,
            );
            if (!claim) continue;
            let terminalKind:
              "evaluation" | "attempt" | "skipped" | "limit" | "failed" =
              "failed";
            let reason = "scheduler-failed";
            let terminalId: string | undefined;
            try {
              const current = await this.dependencies.policy();
              if (
                current.id !== policy.id ||
                current.version !== policy.version
              ) {
                terminalKind = "skipped";
                reason = "policy-changed";
              } else if (!current.enabled || current.killSwitch !== "open") {
                terminalKind = "skipped";
                reason =
                  current.killSwitch === "killed" ? "killed" : "disabled";
              } else if (
                !current.allowlist.some(
                  (allowed) =>
                    JSON.stringify(allowed) === JSON.stringify(configuredTuple),
                )
              ) {
                terminalKind = "skipped";
                reason = "policy-changed";
              } else if (
                !(await this.dependencies.candidates.rereadEligible(
                  entry.candidate,
                  now(),
                ))
              ) {
                terminalKind = "skipped";
                reason = "event-ineligible";
              } else if (
                tuple.mode === "paper" &&
                this.dependencies.modelCapability !== "approved"
              ) {
                terminalKind = "attempt";
                reason = "model-disabled";
              } else {
                const reserved = await this.dependencies.runs.reserve(
                  entry.item.itemId,
                  claim.token,
                  {
                    modelCalls: 1,
                    ...this.dependencies.reservation,
                    concurrency: 1,
                  },
                  policy.limits,
                );
                if (reserved !== "reserved") {
                  terminalKind = "limit";
                  limitCount++;
                  reason = reserved;
                  this.emit({
                    metric: "limit",
                    mode: tuple.mode,
                    reasonCode: reason,
                    count: 1,
                  });
                } else {
                  const input = await this.dependencies.assemble(
                    entry.candidate,
                    tuple,
                    scheduledFor,
                  );
                  const boundaryPolicy = validatePaperPickSchedulePolicy(
                    await this.dependencies.policy(),
                  );
                  if (
                    boundaryPolicy.id !== policy.id ||
                    boundaryPolicy.version !== policy.version ||
                    !boundaryPolicy.enabled ||
                    boundaryPolicy.killSwitch !== "open" ||
                    !boundaryPolicy.allowlist.some(
                      (allowed) =>
                        JSON.stringify(allowed) ===
                        JSON.stringify(configuredTuple),
                    ) ||
                    !(await this.dependencies.candidates.rereadEligible(
                      entry.candidate,
                      now(),
                    ))
                  ) {
                    terminalKind = "skipped";
                    reason =
                      boundaryPolicy.killSwitch === "killed"
                        ? "killed"
                        : !boundaryPolicy.enabled
                          ? "disabled"
                          : "event-ineligible";
                  } else {
                    await this.dependencies.runs.renewItem(
                      entry.item.itemId,
                      claim.token,
                      now(),
                      60_000,
                    );
                    const result = await this.dependencies.evaluator.evaluate({
                      ...input,
                      timeoutMs: Math.min(input.timeoutMs ?? 45_000, 45_000),
                      execution: {
                        mode: tuple.mode,
                        runId: run.runId,
                        itemId: entry.item.itemId,
                        policyId: policy.id,
                        policyVersion: policy.version,
                        scheduledFor,
                      },
                    });
                    const details = terminalDetails(result);
                    terminalKind = details.terminal;
                    reason = details.reason;
                    terminalId = details.id;
                  }
                }
              }
            } catch {
              terminalKind = "failed";
              reason = "scheduler-failed";
              this.emit({
                metric: "failure",
                mode: tuple.mode,
                reasonCode: reason,
                count: 1,
              });
            } finally {
              try {
                await this.dependencies.runs.releaseConcurrency(
                  entry.item.itemId,
                  claim.token,
                );
              } catch {
                /* lease loss makes terminal fencing authoritative */
              }
            }
            try {
              await this.dependencies.runs.finishItem(
                entry.item.itemId,
                claim.token,
                terminalKind,
                reason,
                now(),
                terminalId,
              );
              terminal++;
              this.emit({
                metric: "terminal",
                mode: tuple.mode,
                reasonCode: reason,
                count: 1,
              });
            } catch {
              /* another lease owner is authoritative */
            }
          }
        },
      );
      await Promise.all(workers);
      await this.dependencies.runs.checkpointRun(run.runId);
      this.emit({ metric: "run", mode: tuple.mode, count: 1 });
    }
    return { runIds, discovered, terminal, limits: limitCount };
  }
}
