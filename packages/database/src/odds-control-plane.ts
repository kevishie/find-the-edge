import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
/* eslint-disable @typescript-eslint/require-await -- memory parity deliberately implements the async repository contract */
import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  UpdateCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import type { OddsEvidenceGap } from "@find-the-edge/domain";

export type OddsRunStatus = "running" | "completed" | "failed" | "skipped";
export interface OddsRunRecord {
  readonly version?: number;
  readonly runId: string;
  readonly leagueKey: string;
  readonly providerId: string;
  readonly policyVersion: string;
  readonly status: OddsRunStatus;
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly failureReason?: string;
  readonly skipReason?: string;
  readonly evidenceCommitted: boolean;
  readonly quotaCost: number;
}
export interface OddsAttemptRecord {
  readonly attemptId: string;
  readonly runId: string;
  readonly pageToken: string;
  readonly requestedAt: string;
  readonly state?: "reserved" | "succeeded" | "failed" | "ambiguous";
  readonly leaseUntil?: string;
  readonly providerId?: string;
  readonly leagueKey?: string;
  readonly capability?: "schedule" | "odds" | "account" | "splits";
  readonly completedAt?: string;
  readonly quotaCost?: number;
  readonly ambiguousUntil?: string;
  readonly failureReason?: string;
}
export interface SealedOddsPage {
  readonly runId: string;
  readonly pageToken: string;
  readonly nextPageToken?: string;
  readonly responseDigest: string;
  readonly normalizedItems: readonly unknown[];
  readonly seenProviderEventIds?: readonly string[];
  readonly gaps: readonly OddsEvidenceGap[];
  readonly quotaCost: number;
  readonly sealedAt: string;
  readonly committedAt?: string;
  readonly evidenceIntentAt?: string;
  readonly metricDeliveredAt?: string;
}
export interface OddsLeagueCheckpoint {
  readonly version?: number;
  readonly leagueKey: string;
  readonly providerId: string;
  readonly completedAt: string;
  readonly nextDueAt: string;
  readonly runId: string;
  /** Upcoming scheduled starts retained for cadence decisions between discovery runs. */
  readonly upcomingStarts?: readonly string[];
  readonly expectedProviderEventIds?: readonly string[];
  readonly expectedProviderEvents?: readonly {
    readonly providerEventId: string;
    readonly startsAt: string;
  }[];
  /** Contradictory committed schedule evidence invalidates prior readiness. */
  readonly unavailableReason?: "stored-event-conflict";
}
export interface OddsProviderHealth {
  readonly version?: number;
  /** provider+league+capability isolation key */
  readonly healthKey?: string;
  readonly providerId: string;
  readonly healthy: boolean;
  readonly status?: "healthy" | "degraded" | "unhealthy";
  /** A usable but incomplete provider capability. Downstream may consume only
   * the explicitly accepted evidence while operators retain the partial state. */
  readonly degraded?: boolean;
  readonly degradedReason?: "stored-event-conflict";
  readonly degradedCount?: number;
  readonly consecutiveSuccesses: number;
  readonly cooldownUntil?: string;
  readonly quotaRemaining?: number;
  /** Authoritative provider request window. Never populated from account RPM. */
  readonly rateWindow?: {
    readonly limit?: number;
    readonly remaining?: number;
    readonly resetsAt?: string;
    readonly probeUntil?: string;
  };
  readonly failureClass?: "transient" | "terminal" | "ambiguous";
  readonly failureReason?: string;
  readonly retryAt?: string;
  /** Only transient unhealthy records expire. Success and terminal audit remain durable. */
  readonly expiresAt?: number;
  readonly updatedAt: string;
}
const resetProviderRateWindow = (
  window: NonNullable<OddsProviderHealth["rateWindow"]>,
) => {
  const reset: {
    limit?: number;
    remaining?: number;
    resetsAt?: string;
    probeUntil?: string;
  } = { ...window };
  delete reset.remaining;
  delete reset.probeUntil;
  delete reset.resetsAt;
  return reset;
};
export interface OddsRunContinuation {
  readonly version?: number;
  readonly leagueKey: string;
  readonly runId: string;
  readonly providerId: string;
  readonly updatedAt: string;
  readonly startedAt?: string;
  readonly capability?: "schedule" | "odds" | "account" | "splits";
  readonly evidenceCommitted?: boolean;
  readonly quotaCost?: number;
  readonly ambiguousUntil?: string;
  readonly ownerId?: string;
  readonly leaseUntil?: string;
}
export interface OddsControlPlaneStore {
  getRun(runId: string): Promise<OddsRunRecord | null>;
  putRun(value: OddsRunRecord): Promise<void>;
  reserveAttempt(value: OddsAttemptRecord): Promise<boolean>;
  reserveQuotaAttempt(
    healthKey: string,
    reserve: number,
    cost: number,
    attempt: OddsAttemptRecord,
  ): Promise<boolean>;
  getAttempt(attemptId: string): Promise<OddsAttemptRecord | null>;
  completeAttempt(value: OddsAttemptRecord): Promise<void>;
  getPage(runId: string, token: string): Promise<SealedOddsPage | null>;
  sealPage(value: SealedOddsPage): Promise<boolean>;
  commitPage(runId: string, token: string, committedAt: string): Promise<void>;
  markEvidenceIntent(
    runId: string,
    token: string,
    markedAt: string,
  ): Promise<void>;
  commitEvidencePage(
    runId: string,
    token: string,
    committedAt: string,
  ): Promise<void>;
  markPageMetricDelivered(
    runId: string,
    token: string,
    deliveredAt: string,
  ): Promise<void>;
  getCheckpoint(leagueKey: string): Promise<OddsLeagueCheckpoint | null>;
  putCheckpoint(value: OddsLeagueCheckpoint): Promise<void>;
  getHealth(providerId: string): Promise<OddsProviderHealth | null>;
  putHealth(value: OddsProviderHealth): Promise<void>;
  reserveQuota(
    healthKey: string,
    reserve: number,
    cost: number,
    updatedAt: string,
  ): Promise<boolean>;
  reconcileQuota(
    healthKey: string,
    reservedCost: number,
    actualCost: number,
    reportedRemaining: number | undefined,
    updatedAt: string,
  ): Promise<void>;
  getContinuation(leagueKey: string): Promise<OddsRunContinuation | null>;
  putContinuation(value: OddsRunContinuation): Promise<void>;
  claimContinuation(value: OddsRunContinuation): Promise<OddsRunContinuation>;
  clearContinuation(
    leagueKey: string,
    expectedRunId?: string,
    expectedOwnerId?: string,
    expectedVersion?: number,
  ): Promise<void>;
  putGap(value: OddsEvidenceGap): Promise<boolean>;
}

