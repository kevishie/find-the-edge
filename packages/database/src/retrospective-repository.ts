import {
  stableCohortValue,
  transitionRetrospective,
  validateRetrospectiveVersion,
  type RetrospectiveReviewDecision,
  type RetrospectiveState,
  type RetrospectiveVersion,
} from "@find-the-edge/domain";

export interface RetrospectivePage {
  readonly items: readonly RetrospectiveVersion[];
  readonly nextCursor?: string;
}
export interface PublicRetrospectiveAudit {
  readonly decisionId: string;
  readonly versionId: string;
  readonly fromState: RetrospectiveState;
  readonly toState: RetrospectiveState;
  readonly reasonCode: RetrospectiveReviewDecision["reasonCode"];
  readonly decidedAt: string;
}
export interface RetrospectiveAuditPage {
  readonly items: readonly PublicRetrospectiveAudit[];
  readonly nextCursor?: string;
}
export interface RetrospectiveRepository {
  putVersion(value: RetrospectiveVersion): Promise<RetrospectiveVersion>;
  getVersion(versionId: string): Promise<RetrospectiveVersion | null>;
  getCurrent(retrospectiveId: string): Promise<RetrospectiveVersion | null>;
  getByReport(
    retrospectiveId: string,
    reportId: string,
  ): Promise<RetrospectiveVersion | null>;
  list(input: {
    readonly limit: number;
    readonly cursor?: string;
  }): Promise<RetrospectivePage>;
  listVersions(input: {
    readonly retrospectiveId: string;
    readonly limit: number;
    readonly cursor?: string;
  }): Promise<RetrospectivePage>;
  review(input: {
    readonly versionId: string;
    readonly reviewerId: string;
    readonly reasonCode: RetrospectiveReviewDecision["reasonCode"];
    readonly note?: string | null;
    readonly decidedAt: string;
    readonly idempotencyKey: string;
    readonly expectedState: RetrospectiveState;
    readonly expectedStateVersion: number;
  }): Promise<{
    readonly version: RetrospectiveVersion;
    readonly decision: RetrospectiveReviewDecision;
  }>;
  listAudit(input: {
    readonly versionId: string;
    readonly limit: number;
    readonly cursor?: string;
  }): Promise<RetrospectiveAuditPage>;
}
export class RetrospectiveConflictError extends Error {
  override readonly name = "RetrospectiveConflictError";
}
export class RetrospectiveNotFoundError extends Error {
  override readonly name = "RetrospectiveNotFoundError";
}
const validateLimit = (limit: number) => {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50)
    throw new Error("retrospective-limit-invalid");
};
const encode = (scope: string, id: string) =>
  Buffer.from(JSON.stringify({ scope, id })).toString("base64url");
const decode = (scope: string, value: string) => {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString()) as {
      scope?: unknown;
      id?: unknown;
    };
    if (parsed.scope !== scope || typeof parsed.id !== "string")
      throw new Error();
    return parsed.id;
  } catch {
    throw new Error("retrospective-cursor-invalid");
  }
};
export const validateRetrospectiveReviewReplay = (
  replay: {
    version: RetrospectiveVersion;
    decision: RetrospectiveReviewDecision;
  },
  input: Parameters<RetrospectiveRepository["review"]>[0],
) => {
  const version = validateRetrospectiveVersion(replay.version);
  const decision = replay.decision;
  if (
    !["approve", "reject", "request-changes"].includes(input.reasonCode) ||
    !["draft", "changes-requested", "approved", "rejected"].includes(
      input.expectedState,
    )
  )
    throw new RetrospectiveConflictError("retrospective-idempotency-conflict");
  const expectedTo =
    input.reasonCode === "approve"
      ? "approved"
      : input.reasonCode === "reject"
        ? "rejected"
        : "changes-requested";
  if (
    !/^retrospective-decision:[a-f0-9]{64}$/.test(decision.decisionId) ||
    decision.retrospectiveId !== version.retrospectiveId ||
    decision.versionId !== version.versionId ||
    decision.versionId !== input.versionId ||
    decision.reviewerId !== input.reviewerId ||
    decision.reasonCode !== input.reasonCode ||
    decision.note !== (input.note ?? null) ||
    decision.fromState !== input.expectedState ||
    decision.toState !== expectedTo ||
    decision.toState !== version.state ||
    decision.stateVersion !== input.expectedStateVersion + 1 ||
    decision.stateVersion !== version.stateVersion ||
    decision.idempotencyKey !== input.idempotencyKey ||
    !Number.isFinite(Date.parse(decision.decidedAt)) ||
    new Date(decision.decidedAt).toISOString() !== decision.decidedAt
  )
    throw new RetrospectiveConflictError("retrospective-idempotency-conflict");
  return { version, decision };
};

