import { describe, expect, it } from "vitest";

import {
  createScoutingAttemptId,
  normalizeScoutingReportVersion,
  parseScoutingReportVersionEnvelope,
} from "@find-the-edge/domain";

import {
  assembleFirstScoutingReportVersion,
  assembleSuccessorScoutingReportVersion,
  createScoutingReportReplayFingerprint,
  projectValidatedReport,
  ScoutingReportPersistenceError,
  type ScoutingReportCompletionContext,
  type ScoutingReportProvenanceSource,
} from "./report-persistence";
import {
  completeOutput,
  completeRequest,
  fixturePolicy,
} from "./fixtures/analysis";

const jobId = (fill: string): string => `scout-job:${fill.repeat(64)}`;

const context = (
  fill: string,
  generatedAt: string,
): ScoutingReportCompletionContext => ({
  requesterId: "user-1",
  eventId: "event-1",
  eventVersion: 3,
  jobId: jobId(fill),
  attemptId: createScoutingAttemptId(jobId(fill), 1),
  generatedAt,
});

const contextA = context("a", "2026-08-03T22:05:00.000Z");
const contextB = context("b", "2026-08-03T22:10:00.000Z");
const contextC = context("c", "2026-08-03T22:15:00.000Z");

const baseSource: ScoutingReportProvenanceSource = {
  providerObservations: [
    {
      providerId: "sharpapi",
      observationId: "obs-2",
      observedAt: "2026-08-03T21:50:00.000Z",
    },
    {
      providerId: "sharpapi",
      observationId: "obs-1",
      observedAt: "2026-08-03T21:45:00.000Z",
    },
  ],
  evidenceReferences: [
    {
      sourceId: "source-1",
      observedAt: "2026-08-03T21:40:00.000Z",
      retrievedAt: "2026-08-03T21:41:00.000Z",
      verification: "verified",
    },
  ],
  calculationVersions: [
    { id: "no-vig", version: "2" },
    { id: "edge", version: "1" },
    { id: "edge", version: "1" },
  ],
  referenceHashes: ["f".repeat(64), "a".repeat(64), "a".repeat(64)],
  oddsSnapshotIds: ["snapshot-2", "snapshot-1"],
};

const project = (
  output: unknown = completeOutput,
  provenanceSource: ScoutingReportProvenanceSource = baseSource,
) =>
  projectValidatedReport({
    request: completeRequest,
    output,
    policy: fixturePolicy,
    provenanceSource,
  });

const probabilityChangedOutput = {
  ...completeOutput,
  probability: { estimate: 0.58, low: 0.51, high: 0.63, uncertainty: 0.06 },
};

const narrativeChangedOutput = {
  ...probabilityChangedOutput,
  summary: "Home form is comfortably above baseline.",
  assertions: [
    {
      text: "Home form is comfortably above baseline.",
      classification: "factual",
      citationIds: ["form-1"],
    },
  ],
};

const failure = (callback: () => unknown): ScoutingReportPersistenceError => {
  try {
    callback();
  } catch (error) {
    if (error instanceof ScoutingReportPersistenceError) return error;
    throw error;
  }
  throw new Error("expected a ScoutingReportPersistenceError");
};

