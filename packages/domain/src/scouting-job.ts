import { sha256Hex } from "./fixture-odds.js";

export const SCOUTING_JOB_SCHEMA_VERSION = 1 as const;
export const SCOUTING_WORKFLOW_INTENT = "fixture-v1" as const;
export const SCOUTING_MAX_ATTEMPTS = 3 as const;

export const SCOUTING_JOB_STATUSES = [
  "queued",
  "in_progress",
  "completed",
  "failed_retryable",
  "failed_terminal",
  "cancelled",
] as const;
export type ScoutingJobStatus = (typeof SCOUTING_JOB_STATUSES)[number];

export const SCOUTING_FAILURE_CODES = [
  "workflow-timeout",
  "workflow-temporarily-unavailable",
  "fixture-transient-failure",
  "fixture-contract-invalid",
  "event-version-changed",
  "event-no-longer-scheduled",
  "attempt-limit-reached",
  "workflow-terminal-failure",
] as const;
export type ScoutingFailureCode = (typeof SCOUTING_FAILURE_CODES)[number];

const RETRYABLE_FAILURE_CODES: ReadonlySet<ScoutingFailureCode> = new Set([
  "workflow-timeout",
  "workflow-temporarily-unavailable",
  "fixture-transient-failure",
]);

export interface ScoutingJobCommand {
  readonly schemaVersion: 1;
  readonly requesterId: string;
  readonly idempotencyKey: string;
  readonly eventId: string;
  readonly eventVersion: number;
  readonly workflowIntent: typeof SCOUTING_WORKFLOW_INTENT;
}

export interface ScoutingJob {
  readonly schemaVersion: 1;
  readonly jobId: string;
  readonly requesterId: string;
  readonly eventId: string;
  readonly eventVersion: number;
  readonly workflowIntent: typeof SCOUTING_WORKFLOW_INTENT;
  readonly commandDigest: string;
  readonly semanticDigest: string;
  readonly status: ScoutingJobStatus;
  readonly stateVersion: number;
  readonly currentAttemptId: string;
  readonly attemptCount: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly failureCode?: ScoutingFailureCode;
}

export interface ScoutingAttempt {
  readonly schemaVersion: 1;
  readonly attemptId: string;
  readonly jobId: string;
  readonly attemptNumber: number;
  readonly previousAttemptId: string | null;
  readonly status: ScoutingJobStatus;
  readonly stateVersion: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly startedAt?: string;
  readonly finishedAt?: string;
  readonly failureCode?: ScoutingFailureCode;
}

export interface ScoutingDispatchCommand {
  readonly schemaVersion: 1;
  readonly jobId: string;
  readonly attemptId: string;
  readonly eventId: string;
  readonly eventVersion: number;
  readonly workflowIntent: typeof SCOUTING_WORKFLOW_INTENT;
}

export interface ScoutingDispatchOutbox {
  readonly schemaVersion: 1;
  readonly outboxId: string;
  readonly jobId: string;
  readonly attemptId: string;
  readonly command: ScoutingDispatchCommand;
  readonly messageGroupId: string;
  readonly messageDeduplicationId: string;
  readonly status: "pending" | "published";
  readonly version: number;
  readonly createdAt: string;
  readonly publishedAt?: string;
}

export interface PublicScoutingJob {
  readonly schemaVersion: 1;
  readonly jobId: string;
  readonly eventId: string;
  readonly eventVersion: number;
  readonly workflowIntent: typeof SCOUTING_WORKFLOW_INTENT;
  readonly status: ScoutingJobStatus;
  readonly stateVersion: number;
  readonly attemptNumber: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly failure?: {
    readonly code: ScoutingFailureCode;
    readonly retryable: boolean;
  };
}

const exactIso = (value: string): string => {
  if (
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  )
    throw new Error("scouting-time-invalid");
  return value;
};

export const assertScoutingTimestamp = exactIso;

const safeIdentity = (value: string, code: string): string => {
  if (!/^[A-Za-z0-9._:@/-]{1,256}$/.test(value)) throw new Error(code);
  return value;
};

