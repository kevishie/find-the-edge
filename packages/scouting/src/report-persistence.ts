import {
  advanceScoutingReportHead,
  canonicalScoutingReportJson,
  createScoutingReportCompletionPointer,
  createScoutingReportDraftHash,
  createScoutingReportHead,
  createScoutingReportId,
  createScoutingReportPersistenceFingerprint,
  createScoutingReportVersion,
  createScoutingReportVersionEnvelope,
  isRetryableScoutingReportFailure,
  isScoutingReportFailureCode,
  normalizeScoutingReportHead,
  normalizeScoutingReportInlinePayload,
  normalizeScoutingReportProvenance,
  normalizeScoutingReportVersion,
  type ScoutingReportCompletionPointer,
  type ScoutingReportEvidenceReference,
  type ScoutingReportFailureCode,
  type ScoutingReportHead,
  type ScoutingReportInlinePayload,
  type ScoutingReportPersistenceMaterial,
  type ScoutingReportProvenance,
  type ScoutingReportProviderObservation,
  type ScoutingReportStatus,
  type ScoutingReportVersionRecord,
  type ScoutingReportVersionRef,
} from "@find-the-edge/domain";

import {
  normalizeAnalysisRequest,
  validateAnalysisOutput,
  type AnalysisPolicyLike,
  type AnalysisStrategyLike,
} from "./analysis-contract";

/**
 * FTE-042 stage 2: the scouting-owned persistence projection. This module
 * revalidates raw FTE-041 analysis material from scratch (a projection from
 * unvalidated input is impossible by construction), projects it into the
 * domain's bounded inline payload plus deterministically sorted provenance,
 * and assembles exactly what a repository needs to run the atomic completion
 * transaction: the immutable version record (which carries its persistence
 * fingerprint), the head to write or compare-and-swap, the job/attempt
 * completion pointer, and the size-capped canonical envelope.
 *
 * Deterministic prior-version change summaries are derived inside the domain
 * contract itself: `createScoutingReportVersion` diffs the predecessor payload
 * via `deriveScoutingReportChangeSummary`, so this module deliberately
 * supplies only the predecessor record and never duplicates that logic.
 */

/** Stable, kebab-case failure surface for every function in this module. */
export class ScoutingReportPersistenceError extends Error {
  override readonly name = "ScoutingReportPersistenceError";
  /** True only for `report-head-cas-conflict`: reload the head and retry. */
  readonly retryable: boolean;
  constructor(
    readonly code: ScoutingReportFailureCode,
    options?: Readonly<{ cause?: unknown }>,
  ) {
    super(code, options?.cause === undefined ? undefined : options);
    this.retryable = isRetryableScoutingReportFailure(code);
  }
}

const toPersistenceError = (error: unknown): ScoutingReportPersistenceError => {
  if (error instanceof ScoutingReportPersistenceError) return error;
  if (error instanceof Error && isScoutingReportFailureCode(error.message)) {
    return new ScoutingReportPersistenceError(error.message, { cause: error });
  }
  return new ScoutingReportPersistenceError("report-validation-invalid", {
    cause: error,
  });
};

/**
 * Provenance material the analysis contract does not carry itself: provider
 * observation identities, external evidence references, calculation versions,
 * reference hashes, and odds snapshot ids gathered by the worker from the
 * FTE-040 scouting input. Order is irrelevant (the domain creator sorts) and
 * exact duplicates are collapsed; conflicting near-duplicates are rejected.
 */
export interface ScoutingReportProvenanceSource {
  readonly providerObservations: readonly ScoutingReportProviderObservation[];
  readonly evidenceReferences: readonly ScoutingReportEvidenceReference[];
  readonly calculationVersions: readonly ScoutingReportVersionRef[];
  readonly referenceHashes: readonly string[];
  readonly oddsSnapshotIds: readonly string[];
}

export interface ProjectValidatedReportOptions {
  /** Raw, untrusted FTE-041 request material; renormalized from scratch. */
  readonly request: unknown;
  /** Raw, untrusted FTE-041 model output material; revalidated from scratch. */
  readonly output: unknown;
  readonly policy: AnalysisPolicyLike;
  readonly strategy?: AnalysisStrategyLike;
  readonly provenanceSource: ScoutingReportProvenanceSource;
}

/**
 * A validated, storage-ready projection: the bounded inline payload, sorted
 * provenance whose six version refs restate the payload manifest exactly, the
 * canonical draft hash, and the input hash bound by the FTE-041 contract.
 */