const clone = <T>(value: T): T => structuredClone(value);
const replayMaterial = (value: unknown) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const material = { ...(value as Record<string, unknown>) };
  delete material["version"];
  return material;
};
const equalReplay = (left: unknown, right: unknown) =>
  JSON.stringify(replayMaterial(left)) ===
  JSON.stringify(replayMaterial(right));
const nextVersioned = <T extends { readonly version?: number }>(
  old: T | undefined,
  value: T,
  conflict: string,
): T => {
  if (!old) {
    if (value.version !== undefined && value.version !== 0)
      throw new Error(conflict);
    return { ...value, version: 1 };
  }
  if (equalReplay(old, value)) return old;
  if (value.version !== old.version) throw new Error(conflict);
  return { ...value, version: (old.version ?? 0) + 1 };
};
export class MemoryOddsControlPlaneStore implements OddsControlPlaneStore {
  readonly runs = new Map<string, OddsRunRecord>();
  readonly attempts = new Map<string, OddsAttemptRecord>();
  readonly pages = new Map<string, SealedOddsPage>();
  readonly checkpoints = new Map<string, OddsLeagueCheckpoint>();
  readonly health = new Map<string, OddsProviderHealth>();
  readonly gaps = new Map<string, OddsEvidenceGap>();
  readonly continuations = new Map<string, OddsRunContinuation>();
  async getRun(id: string) {
    return clone(this.runs.get(id) ?? null);
  }
  async putRun(v: OddsRunRecord) {
    const old = this.runs.get(v.runId);
    this.runs.set(
      v.runId,
      clone(nextVersioned(old, v, "run-transition-conflict")),
    );
  }
  async reserveAttempt(v: OddsAttemptRecord) {
    const old = this.attempts.get(v.attemptId);
    if (old?.completedAt) return false;
    if (
      old &&
      (!old.leaseUntil ||
        Date.parse(old.leaseUntil) > Date.parse(v.requestedAt))
    )
      return false;
    this.attempts.set(v.attemptId, clone({ ...v, state: "reserved" }));
    return true;
  }
  async reserveQuotaAttempt(
    k: string,
    reserve: number,
    cost: number,
    attempt: OddsAttemptRecord,
  ) {
    if (this.attempts.has(attempt.attemptId)) return false;
    let health = this.health.get(k);
    if (
      health?.rateWindow?.resetsAt &&
      Date.parse(health.rateWindow.resetsAt) <= Date.parse(attempt.requestedAt)
    ) {
      const resetHealth: OddsProviderHealth = {
        ...health,
        version: (health.version ?? 0) + 1,
        rateWindow: resetProviderRateWindow(health.rateWindow),
        updatedAt: attempt.requestedAt,
      };
      health = resetHealth;
      this.health.set(k, resetHealth);
    }
    const remaining = health?.rateWindow?.remaining ?? health?.quotaRemaining;
    if (health?.rateWindow && health.rateWindow.remaining === undefined)
      if (
        health.rateWindow.probeUntil &&
        Date.parse(health.rateWindow.probeUntil) >
          Date.parse(attempt.requestedAt)
      )
        return false;
      else if (health) {
        const probeUntil = new Date(
          Date.parse(attempt.requestedAt) + 60_000,
        ).toISOString();
        this.health.set(k, {
          ...health,
          version: (health.version ?? 0) + 1,
          rateWindow: { ...health.rateWindow, probeUntil },
          updatedAt: attempt.requestedAt,
        });
        this.attempts.set(
          attempt.attemptId,
          clone({ ...attempt, state: "reserved" }),
        );
        return true;
      }
    if (remaining !== undefined && remaining - cost < reserve) return false;
    if (remaining !== undefined && health)
      this.health.set(k, {
        ...health,
        version: (health.version ?? 0) + 1,
        ...(health.rateWindow
          ? {
              rateWindow: {
                ...health.rateWindow,
                remaining: remaining - cost,
              },
            }
          : { quotaRemaining: remaining - cost }),
        updatedAt: attempt.requestedAt,
      });
    this.attempts.set(
      attempt.attemptId,
      clone({ ...attempt, state: "reserved" }),
    );
    return true;
  }
  async getAttempt(id: string) {
    return clone(this.attempts.get(id) ?? null);
  }
  async completeAttempt(v: OddsAttemptRecord) {
    const old = this.attempts.get(v.attemptId);
    if (!old || old.runId !== v.runId || old.pageToken !== v.pageToken)
      throw new Error("attempt-transition-conflict");
    if (old.completedAt) return;
    this.attempts.set(
      v.attemptId,
      clone({
        ...old,
        ...v,
        state: v.state ?? (v.failureReason ? "failed" : "succeeded"),
      }),
    );
  }
  async getPage(r: string, t: string) {
    return clone(this.pages.get(`${r}#${t}`) ?? null);
  }
  async sealPage(v: SealedOddsPage) {
    const k = `${v.runId}#${v.pageToken}`;
    const old = this.pages.get(k);
    if (old) {
      if (old.responseDigest !== v.responseDigest)
        throw new Error("sealed-page-conflict");
      return false;
    }
    this.pages.set(k, clone(v));
    return true;
  }
  async commitPage(r: string, t: string, a: string) {
    const k = `${r}#${t}`;
    const v = this.pages.get(k);
    if (!v) throw new Error("sealed-page-missing");
    if (v.committedAt) {
      if (v.committedAt === a) return;
      throw new Error("page-transition-conflict");
    }
    this.pages.set(k, { ...v, committedAt: a });
  }
  async markEvidenceIntent(r: string, t: string, a: string) {
    const k = `${r}#${t}`;
    const page = this.pages.get(k);
    const run = this.runs.get(r);
    if (!page || !run) throw new Error("evidence-transition-conflict");
    if (page.evidenceIntentAt && page.evidenceIntentAt !== a)
      throw new Error("evidence-transition-conflict");
    this.pages.set(k, { ...page, evidenceIntentAt: a });
    this.runs.set(r, {
      ...run,
      version: (run.version ?? 0) + 1,
      evidenceCommitted: true,
      updatedAt: a,
    });
  }
  async commitEvidencePage(r: string, t: string, a: string) {
    const existing = await this.getPage(r, t);
    const existingRun = await this.getRun(r);
    if (existing?.committedAt) {
      if (existing.committedAt === a && existingRun?.evidenceCommitted) return;
      throw new Error("evidence-transition-conflict");
    }
    await this.commitPage(r, t, a);
    const run = this.runs.get(r);
    if (!run) throw new Error("run-transition-conflict");
    this.runs.set(r, {
      ...run,
      version: (run.version ?? 0) + 1,
      evidenceCommitted: true,
      updatedAt: a,
    });
  }
  async markPageMetricDelivered(r: string, t: string, a: string) {
    const k = `${r}#${t}`;
    const page = this.pages.get(k);
    if (!page?.committedAt) throw new Error("metric-transition-conflict");
    if (page.metricDeliveredAt) return;
    this.pages.set(k, { ...page, metricDeliveredAt: a });
  }
  async getCheckpoint(k: string) {
    return clone(this.checkpoints.get(k) ?? null);
  }
  async putCheckpoint(v: OddsLeagueCheckpoint) {
    const old = this.checkpoints.get(v.leagueKey);
    this.checkpoints.set(
      v.leagueKey,
      clone(nextVersioned(old, v, "checkpoint-transition-conflict")),
    );
  }
  async getHealth(k: string) {
    return clone(this.health.get(k) ?? null);
  }
  async putHealth(v: OddsProviderHealth) {
    const k = v.healthKey ?? v.providerId;
    const old = this.health.get(k);
    this.health.set(
      k,
      clone(nextVersioned(old, v, "health-transition-conflict")),
    );
  }
  async reserveQuota(
    k: string,
    reserve: number,
    cost: number,
    updatedAt: string,
  ) {
    let old = this.health.get(k);
    if (
      old?.rateWindow?.resetsAt &&
      Date.parse(old.rateWindow.resetsAt) <= Date.parse(updatedAt)
    ) {
      const resetHealth: OddsProviderHealth = {
        ...old,
        version: (old.version ?? 0) + 1,
        rateWindow: resetProviderRateWindow(old.rateWindow),
        updatedAt,
      };
      old = resetHealth;
      this.health.set(k, resetHealth);
    }
    const remaining = old?.rateWindow?.remaining ?? old?.quotaRemaining;
    if (old?.rateWindow && old.rateWindow.remaining === undefined) return false;
    if (remaining === undefined || !old) return true;
    if (remaining - cost < reserve) return false;
    this.health.set(k, {
      ...old,
      version: (old.version ?? 0) + 1,
      ...(old.rateWindow
        ? {
            rateWindow: {
              ...old.rateWindow,
              remaining: remaining - cost,
            },
          }
        : { quotaRemaining: remaining - cost }),
      updatedAt,
    });
    return true;
  }
  async reconcileQuota(
    k: string,
    reserved: number,
    actual: number,
    reported: number | undefined,
    updatedAt: string,
  ) {
    const old = this.health.get(k);
    const remaining = old?.rateWindow?.remaining ?? old?.quotaRemaining;
    if (remaining === undefined || !old) return;
    const nextRemaining =
      reported === undefined
        ? Math.max(0, remaining + reserved - actual)
        : Math.min(reported, Math.max(0, remaining + reserved - actual));
    this.health.set(k, {
      ...old,
      version: (old.version ?? 0) + 1,
      ...(old.rateWindow
        ? {
            rateWindow: { ...old.rateWindow, remaining: nextRemaining },
          }
        : { quotaRemaining: nextRemaining }),
      updatedAt,
    });
  }
  async getContinuation(k: string) {
    return clone(this.continuations.get(k) ?? null);
  }
  async putContinuation(v: OddsRunContinuation) {
    const old = this.continuations.get(v.leagueKey);
    this.continuations.set(
      v.leagueKey,
      clone(nextVersioned(old, v, "continuation-transition-conflict")),
    );
  }
  async claimContinuation(v: OddsRunContinuation) {
    const old = this.continuations.get(v.leagueKey);
    if (
      old &&
      (!v.ownerId ||
        (old.ownerId !== v.ownerId &&
          !!old.ownerId &&
          !!old.leaseUntil &&
          Date.parse(old.leaseUntil) > Date.parse(v.updatedAt)))
    )
      return clone(old);
    if (old) {
      const claimed = nextVersioned(
        old,
        { ...v, version: old.version ?? 0 },
        "continuation-transition-conflict",
      );
      this.continuations.set(v.leagueKey, clone(claimed));
      return clone(claimed);
    }
    const created = nextVersioned(
      undefined,
      v,
      "continuation-transition-conflict",
    );
    this.continuations.set(v.leagueKey, clone(created));
    return clone(created);
  }
  async clearContinuation(
    k: string,
    expectedRunId?: string,
    expectedOwnerId?: string,
    expectedVersion?: number,
  ) {
    const old = this.continuations.get(k);
    if (
      (expectedRunId !== undefined && old?.runId !== expectedRunId) ||
      (expectedOwnerId !== undefined && old?.ownerId !== expectedOwnerId) ||
      (expectedVersion !== undefined && old?.version !== expectedVersion)
    )
      throw new Error("continuation-transition-conflict");
    this.continuations.delete(k);
  }
  async putGap(v: OddsEvidenceGap) {
    if (this.gaps.has(v.gapId)) return false;
    this.gaps.set(v.gapId, clone(v));
    return true;
  }
}