const canonicalEventId = (value: string): string => {
  if (value.length < 1 || value.length > 512)
    throw new Error("scouting-event-id-invalid");
  for (const part of value.split(":")) {
    if (!/^(?:[a-z0-9.!'()*_~-]|%[0-9A-F]{2})+$/.test(part))
      throw new Error("scouting-event-id-invalid");
    let decoded: string;
    try {
      decoded = decodeURIComponent(part);
    } catch {
      throw new Error("scouting-event-id-invalid");
    }
    if (
      !decoded ||
      ["__proto__", "constructor", "prototype"].includes(decoded) ||
      decoded !==
        decoded.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ") ||
      encodeURIComponent(decoded) !== part
    )
      throw new Error("scouting-event-id-invalid");
  }
  return value;
};

export function normalizeScoutingJobCommand(
  value: ScoutingJobCommand,
): ScoutingJobCommand {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join("|") !==
      [
        "schemaVersion",
        "requesterId",
        "idempotencyKey",
        "eventId",
        "eventVersion",
        "workflowIntent",
      ]
        .sort()
        .join("|") ||
    value.schemaVersion !== SCOUTING_JOB_SCHEMA_VERSION ||
    value.workflowIntent !== SCOUTING_WORKFLOW_INTENT ||
    !Number.isSafeInteger(value.eventVersion) ||
    value.eventVersion < 1
  )
    throw new Error("scouting-command-invalid");
  safeIdentity(value.requesterId, "scouting-requester-invalid");
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(value.idempotencyKey))
    throw new Error("scouting-idempotency-key-invalid");
  canonicalEventId(value.eventId);
  return Object.freeze({ ...value });
}

const exactKeys = (
  value: Readonly<Record<string, unknown>>,
  required: readonly string[],
  optional: readonly string[] = [],
) => {
  const keys = Object.keys(value);
  return (
    required.every((key) => keys.includes(key)) &&
    keys.every((key) => required.includes(key) || optional.includes(key))
  );
};

const objectRecord = (value: unknown): Readonly<Record<string, unknown>> => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("scouting-contract-invalid");
  return value as Readonly<Record<string, unknown>>;
};

const validJobId = (value: unknown): value is string =>
  typeof value === "string" && /^scout-job:[a-f0-9]{64}$/.test(value);
const validAttemptId = (value: unknown): value is string =>
  typeof value === "string" && /^scout-attempt:[a-f0-9]{64}$/.test(value);
const validOutboxId = (value: unknown): value is string =>
  typeof value === "string" && /^scout-outbox:[a-f0-9]{64}$/.test(value);
const validStatus = (value: unknown): value is ScoutingJobStatus =>
  SCOUTING_JOB_STATUSES.includes(value as ScoutingJobStatus);
const validFailure = (value: unknown): value is ScoutingFailureCode =>
  SCOUTING_FAILURE_CODES.includes(value as ScoutingFailureCode);

export function validateScoutingDispatchCommand(
  input: unknown,
): ScoutingDispatchCommand {
  const value = objectRecord(input);
  if (
    !exactKeys(value, [
      "schemaVersion",
      "jobId",
      "attemptId",
      "eventId",
      "eventVersion",
      "workflowIntent",
    ]) ||
    value["schemaVersion"] !== 1 ||
    !validJobId(value["jobId"]) ||
    !validAttemptId(value["attemptId"]) ||
    typeof value["eventId"] !== "string" ||
    !Number.isSafeInteger(value["eventVersion"]) ||
    Number(value["eventVersion"]) < 1 ||
    value["workflowIntent"] !== SCOUTING_WORKFLOW_INTENT
  )
    throw new Error("scouting-dispatch-command-invalid");
  canonicalEventId(value["eventId"]);
  const dispatchJobId = String(value["jobId"]);
  const dispatchAttemptId = String(value["attemptId"]);
  if (
    !Array.from({ length: SCOUTING_MAX_ATTEMPTS }, (_, index) =>
      createScoutingAttemptId(dispatchJobId, index + 1),
    ).includes(dispatchAttemptId)
  )
    throw new Error("scouting-dispatch-command-invalid");
  return Object.freeze({
    schemaVersion: 1,
    jobId: dispatchJobId,
    attemptId: dispatchAttemptId,
    eventId: value["eventId"],
    eventVersion: Number(value["eventVersion"]),
    workflowIntent: SCOUTING_WORKFLOW_INTENT,
  });
}

