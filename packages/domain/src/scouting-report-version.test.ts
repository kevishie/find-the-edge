import { describe, expect, it } from "vitest";
import {
  SCOUTING_WORKFLOW_INTENT,
  completeScoutingAttemptWithReport,
  completeScoutingJobWithReport,
  createQueuedScoutingRecords,
  readScoutingAttemptRecord,
  readScoutingJobRecord,
  validateScoutingAttemptV2,
  validateScoutingJobV2,
  validateScoutingReportBinding,
  type ScoutingAttempt,
  type ScoutingJob,
} from "./scouting-job";
import {
  SCOUTING_REPORT_ENVELOPE_MAX_BYTES,
  SCOUTING_REPORT_FAILURE_CODES,
  advanceScoutingReportHead,
  assertScoutingReportEnvelopeBytes,
  canonicalScoutingReportJson,
  createScoutingReportCompletionPointer,
  createScoutingReportDraftHash,
  createScoutingReportHead,
  createScoutingReportId,
  createScoutingReportPersistenceFingerprint,
  createScoutingReportVersion,
  createScoutingReportVersionEnvelope,
  deriveScoutingReportChangeSummary,
  isRetryableScoutingReportFailure,
  isScoutingReportFailureCode,
  normalizeScoutingReportCompletionPointer,
  normalizeScoutingReportVersion,
  parseScoutingReportVersionEnvelope,
  toScoutingReportBinding,
  type CreateScoutingReportVersionInput,
  type ScoutingReportInlinePayload,
  type ScoutingReportProvenance,
} from "./scouting-report-version";

const T0 = "2026-08-10T12:00:00.000Z";
const T1 = "2026-08-10T12:01:00.000Z";
const T2 = "2026-08-10T12:05:00.000Z";
const T3 = "2026-08-10T12:09:00.000Z";

const command = {
  schemaVersion: 1 as const,
  requesterId: "user-123",
  idempotencyKey: "request-123",
  eventId: "baseball:mlb:event-123",
  eventVersion: 7,
  workflowIntent: SCOUTING_WORKFLOW_INTENT,
};

const firstJob = createQueuedScoutingRecords(command, T0);
const secondJob = createQueuedScoutingRecords(
  { ...command, idempotencyKey: "request-456" },
  T0,
);

const versions = {
  contractVersion: "analysis-contract-v1",
  promptBundleId: "bundle-mlb",
  promptBundleVersion: "1.0.0",
  promptSections: {
    shared: { id: "shared-core", version: "1" },
    sport: { id: "mlb-module", version: "2" },
    strategy: { id: "core-strategy", version: "3" },
    analysis: { id: "analysis-core", version: "1" },
  },
  inputSchemaId: "scouting-input",
  inputSchemaVersion: "1",
  outputSchemaId: "scouting-report",
  outputSchemaVersion: "1",
  modelId: "model-x",
  modelVersion: "2026-01",
} satisfies ScoutingReportInlinePayload["versions"];

const payload = {
  candidate: {
    marketKey: "moneyline",
    outcomeStructure: "two-way",
    selection: { kind: "participant", participantId: "yankees" },
  },
  versions,
  probability: { estimate: 0.55, low: 0.5, high: 0.6, uncertainty: 0.05 },
  status: "complete",
  abstentionCodes: [],
  summary: "Yankees hold a pricing edge.",
  assertions: [
    {
      text: "Yankees hold a pricing edge.",
      classification: "inference",
      citationIds: ["obs-1"],
    },
  ],
} satisfies ScoutingReportInlinePayload;