export class MemoryRetrospectiveRepository implements RetrospectiveRepository {
  private readonly versions = new Map<string, RetrospectiveVersion>();
  private readonly current = new Map<string, string>();
  private readonly decisions = new Map<string, RetrospectiveReviewDecision[]>();
  private readonly replay = new Map<
    string,
    { version: RetrospectiveVersion; decision: RetrospectiveReviewDecision }
  >();
  async putVersion(value: RetrospectiveVersion) {
    await Promise.resolve();
    validateRetrospectiveVersion(value);
    const existing = this.versions.get(value.versionId);
    if (existing && stableCohortValue(existing) !== stableCohortValue(value))
      throw new RetrospectiveConflictError("retrospective-version-conflict");
    const currentId = this.current.get(value.retrospectiveId);
    if (value.version > 1) {
      const predecessor = value.predecessorVersionId
        ? this.versions.get(value.predecessorVersionId)
        : undefined;
      if (
        !predecessor ||
        predecessor.retrospectiveId !== value.retrospectiveId ||
        predecessor.version + 1 !== value.version ||
        currentId !== predecessor.versionId
      )
        throw new RetrospectiveConflictError("retrospective-lineage-conflict");
    } else if (currentId && currentId !== value.versionId)
      throw new RetrospectiveConflictError("retrospective-current-conflict");
    this.versions.set(value.versionId, structuredClone(value));
    this.current.set(value.retrospectiveId, value.versionId);
    return structuredClone(value);
  }
  async getVersion(id: string) {
    await Promise.resolve();
    return this.versions.has(id)
      ? structuredClone(validateRetrospectiveVersion(this.versions.get(id)!))
      : null;
  }
  async getCurrent(id: string) {
    const current = this.current.get(id);
    return current ? this.getVersion(current) : null;
  }
  async getByReport(retrospectiveId: string, reportId: string) {
    await Promise.resolve();
    const matches = [...this.versions.values()].filter(
      (version) =>
        version.retrospectiveId === retrospectiveId &&
        version.reportId === reportId,
    );
    if (matches.length > 1)
      throw new RetrospectiveConflictError(
        "retrospective-report-index-corrupt",
      );
    return matches[0]
      ? structuredClone(validateRetrospectiveVersion(matches[0]))
      : null;
  }
  private page(
    values: RetrospectiveVersion[],
    scope: string,
    input: { limit: number; cursor?: string },
  ) {
    validateLimit(input.limit);
    const cursor = input.cursor ? decode(scope, input.cursor) : undefined;
    const start = cursor
      ? values.findIndex((v) => v.versionId === cursor) + 1
      : 0;
    if (cursor && start === 0) throw new Error("retrospective-cursor-invalid");
    const items = values.slice(start, start + input.limit);
    return {
      items: structuredClone(items),
      ...(start + items.length < values.length
        ? { nextCursor: encode(scope, items.at(-1)!.versionId) }
        : {}),
    };
  }
  async list(input: { limit: number; cursor?: string }) {
    await Promise.resolve();
    const values = [...this.current.values()]
      .map((id) => this.versions.get(id)!)
      .sort(
        (a, b) =>
          b.createdAt.localeCompare(a.createdAt) ||
          a.versionId.localeCompare(b.versionId),
      );
    return this.page(values, "retrospectives", input);
  }
  async listVersions(input: {
    retrospectiveId: string;
    limit: number;
    cursor?: string;
  }) {
    await Promise.resolve();
    const values = [...this.versions.values()]
      .filter((v) => v.retrospectiveId === input.retrospectiveId)
      .sort((a, b) => b.version - a.version);
    return this.page(values, `versions:${input.retrospectiveId}`, input);
  }
  async review(input: Parameters<RetrospectiveRepository["review"]>[0]) {
    await Promise.resolve();
    const replayKey = `${input.versionId}#${input.idempotencyKey}`,
      replay = this.replay.get(replayKey);
    if (replay) {
      return structuredClone(validateRetrospectiveReviewReplay(replay, input));
    }
    const stored = this.versions.get(input.versionId);
    if (!stored)
      throw new RetrospectiveNotFoundError("retrospective-not-found");
    let result;
    try {
      result = transitionRetrospective(stored, input);
    } catch {
      throw new RetrospectiveConflictError("retrospective-review-conflict");
    }
    this.versions.set(input.versionId, structuredClone(result.version));
    this.decisions.set(input.versionId, [
      ...(this.decisions.get(input.versionId) ?? []),
      structuredClone(result.decision),
    ]);
    this.replay.set(replayKey, structuredClone(result));
    return structuredClone(result);
  }
  async listAudit(input: Parameters<RetrospectiveRepository["listAudit"]>[0]) {
    await Promise.resolve();
    validateLimit(input.limit);
    const values = (this.decisions.get(input.versionId) ?? []).map(
      ({
        decisionId,
        versionId: id,
        fromState,
        toState,
        reasonCode,
        decidedAt,
      }) => ({
        decisionId,
        versionId: id,
        fromState,
        toState,
        reasonCode,
        decidedAt,
      }),
    );
    const cursor = input.cursor
      ? decode(`audit:${input.versionId}`, input.cursor)
      : undefined;
    const start = cursor
      ? values.findIndex((value) => value.decisionId === cursor) + 1
      : 0;
    if (cursor && start === 0) throw new Error("retrospective-cursor-invalid");
    const items = values.slice(start, start + input.limit);
    return {
      items,
      ...(start + items.length < values.length
        ? {
            nextCursor: encode(
              `audit:${input.versionId}`,
              items.at(-1)!.decisionId,
            ),
          }
        : {}),
    };
  }
}