export function validateScoutingJob(input: unknown): ScoutingJob {
  const value = objectRecord(input);
  if (
    !exactKeys(
      value,
      [
        "schemaVersion",
        "jobId",
        "requesterId",
        "eventId",
        "eventVersion",
        "workflowIntent",
        "commandDigest",
        "semanticDigest",
        "status",
        "stateVersion",
        "currentAttemptId",
        "attemptCount",
        "createdAt",
        "updatedAt",
      ],
      ["failureCode"],
    ) ||
    value["schemaVersion"] !== 1 ||
    !validJobId(value["jobId"]) ||
    !validAttemptId(value["currentAttemptId"]) ||
    typeof value["requesterId"] !== "string" ||
    typeof value["eventId"] !== "string" ||
    !Number.isSafeInteger(value["eventVersion"]) ||
    Number(value["eventVersion"]) < 1 ||
    value["workflowIntent"] !== SCOUTING_WORKFLOW_INTENT ||
    typeof value["commandDigest"] !== "string" ||
    !/^[a-f0-9]{64}$/.test(value["commandDigest"]) ||
    typeof value["semanticDigest"] !== "string" ||
    !/^[a-f0-9]{64}$/.test(value["semanticDigest"]) ||
    !validStatus(value["status"]) ||
    !Number.isSafeInteger(value["stateVersion"]) ||
    Number(value["stateVersion"]) < 1 ||
    !Number.isSafeInteger(value["attemptCount"]) ||
    Number(value["attemptCount"]) < 1 ||
    Number(value["attemptCount"]) > SCOUTING_MAX_ATTEMPTS ||
    typeof value["createdAt"] !== "string" ||
    typeof value["updatedAt"] !== "string" ||
    (value["failureCode"] !== undefined && !validFailure(value["failureCode"]))
  )
    throw new Error("scouting-job-invalid");
  safeIdentity(value["requesterId"], "scouting-job-invalid");
  canonicalEventId(value["eventId"]);
  exactIso(value["createdAt"]);
  exactIso(value["updatedAt"]);
  const attemptCount = Number(value["attemptCount"]);
  const stateVersion = Number(value["stateVersion"]);
  const minimumStateVersion =
    value["status"] === "queued"
      ? 2 * attemptCount - 1
      : value["status"] === "completed"
        ? 2 * attemptCount + 1
        : 2 * attemptCount;
  const maximumStateVersion =
    value["status"] === "queued"
      ? 3 * attemptCount - 2
      : value["status"] === "in_progress"
        ? 3 * attemptCount - 1
        : 3 * attemptCount;
  if (
    value["updatedAt"] < value["createdAt"] ||
    stateVersion < minimumStateVersion ||
    stateVersion > maximumStateVersion ||
    createScoutingSemanticDigest({
      schemaVersion: 1,
      requesterId: value["requesterId"],
      idempotencyKey: "stored-validation",
      eventId: value["eventId"],
      eventVersion: Number(value["eventVersion"]),
      workflowIntent: SCOUTING_WORKFLOW_INTENT,
    }) !== value["semanticDigest"] ||
    createScoutingAttemptId(value["jobId"], attemptCount) !==
      value["currentAttemptId"] ||
    (value["status"] === "failed_retryable" ||
      value["status"] === "failed_terminal") !==
      (value["failureCode"] !== undefined) ||
    (value["status"] === "failed_retryable" &&
      !isRetryableScoutingFailure(
        value["failureCode"] as ScoutingFailureCode,
      )) ||
    (value["status"] === "failed_terminal" &&
      isRetryableScoutingFailure(value["failureCode"] as ScoutingFailureCode))
  )
    throw new Error("scouting-job-invalid");
  return Object.freeze({ ...(value as unknown as ScoutingJob) });
}

