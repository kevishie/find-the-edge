import type {
  PaperPickRunItem,
  PaperPickRunRecord,
  PaperPickRunIdentityInput,
  PaperPickItemTerminal,
} from "@find-the-edge/domain";
import {
  createPaperPickItemId,
  createPaperPickGenerationId,
  createPaperPickRunId,
  assertPaperPickItemTransition,
  assertPaperPickTransition,
  normalizePaperPickCandidateManifest,
} from "@find-the-edge/domain";

export interface PaperPickBudgetAmount {
  readonly modelCalls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costMicros: number;
  readonly concurrency: number;
}
export interface PaperPickBudgetLimits extends PaperPickBudgetAmount {
  readonly events: number;
}
export type PaperPickLimitReason =
  "model-call-limit" | "token-limit" | "cost-limit" | "concurrency-limit";
export interface PaperPickItemClaim {
  readonly item: PaperPickRunItem;
  readonly token: string;
  readonly leaseExpiresAt: string;
}
export interface PaperPickRunRepository {
  createGeneration(
    policyId: string,
    policyVersion: string,
    scheduledFor: string,
    limits: PaperPickBudgetLimits,
  ): Promise<string>;
  createRun(
    identity: PaperPickRunIdentityInput,
    createdAt: string,
    candidates: readonly {
      readonly eventId: string;
      readonly eventVersion: number;
      readonly sportKey: string;
      readonly leagueKey: string;
      readonly participantIds: readonly string[];
      readonly startsAt: string;
    }[],
    generationId: string,
  ): Promise<{ outcome: "created" | "duplicate"; run: PaperPickRunRecord }>;
  admitEvent(
    generationId: string,
    eventId: string,
    eventVersion: number,
    maximumEvents: number,
  ): Promise<"admitted" | "existing" | "event-limit">;
  createItem(
    runId: string,
    candidate: {
      readonly eventId: string;
      readonly eventVersion: number;
      readonly sportKey: string;
      readonly leagueKey: string;
      readonly participantIds: readonly string[];
      readonly startsAt: string;
    },
    mode: "shadow" | "paper",
  ): Promise<PaperPickRunItem>;
  claimItem(
    itemId: string,
    owner: string,
    now: string,
    leaseMs: number,
  ): Promise<PaperPickItemClaim | null>;
  renewItem(
    itemId: string,
    token: string,
    now: string,
    leaseMs: number,
  ): Promise<PaperPickItemClaim>;
  reserve(
    itemId: string,
    token: string,
    amount: PaperPickBudgetAmount,
    limits: PaperPickBudgetLimits,
  ): Promise<"reserved" | PaperPickLimitReason>;
  reconcile(
    itemId: string,
    token: string,
    actual: Omit<PaperPickBudgetAmount, "concurrency">,
  ): Promise<void>;
  releaseConcurrency(itemId: string, token: string): Promise<void>;
  finishItem(
    itemId: string,
    token: string,
    terminal: PaperPickItemTerminal,
    reasonCode: string,
    now: string,
    terminalId?: string,
  ): Promise<PaperPickRunItem>;
  checkpointRun(runId: string): Promise<PaperPickRunRecord>;
  getRun(runId: string): Promise<PaperPickRunRecord | null>;
  getItem(itemId: string): Promise<PaperPickRunItem | null>;
  listItems(runId: string): Promise<readonly PaperPickRunItem[]>;
}
const clone = <T>(value: T): T => structuredClone(value);
const amount = (value: PaperPickBudgetAmount) =>
  Object.values(value).every((n) => Number.isSafeInteger(n) && n >= 0);