export interface ScoutingReportProjection {
  readonly payload: ScoutingReportInlinePayload;
  readonly provenance: ScoutingReportProvenance;
  readonly draftHash: string;
  readonly inputHash: string;
  /** Derived from `payload.status`; never caller-supplied. */
  readonly validationOutcome: ScoutingReportStatus;
}

const PROVENANCE_SOURCE_KEYS = [
  "calculationVersions",
  "evidenceReferences",
  "oddsSnapshotIds",
  "providerObservations",
  "referenceHashes",
] as const;

const isProvenanceSourceShape = (
  value: unknown,
): value is ScoutingReportProvenanceSource =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).length === PROVENANCE_SOURCE_KEYS.length &&
  PROVENANCE_SOURCE_KEYS.every((key) =>
    Array.isArray((value as Readonly<Record<string, unknown>>)[key]),
  );

const dedupeExact = <T>(items: readonly T[]): readonly T[] => {
  const seen = new Set<string>();
  const output: T[] = [];
  for (const item of items) {
    const key = canonicalScoutingReportJson(item);
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(item);
  }
  return output;
};

/**
 * Revalidates raw FTE-041 material end to end (request normalization plus
 * output validation against the policy) and projects the result into the
 * domain inline payload and provenance. Cited source observations are
 * extracted from the assertions' citation ids only — uncited evidence never
 * enters provenance — and the provenance version refs restate the validated
 * output's version manifest, so payload/provenance coherence holds by
 * construction. Tampered or unvalidated material throws
 * `report-validation-invalid`.
 */
export function projectValidatedReport(
  options: ProjectValidatedReportOptions,
): ScoutingReportProjection {
  try {
    if (!isProvenanceSourceShape(options.provenanceSource)) {
      throw new ScoutingReportPersistenceError("report-validation-invalid");
    }
    const request = normalizeAnalysisRequest(
      options.request,
      options.policy,
      options.strategy,
    );
    const validated = validateAnalysisOutput(
      options.output,
      request,
      options.policy,
    );
    const payload = normalizeScoutingReportInlinePayload({
      candidate: validated.candidate,
      versions: validated.versions,
      probability: validated.probability,
      status: validated.status,
      abstentionCodes: validated.abstentionCodes,
      summary: validated.summary,
      assertions: validated.assertions,
    });
    const citedIds = new Set<string>();
    for (const assertion of validated.assertions) {
      for (const citationId of assertion.citationIds) citedIds.add(citationId);
    }
    const citedSourceObservations = request.evidence
      .filter((item) => citedIds.has(item.id))
      .map((item) => ({
        observationId: item.id,
        category: item.category,
        status: item.status,
        observedAt: item.observedAt,
      }));
    const versions = validated.versions;
    const provenance = normalizeScoutingReportProvenance({
      citedSourceObservations,
      providerObservations: dedupeExact(
        options.provenanceSource.providerObservations,
      ),
      evidenceReferences: dedupeExact(
        options.provenanceSource.evidenceReferences,
      ),
      calculationVersions: dedupeExact(
        options.provenanceSource.calculationVersions,
      ),
      referenceHashes: dedupeExact(options.provenanceSource.referenceHashes),
      oddsSnapshotIds: dedupeExact(options.provenanceSource.oddsSnapshotIds),
      inputHash: request.inputHash,
      inputSchema: {
        id: versions.inputSchemaId,
        version: versions.inputSchemaVersion,
      },
      promptBundle: {
        id: versions.promptBundleId,
        version: versions.promptBundleVersion,
      },
      model: { id: versions.modelId, version: versions.modelVersion },
      sportModule: versions.promptSections.sport,
      strategy: versions.promptSections.strategy,
      reportSchema: {
        id: versions.outputSchemaId,
        version: versions.outputSchemaVersion,
      },
    });
    return Object.freeze({
      payload,
      provenance,
      draftHash: createScoutingReportDraftHash(payload),
      inputHash: provenance.inputHash,
      validationOutcome: payload.status,
    });
  } catch (error) {
    throw toPersistenceError(error);
  }
}

/** Identity and chronology supplied by the trusted worker at completion. */
export interface ScoutingReportCompletionContext {
  readonly requesterId: string;
  readonly eventId: string;
  readonly eventVersion: number;
  readonly jobId: string;
  readonly attemptId: string;
  /** Trusted worker clock, bounded by attempt chronology upstream. */
  readonly generatedAt: string;
}

/**
 * Everything a repository needs for one atomic completion transaction. The
 * persistence fingerprint travels inside `version`; the envelope is the
 * canonical serialization already checked against the 196,608-byte cap.
 */
export interface ScoutingReportCompletionMaterial {
  readonly version: ScoutingReportVersionRecord;
  readonly head: ScoutingReportHead;
  readonly completionPointer: ScoutingReportCompletionPointer;
  readonly envelope: string;
}