const key = (kind: string, id: string) => ({
  pk: `ODDS_CONTROL#${kind}#${id}`,
  sk: "CURRENT",
});
export class DynamoOddsControlPlaneStore implements OddsControlPlaneStore {
  constructor(
    private readonly client: DynamoDBDocumentClient,
    private readonly tableName: string,
  ) {}
  private async get<T>(kind: string, id: string): Promise<T | null> {
    const r = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: key(kind, id),
        ConsistentRead: true,
      }),
    );
    return (r.Item?.["value"] as T | undefined) ?? null;
  }
  private async put(
    kind: string,
    id: string,
    value: unknown,
    condition?: string,
    expressionAttributeNames?: Record<string, string>,
    expressionAttributeValues?: Record<string, unknown>,
  ) {
    try {
      await this.client.send(
        new PutCommand({
          TableName: this.tableName,
          Item: { ...key(kind, id), value },
          ...(condition ? { ConditionExpression: condition } : {}),
          ...(expressionAttributeNames
            ? { ExpressionAttributeNames: expressionAttributeNames }
            : {}),
          ...(expressionAttributeValues
            ? { ExpressionAttributeValues: expressionAttributeValues }
            : {}),
        }),
      );
      return true;
    } catch (e) {
      if (e instanceof Error && e.name === "ConditionalCheckFailedException")
        return false;
      throw e;
    }
  }
  private async putVersioned<T extends { readonly version?: number }>(
    kind: string,
    id: string,
    value: T,
    conflict: string,
  ) {
    const old = await this.get<T>(kind, id);
    if (old && equalReplay(old, value)) return;
    let next: T;
    try {
      next = nextVersioned(old ?? undefined, value, conflict);
    } catch {
      throw new Error(conflict);
    }
    const changed = await this.put(
      kind,
      id,
      next,
      old ? "#v.#version = :expected" : "attribute_not_exists(pk)",
      old ? { "#v": "value", "#version": "version" } : undefined,
      old ? { ":expected": old.version } : undefined,
    );
    if (changed) return;
    const winner = await this.get<T>(kind, id);
    if (winner && equalReplay(winner, value)) return;
    throw new Error(conflict);
  }
  private async currentRateHealth(healthKey: string, updatedAt: string) {
    for (let retry = 0; retry < 8; retry += 1) {
      const old = await this.getHealth(healthKey);
      if (
        !old?.rateWindow?.resetsAt ||
        Date.parse(old.rateWindow.resetsAt) > Date.parse(updatedAt)
      )
        return old;
      const reset: OddsProviderHealth = {
        ...old,
        rateWindow: resetProviderRateWindow(old.rateWindow),
        updatedAt,
      };
      try {
        await this.putVersioned(
          "HEALTH",
          healthKey,
          {
            ...reset,
            ...(old.version === undefined ? {} : { version: old.version }),
          },
          "health-transition-conflict",
        );
      } catch (error) {
        if (
          !(error instanceof Error) ||
          error.message !== "health-transition-conflict"
        )
          throw error;
        continue;
      }
      return this.getHealth(healthKey);
    }
    throw new Error("health-transition-conflict");
  }
  getRun(id: string) {
    return this.get<OddsRunRecord>("RUN", id);
  }
  async putRun(v: OddsRunRecord) {
    await this.putVersioned("RUN", v.runId, v, "run-transition-conflict");
  }
  async reserveAttempt(v: OddsAttemptRecord) {
    const old = await this.getAttempt(v.attemptId);
    if (old?.completedAt) return false;
    if (
      old &&
      (!old.leaseUntil ||
        Date.parse(old.leaseUntil) > Date.parse(v.requestedAt))
    )
      return false;
    return this.put(
      "ATTEMPT",
      v.attemptId,
      { ...v, state: "reserved" },
      old ? "#v.#r = :old" : "attribute_not_exists(pk)",
      old ? { "#v": "value", "#r": "requestedAt" } : undefined,
      old ? { ":old": old.requestedAt } : undefined,
    );
  }
  async reserveQuotaAttempt(
    healthKey: string,
    reserve: number,
    cost: number,
    attempt: OddsAttemptRecord,
  ) {
    const health = await this.currentRateHealth(healthKey, attempt.requestedAt);
    const rateRemaining = health?.rateWindow?.remaining;
    const legacyRemaining = health?.quotaRemaining;
    if (health?.rateWindow && rateRemaining === undefined) {
      const probeUntil = new Date(
        Date.parse(attempt.requestedAt) + 60_000,
      ).toISOString();
      try {
        await this.client.send(
          new TransactWriteCommand({
            TransactItems: [
              {
                Update: {
                  TableName: this.tableName,
                  Key: key("HEALTH", healthKey),
                  UpdateExpression:
                    "SET #v.#window.#probe = :probe, #v.#u = :updated, #v.#version = if_not_exists(#v.#version, :zero) + :one",
                  ConditionExpression: `attribute_not_exists(#v.#window.#remaining) AND ${health.version === undefined ? "attribute_not_exists(#v.#version)" : "#v.#version = :expectedVersion"} AND (attribute_not_exists(#v.#window.#probe) OR #v.#window.#probe <= :updated)`,
                  ExpressionAttributeNames: {
                    "#v": "value",
                    "#window": "rateWindow",
                    "#probe": "probeUntil",
                    "#remaining": "remaining",
                    "#u": "updatedAt",
                    "#version": "version",
                  },
                  ExpressionAttributeValues: {
                    ":probe": probeUntil,
                    ":updated": attempt.requestedAt,
                    ":one": 1,
                    ":zero": 0,
                    ...(health.version === undefined
                      ? {}
                      : { ":expectedVersion": health.version }),
                  },
                },
              },
              {
                Put: {
                  TableName: this.tableName,
                  Item: {
                    ...key("ATTEMPT", attempt.attemptId),
                    value: { ...attempt, state: "reserved" },
                  },
                  ConditionExpression: "attribute_not_exists(pk)",
                },
              },
            ],
          }),
        );
        return true;
      } catch (error) {
        if (
          error instanceof Error &&
          [
            "ConditionalCheckFailedException",
            "TransactionCanceledException",
          ].includes(error.name)
        )
          return false;
        throw error;
      }
    }
    if (rateRemaining === undefined && legacyRemaining === undefined)
      return this.reserveAttempt(attempt);
    const rateWindow = rateRemaining !== undefined;
    try {
      await this.client.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Update: {
                TableName: this.tableName,
                Key: key("HEALTH", healthKey),
                UpdateExpression: `SET ${rateWindow ? "#v.#window.#q" : "#v.#q"} = ${rateWindow ? "#v.#window.#q" : "#v.#q"} - :cost, #v.#u = :updated, #v.#version = if_not_exists(#v.#version, :zero) + :one`,
                ConditionExpression: `${rateWindow ? "#v.#window.#q" : "#v.#q"} >= :minimum`,
                ExpressionAttributeNames: {
                  "#v": "value",
                  ...(rateWindow ? { "#window": "rateWindow" } : {}),
                  "#q": rateWindow ? "remaining" : "quotaRemaining",
                  "#u": "updatedAt",
                  "#version": "version",
                },
                ExpressionAttributeValues: {
                  ":cost": cost,
                  ":minimum": reserve + cost,
                  ":updated": attempt.requestedAt,
                  ":one": 1,
                  ":zero": 0,
                },
              },
            },
            {
              Put: {
                TableName: this.tableName,
                Item: {
                  ...key("ATTEMPT", attempt.attemptId),
                  value: { ...attempt, state: "reserved" },
                },
                ConditionExpression: "attribute_not_exists(pk)",
              },
            },
          ],
        }),
      );
      return true;
    } catch (error) {
      if (
        error instanceof Error &&
        [
          "TransactionCanceledException",
          "ConditionalCheckFailedException",
        ].includes(error.name)
      )
        return false;
      throw error;
    }
  }
  getAttempt(id: string) {
    return this.get<OddsAttemptRecord>("ATTEMPT", id);
  }
  async completeAttempt(v: OddsAttemptRecord) {
    const old = await this.getAttempt(v.attemptId);
    if (!old || old.runId !== v.runId || old.pageToken !== v.pageToken)
      throw new Error("attempt-transition-conflict");
    if (old.completedAt) return;
    const updated = {
      ...old,
      ...v,
      state: v.state ?? (v.failureReason ? "failed" : "succeeded"),
    } as OddsAttemptRecord;
    const changed = await this.put(
      "ATTEMPT",
      v.attemptId,
      updated,
      "#v.#r = :requested AND attribute_not_exists(#v.#c)",
      {
        "#v": "value",
        "#r": "requestedAt",
        "#c": "completedAt",
      },
      { ":requested": old.requestedAt },
    );
    if (!changed) throw new Error("attempt-transition-conflict");
  }
  getPage(r: string, t: string) {
    return this.get<SealedOddsPage>("PAGE", `${r}#${t}`);
  }
  async sealPage(v: SealedOddsPage) {
    const old = await this.getPage(v.runId, v.pageToken);
    if (old) {
      if (old.responseDigest !== v.responseDigest)
        throw new Error("sealed-page-conflict");
      return false;
    }
    const inserted = await this.put(
      "PAGE",
      `${v.runId}#${v.pageToken}`,
      v,
      "attribute_not_exists(pk)",
    );
    if (inserted) return true;
    const winner = await this.getPage(v.runId, v.pageToken);
    if (!winner || winner.responseDigest !== v.responseDigest)
      throw new Error("sealed-page-conflict");
    return false;
  }
  async commitPage(r: string, t: string, a: string) {
    const existing = await this.getPage(r, t);
    if (existing?.committedAt) {
      if (existing.committedAt === a) return;
      throw new Error("page-transition-conflict");
    }
    await this.client.send(
      new UpdateCommand({
        TableName: this.tableName,
        Key: key("PAGE", `${r}#${t}`),
        UpdateExpression: "SET #v.#c = :a",
        ConditionExpression:
          "attribute_exists(pk) AND (attribute_not_exists(#v.#c) OR #v.#c = :a)",
        ExpressionAttributeNames: { "#v": "value", "#c": "committedAt" },
        ExpressionAttributeValues: { ":a": a },
      }),
    );
  }
  async markEvidenceIntent(r: string, t: string, a: string) {
    const page = await this.getPage(r, t);
    const run = await this.getRun(r);
    if (!page || !run) throw new Error("evidence-transition-conflict");
    if (page.evidenceIntentAt) {
      if (page.evidenceIntentAt === a && run.evidenceCommitted) return;
      throw new Error("evidence-transition-conflict");
    }
    try {
      await this.client.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Update: {
                TableName: this.tableName,
                Key: key("PAGE", `${r}#${t}`),
                UpdateExpression: "SET #v.#intent = :a",
                ConditionExpression:
                  "attribute_exists(pk) AND attribute_not_exists(#v.#intent)",
                ExpressionAttributeNames: {
                  "#v": "value",
                  "#intent": "evidenceIntentAt",
                },
                ExpressionAttributeValues: { ":a": a },
              },
            },
            {
              Update: {
                TableName: this.tableName,
                Key: key("RUN", r),
                UpdateExpression:
                  "SET #v.#e = :yes, #v.#u = :a, #v.#version = #v.#version + :one",
                ConditionExpression: "#v.#version = :expected",
                ExpressionAttributeNames: {
                  "#v": "value",
                  "#e": "evidenceCommitted",
                  "#u": "updatedAt",
                  "#version": "version",
                },
                ExpressionAttributeValues: {
                  ":yes": true,
                  ":a": a,
                  ":one": 1,
                  ":expected": run.version,
                },
              },
            },
          ],
        }),
      );
    } catch (error) {
      if (
        error instanceof Error &&
        error.name === "TransactionCanceledException"
      )
        throw new Error("evidence-transition-conflict");
      throw error;
    }
  }
  async commitEvidencePage(r: string, t: string, a: string) {
    const existing = await this.getPage(r, t);
    const run = await this.getRun(r);
    if (!run) throw new Error("evidence-transition-conflict");
    if (existing?.committedAt) {
      if (existing.committedAt === a && run?.evidenceCommitted) return;
      throw new Error("evidence-transition-conflict");
    }
    try {
      await this.client.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Update: {
                TableName: this.tableName,
                Key: key("PAGE", `${r}#${t}`),
                UpdateExpression: "SET #v.#c = :a",
                ConditionExpression:
                  "attribute_exists(pk) AND (attribute_not_exists(#v.#c) OR #v.#c = :a)",
                ExpressionAttributeNames: {
                  "#v": "value",
                  "#c": "committedAt",
                },
                ExpressionAttributeValues: { ":a": a },
              },
            },
            {
              Update: {
                TableName: this.tableName,
                Key: key("RUN", r),
                UpdateExpression:
                  "SET #v.#e = :yes, #v.#u = :a, #v.#version = if_not_exists(#v.#version, :zero) + :one",
                ConditionExpression:
                  "attribute_exists(pk) AND #v.#version = :expected",
                ExpressionAttributeNames: {
                  "#v": "value",
                  "#e": "evidenceCommitted",
                  "#u": "updatedAt",
                  "#version": "version",
                },
                ExpressionAttributeValues: {
                  ":yes": true,
                  ":a": a,
                  ":one": 1,
                  ":zero": 0,
                  ":expected": run.version,
                },
              },
            },
          ],
        }),
      );
    } catch (error) {
      if (
        error instanceof Error &&
        error.name === "TransactionCanceledException"
      )
        throw new Error("evidence-transition-conflict");
      throw error;
    }
  }
  async markPageMetricDelivered(r: string, t: string, a: string) {
    try {
      await this.client.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: key("PAGE", `${r}#${t}`),
          UpdateExpression: "SET #v.#m = if_not_exists(#v.#m, :a)",
          ConditionExpression: "attribute_exists(#v.#c)",
          ExpressionAttributeNames: {
            "#v": "value",
            "#m": "metricDeliveredAt",
            "#c": "committedAt",
          },
          ExpressionAttributeValues: { ":a": a },
        }),
      );
    } catch (error) {
      throw new Error("metric-transition-conflict", { cause: error });
    }
  }
  getCheckpoint(k: string) {
    return this.get<OddsLeagueCheckpoint>("CHECKPOINT", k);
  }
  async putCheckpoint(v: OddsLeagueCheckpoint) {
    await this.putVersioned(
      "CHECKPOINT",
      v.leagueKey,
      v,
      "checkpoint-transition-conflict",
    );
  }
  getHealth(k: string) {
    return this.get<OddsProviderHealth>("HEALTH", k);
  }
  async putHealth(v: OddsProviderHealth) {
    await this.putVersioned(
      "HEALTH",
      v.healthKey ?? v.providerId,
      v,
      "health-transition-conflict",
    );
  }
  async reserveQuota(
    healthKey: string,
    reserve: number,
    cost: number,
    updatedAt: string,
  ) {
    const old = await this.currentRateHealth(healthKey, updatedAt);
    const rateRemaining = old?.rateWindow?.remaining;
    const legacyRemaining = old?.quotaRemaining;
    if (old?.rateWindow && rateRemaining === undefined) return false;
    if (rateRemaining === undefined && legacyRemaining === undefined)
      return true;
    const rateWindow = rateRemaining !== undefined;
    try {
      await this.client.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: key("HEALTH", healthKey),
          UpdateExpression: `SET ${rateWindow ? "#v.#window.#q" : "#v.#q"} = ${rateWindow ? "#v.#window.#q" : "#v.#q"} - :cost, #v.#u = :updated, #v.#version = if_not_exists(#v.#version, :zero) + :one`,
          ConditionExpression: `${rateWindow ? "#v.#window.#q" : "#v.#q"} >= :minimum`,
          ExpressionAttributeNames: {
            "#v": "value",
            ...(rateWindow ? { "#window": "rateWindow" } : {}),
            "#q": rateWindow ? "remaining" : "quotaRemaining",
            "#u": "updatedAt",
            "#version": "version",
          },
          ExpressionAttributeValues: {
            ":cost": cost,
            ":minimum": reserve + cost,
            ":updated": updatedAt,
            ":one": 1,
            ":zero": 0,
          },
        }),
      );
      return true;
    } catch (error) {
      if (
        error instanceof Error &&
        error.name === "ConditionalCheckFailedException"
      )
        return false;
      throw error;
    }
  }
  async reconcileQuota(
    healthKey: string,
    reserved: number,
    actual: number,
    reported: number | undefined,
    updatedAt: string,
  ) {
    for (let retry = 0; retry < 8; retry += 1) {
      const old = await this.currentRateHealth(healthKey, updatedAt);
      const rateRemaining = old?.rateWindow?.remaining;
      const legacyRemaining = old?.quotaRemaining;
      const remaining = rateRemaining ?? legacyRemaining;
      if (remaining === undefined) return;
      const rateWindow = rateRemaining !== undefined;
      const adjusted = Math.max(0, remaining + reserved - actual);
      try {
        await this.client.send(
          new UpdateCommand({
            TableName: this.tableName,
            Key: key("HEALTH", healthKey),
            UpdateExpression: `SET ${rateWindow ? "#v.#window.#q" : "#v.#q"} = :remaining, #v.#u = :updated, #v.#version = if_not_exists(#v.#version, :zero) + :one`,
            ConditionExpression: `${rateWindow ? "#v.#window.#q" : "#v.#q"} = :expected`,
            ExpressionAttributeNames: {
              "#v": "value",
              ...(rateWindow ? { "#window": "rateWindow" } : {}),
              "#q": rateWindow ? "remaining" : "quotaRemaining",
              "#u": "updatedAt",
              "#version": "version",
            },
            ExpressionAttributeValues: {
              ":remaining":
                reported === undefined
                  ? adjusted
                  : Math.min(reported, adjusted),
              ":expected": remaining,
              ":updated": updatedAt,
              ":one": 1,
              ":zero": 0,
            },
          }),
        );
        return;
      } catch (error) {
        if (
          !(error instanceof Error) ||
          error.name !== "ConditionalCheckFailedException"
        )
          throw error;
      }
    }
    throw new Error("health-transition-conflict");
  }
  getContinuation(k: string) {
    return this.get<OddsRunContinuation>("CONTINUATION", k);
  }
  async putContinuation(v: OddsRunContinuation) {
    await this.putVersioned(
      "CONTINUATION",
      v.leagueKey,
      v,
      "continuation-transition-conflict",
    );
  }
  async claimContinuation(v: OddsRunContinuation) {
    const old = await this.getContinuation(v.leagueKey);
    if (
      old &&
      (!v.ownerId ||
        (old.ownerId !== v.ownerId &&
          !!old.ownerId &&
          !!old.leaseUntil &&
          Date.parse(old.leaseUntil) > Date.parse(v.updatedAt)))
    )
      return old;
    if (old) {
      await this.putVersioned(
        "CONTINUATION",
        v.leagueKey,
        { ...v, version: old.version ?? 0 },
        "continuation-transition-conflict",
      );
      return (await this.getContinuation(v.leagueKey))!;
    }
    const created = { ...v, version: 1 };
    const inserted = await this.put(
      "CONTINUATION",
      v.leagueKey,
      created,
      "attribute_not_exists(pk)",
    );
    if (inserted) return created;
    const owner = await this.getContinuation(v.leagueKey);
    if (!owner) throw new Error("continuation-transition-conflict");
    return owner;
  }
  async clearContinuation(
    k: string,
    expectedRunId?: string,
    expectedOwnerId?: string,
    expectedVersion?: number,
  ) {
    try {
      await this.client.send(
        new DeleteCommand({
          TableName: this.tableName,
          Key: key("CONTINUATION", k),
          ...(expectedRunId === undefined &&
          expectedOwnerId === undefined &&
          expectedVersion === undefined
            ? {}
            : {
                ConditionExpression: [
                  expectedRunId === undefined ? undefined : "#v.#r = :run",
                  expectedOwnerId === undefined
                    ? undefined
                    : "#v.#owner = :owner",
                  expectedVersion === undefined
                    ? undefined
                    : "#v.#version = :version",
                ]
                  .filter(Boolean)
                  .join(" AND "),
                ExpressionAttributeNames: {
                  "#v": "value",
                  "#r": "runId",
                  "#owner": "ownerId",
                  "#version": "version",
                },
                ExpressionAttributeValues: {
                  ...(expectedRunId === undefined
                    ? {}
                    : { ":run": expectedRunId }),
                  ...(expectedOwnerId === undefined
                    ? {}
                    : { ":owner": expectedOwnerId }),
                  ...(expectedVersion === undefined
                    ? {}
                    : { ":version": expectedVersion }),
                },
              }),
        }),
      );
    } catch (error) {
      if (
        error instanceof Error &&
        error.name === "ConditionalCheckFailedException"
      )
        throw new Error("continuation-transition-conflict");
      throw error;
    }
  }
  putGap(v: OddsEvidenceGap) {
    return this.put("GAP", v.gapId, v, "attribute_not_exists(pk)");
  }
}
