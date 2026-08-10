import {
  assertScoutingReportEnvelopeBytes,
  assertScoutingTimestamp,
  canonicalScoutingReportJson,
  completeScoutingAttemptWithReport,
  completeScoutingJobWithReport,
  createScoutingReportCompletionPointer,
  isRetryableScoutingReportFailure,
  isScoutingReportFailureCode,
  normalizeScoutingReportCompletionPointer,
  normalizeScoutingReportHead,
  normalizeScoutingReportVersion,
  readScoutingAttemptRecord,
  readScoutingJobRecord,
  toScoutingReportBinding,
  type ScoutingAttempt,
  type ScoutingAttemptRecordRead,
  type ScoutingAttemptV2,
  type ScoutingJob,
  type ScoutingJobRecordRead,
  type ScoutingJobV2,
  type ScoutingReportCompletionPointer,
  type ScoutingReportFailureCode,
  type ScoutingReportHead,
  type ScoutingReportVersionRecord,
} from "@find-the-edge/domain";

/**
 * FTE-042 stage 3: the scouting report repository behavior contract plus the
 * in-memory reference implementation. One atomic `completeWithReport` inserts
 * the immutable version, compare-and-swaps the head, binds the job to its
 * version for replay, transitions job and attempt to schema-v2 completed with
 * the report pointer, releases the active lock, and fences on the exact
 * canonical event version — all or nothing. Replay resolves from the
 * immutable job binding before any active attempt is required.
 */

export const SCOUTING_REPORT_BINDING_SCHEMA_VERSION = 1 as const;
/** Maximum head-CAS recompute retries after the initial attempt. */
export const SCOUTING_REPORT_CAS_RETRY_LIMIT = 3 as const;

const REPORT_ID = /^scout-report:[a-f0-9]{64}$/;
const JOB_ID = /^scout-job:[a-f0-9]{64}$/;
const HEX64 = /^[a-f0-9]{64}$/;

/** Stable kebab-case failure surface reusing the domain report taxonomy. */
export class ScoutingReportRepositoryError extends Error {
  override readonly name = "ScoutingReportRepositoryError";
  /** True only for `report-head-cas-conflict`: reload, recompute, retry. */
  readonly retryable: boolean;
  constructor(
    readonly code: ScoutingReportFailureCode,
    options?: Readonly<{ cause?: unknown }>,
  ) {
    super(code, options?.cause === undefined ? undefined : options);
    this.retryable = isRetryableScoutingReportFailure(code);
  }
}

export const toScoutingReportRepositoryError = (
  error: unknown,
  fallback: ScoutingReportFailureCode,
): ScoutingReportRepositoryError => {
  if (error instanceof ScoutingReportRepositoryError) return error;
  if (error instanceof Error && isScoutingReportFailureCode(error.message))
    return new ScoutingReportRepositoryError(error.message, { cause: error });
  return new ScoutingReportRepositoryError(fallback, { cause: error });
};

/**
 * Everything one atomic completion needs, exactly as assembled by
 * `assembleFirstScoutingReportVersion` / `assembleSuccessorScoutingReportVersion`
 * in packages/scouting (mirrored structurally: this package depends only on
 * the domain contracts).
 */
export interface ScoutingReportCompletionMaterial {
  readonly version: ScoutingReportVersionRecord;
  readonly head: ScoutingReportHead;
  readonly completionPointer: ScoutingReportCompletionPointer;
  readonly envelope: string;
}

/**
 * CAS-loser recompute: given the winning head and its full version record,
 * return fresh completion material fenced on that winner (same projection,
 * same job/attempt). Typically delegates back to
 * `assembleSuccessorScoutingReportVersion`.
 */
export type ScoutingReportCompletionRecompute = (
  winningHead: ScoutingReportHead,
  winningPredecessor: ScoutingReportVersionRecord,
) =>
  ScoutingReportCompletionMaterial | Promise<ScoutingReportCompletionMaterial>;