const provenance = {
  citedSourceObservations: [
    {
      observationId: "obs-2",
      category: "injury",
      status: "verified",
      observedAt: T1,
    },
    {
      observationId: "obs-1",
      category: "lineup",
      status: "verified",
      observedAt: T1,
    },
  ],
  providerObservations: [
    { providerId: "sharpapi", observationId: "obs-1", observedAt: T1 },
  ],
  evidenceReferences: [
    {
      sourceId: "sharpapi",
      observedAt: T1,
      retrievedAt: T1,
      verification: "verified",
    },
  ],
  calculationVersions: [{ id: "no-vig-fair-line", version: "1" }],
  referenceHashes: ["ab".repeat(32)],
  oddsSnapshotIds: ["snap-2", "snap-1"],
  inputHash: "cd".repeat(32),
  inputSchema: { id: "scouting-input", version: "1" },
  promptBundle: { id: "bundle-mlb", version: "1.0.0" },
  model: { id: "model-x", version: "2026-01" },
  sportModule: { id: "mlb-module", version: "2" },
  strategy: { id: "core-strategy", version: "3" },
  reportSchema: { id: "scouting-report", version: "1" },
} satisfies ScoutingReportProvenance;

const baseInput: CreateScoutingReportVersionInput = {
  requesterId: command.requesterId,
  eventId: command.eventId,
  eventVersion: command.eventVersion,
  jobId: firstJob.job.jobId,
  attemptId: firstJob.job.currentAttemptId,
  versionNumber: 1,
  payload,
  provenance,
  generatedAt: T2,
  predecessor: null,
};

const versionOne = createScoutingReportVersion(baseInput);

const changedPayload = {
  ...payload,
  probability: { estimate: 0.58, low: 0.53, high: 0.63, uncertainty: 0.05 },
} satisfies ScoutingReportInlinePayload;

const versionTwoInput: CreateScoutingReportVersionInput = {
  ...baseInput,
  jobId: secondJob.job.jobId,
  attemptId: secondJob.job.currentAttemptId,
  versionNumber: 2,
  payload: changedPayload,
  generatedAt: T3,
  predecessor: {
    reportVersionId: versionOne.reportVersionId,
    versionNumber: 1,
    draftHash: versionOne.draftHash,
    payload,
  },
};

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

describe("scouting report version records", () => {
  it("round-trips a stored record through re-derivation byte-identically", () => {
    const stored = clone(versionOne);
    const normalized = normalizeScoutingReportVersion(stored);
    expect(canonicalScoutingReportJson(normalized)).toBe(
      canonicalScoutingReportJson(versionOne),
    );
    expect(normalized.reportId).toBe(
      createScoutingReportId(command.requesterId, command.eventId),
    );
    expect(normalized.validationOutcome).toBe("complete");
    expect(Object.isFrozen(normalized)).toBe(true);
    expect(Object.isFrozen(normalized.payload.assertions)).toBe(true);
    expect(Object.isFrozen(normalized.provenance.oddsSnapshotIds)).toBe(true);
  });

  it("sorts provenance collections deterministically on creation", () => {
    expect(
      versionOne.provenance.citedSourceObservations.map(
        ({ observationId }) => observationId,
      ),
    ).toEqual(["obs-1", "obs-2"]);
    expect(versionOne.provenance.oddsSnapshotIds).toEqual(["snap-1", "snap-2"]);
  });

  it("derives identical identities and bytes regardless of provenance input order", () => {
    const shuffled = createScoutingReportVersion({
      ...baseInput,
      provenance: {
        ...provenance,
        citedSourceObservations: [
          ...provenance.citedSourceObservations,
        ].reverse(),
        oddsSnapshotIds: [...provenance.oddsSnapshotIds].reverse(),
      },
    });
    expect(shuffled.reportVersionId).toBe(versionOne.reportVersionId);
    expect(shuffled.draftHash).toBe(versionOne.draftHash);
    expect(createScoutingReportDraftHash(payload)).toBe(versionOne.draftHash);
    expect(canonicalScoutingReportJson(shuffled)).toBe(
      canonicalScoutingReportJson(versionOne),
    );
  });

  it("scopes report identity to owner and event", () => {
    expect(createScoutingReportId("user-123", command.eventId)).toBe(
      versionOne.reportId,
    );
    expect(createScoutingReportId("user-456", command.eventId)).not.toBe(
      versionOne.reportId,
    );
    expect(
      createScoutingReportId("user-123", "baseball:mlb:event-456"),
    ).not.toBe(versionOne.reportId);
  });

  it("rejects tampered stored material as corrupt", () => {
    expect(() =>
      normalizeScoutingReportVersion({
        ...clone(versionOne),
        draftHash: "ef".repeat(32),
      }),
    ).toThrow("report-storage-corrupt");
    const unsorted = clone(versionOne) as unknown as {
      provenance: { oddsSnapshotIds: string[] };
    };
    unsorted.provenance.oddsSnapshotIds = ["snap-2", "snap-1"];
    expect(() => normalizeScoutingReportVersion(unsorted)).toThrow(
      "report-storage-corrupt",
    );
    const outcome = { ...clone(versionOne), validationOutcome: "abstain" };
    expect(() => normalizeScoutingReportVersion(outcome)).toThrow(
      "report-storage-corrupt",
    );
  });

  it("rejects provenance that contradicts the payload version manifest", () => {
    expect(() =>
      createScoutingReportVersion({
        ...baseInput,
        provenance: {
          ...provenance,
          model: { id: "model-x", version: "2026-02" },
        },
      }),
    ).toThrow("report-validation-invalid");
  });
});

