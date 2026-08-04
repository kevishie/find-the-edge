import {
  freezeCohort,
  performanceReportId,
  stableCohortValue,
  type CohortDefinition,
  type CohortMember,
  type FrozenCohort,
} from "@find-the-edge/domain";
export interface StoredPerformanceReport<T = unknown> {
  readonly reportId: string;
  readonly cohortId: string;
  readonly cutoff: string;
  readonly evidenceDigest: string;
  readonly revision: number;
  readonly createdAt: string;
  readonly facets: {
    readonly sports: readonly string[];
    readonly leagues: readonly string[];
    readonly markets: readonly string[];
    readonly oddsBands: readonly string[];
    readonly strategyVersions: readonly string[];
    readonly modelVersions: readonly string[];
  };
  readonly metrics: T;
}
export interface CohortRepository {
  putCohort(input: {
    readonly definition: CohortDefinition;
    readonly cutoff: string;
    readonly members: readonly CohortMember[];
  }): Promise<FrozenCohort>;
  getCohort(id: string): Promise<FrozenCohort | null>;
  listCohorts(input: {
    readonly limit: number;
    readonly cursor?: string;
  }): Promise<{
    readonly items: readonly FrozenCohort[];
    readonly nextCursor?: string;
  }>;
  putReport<T>(
    input: Omit<StoredPerformanceReport<T>, "reportId">,
  ): Promise<StoredPerformanceReport<T>>;
  getReport<T>(id: string): Promise<StoredPerformanceReport<T> | null>;
  listReports<T>(input: {
    readonly limit: number;
    readonly cursor?: string;
  }): Promise<{
    readonly items: readonly StoredPerformanceReport<T>[];
    readonly nextCursor?: string;
  }>;
}
export class CohortConflictError extends Error {
  override readonly name = "CohortConflictError";
}
export function validateStoredPerformanceReport<T>(
  value: StoredPerformanceReport<T>,
) {
  const expected = performanceReportId(
    value.cohortId,
    value.evidenceDigest,
    value.cutoff,
    value.revision,
  );
  if (
    value.reportId !== expected ||
    !/^cohort:[a-f0-9]{64}$/.test(value.cohortId) ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 1 ||
    !Number.isFinite(Date.parse(value.cutoff)) ||
    !Number.isFinite(Date.parse(value.createdAt))
  )
    throw new CohortConflictError("performance-report-corrupt");
  return value;
}
export class MemoryCohortRepository implements CohortRepository {
  private readonly cohorts = new Map<string, FrozenCohort>();
  private readonly reports = new Map<string, StoredPerformanceReport>();
  private readonly cohortCutoffs = new Map<string, string>();
  async putCohort(input: {
    readonly definition: CohortDefinition;
    readonly cutoff: string;
    readonly members: readonly CohortMember[];
  }) {
    await Promise.resolve();
    const value = freezeCohort(input),
      existing = this.cohorts.get(value.cohortId);
    const cutoffKey = `${value.definitionHash}#${value.cutoff}`;
    const finalized = this.cohortCutoffs.get(cutoffKey);
    if (finalized && finalized !== value.membershipDigest)
      throw new CohortConflictError("cohort-cutoff-finalized");
    if (existing && stableCohortValue(existing) !== stableCohortValue(value))
      throw new CohortConflictError("cohort-conflict");
    this.cohorts.set(value.cohortId, structuredClone(value));
    this.cohortCutoffs.set(cutoffKey, value.membershipDigest);
    return structuredClone(value);
  }
  async getCohort(id: string) {
    await Promise.resolve();
    const stored = this.cohorts.get(id);
    if (!stored) return null;
    const verified = freezeCohort(stored);
    if (
      verified.cohortId !== id ||
      stableCohortValue(verified) !== stableCohortValue(stored)
    )
      throw new CohortConflictError("cohort-corrupt");
    return structuredClone(verified);
  }
  async listCohorts(input: {
    readonly limit: number;
    readonly cursor?: string;
  }) {
    await Promise.resolve();
    if (
      !Number.isSafeInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > 100
    )
      throw new Error("cohort-limit-invalid");
    const decode = (cursor: string) => {
      try {
        const parsed = JSON.parse(
          Buffer.from(cursor, "base64url").toString(),
        ) as { scope?: unknown; id?: unknown };
        if (parsed.scope !== "cohorts" || typeof parsed.id !== "string")
          throw new Error();
        return parsed.id;
      } catch {
        throw new Error("cohort-cursor-invalid");
      }
    };
    const values = [...this.cohorts.values()].sort((a, b) =>
        a.cohortId.localeCompare(b.cohortId),
      ),
      cursorId = input.cursor ? decode(input.cursor) : undefined,
      start =
        cursorId === undefined
          ? 0
          : values.findIndex((v) => v.cohortId === cursorId) + 1;
    if (input.cursor !== undefined && start === 0)
      throw new Error("cohort-cursor-invalid");
    const items = values.slice(start, start + input.limit);
    return {
      items: structuredClone(items),
      ...(start + items.length < values.length
        ? {
            nextCursor: Buffer.from(
              JSON.stringify({ scope: "cohorts", id: items.at(-1)!.cohortId }),
            ).toString("base64url"),
          }
        : {}),
    };
  }
  async putReport<T>(input: Omit<StoredPerformanceReport<T>, "reportId">) {
    await Promise.resolve();
    const cohort = this.cohorts.get(input.cohortId);
    if (!cohort || cohort.cutoff !== input.cutoff)
      throw new CohortConflictError(
        "performance-report-cohort-binding-invalid",
      );
    const reportId = performanceReportId(
        input.cohortId,
        input.evidenceDigest,
        input.cutoff,
        input.revision,
      ),
      value = { ...input, reportId },
      existing = this.reports.get(reportId);
    if (existing && stableCohortValue(existing) !== stableCohortValue(value))
      throw new CohortConflictError("performance-report-conflict");
    this.reports.set(reportId, structuredClone(value));
    return structuredClone(value);
  }
  async getReport<T>(id: string) {
    await Promise.resolve();
    const stored = this.reports.get(id) as
      StoredPerformanceReport<T> | undefined;
    return stored
      ? structuredClone(validateStoredPerformanceReport(stored))
      : null;
  }
  async listReports<T>(input: {
    readonly limit: number;
    readonly cursor?: string;
  }) {
    await Promise.resolve();
    if (
      !Number.isSafeInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > 100
    )
      throw new Error("report-limit-invalid");
    const decode = (cursor: string) => {
      try {
        const parsed = JSON.parse(
          Buffer.from(cursor, "base64url").toString(),
        ) as { id?: unknown; scope?: unknown };
        if (parsed.scope !== "reports" || typeof parsed.id !== "string")
          throw new Error();
        return parsed.id;
      } catch {
        throw new Error("report-cursor-invalid");
      }
    };
    const values = [...this.reports.values()]
      .map(validateStoredPerformanceReport)
      .sort(
        (a, b) =>
          b.createdAt.localeCompare(a.createdAt) ||
          a.reportId.localeCompare(b.reportId),
      ) as StoredPerformanceReport<T>[];
    const decodedCursor =
      input.cursor === undefined ? undefined : decode(input.cursor);
    const start =
      decodedCursor === undefined
        ? 0
        : values.findIndex((value) => value.reportId === decodedCursor) + 1;
    if (input.cursor !== undefined && start === 0)
      throw new Error("report-cursor-invalid");
    const items = values.slice(start, start + input.limit);
    return {
      items: structuredClone(items),
      ...(start + items.length < values.length
        ? {
            nextCursor: Buffer.from(
              JSON.stringify({ scope: "reports", id: items.at(-1)!.reportId }),
            ).toString("base64url"),
          }
        : {}),
    };
  }
}
