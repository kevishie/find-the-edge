import {
  OpportunityLifecycleConflictError,
  type OpportunityLifecycleRepository,
} from "@find-the-edge/database";
import type { OpportunityLifecycleHead } from "@find-the-edge/domain";
import {
  OpportunityLifecycleService,
  type OpportunityLifecycleTelemetry,
} from "./opportunity-lifecycle-service";

export interface OpportunityExpirationCommand {
  readonly asOf: string;
  readonly sportKeys: readonly string[];
  readonly pageLimit?: number;
  readonly maximumPages?: number;
}
export interface OpportunityExpirationResult {
  readonly discoveredCount: number;
  readonly transitionCount: number;
  readonly expirationCount: number;
  readonly conflictCount: number;
  readonly staleActiveCount: number;
  readonly failureCount: number;
}
const SPORT_KEY = /^[a-z0-9][a-z0-9_-]{0,63}$/;
export class OpportunityExpirationWorker {
  constructor(
    private readonly dependencies: {
      readonly lifecycle: OpportunityLifecycleRepository;
      readonly service: OpportunityLifecycleService;
      readonly telemetry?: OpportunityLifecycleTelemetry;
    },
  ) {}
  async run(
    command: OpportunityExpirationCommand,
  ): Promise<OpportunityExpirationResult> {
    if (
      new Date(command.asOf).toISOString() !== command.asOf ||
      command.sportKeys.length === 0 ||
      new Set(command.sportKeys).size !== command.sportKeys.length ||
      command.sportKeys.some((sportKey) => !SPORT_KEY.test(sportKey))
    )
      throw new Error("opportunity-expiration-command-invalid");
    const pageLimit = command.pageLimit ?? 100;
    const maximumPages = command.maximumPages ?? 10;
    if (
      !Number.isSafeInteger(pageLimit) ||
      pageLimit < 1 ||
      pageLimit > 100 ||
      !Number.isSafeInteger(maximumPages) ||
      maximumPages < 1 ||
      maximumPages > 100
    )
      throw new Error("opportunity-expiration-command-invalid");
    const discovered = new Map<string, OpportunityLifecycleHead>();
    const staleActiveKeys = new Set<string>();
    const discoveryFailureKeys = new Set<string>();
    let failureCount = 0;
    for (const sportKey of [...command.sportKeys].sort()) {
      for (const mode of ["due", "fresh"] as const) {
        const through = mode === "due" ? command.asOf : undefined;
        let cursor =
          (await this.dependencies.lifecycle.getSweepCursor(sportKey, mode)) ??
          undefined;
        for (let pageNumber = 0; pageNumber < maximumPages; pageNumber += 1) {
          const page = await this.dependencies.lifecycle.discoverActive({
            sportKey,
            asOf: command.asOf,
            ...(through ? { through } : {}),
            limit: pageLimit,
            ...(cursor ? { cursor } : {}),
          });
          for (const key of page.staleActiveKeys) staleActiveKeys.add(key);
          const newFailureKeys = page.discoveryFailureKeys.filter(
            (key) => !discoveryFailureKeys.has(key),
          );
          for (const key of newFailureKeys) discoveryFailureKeys.add(key);
          if (newFailureKeys.length > 0) {
            failureCount += newFailureKeys.length;
            try {
              this.dependencies.telemetry?.emit({
                outcome: "failure",
                cause: "sweep",
                sportKey,
                fromState: null,
                toState: null,
                staleActiveCount: 0,
                transitionCount: 0,
                expirationCount: 0,
                conflictCount: 0,
                failureCount: newFailureKeys.length,
              });
            } catch {
              // Metrics are non-authoritative.
            }
          }
          for (const head of page.items)
            discovered.set(head.logicalOpportunityId, head);
          cursor = page.nextCursor ?? undefined;
          if (!cursor) break;
        }
        await this.dependencies.lifecycle.setSweepCursor({
          sportKey,
          mode,
          cursor: cursor ?? null,
          updatedAt: command.asOf,
        });
      }
    }
    let transitionCount = 0;
    let expirationCount = 0;
    let conflictCount = 0;
    for (let head of discovered.values()) {
      let result;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          result = await this.dependencies.service.sweepHead(
            head,
            command.asOf,
          );
          break;
        } catch (error) {
          if (!(error instanceof OpportunityLifecycleConflictError)) {
            failureCount += 1;
            try {
              this.dependencies.telemetry?.emit({
                outcome: "failure",
                cause: "sweep",
                sportKey: head.sportKey,
                fromState: head.state,
                toState: null,
                staleActiveCount: 0,
                transitionCount: 0,
                expirationCount: 0,
                conflictCount: 0,
                failureCount: 1,
              });
            } catch {
              // Metrics are non-authoritative.
            }
            break;
          }
          conflictCount += 1;
          try {
            this.dependencies.telemetry?.emit({
              outcome: "conflict",
              cause: "sweep",
              sportKey: head.sportKey,
              fromState: head.state,
              toState: null,
              staleActiveCount: 0,
              transitionCount: 0,
              expirationCount: 0,
              conflictCount: 1,
              failureCount: 0,
            });
          } catch {
            // Metrics are non-authoritative.
          }
          if (attempt === 2) break;
          const winner = await this.dependencies.lifecycle.get(
            head.logicalOpportunityId,
          );
          if (!winner || winner.state !== "active") break;
          head = winner;
        }
      }
      if (result?.outcome === "applied") {
        transitionCount += 1;
        if (result.head.state === "stale" || result.head.state === "closed")
          expirationCount += 1;
      }
    }
    try {
      this.dependencies.telemetry?.emit({
        outcome: "transition",
        cause: "sweep",
        sportKey: "all",
        fromState: null,
        toState: null,
        staleActiveCount: staleActiveKeys.size,
        transitionCount,
        expirationCount,
        conflictCount,
        failureCount,
      });
    } catch {
      // Metrics are non-authoritative.
    }
    return Object.freeze({
      discoveredCount: discovered.size,
      transitionCount,
      expirationCount,
      conflictCount,
      staleActiveCount: staleActiveKeys.size,
      failureCount,
    });
  }
}