describe("persistence fingerprint", () => {
  const material = {
    reportId: versionOne.reportId,
    eventId: command.eventId,
    eventVersion: command.eventVersion,
    draftHash: versionOne.draftHash,
    provenance,
  };

  it("ignores usage and latency so exact replay matches first write", () => {
    const bare = createScoutingReportPersistenceFingerprint(material);
    const withTelemetry = createScoutingReportPersistenceFingerprint({
      ...material,
      usage: { inputTokens: 4096, outputTokens: 512 },
      latencyMs: 1834,
    });
    expect(withTelemetry).toBe(bare);
    expect(versionOne.persistenceFingerprint).toBe(bare);
  });

  it("changes when authoritative material changes", () => {
    expect(
      createScoutingReportPersistenceFingerprint({
        ...material,
        eventVersion: command.eventVersion + 1,
      }),
    ).not.toBe(versionOne.persistenceFingerprint);
    expect(
      createScoutingReportPersistenceFingerprint({
        ...material,
        draftHash: "ef".repeat(32),
      }),
    ).not.toBe(versionOne.persistenceFingerprint);
    expect(
      createScoutingReportPersistenceFingerprint({
        ...material,
        provenance: {
          ...provenance,
          model: { id: "model-x", version: "2026-02" },
        },
      }),
    ).not.toBe(versionOne.persistenceFingerprint);
  });
});

