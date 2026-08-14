import {
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  type DynamoDBDocumentClient,
} from "@aws-sdk/lib-dynamodb";
import {
  assertScoutingTimestamp,
  completeScoutingAttemptWithReport,
  completeScoutingJobWithReport,
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
  type ScoutingReportHead,
  type ScoutingReportVersionRecord,
} from "@find-the-edge/domain";
import {
  scoutingActiveLockItemKey,
  scoutingAttemptItemKey,
  scoutingEventDetailItemKey,
  scoutingJobItemKey,
} from "./dynamodb-scouting-job-repository";
import {
  SCOUTING_REPORT_CAS_RETRY_LIMIT,
  ScoutingReportRepositoryError,
  assertScoutingReportRecomputeCoherent,
  isScoutingJobIdForReports,
  isScoutingReportId,
  normalizeScoutingReportCompletionMaterial,
  normalizeScoutingReportJobBinding,
  requireClaimedScoutingLifecycle,
  toScoutingReportRepositoryError,
  type ScoutingReportCompletionInput,
  type ScoutingReportCompletionMaterial,
  type ScoutingReportCompletionResult,
  type ScoutingReportJobBinding,
  type ScoutingReportRepository,
} from "./scouting-report-repository";

/**
 * DynamoDB parity for the FTE-042 report repository: exact-key reads only (no
 * Scan, no new GSI) and one conditional TransactWriteCommand for completion
 * covering the canonical event fence, the immutable version insert, the head
 * CAS, the job replay binding, the schema-v2 job and attempt completion, and
 * the active-lock tombstone. Dispatch outbox publication state is
 * deliberately not part of completion.
 *
 * Key schema (single table, primary key only):
 * - `SCOUT_REPORT#<reportId>` / `HEAD` — CAS-guarded latest-version pointer.
 * - `SCOUT_REPORT#<reportId>` / `V#<16-digit zero-padded number>` —
 *   append-only immutable versions; the padding makes a `begins_with(sk, V#)`
 *   Query return history in ascending version order.
 * - `SCOUT_REPORT_JOB#<jobId>` / `BINDING` — immutable job-to-version replay
 *   binding carrying the persistence fingerprint.
 * - Job, attempt, active-lock, and event items reuse the exact keys exported
 *   by the scouting job repository.
 */

const reportPartition = (reportId: string): string =>
  `SCOUT_REPORT#${reportId}`;
const paddedVersion = (versionNumber: number): string =>
  String(versionNumber).padStart(16, "0");
export const scoutingReportHeadKey = (reportId: string) => ({
  pk: reportPartition(reportId),
  sk: "HEAD",
});
export const scoutingReportVersionKey = (
  reportId: string,
  versionNumber: number,
) => ({
  pk: reportPartition(reportId),
  sk: `V#${paddedVersion(versionNumber)}`,
});
export const scoutingReportJobBindingKey = (jobId: string) => ({
  pk: `SCOUT_REPORT_JOB#${jobId}`,
  sk: "BINDING",
});

const VERSION_SK_PREFIX = "V#";

type CancellationReason = { readonly Code?: string };

const cancellationReasons = (
  error: unknown,
): readonly CancellationReason[] | null => {
  if (
    !(error instanceof Error) ||
    error.name !== "TransactionCanceledException"
  )
    return null;
  const reasons = (
    error as Error & { CancellationReasons?: readonly CancellationReason[] }
  ).CancellationReasons;
  return reasons ?? null;
};

/** Fixed TransactItems order; cancellation reasons are decoded by index. */
const TRANSACT_EVENT = 0;
const TRANSACT_VERSION = 1;
const TRANSACT_HEAD = 2;
const TRANSACT_BINDING = 3;
const TRANSACT_JOB = 4;
const TRANSACT_ATTEMPT = 5;
const TRANSACT_LOCK = 6;

export class DynamoScoutingReportRepository implements ScoutingReportRepository {
  constructor(
    private readonly client: DynamoDBDocumentClient,
    private readonly tableName: string,
  ) {}