export interface ScoutingReportCompletionInput {
  readonly material: ScoutingReportCompletionMaterial;
  /** Trusted worker clock; must not precede `version.generatedAt`. */
  readonly completedAt: string;
  /** Required for bounded head-CAS retry; without it a CAS loss throws. */
  readonly recompute?: ScoutingReportCompletionRecompute;
}

export type ScoutingReportCompletionResult =
  | {
      readonly outcome: "completed";
      readonly version: ScoutingReportVersionRecord;
      readonly head: ScoutingReportHead;
      readonly job: ScoutingJobV2;
      readonly attempt: ScoutingAttemptV2;
    }
  | {
      /** Exact same-job replay: first-write version and telemetry win. */
      readonly outcome: "replayed";
      readonly version: ScoutingReportVersionRecord;
      readonly head: ScoutingReportHead;
    };

export interface ScoutingReportRepository {
  /**
   * Atomic completion. Replay resolves FIRST from the immutable job binding:
   * an exact persistence-fingerprint match returns the originally stored
   * version with zero mutation (no active attempt required); a mismatch is a
   * stable `report-replay-conflict`. Otherwise requires the exact currently
   * claimed attempt and the exact canonical event version, then commits the
   * version insert, head CAS, job binding, schema-v2 job/attempt completion,
   * and active-lock release as one all-or-nothing operation.
   */
  completeWithReport(
    input: ScoutingReportCompletionInput,
  ): Promise<ScoutingReportCompletionResult>;
  /** Owner-scoped; foreign requesters get neutral missing. */
  getHead(
    reportId: string,
    requesterId: string,
  ): Promise<ScoutingReportHead | null>;
  getVersion(
    reportId: string,
    versionNumber: number,
    requesterId: string,
  ): Promise<ScoutingReportVersionRecord | null>;
  /** Historical versions in ascending version order. */
  listVersions(
    reportId: string,
    requesterId: string,
  ): Promise<readonly ScoutingReportVersionRecord[]>;
  getByJobBinding(
    jobId: string,
    requesterId: string,
  ): Promise<ScoutingReportVersionRecord | null>;
}

/** Immutable job-to-version replay binding persisted at completion. */
export interface ScoutingReportJobBinding extends ScoutingReportCompletionPointer {
  readonly persistenceFingerprint: string;
}

export const normalizeScoutingReportJobBinding = (
  input: unknown,
): ScoutingReportJobBinding => {
  try {
    if (input === null || typeof input !== "object" || Array.isArray(input))
      throw new Error("report-storage-corrupt");
    const { persistenceFingerprint, ...pointer } = input as Readonly<
      Record<string, unknown>
    >;
    if (
      typeof persistenceFingerprint !== "string" ||
      !HEX64.test(persistenceFingerprint)
    )
      throw new Error("report-storage-corrupt");
    return Object.freeze({
      ...normalizeScoutingReportCompletionPointer(pointer),
      persistenceFingerprint,
    });
  } catch (error) {
    throw toScoutingReportRepositoryError(error, "report-storage-corrupt");
  }
};

/**
 * Re-derives and cross-checks the caller-supplied completion material: the
 * version record, head, pointer, and envelope must all describe the same
 * report version, and the envelope must be its canonical serialization within
 * the byte cap. Anything incoherent is `report-validation-invalid`.
 */
export function normalizeScoutingReportCompletionMaterial(
  material: ScoutingReportCompletionMaterial,
): ScoutingReportCompletionMaterial {
  try {
    const version = normalizeScoutingReportVersion(material.version);
    const head = normalizeScoutingReportHead(material.head);
    const completionPointer = normalizeScoutingReportCompletionPointer(
      material.completionPointer,
    );
    const envelope = assertScoutingReportEnvelopeBytes(material.envelope);
    if (
      envelope !== canonicalScoutingReportJson(version) ||
      canonicalScoutingReportJson(completionPointer) !==
        canonicalScoutingReportJson(
          createScoutingReportCompletionPointer(version),
        ) ||
      head.reportId !== version.reportId ||
      head.requesterId !== version.requesterId ||
      head.eventId !== version.eventId ||
      head.latestVersionNumber !== version.versionNumber ||
      head.latestVersionId !== version.reportVersionId ||
      head.latestDraftHash !== version.draftHash ||
      (version.versionNumber === 1 && head.stateVersion !== 1)
    )
      throw new Error("report-validation-invalid");
    return Object.freeze({ version, head, completionPointer, envelope });
  } catch (error) {
    throw toScoutingReportRepositoryError(error, "report-validation-invalid");
  }
}