describe("canonical envelope byte cap", () => {
  it("accepts exactly the cap and rejects one byte over, measuring bytes", () => {
    const exactAscii = "a".repeat(SCOUTING_REPORT_ENVELOPE_MAX_BYTES);
    expect(assertScoutingReportEnvelopeBytes(exactAscii)).toBe(exactAscii);
    expect(() => assertScoutingReportEnvelopeBytes(`${exactAscii}a`)).toThrow(
      "report-envelope-oversized",
    );
    // Two-byte character: string length stays below the cap while encoded
    // bytes land exactly on it, then one past it.
    const exactMultibyte = `${"a".repeat(SCOUTING_REPORT_ENVELOPE_MAX_BYTES - 2)}é`;
    expect(exactMultibyte.length).toBeLessThan(
      SCOUTING_REPORT_ENVELOPE_MAX_BYTES,
    );
    expect(assertScoutingReportEnvelopeBytes(exactMultibyte)).toBe(
      exactMultibyte,
    );
    expect(() =>
      assertScoutingReportEnvelopeBytes(
        `${"a".repeat(SCOUTING_REPORT_ENVELOPE_MAX_BYTES - 1)}é`,
      ),
    ).toThrow("report-envelope-oversized");
  });

  it("serializes, caps, and reparses a record envelope canonically", () => {
    const envelope = createScoutingReportVersionEnvelope(versionOne);
    const reparsed = parseScoutingReportVersionEnvelope(envelope);
    expect(canonicalScoutingReportJson(reparsed)).toBe(envelope);
    expect(() => parseScoutingReportVersionEnvelope(`${envelope} `)).toThrow(
      "report-storage-corrupt",
    );
  });

  it("accepts a record landing exactly on the cap and rejects one byte more", () => {
    const filler = (length: number) => ({
      text: "a".repeat(length),
      classification: "inference" as const,
      citationIds: Array.from(
        { length: 16 },
        (_, index) =>
          `cite-${String(index).padStart(2, "0")}-${"x".repeat(120)}`,
      ),
    });
    const build = (
      fillerCount: number,
      finalLength: number,
      summaryLength: number,
    ) =>
      createScoutingReportVersion({
        ...baseInput,
        payload: {
          ...payload,
          summary: "a".repeat(summaryLength),
          assertions: [
            ...payload.assertions,
            ...Array.from({ length: fillerCount }, () => filler(2000)),
            filler(finalLength),
          ],
        },
      });
    const measure = (fillerCount: number) =>
      SCOUTING_REPORT_ENVELOPE_MAX_BYTES -
      new TextEncoder().encode(
        canonicalScoutingReportJson(build(fillerCount, 1, 1)),
      ).length;
    let fillerCount = 0;
    let deficit = measure(fillerCount);
    while (deficit > 5800) {
      fillerCount += 1;
      deficit = measure(fillerCount);
    }
    const finalLength = 1 + Math.min(deficit, 1999);
    const summaryLength = 1 + deficit - (finalLength - 1);
    expect(summaryLength).toBeLessThanOrEqual(4000);
    const exact = build(fillerCount, finalLength, summaryLength);
    const envelope = createScoutingReportVersionEnvelope(exact);
    expect(new TextEncoder().encode(envelope).length).toBe(
      SCOUTING_REPORT_ENVELOPE_MAX_BYTES,
    );
    expect(() => build(fillerCount, finalLength, summaryLength + 1)).toThrow(
      "report-envelope-oversized",
    );
  });
});

describe("predecessor fence, change summary, and head CAS", () => {
  it("creates a fenced successor with a deterministic change summary", () => {
    const versionTwo = createScoutingReportVersion(versionTwoInput);
    expect(versionTwo.versionNumber).toBe(2);
    expect(versionTwo.predecessor).toEqual({
      reportVersionId: versionOne.reportVersionId,
      versionNumber: 1,
      draftHash: versionOne.draftHash,
    });
    expect(versionTwo.changeSummary).toEqual({
      kind: "changed",
      changedFields: ["probability"],
    });
  });

  it("marks an identical-content successor from a new job as unchanged", () => {
    const unchanged = createScoutingReportVersion({
      ...versionTwoInput,
      payload,
    });
    expect(unchanged.changeSummary).toEqual({
      kind: "unchanged",
      changedFields: [],
    });
    expect(unchanged.draftHash).toBe(versionOne.draftHash);
    expect(unchanged.reportVersionId).not.toBe(versionOne.reportVersionId);
  });

  it("derives initial, unchanged, and changed summaries deterministically", () => {
    expect(deriveScoutingReportChangeSummary(null, payload)).toEqual({
      kind: "initial",
      changedFields: [],
    });
    expect(deriveScoutingReportChangeSummary(payload, payload)).toEqual({
      kind: "unchanged",
      changedFields: [],
    });
    expect(
      deriveScoutingReportChangeSummary(payload, {
        ...changedPayload,
        status: "abstain",
        abstentionCodes: ["missing-evidence:lineup"],
        summary: "Abstaining.",
        assertions: [
          { text: "Abstaining.", classification: "inference", citationIds: [] },
        ],
      }).changedFields,
    ).toEqual([
      "abstentionCodes",
      "assertions",
      "probability",
      "status",
      "summary",
    ]);
  });

  it("rejects fence violations at creation", () => {
    expect(() =>
      createScoutingReportVersion({ ...versionTwoInput, predecessor: null }),
    ).toThrow("report-validation-invalid");
    expect(() =>
      createScoutingReportVersion({ ...baseInput, versionNumber: 2 }),
    ).toThrow("report-validation-invalid");
    expect(() =>
      createScoutingReportVersion({
        ...versionTwoInput,
        predecessor: {
          ...versionTwoInput.predecessor!,
          draftHash: "ef".repeat(32),
        },
      }),
    ).toThrow("report-validation-invalid");
  });

  it("advances the head only through an exact compare-and-swap fence", () => {
    const head = createScoutingReportHead(versionOne);
    expect(head.latestVersionNumber).toBe(1);
    expect(head.stateVersion).toBe(1);
    const versionTwo = createScoutingReportVersion(versionTwoInput);
    const advanced = advanceScoutingReportHead(head, versionTwo);
    expect(advanced.latestVersionNumber).toBe(2);
    expect(advanced.latestVersionId).toBe(versionTwo.reportVersionId);
    expect(advanced.latestDraftHash).toBe(versionTwo.draftHash);
    expect(advanced.stateVersion).toBe(2);
    expect(() => advanceScoutingReportHead(head, versionOne)).toThrow(
      "report-head-cas-conflict",
    );
    expect(() => advanceScoutingReportHead(advanced, versionTwo)).toThrow(
      "report-head-cas-conflict",
    );
    expect(() => createScoutingReportHead(versionTwo)).toThrow(
      "report-head-cas-conflict",
    );
  });
});