export function validateScoutingAttempt(input: unknown): ScoutingAttempt {
  const value = objectRecord(input);
  if (
    !exactKeys(
      value,
      [
        "schemaVersion",
        "attemptId",
        "jobId",
        "attemptNumber",
        "previousAttemptId",
        "status",
        "stateVersion",
        "createdAt",
        "updatedAt",
      ],
      ["startedAt", "finishedAt", "failureCode"],
    ) ||
    value["schemaVersion"] !== 1 ||
    !validAttemptId(value["attemptId"]) ||
    !validJobId(value["jobId"]) ||
    !Number.isSafeInteger(value["attemptNumber"]) ||
    Number(value["attemptNumber"]) < 1 ||
    Number(value["attemptNumber"]) > SCOUTING_MAX_ATTEMPTS ||
    !(
      value["previousAttemptId"] === null ||
      validAttemptId(value["previousAttemptId"])
    ) ||
    !validStatus(value["status"]) ||
    !Number.isSafeInteger(value["stateVersion"]) ||
    Number(value["stateVersion"]) < 1 ||
    typeof value["createdAt"] !== "string" ||
    typeof value["updatedAt"] !== "string" ||
    (value["startedAt"] !== undefined &&
      typeof value["startedAt"] !== "string") ||
    (value["finishedAt"] !== undefined &&
      typeof value["finishedAt"] !== "string") ||
    (value["failureCode"] !== undefined && !validFailure(value["failureCode"]))
  )
    throw new Error("scouting-attempt-invalid");
  for (const time of [
    value["createdAt"],
    value["updatedAt"],
    value["startedAt"],
    value["finishedAt"],
  ].filter((item): item is string => typeof item === "string"))
    exactIso(time);
  if (
    value["updatedAt"] < value["createdAt"] ||
    createScoutingAttemptId(value["jobId"], Number(value["attemptNumber"])) !==
      value["attemptId"] ||
    (Number(value["attemptNumber"]) === 1) !==
      (value["previousAttemptId"] === null) ||
    (Number(value["attemptNumber"]) > 1 &&
      value["previousAttemptId"] !==
        createScoutingAttemptId(
          value["jobId"],
          Number(value["attemptNumber"]) - 1,
        )) ||
    (value["status"] === "queued" &&
      (value["stateVersion"] !== 1 ||
        value["startedAt"] !== undefined ||
        value["finishedAt"] !== undefined)) ||
    (value["status"] === "in_progress" &&
      (value["stateVersion"] !== 2 ||
        value["startedAt"] === undefined ||
        value["finishedAt"] !== undefined)) ||
    (terminalScoutingStatuses.has(value["status"]) &&
      value["finishedAt"] === undefined) ||
    (value["status"] === "completed" && value["startedAt"] === undefined) ||
    (terminalScoutingStatuses.has(value["status"]) &&
      value["stateVersion"] !== (value["startedAt"] === undefined ? 2 : 3)) ||
    (typeof value["startedAt"] === "string" &&
      (value["startedAt"] < value["createdAt"] ||
        value["startedAt"] > value["updatedAt"])) ||
    (typeof value["finishedAt"] === "string" &&
      (value["finishedAt"] < value["createdAt"] ||
        value["finishedAt"] !== value["updatedAt"])) ||
    (typeof value["startedAt"] === "string" &&
      typeof value["finishedAt"] === "string" &&
      value["finishedAt"] < value["startedAt"]) ||
    (value["status"] === "failed_retryable" ||
      value["status"] === "failed_terminal") !==
      (value["failureCode"] !== undefined) ||
    (value["status"] === "failed_retryable" &&
      !isRetryableScoutingFailure(
        value["failureCode"] as ScoutingFailureCode,
      )) ||
    (value["status"] === "failed_terminal" &&
      isRetryableScoutingFailure(value["failureCode"] as ScoutingFailureCode))
  )
    throw new Error("scouting-attempt-invalid");
  return Object.freeze({ ...(value as unknown as ScoutingAttempt) });
}