export class MemoryPaperPickRunRepository implements PaperPickRunRepository {
  private readonly runs = new Map<string, PaperPickRunRecord>();
  private readonly items = new Map<string, PaperPickRunItem>();
  private readonly claims = new Map<
    string,
    {
      token: string;
      leaseExpiresAt: string;
      runId: string;
      concurrencyHeld: boolean;
    }
  >();
  private readonly budgets = new Map<string, PaperPickBudgetAmount>();
  private readonly generationLimits = new Map<string, PaperPickBudgetLimits>();
  private readonly runGenerations = new Map<string, string>();
  private readonly admittedEvents = new Map<string, Set<string>>();
  private readonly reservations = new Map<
    string,
    Omit<PaperPickBudgetAmount, "concurrency">
  >();
  private sequence = 0;
  private queue: Promise<void> = Promise.resolve();
  private locked<T>(work: () => T | Promise<T>): Promise<T> {
    const result = this.queue.then(work);
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
  createGeneration(
    policyId: string,
    policyVersion: string,
    scheduledFor: string,
    limits: PaperPickBudgetLimits,
  ) {
    return this.locked(() => {
      if (!amount(limits)) throw new Error("paper-pick-budget-invalid");
      const generationId = createPaperPickGenerationId(
        policyId,
        policyVersion,
        scheduledFor,
      );
      const existing = this.generationLimits.get(generationId);
      if (existing && JSON.stringify(existing) !== JSON.stringify(limits))
        throw new Error("paper-pick-generation-replay-conflict");
      this.generationLimits.set(generationId, structuredClone(limits));
      if (!this.budgets.has(generationId))
        this.budgets.set(generationId, {
          modelCalls: 0,
          inputTokens: 0,
          outputTokens: 0,
          costMicros: 0,
          concurrency: 0,
        });
      if (!this.admittedEvents.has(generationId))
        this.admittedEvents.set(generationId, new Set());
      return generationId;
    });
  }
  admitEvent(
    generationId: string,
    eventId: string,
    eventVersion: number,
    maximumEvents: number,
  ) {
    return this.locked(() => {
      const admitted = this.admittedEvents.get(generationId);
      const limits = this.generationLimits.get(generationId);
      if (!admitted || !limits)
        throw new Error("paper-pick-generation-missing");
      if (
        !eventId ||
        !Number.isSafeInteger(eventVersion) ||
        eventVersion < 1 ||
        maximumEvents !== limits.events
      )
        throw new Error("paper-pick-event-admission-invalid");
      const identity = eventId;
      if (admitted.has(identity)) return "existing" as const;
      if (admitted.size >= maximumEvents) return "event-limit" as const;
      admitted.add(identity);
      return "admitted" as const;
    });
  }
  createRun(
    identity: PaperPickRunIdentityInput,
    createdAt: string,
    candidates: readonly {
      readonly eventId: string;
      readonly eventVersion: number;
      readonly sportKey: string;
      readonly leagueKey: string;
      readonly participantIds: readonly string[];
      readonly startsAt: string;
    }[],
    generationId: string,
  ) {
    return this.locked(() => {
      const runId = createPaperPickRunId(identity);
      const existing = this.runs.get(runId);
      if (existing)
        return { outcome: "duplicate" as const, run: clone(existing) };
      if (!this.generationLimits.has(generationId))
        throw new Error("paper-pick-generation-missing");
      const run = Object.freeze({
        ...identity,
        runId,
        generationId,
        createdAt,
        state: "ready" as const,
        counters: {
          discovered: 0,
          terminal: 0,
          evaluations: 0,
          attempts: 0,
          skipped: 0,
          limits: 0,
          failures: 0,
        },
        candidateManifest: normalizePaperPickCandidateManifest(
          identity,
          candidates,
        ),
      });
      this.runs.set(runId, run);
      this.runGenerations.set(runId, generationId);
      return { outcome: "created" as const, run: clone(run) };
    });
  }
  createItem(
    runId: string,
    candidate: {
      readonly eventId: string;
      readonly eventVersion: number;
      readonly sportKey: string;
      readonly leagueKey: string;
      readonly participantIds: readonly string[];
      readonly startsAt: string;
    },
    mode: "shadow" | "paper",
  ) {
    return this.locked(() => {
      if (!this.runs.has(runId)) throw new Error("paper-pick-run-missing");
      const itemId = createPaperPickItemId(
        runId,
        candidate.eventId,
        candidate.eventVersion,
      );
      const existing = this.items.get(itemId);
      if (existing) {
        if (existing.mode !== mode)
          throw new Error("paper-pick-item-replay-conflict");
        return clone(existing);
      }
      const item: PaperPickRunItem = Object.freeze({
        itemId,
        runId,
        ...structuredClone(candidate),
        mode,
        state: "ready",
      });
      this.items.set(itemId, item);
      return clone(item);
    });
  }
  claimItem(itemId: string, owner: string, now: string, leaseMs: number) {
    return this.locked(() => {
      const item = this.items.get(itemId);
      if (!item || item.state === "terminal") return null;
      const prior = this.claims.get(itemId);
      if (prior && Date.parse(prior.leaseExpiresAt) > Date.parse(now))
        return null;
      if (prior?.concurrencyHeld) {
        const generationId = this.runGenerations.get(prior.runId);
        const budget = generationId ? this.budgets.get(generationId) : null;
        if (!generationId || !budget)
          throw new Error("paper-pick-generation-missing");
        this.budgets.set(generationId, {
          ...budget,
          concurrency: Math.max(0, budget.concurrency - 1),
        });
        prior.concurrencyHeld = false;
      }
      assertPaperPickItemTransition(item.state, "claimed");
      const token = `${owner}:${++this.sequence}`;
      const leaseExpiresAt = new Date(Date.parse(now) + leaseMs).toISOString();
      const claimed = Object.freeze({ ...item, state: "claimed" as const });
      this.items.set(itemId, claimed);
      this.claims.set(itemId, {
        token,
        leaseExpiresAt,
        runId: item.runId,
        concurrencyHeld: false,
      });
      return { item: clone(claimed), token, leaseExpiresAt };
    });
  }
  renewItem(itemId: string, token: string, now: string, leaseMs: number) {
    return this.locked(() => {
      const claim = this.claims.get(itemId);
      const item = this.items.get(itemId);
      if (
        !claim ||
        !item ||
        claim.token !== token ||
        Date.parse(claim.leaseExpiresAt) <= Date.parse(now)
      )
        throw new Error("paper-pick-lease-lost");
      claim.leaseExpiresAt = new Date(Date.parse(now) + leaseMs).toISOString();
      return { item: clone(item), token, leaseExpiresAt: claim.leaseExpiresAt };
    });
  }
  reserve(
    itemId: string,
    token: string,
    requested: PaperPickBudgetAmount,
    limits: PaperPickBudgetLimits,
  ) {
    return this.locked(() => {
      if (!amount(requested) || !amount(limits))
        throw new Error("paper-pick-budget-invalid");
      const claim = this.claims.get(itemId);
      const runId = this.items.get(itemId)?.runId;
      const generationId = runId ? this.runGenerations.get(runId) : undefined;
      const current = generationId ? this.budgets.get(generationId) : null;
      const authoritativeLimits = generationId
        ? this.generationLimits.get(generationId)
        : null;
      if (
        !claim ||
        claim.token !== token ||
        !current ||
        !generationId ||
        !authoritativeLimits
      )
        throw new Error("paper-pick-lease-lost");
      if (JSON.stringify(limits) !== JSON.stringify(authoritativeLimits))
        throw new Error("paper-pick-budget-policy-conflict");
      const increment = {
        ...requested,
        concurrency: claim.concurrencyHeld ? 0 : requested.concurrency,
      };
      const next = Object.fromEntries(
        Object.keys(current).map((key) => [
          key,
          current[key as keyof PaperPickBudgetAmount] +
            increment[key as keyof PaperPickBudgetAmount],
        ]),
      ) as unknown as PaperPickBudgetAmount;
      if (next.concurrency > limits.concurrency)
        return "concurrency-limit" as const;
      if (next.modelCalls > limits.modelCalls)
        return "model-call-limit" as const;
      if (
        next.inputTokens > limits.inputTokens ||
        next.outputTokens > limits.outputTokens
      )
        return "token-limit" as const;
      if (next.costMicros > limits.costMicros) return "cost-limit" as const;
      this.budgets.set(generationId, next);
      if (increment.concurrency) claim.concurrencyHeld = true;
      this.reservations.set(token, {
        modelCalls: requested.modelCalls,
        inputTokens: requested.inputTokens,
        outputTokens: requested.outputTokens,
        costMicros: requested.costMicros,
      });
      return "reserved" as const;
    });
  }
  reconcile(
    itemId: string,
    token: string,
    actual: Omit<PaperPickBudgetAmount, "concurrency">,
  ) {
    return this.locked(() => {
      const claim = this.claims.get(itemId);
      const runId = this.items.get(itemId)?.runId;
      const generationId = runId ? this.runGenerations.get(runId) : undefined;
      const budget = generationId ? this.budgets.get(generationId) : null;
      const reserved = this.reservations.get(token);
      if (
        !claim ||
        claim.token !== token ||
        !generationId ||
        !budget ||
        !reserved
      )
        throw new Error("paper-pick-lease-lost");
      if (!amount({ ...actual, concurrency: 0 }))
        throw new Error("paper-pick-budget-invalid");
      for (const key of [
        "modelCalls",
        "inputTokens",
        "outputTokens",
        "costMicros",
      ] as const)
        if (actual[key] > reserved[key])
          throw new Error("paper-pick-usage-exceeds-reservation");
      this.budgets.set(generationId, {
        ...budget,
        modelCalls:
          budget.modelCalls - (reserved.modelCalls - actual.modelCalls),
        inputTokens:
          budget.inputTokens - (reserved.inputTokens - actual.inputTokens),
        outputTokens:
          budget.outputTokens - (reserved.outputTokens - actual.outputTokens),
        costMicros:
          budget.costMicros - (reserved.costMicros - actual.costMicros),
      });
      this.reservations.delete(token);
    });
  }
  releaseConcurrency(itemId: string, token: string) {
    return this.locked(() => {
      const claim = this.claims.get(itemId);
      const runId = this.items.get(itemId)?.runId;
      const generationId = runId ? this.runGenerations.get(runId) : undefined;
      const budget = generationId ? this.budgets.get(generationId) : null;
      if (!claim || claim.token !== token || !budget)
        throw new Error("paper-pick-lease-lost");
      if (claim.concurrencyHeld) {
        this.budgets.set(generationId!, {
          ...budget,
          concurrency: Math.max(0, budget.concurrency - 1),
        });
        claim.concurrencyHeld = false;
      }
    });
  }
  finishItem(
    itemId: string,
    token: string,
    terminal: PaperPickItemTerminal,
    reasonCode: string,
    now: string,
    terminalId?: string,
  ) {
    return this.locked(() => {
      const item = this.items.get(itemId);
      if (!item) throw new Error("paper-pick-item-missing");
      if (item.state === "terminal") {
        if (item.terminal !== terminal || item.reasonCode !== reasonCode)
          throw new Error("paper-pick-terminal-conflict");
        return clone(item);
      }
      const claim = this.claims.get(itemId);
      if (
        !claim ||
        claim.token !== token ||
        Date.parse(claim.leaseExpiresAt) <= Date.parse(now)
      )
        throw new Error("paper-pick-lease-lost");
      assertPaperPickItemTransition(item.state, "terminal");
      const finished = Object.freeze({
        ...item,
        state: "terminal" as const,
        terminal,
        reasonCode,
        ...(terminalId ? { terminalId } : {}),
      });
      this.items.set(itemId, finished);
      return clone(finished);
    });
  }
  checkpointRun(runId: string) {
    return this.locked(() => {
      const run = this.runs.get(runId);
      if (!run) throw new Error("paper-pick-run-missing");
      if (run.state === "complete" || run.state === "stopped")
        return clone(run);
      const items = [...this.items.values()].filter(
        (item) => item.runId === runId,
      );
      const terminals = items.filter((item) => item.state === "terminal");
      const count = (kind: PaperPickItemTerminal) =>
        terminals.filter((item) => item.terminal === kind).length;
      const next: PaperPickRunRecord = Object.freeze({
        ...run,
        state:
          terminals.length === items.length
            ? "complete"
            : terminals.length
              ? "partial"
              : items.length
                ? "running"
                : "complete",
        counters: {
          discovered: items.length,
          terminal: terminals.length,
          evaluations: count("evaluation"),
          attempts: count("attempt"),
          skipped: count("skipped"),
          limits: count("limit"),
          failures: count("failed"),
        },
      });
      assertPaperPickTransition(run.state, next.state);
      this.runs.set(runId, next);
      return clone(next);
    });
  }
  getRun(runId: string) {
    return Promise.resolve(
      this.runs.has(runId) ? clone(this.runs.get(runId)!) : null,
    );
  }
  getItem(itemId: string) {
    return Promise.resolve(
      this.items.has(itemId) ? clone(this.items.get(itemId)!) : null,
    );
  }
  listItems(runId: string) {
    return Promise.resolve(
      [...this.items.values()]
        .filter((item) => item.runId === runId)
        .map(clone),
    );
  }
}
