import type {
  EventIngestionStore,
  ResultRepository,
} from "@find-the-edge/database";
import type { EntityId, IsoTimestamp, SportKey } from "@find-the-edge/domain";
import type {
  CompletedResultsAdapterRegistry,
  FeedCoverageRegistry,
} from "@find-the-edge/providers";
import { validateCompletedResultPage } from "@find-the-edge/providers";
import {
  mlbResultValidator,
  soccerResultValidator,
  type SportResultValidator,
} from "@find-the-edge/sports";

export interface CompletedResultCommand {
  readonly attemptId: string;
  readonly sportKey: SportKey;
  readonly leagueKey: string;
  readonly windowStart: IsoTimestamp;
  readonly windowEnd: IsoTimestamp;
  readonly pageLimit: number;
  readonly maxPages: number;
  readonly cursor?: string;
  readonly mode?: "scheduled" | "backfill";
}
export interface CompletedResultCounters {
  providerRequests: number;
  pages: number;
  finalized: number;
  corrected: number;
  duplicate: number;
  unresolved: number;
  stale: number;
  failed: number;
  quotaUsed: number;
}
export interface CompletedResultRun {
  readonly attemptId: string;
  readonly sportKey: SportKey;
  readonly leagueKey: string;
  readonly providerId?: string;
  readonly status: "succeeded" | "failed";
  readonly counters: CompletedResultCounters;
  readonly nextCursor?: string;
  readonly failureCode?: string;
}
const validators: Record<string, SportResultValidator> = {
  mlb: mlbResultValidator,
  soccer: soccerResultValidator,
};
export const validateCompletedResultCommand = (
  raw: unknown,
): CompletedResultCommand => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new Error("invalid-result-command");
  const input = raw as Record<string, unknown>,
    isIso = (value: unknown): value is string =>
      typeof value === "string" &&
      value.length <= 40 &&
      Number.isFinite(Date.parse(value)) &&
      new Date(value).toISOString() === value,
    allowed = [
      "attemptId",
      "sportKey",
      "leagueKey",
      "windowStart",
      "windowEnd",
      "pageLimit",
      "maxPages",
      "cursor",
      "mode",
    ];
  if (
    !Object.keys(input).every((key) => allowed.includes(key)) ||
    !allowed.slice(0, 7).every((key) => Object.hasOwn(input, key)) ||
    typeof input["attemptId"] !== "string" ||
    !input["attemptId"] ||
    input["attemptId"].length > 256 ||
    typeof input["leagueKey"] !== "string" ||
    !input["leagueKey"] ||
    input["leagueKey"].length > 128 ||
    typeof input["sportKey"] !== "string" ||
    input["sportKey"].length > 64 ||
    !validators[input["sportKey"]] ||
    typeof input["windowStart"] !== "string" ||
    typeof input["windowEnd"] !== "string" ||
    typeof input["pageLimit"] !== "number" ||
    typeof input["maxPages"] !== "number" ||
    (input["cursor"] !== undefined &&
      (typeof input["cursor"] !== "string" ||
        !input["cursor"] ||
        input["cursor"].length > 1024)) ||
    (input["mode"] !== undefined &&
      (typeof input["mode"] !== "string" ||
        !["scheduled", "backfill"].includes(input["mode"]))) ||
    !Number.isSafeInteger(input["pageLimit"]) ||
    input["pageLimit"] < 1 ||
    input["pageLimit"] > 100 ||
    !Number.isSafeInteger(input["maxPages"]) ||
    input["maxPages"] < 1 ||
    input["maxPages"] > 20 ||
    !isIso(input["windowStart"]) ||
    !isIso(input["windowEnd"]) ||
    Date.parse(input["windowStart"]) >= Date.parse(input["windowEnd"]) ||
    Date.parse(input["windowEnd"]) - Date.parse(input["windowStart"]) >
      31 * 86400000
  )
    throw new Error("invalid-result-command");
  return input as unknown as CompletedResultCommand;
};
export interface ExactResultParticipantResolver {
  resolve(input: {
    providerId: string;
    sportKey: SportKey;
    leagueKey: string;
    providerParticipantIds: readonly string[];
    canonicalParticipantIds: readonly EntityId[];
  }): Promise<
    | readonly {
        readonly providerParticipantId: string;
        readonly canonicalParticipantId: EntityId;
      }[]
    | null
  >;
}
export class CompletedResultOrchestrator {
  constructor(
    readonly coverage: FeedCoverageRegistry,
    readonly adapters: CompletedResultsAdapterRegistry,
    readonly events: Pick<EventIngestionStore, "resolveExactCanonicalBinding">,
    readonly results: ResultRepository,
    readonly participants: ExactResultParticipantResolver,
    readonly paperGrading?: {
      gradeCurrentResult(
        eventId: string,
        resultObservationId: string,
      ): Promise<{ readonly failed: number }>;
    },
  ) {}
  async execute(rawCommand: unknown): Promise<CompletedResultRun> {
    const counters: CompletedResultCounters = {
      providerRequests: 0,
      pages: 0,
      finalized: 0,
      corrected: 0,
      duplicate: 0,
      unresolved: 0,
      stale: 0,
      failed: 0,
      quotaUsed: 0,
    };
    const addCounter = (key: keyof CompletedResultCounters, amount = 1) => {
      if (
        !Number.isSafeInteger(amount) ||
        amount < 0 ||
        !Number.isSafeInteger(counters[key] + amount)
      )
        throw new Error("result-counter-overflow");
      counters[key] += amount;
    };
    let providerId: string | undefined;
    let command: CompletedResultCommand | undefined;
    const raw =
      rawCommand && typeof rawCommand === "object" && !Array.isArray(rawCommand)
        ? (rawCommand as Record<string, unknown>)
        : {};
    const safeAttemptId =
      typeof raw["attemptId"] === "string" && raw["attemptId"].length <= 256
        ? raw["attemptId"]
        : "invalid-result-command";
    const safeSportKey =
      typeof raw["sportKey"] === "string" && raw["sportKey"].length <= 64
        ? (raw["sportKey"] as SportKey)
        : ("unknown" as SportKey);
    const safeLeagueKey =
      typeof raw["leagueKey"] === "string" && raw["leagueKey"].length <= 128
        ? raw["leagueKey"]
        : "unknown";
    const saveRun = async (run: Parameters<ResultRepository["saveRun"]>[0]) => {
      try {
        await this.results.saveRun(run);
        return true;
      } catch {
        return false;
      }
    };
    try {
      command = validateCompletedResultCommand(rawCommand);
      const resolved = this.coverage.resolve({
        sportKey: command.sportKey,
        leagueKey: command.leagueKey,
        capability: "results",
      });
      if (!resolved.supported) throw new Error("coverage-unavailable");
      providerId = resolved.providerId;
      if (
        !providerId ||
        providerId.length > 128 ||
        providerId !== providerId.trim()
      )
        throw new Error("provider-id-invalid");
      const adapter = this.adapters.get(
        providerId,
        command.sportKey,
        command.leagueKey,
      );
      if (!adapter) throw new Error("adapter-unavailable");
      const mode = command.mode ?? "backfill";
      const checkpointKey =
        mode === "scheduled"
          ? `${providerId}:${command.sportKey}:${command.leagueKey}:scheduled`
          : `${providerId}:${command.sportKey}:${command.leagueKey}:backfill:${command.windowStart}:${command.windowEnd}`;
      const ownsCheckpoint = command.cursor === undefined;
      const stored =
        command.cursor === undefined
          ? await this.results.checkpoint(checkpointKey)
          : undefined;
      let resumed:
        | { cursor: string; windowStart: IsoTimestamp; windowEnd: IsoTimestamp }
        | undefined;
      if (stored) {
        try {
          const parsed = JSON.parse(stored) as Record<string, unknown>;
          const checkpointIso = (value: unknown): value is IsoTimestamp =>
            typeof value === "string" &&
            value.length <= 40 &&
            Number.isFinite(Date.parse(value)) &&
            new Date(value).toISOString() === value;
          if (
            !parsed ||
            typeof parsed !== "object" ||
            Array.isArray(parsed) ||
            Object.keys(parsed).length !== 4 ||
            !Object.keys(parsed).every((k) =>
              ["cursor", "windowStart", "windowEnd", "mode"].includes(k),
            ) ||
            typeof parsed["cursor"] !== "string" ||
            !parsed["cursor"] ||
            parsed["cursor"] !== parsed["cursor"].trim() ||
            parsed["cursor"].length > 1024 ||
            !checkpointIso(parsed["windowStart"]) ||
            !checkpointIso(parsed["windowEnd"]) ||
            Date.parse(parsed["windowStart"]) >=
              Date.parse(parsed["windowEnd"]) ||
            Date.parse(parsed["windowEnd"]) -
              Date.parse(parsed["windowStart"]) >
              31 * 86_400_000 ||
            (mode === "backfill" &&
              (parsed["windowStart"] !== command.windowStart ||
                parsed["windowEnd"] !== command.windowEnd)) ||
            parsed["mode"] !== mode
          )
            throw new Error();
          resumed = parsed as unknown as typeof resumed;
        } catch {
          throw new Error("checkpoint-invalid");
        }
      }
      let cursor = command.cursor ?? resumed?.cursor;
      const windowStart = resumed?.windowStart ?? command.windowStart,
        windowEnd = resumed?.windowEnd ?? command.windowEnd;
      const seen = new Set<string>();
      for (let pageNumber = 0; pageNumber < command.maxPages; pageNumber++) {
        if (cursor !== undefined && !cursor.length)
          throw new Error("cursor-invalid");
        if (cursor !== undefined && seen.has(cursor))
          throw new Error("cursor-stalled");
        if (cursor !== undefined) seen.add(cursor);
        const request = {
          sportKey: command.sportKey,
          leagueKey: command.leagueKey,
          windowStart,
          windowEnd,
          limit: command.pageLimit,
          ...(cursor !== undefined ? { cursor } : {}),
        };
        const page = validateCompletedResultPage(
          await adapter.listCompletedResults(request),
          request,
          providerId,
        );
        addCounter("providerRequests", page.providerRequests);
        addCounter("quotaUsed", page.quotaUsed);
        addCounter("pages");
        for (const providerResult of page.results) {
          const providerSemanticValidation = validators[
            command.sportKey
          ]!.validateResult({
            state: providerResult.state,
            scoreScope: providerResult.scoreScope,
            ...(providerResult.scores
              ? {
                  scores: providerResult.scores.map((score) => ({
                    participantId: score.providerParticipantId as EntityId,
                    score: score.score,
                  })),
                }
              : {}),
            ...(providerResult.detail ? { detail: providerResult.detail } : {}),
          });
          if (!providerSemanticValidation.valid)
            throw new Error("result-item-invalid");
        }
        for (const providerResult of page.results) {
          const binding = await this.events.resolveExactCanonicalBinding({
            providerId,
            providerEventId: providerResult.providerEventId,
            sportKey: command.sportKey,
            leagueKey: command.leagueKey,
          });
          if (!binding) {
            await this.results.persistUnresolved({
              providerId,
              providerEventId: providerResult.providerEventId,
              sportKey: command.sportKey,
              leagueKey: command.leagueKey,
              state: providerResult.state,
              scoreScope: providerResult.scoreScope,
              ...(providerResult.scores
                ? { scores: providerResult.scores }
                : {}),
              ...(providerResult.detail
                ? { detail: providerResult.detail }
                : {}),
              providerRevision: providerResult.revision,
              providerTimestamp: providerResult.providerTimestamp,
              retrievedAt: page.retrievedAt,
              sourceProvenance: `${providerId}:results`,
              reason: "event-unmapped",
            });
            addCounter("unresolved");
            continue;
          }
          const mapped = providerResult.scores
            ? await this.participants.resolve({
                providerId,
                sportKey: command.sportKey,
                leagueKey: command.leagueKey,
                providerParticipantIds: providerResult.scores.map(
                  (score) => score.providerParticipantId,
                ),
                canonicalParticipantIds: binding.participantIds,
              })
            : undefined;
          const mapping = mapped
            ? new Map(
                mapped.map((item) => [
                  item.providerParticipantId,
                  item.canonicalParticipantId,
                ]),
              )
            : undefined;
          const scores =
            mapping && providerResult.scores
              ? providerResult.scores.map((providerScore) => ({
                  participantId: mapping.get(
                    providerScore.providerParticipantId,
                  )!,
                  score: providerScore.score,
                }))
              : undefined;
          if (
            providerResult.scores &&
            (!mapped ||
              new Set(mapped.map((item) => item.providerParticipantId)).size !==
                providerResult.scores.length ||
              new Set(mapped.map((item) => item.canonicalParticipantId))
                .size !== binding.participantIds.length ||
              mapped.length !== binding.participantIds.length ||
              providerResult.scores.some(
                (score) => !mapping?.has(score.providerParticipantId),
              ) ||
              binding.participantIds.some(
                (id) =>
                  !mapped.some((item) => item.canonicalParticipantId === id),
              ))
          ) {
            await this.results.persistUnresolved({
              providerId,
              providerEventId: providerResult.providerEventId,
              sportKey: command.sportKey,
              leagueKey: command.leagueKey,
              state: providerResult.state,
              scoreScope: providerResult.scoreScope,
              ...(providerResult.scores
                ? { scores: providerResult.scores }
                : {}),
              ...(providerResult.detail
                ? { detail: providerResult.detail }
                : {}),
              providerRevision: providerResult.revision,
              providerTimestamp: providerResult.providerTimestamp,
              retrievedAt: page.retrievedAt,
              sourceProvenance: `${providerId}:results`,
              reason: "scope-mismatch",
            });
            addCounter("unresolved");
            continue;
          }
          const validation = validators[command.sportKey]!.validateResult({
            state: providerResult.state,
            scoreScope: providerResult.scoreScope,
            ...(scores ? { scores } : {}),
            ...(providerResult.detail ? { detail: providerResult.detail } : {}),
          });
          if (!validation.valid) {
            throw new Error("result-item-invalid");
          }
          const outcome = await this.results.persist({
            providerId,
            providerEventId: providerResult.providerEventId,
            canonicalEventId: binding.id,
            canonicalEventVersion: binding.version,
            sportKey: command.sportKey,
            leagueKey: command.leagueKey,
            state: providerResult.state,
            scoreScope: providerResult.scoreScope,
            ...(scores ? { scores } : {}),
            ...(providerResult.detail ? { detail: providerResult.detail } : {}),
            providerRevision: providerResult.revision,
            providerTimestamp: providerResult.providerTimestamp,
            retrievedAt: page.retrievedAt,
            sourceProvenance: `${providerId}:results`,
          });
          if (
            this.paperGrading &&
            (await this.results.current(binding.id))?.id ===
              outcome.observation.id
          ) {
            const grading = await this.paperGrading.gradeCurrentResult(
              binding.id,
              outcome.observation.id,
            );
            if (grading.failed > 0) throw new Error("paper-grading-failed");
          }
          if (outcome.history === "duplicate") addCounter("duplicate");
          if (outcome.history === "duplicate" && outcome.current === "stale")
            continue;
          if (outcome.current === "finalized") addCounter("finalized");
          else if (outcome.current === "corrected") addCounter("corrected");
          else addCounter("stale");
        }
        if (!page.nextCursor) {
          if (ownsCheckpoint) await this.results.saveCheckpoint(checkpointKey);
          const run = {
            attemptId: command.attemptId,
            sportKey: command.sportKey,
            leagueKey: command.leagueKey,
            providerId,
            status: "succeeded",
            counters: { ...counters },
          } as const;
          const saved = await saveRun({
            id: command.attemptId,
            sportKey: command.sportKey,
            leagueKey: command.leagueKey,
            status: "succeeded",
            counters,
            updatedAt: new Date().toISOString(),
          });
          if (!saved)
            return {
              ...run,
              status: "failed",
              failureCode: "run-record-persistence-failed",
              counters: { ...counters, failed: counters.failed + 1 },
            };
          return run;
        }
        cursor = page.nextCursor;
        if (ownsCheckpoint)
          await this.results.saveCheckpoint(
            checkpointKey,
            JSON.stringify({ cursor, windowStart, windowEnd, mode }),
          );
      }
      const run = {
        attemptId: command.attemptId,
        sportKey: command.sportKey,
        leagueKey: command.leagueKey,
        providerId,
        status: "succeeded",
        counters: { ...counters },
        ...(cursor ? { nextCursor: cursor } : {}),
      } as const;
      const saved = await saveRun({
        id: command.attemptId,
        sportKey: command.sportKey,
        leagueKey: command.leagueKey,
        status: "continuation",
        counters: { ...counters },
        updatedAt: new Date().toISOString(),
      });
      if (!saved)
        return {
          ...run,
          status: "failed",
          failureCode: "run-record-persistence-failed",
          counters: { ...counters, failed: counters.failed + 1 },
        };
      return run;
    } catch (error) {
      addCounter("failed");
      const run = {
        attemptId: command?.attemptId ?? safeAttemptId,
        sportKey: command?.sportKey ?? safeSportKey,
        leagueKey: command?.leagueKey ?? safeLeagueKey,
        ...(providerId ? { providerId } : {}),
        status: "failed",
        counters,
        failureCode:
          error instanceof Error && /^[a-z-]+$/.test(error.message)
            ? error.message
            : "result-ingestion-failed",
      } as const;
      await saveRun({
        id: command?.attemptId ?? safeAttemptId,
        sportKey: command?.sportKey ?? safeSportKey,
        leagueKey: command?.leagueKey ?? safeLeagueKey,
        status: "failed",
        counters,
        failureCode: run.failureCode,
        updatedAt: new Date().toISOString(),
      });
      return run;
    }
  }
}