/** The recomputed material must keep the original job/report identity. */
export const assertScoutingReportRecomputeCoherent = (
  original: ScoutingReportCompletionMaterial,
  recomputed: ScoutingReportCompletionMaterial,
): ScoutingReportCompletionMaterial => {
  if (
    recomputed.version.jobId !== original.version.jobId ||
    recomputed.version.attemptId !== original.version.attemptId ||
    recomputed.version.reportId !== original.version.reportId ||
    recomputed.version.requesterId !== original.version.requesterId ||
    recomputed.version.eventId !== original.version.eventId ||
    recomputed.version.eventVersion !== original.version.eventVersion
  )
    throw new ScoutingReportRepositoryError("report-validation-invalid");
  return recomputed;
};

export const isScoutingReportId = (value: string): boolean =>
  REPORT_ID.test(value);
export const isScoutingJobIdForReports = (value: string): boolean =>
  JOB_ID.test(value);

/** Exact event-version fence port for the in-memory implementation. */
export interface ScoutingReportEventFence {
  verifyEventVersion(eventId: string, eventVersion: number): Promise<boolean>;
}

type ClaimedLifecycle = {
  readonly job: ScoutingJob | ScoutingJobV2;
  readonly attempt: ScoutingAttempt | ScoutingAttemptV2;
};

/**
 * Requires the exact currently claimed attempt: the job's current attempt is
 * the version's attempt, both are `in_progress`, and identity matches the
 * material. Lifecycle-state mismatches are `report-stale-attempt`; identity
 * mismatches are `report-validation-invalid`.
 */
export function requireClaimedScoutingLifecycle(
  jobRead: ScoutingJobRecordRead | null,
  attemptRead: ScoutingAttemptRecordRead | null,
  version: ScoutingReportVersionRecord,
): ClaimedLifecycle {
  if (
    !jobRead ||
    !attemptRead ||
    jobRead.kind === "legacy-reportless-completion" ||
    attemptRead.kind === "legacy-reportless-completion"
  )
    throw new ScoutingReportRepositoryError("report-stale-attempt");
  const job = jobRead.job;
  const attempt = attemptRead.attempt;
  if (
    job.requesterId !== version.requesterId ||
    job.eventId !== version.eventId ||
    job.eventVersion !== version.eventVersion ||
    attempt.jobId !== job.jobId
  )
    throw new ScoutingReportRepositoryError("report-validation-invalid");
  if (
    job.currentAttemptId !== version.attemptId ||
    job.status !== "in_progress" ||
    attempt.status !== "in_progress"
  )
    throw new ScoutingReportRepositoryError("report-stale-attempt");
  return { job, attempt };
}

type StoredBindingRow = { readonly value: unknown };
type StoredLock = { readonly jobId: string; readonly attemptId: string };

const clone = <T>(value: T): T => structuredClone(value);

const passingFence: ScoutingReportEventFence = {
  verifyEventVersion: () => Promise.resolve(true),
};

/**
 * In-memory reference implementation. Job, attempt, and active-lock state is
 * seeded by the caller (stage 4 composes real storage); all completion
 * mutations are applied only after every check passes, so a failure never
 * leaves a partial write.
 */