describe("failure taxonomy", () => {
  it("is the exact closed union with a stable retry classification", () => {
    expect([...SCOUTING_REPORT_FAILURE_CODES]).toEqual([
      "report-validation-invalid",
      "report-replay-conflict",
      "report-stale-attempt",
      "report-event-version-changed",
      "report-head-cas-conflict",
      "report-storage-corrupt",
      "report-envelope-oversized",
    ]);
    for (const code of SCOUTING_REPORT_FAILURE_CODES) {
      expect(isScoutingReportFailureCode(code)).toBe(true);
      expect(isRetryableScoutingReportFailure(code)).toBe(
        code === "report-head-cas-conflict",
      );
    }
    expect(isScoutingReportFailureCode("workflow-timeout")).toBe(false);
  });
});

describe("completion pointer", () => {
  it("binds job and attempt to exactly one version and round-trips", () => {
    const pointer = createScoutingReportCompletionPointer(versionOne);
    expect(pointer).toEqual({
      schemaVersion: 1,
      jobId: firstJob.job.jobId,
      attemptId: firstJob.job.currentAttemptId,
      reportId: versionOne.reportId,
      reportVersionId: versionOne.reportVersionId,
      reportVersionNumber: 1,
      draftHash: versionOne.draftHash,
    });
    expect(normalizeScoutingReportCompletionPointer(clone(pointer))).toEqual(
      pointer,
    );
    expect(() =>
      normalizeScoutingReportCompletionPointer({
        ...pointer,
        attemptId: secondJob.job.currentAttemptId,
      }),
    ).toThrow("report-completion-pointer-invalid");
    expect(() =>
      normalizeScoutingReportCompletionPointer({
        ...pointer,
        draftHash: "ef".repeat(32),
      }),
    ).toThrow("report-completion-pointer-invalid");
  });
});