const terminalScoutingStatuses: ReadonlySet<unknown> = new Set([
  "completed",
  "failed_retryable",
  "failed_terminal",
  "cancelled",
]);

export function validateScoutingDispatchOutbox(
  input: unknown,
): ScoutingDispatchOutbox {
  const value = objectRecord(input);
  if (
    !exactKeys(
      value,
      [
        "schemaVersion",
        "outboxId",
        "jobId",
        "attemptId",
        "command",
        "messageGroupId",
        "messageDeduplicationId",
        "status",
        "version",
        "createdAt",
      ],
      ["publishedAt"],
    ) ||
    value["schemaVersion"] !== 1 ||
    !validOutboxId(value["outboxId"]) ||
    !validJobId(value["jobId"]) ||
    !validAttemptId(value["attemptId"]) ||
    value["messageGroupId"] !== value["jobId"] ||
    value["messageDeduplicationId"] !== value["attemptId"] ||
    !["pending", "published"].includes(String(value["status"])) ||
    !Number.isSafeInteger(value["version"]) ||
    Number(value["version"]) < 1 ||
    typeof value["createdAt"] !== "string" ||
    (value["publishedAt"] !== undefined &&
      typeof value["publishedAt"] !== "string")
  )
    throw new Error("scouting-outbox-invalid");
  const command = validateScoutingDispatchCommand(value["command"]);
  exactIso(value["createdAt"]);
  if (typeof value["publishedAt"] === "string") exactIso(value["publishedAt"]);
  if (
    command.jobId !== value["jobId"] ||
    command.attemptId !== value["attemptId"] ||
    createScoutingOutboxId(command.attemptId) !== value["outboxId"] ||
    (value["status"] === "pending") !== (value["publishedAt"] === undefined) ||
    (value["status"] === "pending" && value["version"] !== 1) ||
    (value["status"] === "published" && value["version"] !== 2) ||
    (typeof value["publishedAt"] === "string" &&
      value["publishedAt"] < value["createdAt"])
  )
    throw new Error("scouting-outbox-invalid");
  return Object.freeze({
    ...(value as unknown as ScoutingDispatchOutbox),
    command,
  });
}

const stableCommand = (command: ScoutingJobCommand) =>
  JSON.stringify({
    schemaVersion: command.schemaVersion,
    requesterId: command.requesterId,
    eventId: command.eventId,
    eventVersion: command.eventVersion,
    workflowIntent: command.workflowIntent,
  });

export const createScoutingCommandDigest = (input: ScoutingJobCommand) => {
  const command = normalizeScoutingJobCommand(input);
  return sha256Hex(`fte:scouting-command:v1:${stableCommand(command)}`);
};

export const createScoutingSemanticDigest = (input: ScoutingJobCommand) => {
  const command = normalizeScoutingJobCommand(input);
  return sha256Hex(`fte:scouting-active:v1:${stableCommand(command)}`);
};

export const createScoutingRequestReceiptId = (input: ScoutingJobCommand) => {
  const command = normalizeScoutingJobCommand(input);
  return sha256Hex(
    `fte:scouting-request:v1:${JSON.stringify({ requesterId: command.requesterId, idempotencyKey: command.idempotencyKey })}`,
  );
};

export const createScoutingJobId = (input: ScoutingJobCommand) => {
  const command = normalizeScoutingJobCommand(input);
  return `scout-job:${sha256Hex(
    `fte:scouting-job:v1:${JSON.stringify({ receiptId: createScoutingRequestReceiptId(command), commandDigest: createScoutingCommandDigest(command) })}`,
  )}`;
};