  private async rawGet(
    key: Readonly<{ pk: string; sk: string }>,
  ): Promise<Record<string, unknown> | undefined> {
    const result = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: key,
        // Completion CAS, bindings, event fences, and replay share this read.
        ConsistentRead: true,
      }),
    );
    return result.Item as Record<string, unknown> | undefined;
  }

  private async storedHead(
    reportId: string,
  ): Promise<ScoutingReportHead | null> {
    const item = await this.rawGet(scoutingReportHeadKey(reportId));
    if (!item) return null;
    if (item["entityType"] !== "scouting-report-head")
      throw new ScoutingReportRepositoryError("report-storage-corrupt");
    let head: ScoutingReportHead;
    try {
      head = normalizeScoutingReportHead(item["value"]);
    } catch (error) {
      throw new ScoutingReportRepositoryError("report-storage-corrupt", {
        cause: error,
      });
    }
    if (head.reportId !== reportId)
      throw new ScoutingReportRepositoryError("report-storage-corrupt");
    return head;
  }

  private async storedVersion(
    reportId: string,
    versionNumber: number,
  ): Promise<ScoutingReportVersionRecord | null> {
    const item = await this.rawGet(
      scoutingReportVersionKey(reportId, versionNumber),
    );
    if (!item) return null;
    return this.versionFromItem(item, reportId, versionNumber);
  }

  private versionFromItem(
    item: Record<string, unknown>,
    reportId: string,
    versionNumber: number | null,
  ): ScoutingReportVersionRecord {
    if (item["entityType"] !== "scouting-report-version")
      throw new ScoutingReportRepositoryError("report-storage-corrupt");
    let version: ScoutingReportVersionRecord;
    try {
      version = normalizeScoutingReportVersion(item["value"]);
    } catch (error) {
      throw new ScoutingReportRepositoryError("report-storage-corrupt", {
        cause: error,
      });
    }
    if (
      version.reportId !== reportId ||
      (versionNumber !== null && version.versionNumber !== versionNumber)
    )
      throw new ScoutingReportRepositoryError("report-storage-corrupt");
    return version;
  }

  private async storedBinding(
    jobId: string,
  ): Promise<ScoutingReportJobBinding | null> {
    const item = await this.rawGet(scoutingReportJobBindingKey(jobId));
    if (!item) return null;
    if (item["entityType"] !== "scouting-report-binding")
      throw new ScoutingReportRepositoryError("report-storage-corrupt");
    const binding = normalizeScoutingReportJobBinding(item["value"]);
    if (binding.jobId !== jobId)
      throw new ScoutingReportRepositoryError("report-storage-corrupt");
    return binding;
  }

  private async readJobRecord(
    jobId: string,
  ): Promise<ScoutingJobRecordRead | null> {
    const item = await this.rawGet(scoutingJobItemKey(jobId));
    if (!item) return null;
    if (item["entityType"] !== "scouting-job")
      throw new ScoutingReportRepositoryError("report-storage-corrupt");
    try {
      const read = readScoutingJobRecord(item["value"]);
      if (read.job.jobId !== jobId) throw new Error("report-storage-corrupt");
      return read;
    } catch (error) {
      throw toScoutingReportRepositoryError(error, "report-storage-corrupt");
    }
  }

  private async readAttemptRecord(
    attemptId: string,
  ): Promise<ScoutingAttemptRecordRead | null> {
    const item = await this.rawGet(scoutingAttemptItemKey(attemptId));
    if (!item) return null;
    if (item["entityType"] !== "scouting-attempt")
      throw new ScoutingReportRepositoryError("report-storage-corrupt");
    try {
      const read = readScoutingAttemptRecord(item["value"]);
      if (read.attempt.attemptId !== attemptId)
        throw new Error("report-storage-corrupt");
      return read;
    } catch (error) {
      throw toScoutingReportRepositoryError(error, "report-storage-corrupt");
    }
  }

  private async assertEventVersion(
    eventId: string,
    eventVersion: number,
  ): Promise<void> {
    const item = await this.rawGet(scoutingEventDetailItemKey(eventId));
    const value = item?.["value"];
    if (
      item !== undefined &&
      (value === null ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        (value as Readonly<Record<string, unknown>>)["eventId"] !== eventId ||
        !Number.isSafeInteger(
          (value as Readonly<Record<string, unknown>>)["materialVersion"],
        ))
    )
      throw new ScoutingReportRepositoryError("report-storage-corrupt");
    const materialVersion =
      item === undefined
        ? null
        : Number(
            (value as Readonly<Record<string, unknown>>)["materialVersion"],
          );
    if (materialVersion !== eventVersion)
      throw new ScoutingReportRepositoryError("report-event-version-changed");
  }

  private async resolveReplay(
    binding: ScoutingReportJobBinding,
    material: ScoutingReportCompletionMaterial,
  ): Promise<ScoutingReportCompletionResult> {
    if (
      binding.persistenceFingerprint !== material.version.persistenceFingerprint
    )
      throw new ScoutingReportRepositoryError("report-replay-conflict");
    const [version, head] = await Promise.all([
      this.storedVersion(binding.reportId, binding.reportVersionNumber),
      this.storedHead(binding.reportId),
    ]);
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

  private fencedJobPut(
    previous: ScoutingJob | ScoutingJobV2,
    next: ScoutingJobV2,
  ) {
    return {
      Put: {
        TableName: this.tableName,
        Item: {
          ...scoutingJobItemKey(next.jobId),
          entityType: "scouting-job",
          value: next,
        },
        ConditionExpression:
          "#value.#stateVersion=:stateVersion AND #value.#status=:status AND #value.#currentAttemptId=:attemptId",
        ExpressionAttributeNames: {
          "#value": "value",
          "#stateVersion": "stateVersion",
          "#status": "status",
          "#currentAttemptId": "currentAttemptId",
        },
        ExpressionAttributeValues: {
          ":stateVersion": previous.stateVersion,
          ":status": previous.status,
          ":attemptId": previous.currentAttemptId,
        },
      },
    };
  }

  private fencedAttemptPut(
    previous: ScoutingAttempt | ScoutingAttemptV2,
    next: ScoutingAttemptV2,
  ) {
    return {
      Put: {
        TableName: this.tableName,
        Item: {
          ...scoutingAttemptItemKey(next.attemptId),
          entityType: "scouting-attempt",
          value: next,
        },
        ConditionExpression:
          "#value.#stateVersion=:stateVersion AND #value.#status=:status AND #value.#jobId=:jobId",
        ExpressionAttributeNames: {
          "#value": "value",
          "#stateVersion": "stateVersion",
          "#status": "status",
          "#jobId": "jobId",
        },
        ExpressionAttributeValues: {
          ":stateVersion": previous.stateVersion,
          ":status": previous.status,
          ":jobId": previous.jobId,
        },
      },
    };
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
      const attempt = await this.completeOnce(material, input.completedAt);
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
    // Replay resolution FIRST: never requires an active attempt.
    const binding = await this.storedBinding(version.jobId);
    if (binding)
      return {
        kind: "done",
        result: await this.resolveReplay(binding, material),
      };
    const [jobRead, attemptRead] = await Promise.all([
      this.readJobRecord(version.jobId),
      this.readAttemptRecord(version.attemptId),
    ]);
    const { job, attempt } = requireClaimedScoutingLifecycle(
      jobRead,
      attemptRead,
      version,
    );
    await this.assertEventVersion(version.eventId, version.eventVersion);
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
    const headWrite =
      version.predecessor === null
        ? {
            Put: {
              TableName: this.tableName,
              Item: {
                ...scoutingReportHeadKey(version.reportId),
                entityType: "scouting-report-head",
                value: material.head,
              },
              ConditionExpression:
                "attribute_not_exists(pk) AND attribute_not_exists(sk)",
            },
          }
        : {
            Put: {
              TableName: this.tableName,
              Item: {
                ...scoutingReportHeadKey(version.reportId),
                entityType: "scouting-report-head",
                value: material.head,
              },
              ConditionExpression:
                "#value.#stateVersion=:previousStateVersion AND #value.#latestVersionId=:predecessorId AND #value.#latestVersionNumber=:predecessorNumber AND #value.#latestDraftHash=:predecessorDraftHash",
              ExpressionAttributeNames: {
                "#value": "value",
                "#stateVersion": "stateVersion",
                "#latestVersionId": "latestVersionId",
                "#latestVersionNumber": "latestVersionNumber",
                "#latestDraftHash": "latestDraftHash",
              },
              ExpressionAttributeValues: {
                ":previousStateVersion": material.head.stateVersion - 1,
                ":predecessorId": version.predecessor.reportVersionId,
                ":predecessorNumber": version.predecessor.versionNumber,
                ":predecessorDraftHash": version.predecessor.draftHash,
              },
            },
          };
    try {
      await this.client.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              ConditionCheck: {
                TableName: this.tableName,
                Key: scoutingEventDetailItemKey(version.eventId),
                ConditionExpression:
                  "#value.#materialVersion=:eventVersion AND attribute_not_exists(expiresAt)",
                ExpressionAttributeNames: {
                  "#value": "value",
                  "#materialVersion": "materialVersion",
                },
                ExpressionAttributeValues: {
                  ":eventVersion": version.eventVersion,
                },
              },
            },
            {
              Put: {
                TableName: this.tableName,
                Item: {
                  ...scoutingReportVersionKey(
                    version.reportId,
                    version.versionNumber,
                  ),
                  entityType: "scouting-report-version",
                  value: version,
                },
                ConditionExpression:
                  "attribute_not_exists(pk) AND attribute_not_exists(sk)",
              },
            },
            headWrite,
            {
              Put: {
                TableName: this.tableName,
                Item: {
                  ...scoutingReportJobBindingKey(version.jobId),
                  entityType: "scouting-report-binding",
                  value: {
                    ...pointer,
                    persistenceFingerprint: version.persistenceFingerprint,
                  },
                },
                ConditionExpression:
                  "attribute_not_exists(pk) AND attribute_not_exists(sk)",
              },
            },
            this.fencedJobPut(job, completedJob),
            this.fencedAttemptPut(attempt, completedAttempt),
            {
              Put: {
                TableName: this.tableName,
                Item: {
                  ...scoutingActiveLockItemKey(job.semanticDigest),
                  entityType: "scouting-active-tombstone",
                  value: {
                    semanticDigest: job.semanticDigest,
                    jobId: job.jobId,
                    attemptId: attempt.attemptId,
                  },
                },
                ConditionExpression:
                  "#entityType=:activeMarker AND #value.#jobId=:jobId AND #value.#attemptId=:attemptId",
                ExpressionAttributeNames: {
                  "#entityType": "entityType",
                  "#value": "value",
                  "#jobId": "jobId",
                  "#attemptId": "attemptId",
                },
                ExpressionAttributeValues: {
                  ":activeMarker": "scouting-active-lock",
                  ":jobId": job.jobId,
                  ":attemptId": attempt.attemptId,
                },
              },
            },
          ],
        }),
      );
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
    } catch (error) {
      return this.classifyCancellation(error, material);
    }
  }

  /**
   * Maps TransactionCanceledException cancellation reasons onto the stable
   * taxonomy, by TransactItems index: a version/binding collision is a
   * potential same-job replay (re-read the binding and resolve); job,
   * attempt, or lock fences are a terminal stale attempt; the event fence is
   * `report-event-version-changed`; the head CAS (or a version-slot loss with
   * no binding) reloads the winning head and predecessor for recompute.
   */
  private async classifyCancellation(
    error: unknown,
    material: ScoutingReportCompletionMaterial,
  ): Promise<
    | { readonly kind: "done"; readonly result: ScoutingReportCompletionResult }
    | {
        readonly kind: "cas";
        readonly winningHead: ScoutingReportHead;
        readonly winningPredecessor: ScoutingReportVersionRecord;
      }
  > {
    const reasons = cancellationReasons(error);
    if (!reasons) throw error;
    const failed = (index: number): boolean =>
      reasons[index]?.Code === "ConditionalCheckFailed";
    if (failed(TRANSACT_VERSION) || failed(TRANSACT_BINDING)) {
      const binding = await this.storedBinding(material.version.jobId);
      if (binding)
        return {
          kind: "done",
          result: await this.resolveReplay(binding, material),
        };
      // A different job took the version slot: the head necessarily moved.
      return this.loadWinner(material);
    }
    if (
      failed(TRANSACT_JOB) ||
      failed(TRANSACT_ATTEMPT) ||
      failed(TRANSACT_LOCK)
    )
      throw new ScoutingReportRepositoryError("report-stale-attempt");
    if (failed(TRANSACT_EVENT))
      throw new ScoutingReportRepositoryError("report-event-version-changed");
    if (failed(TRANSACT_HEAD)) return this.loadWinner(material);
    throw error;
  }

  private async loadWinner(
    material: ScoutingReportCompletionMaterial,
  ): Promise<{
    readonly kind: "cas";
    readonly winningHead: ScoutingReportHead;
    readonly winningPredecessor: ScoutingReportVersionRecord;
  }> {
    const winningHead = await this.storedHead(material.version.reportId);
    if (!winningHead)
      throw new ScoutingReportRepositoryError("report-head-cas-conflict");
    const winningPredecessor = await this.storedVersion(
      material.version.reportId,
      winningHead.latestVersionNumber,
    );
    if (!winningPredecessor)
      throw new ScoutingReportRepositoryError("report-storage-corrupt");
    return { kind: "cas", winningHead, winningPredecessor };
  }

  async getHead(
    reportId: string,
    requesterId: string,
  ): Promise<ScoutingReportHead | null> {
    if (!isScoutingReportId(reportId)) return null;
    const head = await this.storedHead(reportId);
    return head && head.requesterId === requesterId ? head : null;
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
    const version = await this.storedVersion(reportId, versionNumber);
    return version && version.requesterId === requesterId ? version : null;
  }

  async listVersions(
    reportId: string,
    requesterId: string,
  ): Promise<readonly ScoutingReportVersionRecord[]> {
    if (!isScoutingReportId(reportId)) return Object.freeze([]);
    const versions: ScoutingReportVersionRecord[] = [];
    let cursor: Record<string, unknown> | undefined;
    do {
      const result = await this.client.send(
        new QueryCommand({
          TableName: this.tableName,
          KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
          ExpressionAttributeValues: {
            ":pk": reportPartition(reportId),
            ":prefix": VERSION_SK_PREFIX,
          },
          // Version history is immutable requester-scoped presentation data;
          // completion, replay, and head CAS use strong point reads.
          ConsistentRead: false,
          ...(cursor ? { ExclusiveStartKey: cursor } : {}),
        }),
      );
      for (const item of result.Items ?? [])
        versions.push(
          this.versionFromItem(item as Record<string, unknown>, reportId, null),
        );
      cursor = result.LastEvaluatedKey as Record<string, unknown> | undefined;
    } while (cursor);
    for (let index = 1; index < versions.length; index += 1) {
      const previous = versions[index - 1];
      const current = versions[index];
      if (
        !previous ||
        !current ||
        previous.versionNumber >= current.versionNumber
      )
        throw new ScoutingReportRepositoryError("report-storage-corrupt");
    }
    if (versions.some((version) => version.requesterId !== requesterId))
      return Object.freeze([]);
    return Object.freeze(versions);
  }

  async getByJobBinding(
    jobId: string,
    requesterId: string,
  ): Promise<ScoutingReportVersionRecord | null> {
    if (!isScoutingJobIdForReports(jobId)) return null;
    const binding = await this.storedBinding(jobId);
    if (!binding) return null;
    const version = await this.storedVersion(
      binding.reportId,
      binding.reportVersionNumber,
    );
    if (!version || version.reportVersionId !== binding.reportVersionId)
      throw new ScoutingReportRepositoryError("report-storage-corrupt");
    return version.requesterId === requesterId ? version : null;
  }
}