describe("projectValidatedReport", () => {
  it("projects revalidated FTE-041 material into sorted, coherent provenance", () => {
    const projection = project();
    expect(projection.validationOutcome).toBe("complete");
    expect(projection.payload.status).toBe("complete");
    expect(projection.payload.summary).toBe(completeOutput.summary);
    expect(projection.inputHash).toMatch(/^[a-f0-9]{64}$/);
    expect(projection.draftHash).toMatch(/^[a-f0-9]{64}$/);
    expect(projection.provenance.citedSourceObservations).toEqual([
      {
        observationId: "form-1",
        category: "form",
        status: "verified",
        observedAt: "2026-08-03T21:55:00.000Z",
      },
    ]);
    expect(
      projection.provenance.providerObservations.map(
        ({ observationId }) => observationId,
      ),
    ).toEqual(["obs-1", "obs-2"]);
    expect(projection.provenance.evidenceReferences).toEqual(
      baseSource.evidenceReferences,
    );
    expect(projection.provenance.calculationVersions).toEqual([
      { id: "edge", version: "1" },
      { id: "no-vig", version: "2" },
    ]);
    expect(projection.provenance.referenceHashes).toEqual([
      "a".repeat(64),
      "f".repeat(64),
    ]);
    expect(projection.provenance.oddsSnapshotIds).toEqual([
      "snapshot-1",
      "snapshot-2",
    ]);
    expect(projection.provenance.inputSchema).toEqual({
      id: "input/fixture",
      version: "1",
    });
    expect(projection.provenance.promptBundle).toEqual({
      id: "analysis",
      version: "1",
    });
    expect(projection.provenance.model).toEqual({
      id: "model-1",
      version: "model-1",
    });
    expect(projection.provenance.sportModule).toEqual({
      id: "sport",
      version: "2",
    });
    expect(projection.provenance.strategy).toEqual({
      id: "strategy",
      version: "1",
    });
    expect(projection.provenance.reportSchema).toEqual({
      id: "output/fixture",
      version: "1",
    });
    expect(Object.isFrozen(projection)).toBe(true);
    expect(Object.isFrozen(projection.payload)).toBe(true);
    expect(Object.isFrozen(projection.provenance)).toBe(true);
  });

  it("keeps uncited evidence out of cited source observations", () => {
    const projection = project();
    expect(
      projection.provenance.citedSourceObservations.some(
        ({ observationId }) => observationId === "lineup-1",
      ),
    ).toBe(false);
  });

  it("rejects tampered FTE-041 output material as report-validation-invalid", () => {
    const outOfBounds = failure(() =>
      project({
        ...completeOutput,
        probability: {
          estimate: 0.99,
          low: 0.51,
          high: 0.63,
          uncertainty: 0.06,
        },
      }),
    );
    expect(outOfBounds.code).toBe("report-validation-invalid");
    expect(outOfBounds.retryable).toBe(false);

    const inventedCitation = failure(() =>
      project({
        ...completeOutput,
        summary: "Fabricated claim.",
        assertions: [
          {
            text: "Fabricated claim.",
            classification: "factual",
            citationIds: ["missing-evidence-id"],
          },
        ],
      }),
    );
    expect(inventedCitation.code).toBe("report-validation-invalid");

    const tamperedSummary = failure(() =>
      project({ ...completeOutput, summary: "Not the assertion composition." }),
    );
    expect(tamperedSummary.code).toBe("report-validation-invalid");

    const tamperedRequest = failure(() =>
      projectValidatedReport({
        request: { ...completeRequest, asOf: "2026-08-05T00:00:00.000Z" },
        output: completeOutput,
        policy: fixturePolicy,
        provenanceSource: baseSource,
      }),
    );
    expect(tamperedRequest.code).toBe("report-validation-invalid");
  });

  it("rejects a malformed provenance source shape", () => {
    const extraKey = failure(() =>
      projectValidatedReport({
        request: completeRequest,
        output: completeOutput,
        policy: fixturePolicy,
        provenanceSource: {
          ...baseSource,
          rawProviderPayload: [],
        } as unknown as ScoutingReportProvenanceSource,
      }),
    );
    expect(extraKey.code).toBe("report-validation-invalid");
  });
});

describe("assembleFirstScoutingReportVersion", () => {
  it("assembles version 1 that round-trips through normalization and the envelope", () => {
    const projection = project();
    const material = assembleFirstScoutingReportVersion(projection, contextA);
    expect(material.version.versionNumber).toBe(1);
    expect(material.version.predecessor).toBeNull();
    expect(material.version.changeSummary).toEqual({
      kind: "initial",
      changedFields: [],
    });
    expect(material.version.validationOutcome).toBe("complete");
    expect(material.version.draftHash).toBe(projection.draftHash);
    expect(material.version.jobId).toBe(contextA.jobId);
    expect(material.version.attemptId).toBe(contextA.attemptId);
    expect(material.version.generatedAt).toBe(contextA.generatedAt);
    expect(material.head).toMatchObject({
      reportId: material.version.reportId,
      latestVersionNumber: 1,
      latestVersionId: material.version.reportVersionId,
      latestDraftHash: material.version.draftHash,
      stateVersion: 1,
      updatedAt: contextA.generatedAt,
    });
    expect(material.completionPointer).toMatchObject({
      jobId: contextA.jobId,
      attemptId: contextA.attemptId,
      reportId: material.version.reportId,
      reportVersionId: material.version.reportVersionId,
      reportVersionNumber: 1,
      draftHash: material.version.draftHash,
    });
    const roundTripped = normalizeScoutingReportVersion(
      JSON.parse(JSON.stringify(material.version)),
    );
    expect(roundTripped).toEqual(material.version);
    expect(parseScoutingReportVersionEnvelope(material.envelope)).toEqual(
      material.version,
    );
  });

  it("propagates the canonical envelope size cap as report-envelope-oversized", () => {
    const oversizedSource: ScoutingReportProvenanceSource = {
      ...baseSource,
      providerObservations: Array.from({ length: 256 }, (_, index) => ({
        providerId: "p".repeat(256),
        observationId: `${String(index).padStart(4, "0")}${"x".repeat(250)}`,
        observedAt: "2026-08-03T21:50:00.000Z",
      })),
      oddsSnapshotIds: Array.from(
        { length: 256 },
        (_, index) => `${String(index).padStart(4, "0")}${"s".repeat(250)}`,
      ),
    };
    const projection = project(completeOutput, oversizedSource);
    const oversized = failure(() =>
      assembleFirstScoutingReportVersion(projection, contextA),
    );
    expect(oversized.code).toBe("report-envelope-oversized");
    expect(oversized.retryable).toBe(false);
  });
});