export const createScoutingAttemptId = (
  jobId: string,
  attemptNumber: number,
) => {
  if (
    !/^scout-job:[a-f0-9]{64}$/.test(jobId) ||
    !Number.isSafeInteger(attemptNumber) ||
    attemptNumber < 1 ||
    attemptNumber > SCOUTING_MAX_ATTEMPTS
  )
    throw new Error("scouting-attempt-identity-invalid");
  return `scout-attempt:${sha256Hex(
    `fte:scouting-attempt:v1:${JSON.stringify({ jobId, attemptNumber })}`,
  )}`;
};

export const createScoutingOutboxId = (attemptId: string) => {
  if (!/^scout-attempt:[a-f0-9]{64}$/.test(attemptId))
    throw new Error("scouting-outbox-identity-invalid");
  return `scout-outbox:${sha256Hex(`fte:scouting-outbox:v1:${attemptId}`)}`;
};

export const isRetryableScoutingFailure = (
  code: ScoutingFailureCode,
): boolean => RETRYABLE_FAILURE_CODES.has(code);

export function assertScoutingJobTransition(
  from: ScoutingJobStatus,
  to: ScoutingJobStatus,
): void {
  const legal: Record<ScoutingJobStatus, readonly ScoutingJobStatus[]> = {
    queued: ["in_progress", "failed_retryable", "failed_terminal", "cancelled"],
    in_progress: [
      "completed",
      "failed_retryable",
      "failed_terminal",
      "cancelled",
    ],
    completed: [],
    failed_retryable: ["queued"],
    failed_terminal: [],
    cancelled: [],
  };
  if (!legal[from].includes(to))
    throw new Error("scouting-job-transition-invalid");
}

export function createQueuedScoutingRecords(
  input: ScoutingJobCommand,
  createdAt: string,
): {
  readonly job: ScoutingJob;
  readonly attempt: ScoutingAttempt;
  readonly outbox: ScoutingDispatchOutbox;
} {
  const command = normalizeScoutingJobCommand(input);
  exactIso(createdAt);
  const jobId = createScoutingJobId(command);
  const attemptId = createScoutingAttemptId(jobId, 1);
  const job: ScoutingJob = {
    schemaVersion: 1,
    jobId,
    requesterId: command.requesterId,
    eventId: command.eventId,
    eventVersion: command.eventVersion,
    workflowIntent: command.workflowIntent,
    commandDigest: createScoutingCommandDigest(command),
    semanticDigest: createScoutingSemanticDigest(command),
    status: "queued",
    stateVersion: 1,
    currentAttemptId: attemptId,
    attemptCount: 1,
    createdAt,
    updatedAt: createdAt,
  };
  const attempt: ScoutingAttempt = {
    schemaVersion: 1,
    attemptId,
    jobId,
    attemptNumber: 1,
    previousAttemptId: null,
    status: "queued",
    stateVersion: 1,
    createdAt,
    updatedAt: createdAt,
  };
  const outboxId = createScoutingOutboxId(attemptId);
  const outbox: ScoutingDispatchOutbox = {
    schemaVersion: 1,
    outboxId,
    jobId,
    attemptId,
    command: {
      schemaVersion: 1,
      jobId,
      attemptId,
      eventId: command.eventId,
      eventVersion: command.eventVersion,
      workflowIntent: command.workflowIntent,
    },
    messageGroupId: jobId,
    messageDeduplicationId: attemptId,
    status: "pending",
    version: 1,
    createdAt,
  };
  return {
    job: validateScoutingJob(job),
    attempt: validateScoutingAttempt(attempt),
    outbox: validateScoutingDispatchOutbox(outbox),
  };
}

export function toPublicScoutingJob(job: ScoutingJob): PublicScoutingJob {
  return {
    schemaVersion: 1,
    jobId: job.jobId,
    eventId: job.eventId,
    eventVersion: job.eventVersion,
    workflowIntent: job.workflowIntent,
    status: job.status,
    stateVersion: job.stateVersion,
    attemptNumber: job.attemptCount,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    ...(job.failureCode
      ? {
          failure: {
            code: job.failureCode,
            retryable:
              isRetryableScoutingFailure(job.failureCode) &&
              job.attemptCount < SCOUTING_MAX_ATTEMPTS,
          },
        }
      : {}),
  };
}