export class MemoryScoutingReportRepository implements ScoutingReportRepository {
  private readonly headRows = new Map<string, unknown>();
  private readonly versionRows = new Map<string, Map<number, unknown>>();
  private readonly versionCanonicalById = new Map<string, string>();
  private readonly bindingRows = new Map<string, StoredBindingRow>();
  private readonly jobRows = new Map<string, unknown>();
  private readonly attemptRows = new Map<string, unknown>();
  private readonly activeLocks = new Map<string, StoredLock>();
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly eventFence: ScoutingReportEventFence = passingFence,
  ) {}

  private locked<T>(work: () => T | Promise<T>): Promise<T> {
    const result = this.queue.then(work);
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /** Seeds a job row exactly as a job repository would store it. */
  seedJob(job: ScoutingJob | ScoutingJobV2): void {
    this.jobRows.set(job.jobId, clone(job));
  }

  seedAttempt(attempt: ScoutingAttempt | ScoutingAttemptV2): void {
    this.attemptRows.set(attempt.attemptId, clone(attempt));
  }

  setActiveLock(
    semanticDigest: string,
    jobId: string,
    attemptId: string,
  ): void {
    this.activeLocks.set(semanticDigest, Object.freeze({ jobId, attemptId }));
  }

  clearActiveLock(semanticDigest: string): void {
    this.activeLocks.delete(semanticDigest);
  }

  readJob(jobId: string): ScoutingJobRecordRead | null {
    const row = this.jobRows.get(jobId);
    if (row === undefined) return null;
    try {
      return readScoutingJobRecord(clone(row));
    } catch (error) {
      throw toScoutingReportRepositoryError(error, "report-storage-corrupt");
    }
  }

  readAttempt(attemptId: string): ScoutingAttemptRecordRead | null {
    const row = this.attemptRows.get(attemptId);
    if (row === undefined) return null;
    try {
      return readScoutingAttemptRecord(clone(row));
    } catch (error) {
      throw toScoutingReportRepositoryError(error, "report-storage-corrupt");
    }
  }

  hasActiveLock(semanticDigest: string): boolean {
    return this.activeLocks.has(semanticDigest);
  }

  /** Test-only escape hatch: writes a raw version row without validation. */
  unsafeSeedVersionRow(
    reportId: string,
    versionNumber: number,
    row: unknown,
  ): void {
    const rows = this.versionRows.get(reportId) ?? new Map<number, unknown>();
    rows.set(versionNumber, clone(row));
    this.versionRows.set(reportId, rows);
  }

  private storedVersion(
    reportId: string,
    versionNumber: number,
  ): ScoutingReportVersionRecord | null {
    const row = this.versionRows.get(reportId)?.get(versionNumber);
    if (row === undefined) return null;
    let record: ScoutingReportVersionRecord;
    try {
      record = normalizeScoutingReportVersion(clone(row));
    } catch (error) {
      throw new ScoutingReportRepositoryError("report-storage-corrupt", {
        cause: error,
      });
    }
    if (record.reportId !== reportId || record.versionNumber !== versionNumber)
      throw new ScoutingReportRepositoryError("report-storage-corrupt");
    return record;
  }

  private storedHead(reportId: string): ScoutingReportHead | null {
    const row = this.headRows.get(reportId);
    if (row === undefined) return null;
    let head: ScoutingReportHead;
    try {
      head = normalizeScoutingReportHead(clone(row));
    } catch (error) {
      throw new ScoutingReportRepositoryError("report-storage-corrupt", {
        cause: error,
      });
    }
    if (head.reportId !== reportId)
      throw new ScoutingReportRepositoryError("report-storage-corrupt");
    return head;
  }

  private storedBinding(jobId: string): ScoutingReportJobBinding | null {
    const row = this.bindingRows.get(jobId);
    if (row === undefined) return null;
    const binding = normalizeScoutingReportJobBinding(clone(row.value));
    if (binding.jobId !== jobId)
      throw new ScoutingReportRepositoryError("report-storage-corrupt");
    return binding;
  }

  private resolveReplay(
    binding: ScoutingReportJobBinding,
    material: ScoutingReportCompletionMaterial,
  ): ScoutingReportCompletionResult {
    if (
      binding.persistenceFingerprint !== material.version.persistenceFingerprint
    )
      throw new ScoutingReportRepositoryError("report-replay-conflict");
    const version = this.storedVersion(
      binding.reportId,
      binding.reportVersionNumber,
    );
    const head = this.storedHead(binding.reportId);
    if (
      !version ||
      !head ||
      version.reportVersionId !== binding.reportVersionId ||
      version.jobId !== binding.jobId ||
      version.persistenceFingerprint !== binding.persistenceFingerprint
    )
      throw new ScoutingReportRepositoryError("report-storage-corrupt");
    return Object.freeze({ outcome: "replayed" as const, version, head });
  }

  async completeWithReport(
    input: ScoutingReportCompletionInput,
  ): Promise<ScoutingReportCompletionResult> {
    try {
      assertScoutingTimestamp(input.completedAt);
    } catch (error) {
      throw toScoutingReportRepositoryError(error, "report-validation-invalid");
    }
    let material = normalizeScoutingReportCompletionMaterial(input.material);
    if (input.completedAt < material.version.generatedAt)
      throw new ScoutingReportRepositoryError("report-validation-invalid");
    const original = material;
    for (let retries = 0; ; retries += 1) {
      const attempt = await this.locked(() =>
        this.completeOnce(material, input.completedAt),
      );
      if (attempt.kind === "done") return attempt.result;
      if (
        input.recompute === undefined ||
        retries >= SCOUTING_REPORT_CAS_RETRY_LIMIT
      )
        throw new ScoutingReportRepositoryError("report-head-cas-conflict");
      material = assertScoutingReportRecomputeCoherent(
        original,
        normalizeScoutingReportCompletionMaterial(
          await input.recompute(
            attempt.winningHead,
            attempt.winningPredecessor,
          ),
        ),
      );
    }
  }

  private async completeOnce(
    material: ScoutingReportCompletionMaterial,
    completedAt: string,
  ): Promise<
    | { readonly kind: "done"; readonly result: ScoutingReportCompletionResult }
    | {
        readonly kind: "cas";
        readonly winningHead: ScoutingReportHead;
        readonly winningPredecessor: ScoutingReportVersionRecord;
      }
  > {
    const version = material.version;
    // Replay resolution FIRST: an existing binding never requires an active
    // attempt and never mutates or rewrites first-write telemetry.
    const binding = this.storedBinding(version.jobId);
    if (binding)
      return { kind: "done", result: this.resolveReplay(binding, material) };
    // Defense in depth: the version id already exists without a binding.
    const existingCanonical = this.versionCanonicalById.get(
      version.reportVersionId,
    );
    if (existingCanonical !== undefined) {
      throw new ScoutingReportRepositoryError(
        existingCanonical === material.envelope
          ? "report-storage-corrupt"
          : "report-replay-conflict",
      );
    }
    const { job, attempt } = requireClaimedScoutingLifecycle(
      this.readJob(version.jobId),
      this.readAttempt(version.attemptId),
      version,
    );
    const lock = this.activeLocks.get(job.semanticDigest);
    if (
      !lock ||
      lock.jobId !== job.jobId ||
      lock.attemptId !== attempt.attemptId
    )
      throw new ScoutingReportRepositoryError("report-stale-attempt");
    if (
      !(await this.eventFence.verifyEventVersion(
        version.eventId,
        version.eventVersion,
      ))
    )
      throw new ScoutingReportRepositoryError("report-event-version-changed");
    // Head CAS: create at stateVersion 1 or advance on the exact predecessor.
    const currentHead = this.storedHead(version.reportId);
    const casSatisfied =
      version.predecessor === null
        ? currentHead === null
        : currentHead !== null &&
          currentHead.latestVersionId === version.predecessor.reportVersionId &&
          currentHead.latestVersionNumber ===
            version.predecessor.versionNumber &&
          currentHead.latestDraftHash === version.predecessor.draftHash &&
          currentHead.stateVersion === material.head.stateVersion - 1;
    if (!casSatisfied) {
      if (currentHead === null)
        throw new ScoutingReportRepositoryError("report-head-cas-conflict");
      const winningPredecessor = this.storedVersion(
        version.reportId,
        currentHead.latestVersionNumber,
      );
      if (!winningPredecessor)
        throw new ScoutingReportRepositoryError("report-storage-corrupt");
      return { kind: "cas", winningHead: currentHead, winningPredecessor };
    }
    if (this.versionRows.get(version.reportId)?.has(version.versionNumber))
      throw new ScoutingReportRepositoryError("report-storage-corrupt");
    const pointer = material.completionPointer;
    const reportBinding = toScoutingReportBinding(pointer);
    let completedJob: ScoutingJobV2;
    let completedAttempt: ScoutingAttemptV2;
    try {
      completedJob = completeScoutingJobWithReport(
        job,
        reportBinding,
        completedAt,
      );
      completedAttempt = completeScoutingAttemptWithReport(
        attempt,
        reportBinding,
        completedAt,
      );
    } catch (error) {
      throw toScoutingReportRepositoryError(error, "report-validation-invalid");
    }
    // Commit point: every check has passed, apply all writes together.
    const rows =
      this.versionRows.get(version.reportId) ?? new Map<number, unknown>();
    rows.set(version.versionNumber, clone(version));
    this.versionRows.set(version.reportId, rows);
    this.versionCanonicalById.set(version.reportVersionId, material.envelope);
    this.headRows.set(version.reportId, clone(material.head));
    this.bindingRows.set(version.jobId, {
      value: clone({
        ...pointer,
        persistenceFingerprint: version.persistenceFingerprint,
      }),
    });
    this.jobRows.set(completedJob.jobId, clone(completedJob));
    this.attemptRows.set(completedAttempt.attemptId, clone(completedAttempt));
    this.activeLocks.delete(job.semanticDigest);
    return {
      kind: "done",
      result: Object.freeze({
        outcome: "completed" as const,
        version,
        head: material.head,
        job: completedJob,
        attempt: completedAttempt,
      }),
    };
  }

  async getHead(
    reportId: string,
    requesterId: string,
  ): Promise<ScoutingReportHead | null> {
    if (!isScoutingReportId(reportId)) return null;
    return this.locked(() => {
      const head = this.storedHead(reportId);
      return head && head.requesterId === requesterId ? head : null;
    });
  }

  async getVersion(
    reportId: string,
    versionNumber: number,
    requesterId: string,
  ): Promise<ScoutingReportVersionRecord | null> {
    if (
      !isScoutingReportId(reportId) ||
      !Number.isSafeInteger(versionNumber) ||
      versionNumber < 1
    )
      return null;
    return this.locked(() => {
      const version = this.storedVersion(reportId, versionNumber);
      return version && version.requesterId === requesterId ? version : null;
    });
  }

  async listVersions(
    reportId: string,
    requesterId: string,
  ): Promise<readonly ScoutingReportVersionRecord[]> {
    if (!isScoutingReportId(reportId)) return Object.freeze([]);
    return this.locked(() => {
      const rows = this.versionRows.get(reportId);
      if (!rows) return Object.freeze([]);
      const versions = [...rows.keys()]
        .sort((left, right) => left - right)
        .map((versionNumber) => {
          const version = this.storedVersion(reportId, versionNumber);
          if (!version)
            throw new ScoutingReportRepositoryError("report-storage-corrupt");
          return version;
        });
      if (versions.some((version) => version.requesterId !== requesterId))
        return Object.freeze([]);
      return Object.freeze(versions);
    });
  }

  async getByJobBinding(
    jobId: string,
    requesterId: string,
  ): Promise<ScoutingReportVersionRecord | null> {
    if (!isScoutingJobIdForReports(jobId)) return null;
    return this.locked(() => {
      const binding = this.storedBinding(jobId);
      if (!binding) return null;
      const version = this.storedVersion(
        binding.reportId,
        binding.reportVersionNumber,
      );
      if (!version || version.reportVersionId !== binding.reportVersionId)
        throw new ScoutingReportRepositoryError("report-storage-corrupt");
      return version.requesterId === requesterId ? version : null;
    });
  }
}