describe("assembleSuccessorScoutingReportVersion", () => {
  it("makes an identical-content new job a distinct unchanged version", () => {
    const first = assembleFirstScoutingReportVersion(project(), contextA);
    const second = assembleSuccessorScoutingReportVersion(
      project(),
      contextB,
      first.head,
      first.version,
    );
    expect(second.version.versionNumber).toBe(2);
    expect(second.version.changeSummary).toEqual({
      kind: "unchanged",
      changedFields: [],
    });
    expect(second.version.draftHash).toBe(first.version.draftHash);
    expect(second.version.reportVersionId).not.toBe(
      first.version.reportVersionId,
    );
    expect(second.version.predecessor).toEqual({
      reportVersionId: first.version.reportVersionId,
      versionNumber: 1,
      draftHash: first.version.draftHash,
    });
    expect(second.head).toMatchObject({
      latestVersionNumber: 2,
      latestVersionId: second.version.reportVersionId,
      stateVersion: 2,
      updatedAt: contextB.generatedAt,
    });
  });

  it("computes an exact deterministic change summary for material changes", () => {
    const first = assembleFirstScoutingReportVersion(project(), contextA);
    const probabilityOnly = assembleSuccessorScoutingReportVersion(
      project(probabilityChangedOutput),
      contextB,
      first.head,
      first.version,
    );
    expect(probabilityOnly.version.changeSummary).toEqual({
      kind: "changed",
      changedFields: ["probability"],
    });
    const multiField = assembleSuccessorScoutingReportVersion(
      project(narrativeChangedOutput),
      contextB,
      first.head,
      first.version,
    );
    expect(multiField.version.changeSummary).toEqual({
      kind: "changed",
      changedFields: ["assertions", "probability", "summary"],
    });
  });

  it("supports the CAS loser recompute path against the winning predecessor", () => {
    const first = assembleFirstScoutingReportVersion(project(), contextA);
    const second = assembleSuccessorScoutingReportVersion(
      project(probabilityChangedOutput),
      contextB,
      first.head,
      first.version,
    );
    const staleFence = failure(() =>
      assembleSuccessorScoutingReportVersion(
        project(narrativeChangedOutput),
        contextC,
        second.head,
        first.version,
      ),
    );
    expect(staleFence.code).toBe("report-head-cas-conflict");
    expect(staleFence.retryable).toBe(true);

    const third = assembleSuccessorScoutingReportVersion(
      project(narrativeChangedOutput),
      contextC,
      second.head,
      second.version,
    );
    expect(third.version.versionNumber).toBe(3);
    expect(third.version.predecessor).toEqual({
      reportVersionId: second.version.reportVersionId,
      versionNumber: 2,
      draftHash: second.version.draftHash,
    });
    expect(third.version.changeSummary).toEqual({
      kind: "changed",
      changedFields: ["assertions", "summary"],
    });
    expect(third.head).toMatchObject({
      latestVersionNumber: 3,
      latestVersionId: third.version.reportVersionId,
      stateVersion: 3,
    });
  });
});

describe("createScoutingReportReplayFingerprint", () => {
  it("is stable under usage/latency-only differences and matches the record", () => {
    const projection = project();
    const first = assembleFirstScoutingReportVersion(projection, contextA);
    const bare = createScoutingReportReplayFingerprint(projection, {
      requesterId: "user-1",
      eventId: "event-1",
      eventVersion: 3,
    });
    const withTelemetry = createScoutingReportReplayFingerprint(projection, {
      requesterId: "user-1",
      eventId: "event-1",
      eventVersion: 3,
      usage: { inputUnits: 10, outputUnits: 3, totalUnits: 13 },
      latencyMs: 950,
    });
    expect(withTelemetry).toBe(bare);
    expect(bare).toBe(first.version.persistenceFingerprint);

    const differentEventVersion = createScoutingReportReplayFingerprint(
      projection,
      { requesterId: "user-1", eventId: "event-1", eventVersion: 4 },
    );
    expect(differentEventVersion).not.toBe(bare);

    const differentMaterial = createScoutingReportReplayFingerprint(
      project(probabilityChangedOutput),
      { requesterId: "user-1", eventId: "event-1", eventVersion: 3 },
    );
    expect(differentMaterial).not.toBe(bare);
  });
});
