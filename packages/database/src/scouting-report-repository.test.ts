import { describe, expect, it } from "vitest";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import {
  SCOUTING_WORKFLOW_INTENT,
  advanceScoutingReportHead,
  createQueuedScoutingRecords,
  createScoutingReportCompletionPointer,
  createScoutingReportHead,
  createScoutingReportVersion,
  createScoutingReportVersionEnvelope,
  readScoutingJobRecord,
  validateScoutingAttempt,
  validateScoutingJob,
  type ScoutingAttempt,
  type ScoutingJob,
  type ScoutingJobRecordRead,
  type ScoutingReportHead,
  type ScoutingReportInlinePayload,
  type ScoutingReportProvenance,
  type ScoutingReportVersionRecord,
} from "@find-the-edge/domain";
import {
  scoutingActiveLockItemKey,
  scoutingAttemptItemKey,
  scoutingEventDetailItemKey,
  scoutingJobItemKey,
} from "./dynamodb-scouting-job-repository";
import {
  DynamoScoutingReportRepository,
  scoutingReportHeadKey,
  scoutingReportJobBindingKey,
  scoutingReportVersionKey,
} from "./dynamodb-scouting-report-repository";
import {
  MemoryScoutingReportRepository,
  ScoutingReportRepositoryError,
  type ScoutingReportCompletionMaterial,
  type ScoutingReportRepository,
} from "./scouting-report-repository";

const T0 = "2026-08-10T12:00:00.000Z";
const T1 = "2026-08-10T12:01:00.000Z";
const T2 = "2026-08-10T12:02:00.000Z";
const T3 = "2026-08-10T12:03:00.000Z";
const T4 = "2026-08-10T12:04:00.000Z";
const T5 = "2026-08-10T12:05:00.000Z";
const T6 = "2026-08-10T12:06:00.000Z";

const requesterId = "user-123";
const foreignRequesterId = "user-456";
const eventId = "baseball:mlb:event-123";

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

const winnerPayload = {
  ...payload,
  probability: { estimate: 0.58, low: 0.53, high: 0.63, uncertainty: 0.05 },
} satisfies ScoutingReportInlinePayload;

const loserPayload = {
  ...payload,
  summary: "Yankees hold a modest pricing edge.",
} satisfies ScoutingReportInlinePayload;