describe("schema-v2 job and attempt completion contracts", () => {
  const pointer = createScoutingReportCompletionPointer(versionOne);
  const binding = toScoutingReportBinding(pointer);
  const inProgressJob: ScoutingJob = {
    ...firstJob.job,
    status: "in_progress",
    stateVersion: 2,
    updatedAt: T1,
  };
  const inProgressAttempt: ScoutingAttempt = {
    ...firstJob.attempt,
    status: "in_progress",
    stateVersion: 2,
    startedAt: T1,
    updatedAt: T1,
  };

  it("reads schema-v1 rows as explicit legacy states without migration", () => {
    expect(readScoutingJobRecord(firstJob.job)).toEqual({
      kind: "legacy",
      job: firstJob.job,
    });
    const legacyCompleted: ScoutingJob = {
      ...firstJob.job,
      status: "completed",
      stateVersion: 3,
      updatedAt: T2,
    };
    const read = readScoutingJobRecord(legacyCompleted);
    expect(read.kind).toBe("legacy-reportless-completion");
    expect(read.job).toEqual(legacyCompleted);
    expect("reportPointer" in read.job).toBe(false);
    const legacyAttempt: ScoutingAttempt = {
      ...firstJob.attempt,
      status: "completed",
      stateVersion: 3,
      startedAt: T1,
      finishedAt: T2,
      updatedAt: T2,
    };
    expect(readScoutingAttemptRecord(legacyAttempt).kind).toBe(
      "legacy-reportless-completion",
    );
    expect(readScoutingAttemptRecord(firstJob.attempt).kind).toBe("legacy");
  });

  it("completes schema-v2 jobs only through a report pointer", () => {
    const completed = completeScoutingJobWithReport(inProgressJob, binding, T2);
    expect(completed.schemaVersion).toBe(2);
    expect(completed.status).toBe("completed");
    expect(completed.stateVersion).toBe(3);
    expect(completed.reportPointer).toEqual(binding);
    expect(readScoutingJobRecord(completed)).toEqual({
      kind: "current",
      job: completed,
    });
    const reportless: Record<string, unknown> = { ...completed };
    delete reportless["reportPointer"];
    expect(() => validateScoutingJobV2(reportless)).toThrow(
      "scouting-job-report-pointer-missing",
    );
    expect(() => readScoutingJobRecord(reportless)).toThrow(
      "scouting-job-report-pointer-missing",
    );
    expect(() =>
      validateScoutingJobV2({
        ...inProgressJob,
        schemaVersion: 2,
        reportPointer: binding,
      }),
    ).toThrow("scouting-job-invalid");
    expect(() =>
      completeScoutingJobWithReport(firstJob.job, binding, T2),
    ).toThrow("scouting-job-transition-invalid");
  });

  it("accepts non-completed schema-v2 rows without a pointer", () => {
    const current = validateScoutingJobV2({
      ...inProgressJob,
      schemaVersion: 2,
    });
    expect(readScoutingJobRecord(current)).toEqual({
      kind: "current",
      job: current,
    });
  });

  it("completes schema-v2 attempts only through a report pointer", () => {
    const completed = completeScoutingAttemptWithReport(
      inProgressAttempt,
      binding,
      T2,
    );
    expect(completed.schemaVersion).toBe(2);
    expect(completed.status).toBe("completed");
    expect(completed.finishedAt).toBe(T2);
    expect(completed.reportPointer).toEqual(binding);
    expect(readScoutingAttemptRecord(completed)).toEqual({
      kind: "current",
      attempt: completed,
    });
    const reportless: Record<string, unknown> = { ...completed };
    delete reportless["reportPointer"];
    expect(() => validateScoutingAttemptV2(reportless)).toThrow(
      "scouting-attempt-report-pointer-missing",
    );
    expect(() =>
      completeScoutingAttemptWithReport(firstJob.attempt, binding, T2),
    ).toThrow("scouting-job-transition-invalid");
  });

  it("rejects malformed report bindings", () => {
    expect(() =>
      validateScoutingReportBinding({ ...binding, reportVersionNumber: 0 }),
    ).toThrow("scouting-report-binding-invalid");
    expect(() =>
      validateScoutingReportBinding({
        ...binding,
        reportVersionId: "scout-report-version:nope",
      }),
    ).toThrow("scouting-report-binding-invalid");
  });
});