const completionMaterial = (
  version: ScoutingReportVersionRecord,
  head: ScoutingReportHead,
): ScoutingReportCompletionMaterial =>
  Object.freeze({
    version,
    head,
    completionPointer: createScoutingReportCompletionPointer(version),
    envelope: createScoutingReportVersionEnvelope(version),
  });

/**
 * Assembles version 1 of a report history: the immutable version record, the
 * freshly created head, the completion pointer, and the size-capped envelope.
 */
export function assembleFirstScoutingReportVersion(
  projection: ScoutingReportProjection,
  context: ScoutingReportCompletionContext,
): ScoutingReportCompletionMaterial {
  try {
    const version = createScoutingReportVersion({
      requesterId: context.requesterId,
      eventId: context.eventId,
      eventVersion: context.eventVersion,
      jobId: context.jobId,
      attemptId: context.attemptId,
      versionNumber: 1,
      payload: projection.payload,
      provenance: projection.provenance,
      generatedAt: context.generatedAt,
      predecessor: null,
    });
    return completionMaterial(version, createScoutingReportHead(version));
  } catch (error) {
    throw toPersistenceError(error);
  }
}

/**
 * Assembles the successor of the exact current head. The caller must supply
 * the head it read plus that head's full predecessor version record — the
 * predecessor payload is required so the domain can derive the deterministic
 * change summary and verify the payload hashes to the fence's draft hash.
 *
 * CAS loser path: when the conditional head write fails with
 * `report-head-cas-conflict` (the only retryable code), reload the winning
 * head and its version record, then call this again with the same projection
 * to recompute the fence, version number, and change summary boundedly.
 */
export function assembleSuccessorScoutingReportVersion(
  projection: ScoutingReportProjection,
  context: ScoutingReportCompletionContext,
  currentHead: ScoutingReportHead,
  predecessor: ScoutingReportVersionRecord,
): ScoutingReportCompletionMaterial {
  try {
    const head = normalizeScoutingReportHead(currentHead);
    const predecessorRecord = normalizeScoutingReportVersion(predecessor);
    if (
      predecessorRecord.reportId !== head.reportId ||
      predecessorRecord.reportVersionId !== head.latestVersionId ||
      predecessorRecord.versionNumber !== head.latestVersionNumber ||
      predecessorRecord.draftHash !== head.latestDraftHash
    ) {
      throw new ScoutingReportPersistenceError("report-head-cas-conflict");
    }
    const version = createScoutingReportVersion({
      requesterId: context.requesterId,
      eventId: context.eventId,
      eventVersion: context.eventVersion,
      jobId: context.jobId,
      attemptId: context.attemptId,
      versionNumber: head.latestVersionNumber + 1,
      payload: projection.payload,
      provenance: projection.provenance,
      generatedAt: context.generatedAt,
      predecessor: {
        reportVersionId: head.latestVersionId,
        versionNumber: head.latestVersionNumber,
        draftHash: head.latestDraftHash,
        payload: predecessorRecord.payload,
      },
    });
    return completionMaterial(
      version,
      advanceScoutingReportHead(head, version),
    );
  } catch (error) {
    throw toPersistenceError(error);
  }
}

/** Owner/event identity for replay comparison; telemetry is ignored. */
export interface ScoutingReportReplayContext {
  readonly requesterId: string;
  readonly eventId: string;
  readonly eventVersion: number;
  /** Accepted for caller convenience; excluded from the fingerprint. */
  readonly usage?: Readonly<Record<string, number>>;
  /** Accepted for caller convenience; excluded from the fingerprint. */
  readonly latencyMs?: number;
}

/**
 * Computes the authoritative replay fingerprint for a projection. Equal to
 * `record.persistenceFingerprint` of any version persisted from the same
 * authoritative material; usage/latency-only differences never change it, so
 * first-write telemetry wins on exact replay.
 */
export function createScoutingReportReplayFingerprint(
  projection: ScoutingReportProjection,
  context: ScoutingReportReplayContext,
): string {
  try {
    const material: ScoutingReportPersistenceMaterial = {
      reportId: createScoutingReportId(context.requesterId, context.eventId),
      eventId: context.eventId,
      eventVersion: context.eventVersion,
      draftHash: projection.draftHash,
      provenance: projection.provenance,
      ...(context.usage === undefined ? {} : { usage: context.usage }),
      ...(context.latencyMs === undefined
        ? {}
        : { latencyMs: context.latencyMs }),
    };
    return createScoutingReportPersistenceFingerprint(material);
  } catch (error) {
    throw toPersistenceError(error);
  }
}