const provenance = {
  citedSourceObservations: [
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
  oddsSnapshotIds: ["snap-1"],
  inputHash: "cd".repeat(32),
  inputSchema: { id: "scouting-input", version: "1" },
  promptBundle: { id: "bundle-mlb", version: "1.0.0" },
  model: { id: "model-x", version: "2026-01" },
  sportModule: { id: "mlb-module", version: "2" },
  strategy: { id: "core-strategy", version: "3" },
  reportSchema: { id: "scouting-report", version: "1" },
} satisfies ScoutingReportProvenance;

const claimedLifecycle = (idempotencyKey: string, eventVersion: number) => {
  const records = createQueuedScoutingRecords(
    {
      schemaVersion: 1,
      requesterId,
      idempotencyKey,
      eventId,
      eventVersion,
      workflowIntent: SCOUTING_WORKFLOW_INTENT,
    },
    T0,
  );
  return {
    job: validateScoutingJob({
      ...records.job,
      status: "in_progress",
      stateVersion: records.job.stateVersion + 1,
      updatedAt: T1,
    }),
    attempt: validateScoutingAttempt({
      ...records.attempt,
      status: "in_progress",
      stateVersion: records.attempt.stateVersion + 1,
      updatedAt: T1,
      startedAt: T1,
    }),
  };
};

const first = claimedLifecycle("request-1", 7);
const winner = claimedLifecycle("request-2", 8);
const loser = claimedLifecycle("request-3", 9);

const toMaterial = (
  version: ScoutingReportVersionRecord,
  head: ScoutingReportHead,
): ScoutingReportCompletionMaterial => ({
  version,
  head,
  completionPointer: createScoutingReportCompletionPointer(version),
  envelope: createScoutingReportVersionEnvelope(version),
});

const firstMaterial = (
  job: ScoutingJob,
  reportPayload: ScoutingReportInlinePayload,
  generatedAt: string,
  eventVersion = job.eventVersion,
): ScoutingReportCompletionMaterial => {
  const version = createScoutingReportVersion({
    requesterId,
    eventId,
    eventVersion,
    jobId: job.jobId,
    attemptId: job.currentAttemptId,
    versionNumber: 1,
    payload: reportPayload,
    provenance,
    generatedAt,
    predecessor: null,
  });
  return toMaterial(version, createScoutingReportHead(version));
};

const successorMaterial = (
  job: ScoutingJob,
  reportPayload: ScoutingReportInlinePayload,
  head: ScoutingReportHead,
  predecessor: ScoutingReportVersionRecord,
  generatedAt: string,
): ScoutingReportCompletionMaterial => {
  const version = createScoutingReportVersion({
    requesterId,
    eventId,
    eventVersion: job.eventVersion,
    jobId: job.jobId,
    attemptId: job.currentAttemptId,
    versionNumber: head.latestVersionNumber + 1,
    payload: reportPayload,
    provenance,
    generatedAt,
    predecessor: {
      reportVersionId: head.latestVersionId,
      versionNumber: head.latestVersionNumber,
      draftHash: head.latestDraftHash,
      payload: predecessor.payload,
    },
  });
  return toMaterial(version, advanceScoutingReportHead(head, version));
};

const materialOne = firstMaterial(first.job, payload, T2);
const reportId = materialOne.version.reportId;

const tamperedRow = (version: ScoutingReportVersionRecord): unknown => {
  const raw = JSON.parse(JSON.stringify(version)) as {
    payload: { summary: string };
  };
  raw.payload.summary = `${raw.payload.summary} tampered`;
  return raw;
};

const expectFailure = async (
  work: Promise<unknown>,
  code: string,
  retryable = false,
): Promise<void> => {
  const outcome = await work.then(
    () => null,
    (error: unknown) => error,
  );
  expect(outcome).toBeInstanceOf(ScoutingReportRepositoryError);
  const failure = outcome as ScoutingReportRepositoryError;
  expect(failure.code).toBe(code);
  expect(failure.retryable).toBe(retryable);
};

interface Harness {
  readonly repo: ScoutingReportRepository;
  seedClaimed(job: ScoutingJob, attempt: ScoutingAttempt): void;
  setEventVersion(id: string, version: number): void;
  clearActiveLock(semanticDigest: string): void;
  corruptVersion(version: ScoutingReportVersionRecord): void;
  readJob(jobId: string): ScoutingJobRecordRead | null;
  hasLock(semanticDigest: string): boolean;
}

const createMemoryHarness = (): Harness => {
  const eventVersions = new Map<string, number>();
  const repo = new MemoryScoutingReportRepository({
    verifyEventVersion: (id, version) =>
      Promise.resolve(eventVersions.get(id) === version),
  });
  return {
    repo,
    seedClaimed: (job, attempt) => {
      repo.seedJob(job);
      repo.seedAttempt(attempt);
      repo.setActiveLock(job.semanticDigest, job.jobId, attempt.attemptId);
    },
    setEventVersion: (id, version) => {
      eventVersions.set(id, version);
    },
    clearActiveLock: (semanticDigest) => {
      repo.clearActiveLock(semanticDigest);
    },
    corruptVersion: (version) => {
      repo.unsafeSeedVersionRow(
        version.reportId,
        version.versionNumber,
        tamperedRow(version),
      );
    },
    readJob: (jobId) => repo.readJob(jobId),
    hasLock: (semanticDigest) => repo.hasActiveLock(semanticDigest),
  };
};

type CommandLike = {
  readonly constructor: { readonly name: string };
  readonly input: Record<string, unknown>;
};

type TransactAction = Readonly<
  Record<
    string,
    {
      readonly TableName?: string;
      readonly Key?: { readonly pk: string; readonly sk: string };
      readonly Item?: Record<string, unknown>;
      readonly ConditionExpression?: string;
      readonly ExpressionAttributeValues?: Record<string, unknown>;
    }
  >
>;

class FakeReportTableClient {
  readonly transactWrites: Record<string, unknown>[] = [];
  onBeforeTransact: (() => void) | null = null;
  private readonly items = new Map<string, Record<string, unknown>>();

  private key(value: { readonly pk: string; readonly sk: string }): string {
    return `${value.pk}\0${value.sk}`;
  }

  putItem(item: Record<string, unknown>): void {
    this.items.set(
      this.key(item as { pk: string; sk: string }),
      structuredClone(item),
    );
  }

  deleteItem(key: { readonly pk: string; readonly sk: string }): void {
    this.items.delete(this.key(key));
  }

  getItem(key: {
    readonly pk: string;
    readonly sk: string;
  }): Record<string, unknown> | undefined {
    const item = this.items.get(this.key(key));
    return item === undefined ? undefined : structuredClone(item);
  }

  private evaluate(action: TransactAction): boolean {
    const operation = action["Put"] ?? action["ConditionCheck"];
    if (!operation) return true;
    const key = action["Put"]
      ? {
          pk: String(operation.Item?.["pk"]),
          sk: String(operation.Item?.["sk"]),
        }
      : (operation.Key as { pk: string; sk: string });
    const existing = this.items.get(this.key(key));
    const expression = operation.ConditionExpression;
    if (expression === undefined) return true;
    if (expression.includes("attribute_not_exists(pk)"))
      return existing === undefined;
    if (existing === undefined) return false;
    const values = operation.ExpressionAttributeValues ?? {};
    if (
      expression.includes("#entityType=:activeMarker") &&
      existing["entityType"] !== values[":activeMarker"]
    )
      return false;
    if (
      expression.includes("attribute_not_exists(expiresAt)") &&
      existing["expiresAt"] !== undefined
    )
      return false;
    const stored = existing["value"] as Record<string, unknown>;
    for (const match of expression.matchAll(
      /#value\.#([A-Za-z]+)=:([A-Za-z]+)/g,
    )) {
      const field = match[1] as string;
      const reference = match[2] as string;
      if (
        JSON.stringify(stored[field]) !==
        JSON.stringify(values[`:${reference}`])
      )
        return false;
    }
    return true;
  }

  async send(raw: unknown): Promise<Record<string, unknown>> {
    await Promise.resolve();
    const command = raw as CommandLike;
    if (command.constructor.name === "GetCommand") {
      const item = this.getItem(
        command.input["Key"] as { pk: string; sk: string },
      );
      return item === undefined ? {} : { Item: item };
    }
    if (command.constructor.name === "QueryCommand") {
      const values = command.input["ExpressionAttributeValues"] as Record<
        string,
        unknown
      >;
      const pk = values[":pk"];
      const prefix = String(values[":prefix"]);
      const rows = [...this.items.values()]
        .filter(
          (item) => item["pk"] === pk && String(item["sk"]).startsWith(prefix),
        )
        .sort((left, right) =>
          String(left["sk"]) < String(right["sk"]) ? -1 : 1,
        );
      return { Items: structuredClone(rows) };
    }
    if (command.constructor.name !== "TransactWriteCommand")
      throw new Error(`unsupported command: ${command.constructor.name}`);
    if (this.onBeforeTransact) {
      const hook = this.onBeforeTransact;
      this.onBeforeTransact = null;
      hook();
    }
    this.transactWrites.push(structuredClone(command.input));
    const actions = command.input["TransactItems"] as readonly TransactAction[];
    const reasons = actions.map((action) =>
      this.evaluate(action)
        ? { Code: "None" }
        : { Code: "ConditionalCheckFailed" },
    );
    if (reasons.some((reason) => reason.Code !== "None")) {
      const error = new Error("conditional transaction");
      error.name = "TransactionCanceledException";
      Object.assign(error, { CancellationReasons: reasons });
      throw error;
    }
    for (const action of actions) {
      const put = action["Put"];
      if (put?.Item) this.putItem(put.Item);
      const remove = action["Delete"];
      if (remove?.Key) this.deleteItem(remove.Key);
    }
    return {};
  }
}

const createDynamoHarness = (): Harness & { client: FakeReportTableClient } => {
  const client = new FakeReportTableClient();
  const repo = new DynamoScoutingReportRepository(
    client as unknown as DynamoDBDocumentClient,
    "table",
  );
  return {
    client,
    repo,
    seedClaimed: (job, attempt) => {
      client.putItem({
        ...scoutingJobItemKey(job.jobId),
        entityType: "scouting-job",
        value: job,
      });
      client.putItem({
        ...scoutingAttemptItemKey(attempt.attemptId),
        entityType: "scouting-attempt",
        value: attempt,
      });
      client.putItem({
        ...scoutingActiveLockItemKey(job.semanticDigest),
        entityType: "scouting-active-lock",
        value: {
          semanticDigest: job.semanticDigest,
          jobId: job.jobId,
          attemptId: attempt.attemptId,
        },
      });
    },
    setEventVersion: (id, version) => {
      client.putItem({
        ...scoutingEventDetailItemKey(id),
        value: { eventId: id, materialVersion: version },
      });
    },
    clearActiveLock: (semanticDigest) => {
      client.deleteItem(scoutingActiveLockItemKey(semanticDigest));
    },
    corruptVersion: (version) => {
      client.putItem({
        ...scoutingReportVersionKey(version.reportId, version.versionNumber),
        entityType: "scouting-report-version",
        value: tamperedRow(version),
      });
    },
    readJob: (jobId) => {
      const item = client.getItem(scoutingJobItemKey(jobId));
      return item === undefined ? null : readScoutingJobRecord(item["value"]);
    },
    hasLock: (semanticDigest) => {
      const item = client.getItem(scoutingActiveLockItemKey(semanticDigest));
      return item?.["entityType"] === "scouting-active-lock";
    },
  };
};

const completeFirst = async (harness: Harness) => {
  harness.setEventVersion(eventId, 7);
  harness.seedClaimed(first.job, first.attempt);
  return harness.repo.completeWithReport({
    material: materialOne,
    completedAt: T3,
  });
};

const completeWinner = async (harness: Harness) => {
  harness.setEventVersion(eventId, 8);
  harness.seedClaimed(winner.job, winner.attempt);
  const material = successorMaterial(
    winner.job,
    winnerPayload,
    materialOne.head,
    materialOne.version,
    T4,
  );
  return {
    material,
    result: await harness.repo.completeWithReport({
      material,
      completedAt: T4,
    }),
  };
};

for (const [name, createHarness] of [
  ["memory", createMemoryHarness],
  ["dynamo", () => createDynamoHarness()],
] as const) {
  describe(`scouting report repository (${name})`, () => {
    it("commits first completion atomically: version, head, binding, schema-v2 lifecycle, lock release", async () => {
      const harness = createHarness();
      const result = await completeFirst(harness);
      expect(result.outcome).toBe("completed");
      if (result.outcome !== "completed") return;
      expect(result.version).toEqual(materialOne.version);
      expect(result.head).toEqual(materialOne.head);
      expect(result.job.schemaVersion).toBe(2);
      expect(result.job.status).toBe("completed");
      expect(result.job.reportPointer).toEqual({
        reportId,
        reportVersionId: materialOne.version.reportVersionId,
        reportVersionNumber: 1,
      });
      expect(result.attempt.schemaVersion).toBe(2);
      expect(result.attempt.status).toBe("completed");
      expect(result.attempt.finishedAt).toBe(T3);
      expect(result.attempt.reportPointer).toEqual(result.job.reportPointer);
      expect(harness.hasLock(first.job.semanticDigest)).toBe(false);
      const storedJob = harness.readJob(first.job.jobId);
      expect(storedJob?.kind).toBe("current");
      await expect(
        harness.repo.getHead(reportId, requesterId),
      ).resolves.toEqual(materialOne.head);
      await expect(
        harness.repo.getVersion(reportId, 1, requesterId),
      ).resolves.toEqual(materialOne.version);
      await expect(
        harness.repo.getByJobBinding(first.job.jobId, requesterId),
      ).resolves.toEqual(materialOne.version);
      await expect(
        harness.repo.listVersions(reportId, requesterId),
      ).resolves.toEqual([materialOne.version]);
    });

    it("advances the head contiguously, fencing the diff on the exact predecessor", async () => {
      const harness = createHarness();
      await completeFirst(harness);
      const { material, result } = await completeWinner(harness);
      expect(result.outcome).toBe("completed");
      expect(result.version.versionNumber).toBe(2);
      expect(result.version.predecessor).toEqual({
        reportVersionId: materialOne.version.reportVersionId,
        versionNumber: 1,
        draftHash: materialOne.version.draftHash,
      });
      expect(result.version.changeSummary).toEqual({
        kind: "changed",
        changedFields: ["probability"],
      });
      expect(result.head.latestVersionNumber).toBe(2);
      expect(result.head.stateVersion).toBe(2);
      const history = await harness.repo.listVersions(reportId, requesterId);
      expect(history.map((record) => record.versionNumber)).toEqual([1, 2]);
      expect(history[0]).toEqual(materialOne.version);
      expect(history[1]).toEqual(material.version);
    });

    it("resolves exact same-job replay from the binding with zero mutation and no active attempt", async () => {
      const harness = createHarness();
      await completeFirst(harness);
      const jobBefore = harness.readJob(first.job.jobId);
      // Same authoritative material, different telemetry timestamp: the
      // fingerprint is unchanged, so the first-write version wins untouched.
      const replayMaterial = firstMaterial(first.job, payload, T4);
      const replay = await harness.repo.completeWithReport({
        material: replayMaterial,
        completedAt: T4,
      });
      expect(replay.outcome).toBe("replayed");
      expect(replay.version).toEqual(materialOne.version);
      expect(replay.version.generatedAt).toBe(T2);
      expect(replay.head).toEqual(materialOne.head);
      expect(harness.readJob(first.job.jobId)).toEqual(jobBefore);
      await expect(
        harness.repo.listVersions(reportId, requesterId),
      ).resolves.toHaveLength(1);
    });

    it("rejects conflicting same-job replay with zero mutation, including same version id with different material", async () => {
      const harness = createHarness();
      await completeFirst(harness);
      // Same job and payload at a different event version: the version id is
      // identical while the fingerprint differs.
      const sameIdDifferentMaterial = firstMaterial(first.job, payload, T2, 8);
      expect(sameIdDifferentMaterial.version.reportVersionId).toBe(
        materialOne.version.reportVersionId,
      );
      await expectFailure(
        harness.repo.completeWithReport({
          material: sameIdDifferentMaterial,
          completedAt: T3,
        }),
        "report-replay-conflict",
      );
      // Same job with different draft material conflicts as well.
      await expectFailure(
        harness.repo.completeWithReport({
          material: firstMaterial(first.job, winnerPayload, T2),
          completedAt: T3,
        }),
        "report-replay-conflict",
      );
      await expect(
        harness.repo.getHead(reportId, requesterId),
      ).resolves.toEqual(materialOne.head);
      await expect(
        harness.repo.listVersions(reportId, requesterId),
      ).resolves.toEqual([materialOne.version]);
    });

    it("lets a CAS loser recompute against the winner and fences the final diff to the actual winner", async () => {
      const harness = createHarness();
      await completeFirst(harness);
      const { material: winnerMaterial } = await completeWinner(harness);
      harness.setEventVersion(eventId, 9);
      harness.seedClaimed(loser.job, loser.attempt);
      const staleMaterial = successorMaterial(
        loser.job,
        loserPayload,
        materialOne.head,
        materialOne.version,
        T5,
      );
      const recomputeCalls: {
        head: ScoutingReportHead;
        predecessor: ScoutingReportVersionRecord;
      }[] = [];
      const result = await harness.repo.completeWithReport({
        material: staleMaterial,
        completedAt: T6,
        recompute: (winningHead, winningPredecessor) => {
          recomputeCalls.push({
            head: winningHead,
            predecessor: winningPredecessor,
          });
          return successorMaterial(
            loser.job,
            loserPayload,
            winningHead,
            winningPredecessor,
            T5,
          );
        },
      });
      expect(recomputeCalls).toHaveLength(1);
      expect(recomputeCalls[0]?.head).toEqual(winnerMaterial.head);
      expect(recomputeCalls[0]?.predecessor).toEqual(winnerMaterial.version);
      expect(result.outcome).toBe("completed");
      expect(result.version.versionNumber).toBe(3);
      expect(result.version.predecessor).toEqual({
        reportVersionId: winnerMaterial.version.reportVersionId,
        versionNumber: 2,
        draftHash: winnerMaterial.version.draftHash,
      });
      expect(result.version.changeSummary.kind).toBe("changed");
      expect(result.head.latestVersionNumber).toBe(3);
      expect(result.head.stateVersion).toBe(3);
      await expect(
        harness.repo.listVersions(reportId, requesterId),
      ).resolves.toHaveLength(3);
      expect(harness.hasLock(loser.job.semanticDigest)).toBe(false);
    });

    it("classifies a CAS loss without a recompute callback as retryable with zero mutation", async () => {
      const harness = createHarness();
      await completeFirst(harness);
      await completeWinner(harness);
      harness.setEventVersion(eventId, 9);
      harness.seedClaimed(loser.job, loser.attempt);
      await expectFailure(
        harness.repo.completeWithReport({
          material: successorMaterial(
            loser.job,
            loserPayload,
            materialOne.head,
            materialOne.version,
            T5,
          ),
          completedAt: T6,
        }),
        "report-head-cas-conflict",
        true,
      );
      await expect(
        harness.repo.listVersions(reportId, requesterId),
      ).resolves.toHaveLength(2);
      expect(harness.readJob(loser.job.jobId)?.job.status).toBe("in_progress");
      expect(harness.hasLock(loser.job.semanticDigest)).toBe(true);
    });

    it("classifies a stale attempt terminally with zero mutation", async () => {
      const harness = createHarness();
      harness.setEventVersion(eventId, 7);
      harness.seedClaimed(first.job, first.attempt);
      harness.clearActiveLock(first.job.semanticDigest);
      await expectFailure(
        harness.repo.completeWithReport({
          material: materialOne,
          completedAt: T3,
        }),
        "report-stale-attempt",
      );
      await expect(
        harness.repo.getHead(reportId, requesterId),
      ).resolves.toBeNull();
      await expect(
        harness.repo.listVersions(reportId, requesterId),
      ).resolves.toEqual([]);
      expect(harness.readJob(first.job.jobId)?.job.status).toBe("in_progress");
    });

    it("classifies an event-version fence failure terminally with zero mutation", async () => {
      const harness = createHarness();
      harness.setEventVersion(eventId, 8);
      harness.seedClaimed(first.job, first.attempt);
      await expectFailure(
        harness.repo.completeWithReport({
          material: materialOne,
          completedAt: T3,
        }),
        "report-event-version-changed",
      );
      await expect(
        harness.repo.getHead(reportId, requesterId),
      ).resolves.toBeNull();
      expect(harness.readJob(first.job.jobId)?.job.status).toBe("in_progress");
      expect(harness.hasLock(first.job.semanticDigest)).toBe(true);
    });

    it("gives foreign requesters neutral missing results on every read", async () => {
      const harness = createHarness();
      await completeFirst(harness);
      await expect(
        harness.repo.getHead(reportId, foreignRequesterId),
      ).resolves.toBeNull();
      await expect(
        harness.repo.getVersion(reportId, 1, foreignRequesterId),
      ).resolves.toBeNull();
      await expect(
        harness.repo.listVersions(reportId, foreignRequesterId),
      ).resolves.toEqual([]);
      await expect(
        harness.repo.getByJobBinding(first.job.jobId, foreignRequesterId),
      ).resolves.toBeNull();
      await expect(
        harness.repo.getHead("scout-report:not-a-real-id", requesterId),
      ).resolves.toBeNull();
    });

    it("rejects corrupt stored version rows on every read path", async () => {
      const harness = createHarness();
      await completeFirst(harness);
      harness.corruptVersion(materialOne.version);
      await expectFailure(
        harness.repo.getVersion(reportId, 1, requesterId),
        "report-storage-corrupt",
      );
      await expectFailure(
        harness.repo.listVersions(reportId, requesterId),
        "report-storage-corrupt",
      );
      await expectFailure(
        harness.repo.getByJobBinding(first.job.jobId, requesterId),
        "report-storage-corrupt",
      );
    });

    it("rejects incoherent completion material before writing anything", async () => {
      const harness = createHarness();
      harness.setEventVersion(eventId, 7);
      harness.seedClaimed(first.job, first.attempt);
      await expectFailure(
        harness.repo.completeWithReport({
          material: {
            ...materialOne,
            envelope: materialOne.envelope.slice(0, -1),
          },
          completedAt: T3,
        }),
        "report-validation-invalid",
      );
      // completedAt must not precede the trusted generatedAt.
      await expectFailure(
        harness.repo.completeWithReport({
          material: materialOne,
          completedAt: T1,
        }),
        "report-validation-invalid",
      );
      await expect(
        harness.repo.getHead(reportId, requesterId),
      ).resolves.toBeNull();
      expect(harness.readJob(first.job.jobId)?.job.status).toBe("in_progress");
    });
  });
}

describe("scouting report repository (dynamo transaction shape)", () => {
  it("commits completion in one TransactWriteCommand covering all seven fenced items", async () => {
    const harness = createDynamoHarness();
    await completeFirst(harness);
    expect(harness.client.transactWrites).toHaveLength(1);
    const transaction = harness.client.transactWrites[0] as {
      TransactItems: TransactActionForAssertions[];
    };
    const items = transaction.TransactItems;
    expect(items).toHaveLength(7);
    expect(items[0]?.ConditionCheck?.Key).toEqual(
      scoutingEventDetailItemKey(eventId),
    );
    expect(items[0]?.ConditionCheck?.ConditionExpression).toContain(
      "#value.#materialVersion=:eventVersion",
    );
    expect(items[1]?.Put?.Item?.["pk"]).toBe(`SCOUT_REPORT#${reportId}`);
    expect(items[1]?.Put?.Item?.["sk"]).toBe(`V#${"1".padStart(16, "0")}`);
    expect(items[1]?.Put?.ConditionExpression).toContain(
      "attribute_not_exists(pk)",
    );
    expect(items[2]?.Put?.Item?.["sk"]).toBe("HEAD");
    expect(items[2]?.Put?.ConditionExpression).toContain(
      "attribute_not_exists(pk)",
    );
    expect(items[3]?.Put?.Item?.["pk"]).toBe(
      `SCOUT_REPORT_JOB#${first.job.jobId}`,
    );
    expect(items[3]?.Put?.Item?.["sk"]).toBe("BINDING");
    expect(items[4]?.Put?.Item?.["pk"]).toBe(`SCOUT_JOB#${first.job.jobId}`);
    expect(items[4]?.Put?.ConditionExpression).toContain(
      "#value.#stateVersion=:stateVersion",
    );
    expect(items[5]?.Put?.Item?.["pk"]).toBe(
      `SCOUT_ATTEMPT#${first.attempt.attemptId}`,
    );
    expect(items[6]?.Put?.Item?.["pk"]).toBe(
      `SCOUT_ACTIVE#${first.job.semanticDigest}`,
    );
    expect(items[6]?.Put?.Item?.["entityType"]).toBe(
      "scouting-active-tombstone",
    );
    expect(items[6]?.Put?.ConditionExpression).toContain(
      "#entityType=:activeMarker",
    );
  });

  it("advances the head with an exact predecessor CAS condition", async () => {
    const harness = createDynamoHarness();
    await completeFirst(harness);
    await completeWinner(harness);
    const transaction = harness.client.transactWrites[1] as {
      TransactItems: TransactActionForAssertions[];
    };
    const headPut = transaction.TransactItems[2]?.Put;
    expect(headPut?.ConditionExpression).toBe(
      "#value.#stateVersion=:previousStateVersion AND #value.#latestVersionId=:predecessorId AND #value.#latestVersionNumber=:predecessorNumber AND #value.#latestDraftHash=:predecessorDraftHash",
    );
    expect(headPut?.ExpressionAttributeValues).toEqual({
      ":previousStateVersion": 1,
      ":predecessorId": materialOne.version.reportVersionId,
      ":predecessorNumber": 1,
      ":predecessorDraftHash": materialOne.version.draftHash,
    });
  });

  it("issues no transaction for replay resolution", async () => {
    const harness = createDynamoHarness();
    await completeFirst(harness);
    const writesBefore = harness.client.transactWrites.length;
    await expect(
      harness.repo.completeWithReport({
        material: materialOne,
        completedAt: T4,
      }),
    ).resolves.toMatchObject({ outcome: "replayed" });
    expect(harness.client.transactWrites).toHaveLength(writesBefore);
  });

  it("decodes an in-transaction event fence loss as event-version-changed", async () => {
    const harness = createDynamoHarness();
    harness.setEventVersion(eventId, 7);
    harness.seedClaimed(first.job, first.attempt);
    harness.client.onBeforeTransact = () => {
      harness.setEventVersion(eventId, 8);
    };
    await expectFailure(
      harness.repo.completeWithReport({
        material: materialOne,
        completedAt: T3,
      }),
      "report-event-version-changed",
    );
    await expect(
      harness.repo.getHead(reportId, requesterId),
    ).resolves.toBeNull();
  });

  it("decodes an in-transaction lifecycle fence loss as a stale attempt", async () => {
    const harness = createDynamoHarness();
    harness.setEventVersion(eventId, 7);
    harness.seedClaimed(first.job, first.attempt);
    harness.client.onBeforeTransact = () => {
      harness.clearActiveLock(first.job.semanticDigest);
    };
    await expectFailure(
      harness.repo.completeWithReport({
        material: materialOne,
        completedAt: T3,
      }),
      "report-stale-attempt",
    );
    await expect(
      harness.repo.getHead(reportId, requesterId),
    ).resolves.toBeNull();
  });

  it("uses exact head and binding keys for reads", () => {
    expect(scoutingReportHeadKey(reportId)).toEqual({
      pk: `SCOUT_REPORT#${reportId}`,
      sk: "HEAD",
    });
    expect(scoutingReportVersionKey(reportId, 12)).toEqual({
      pk: `SCOUT_REPORT#${reportId}`,
      sk: `V#${"12".padStart(16, "0")}`,
    });
    expect(scoutingReportJobBindingKey(first.job.jobId)).toEqual({
      pk: `SCOUT_REPORT_JOB#${first.job.jobId}`,
      sk: "BINDING",
    });
  });
});

type TransactActionForAssertions = Readonly<
  Record<
    "Put" | "ConditionCheck",
    | {
        readonly Key?: { readonly pk: string; readonly sk: string };
        readonly Item?: Record<string, unknown>;
        readonly ConditionExpression?: string;
        readonly ExpressionAttributeValues?: Record<string, unknown>;
      }
    | undefined
  >
>;
