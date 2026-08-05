import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { run } from "./phase1-support.mjs";

export const RESET_ACCOUNT = "228246988391";
export const RESET_REGION = "us-east-1";
export const RESET_STACK = "FindTheEdge-dev-Foundation";
export const RESET_MODES = new Set(["dry-run", "apply"]);
export const RESET_ENABLED_LEAGUES = Object.freeze([
  "mlb",
  "mls",
  "epl",
  "liga-mx",
  "uefa-champions-league",
]);
export const RESET_MAX_MANIFEST_KEYS = 250_000;

const boundedText = (value, maximum = 2048) =>
  typeof value === "string" && value.length > 0 && value.length <= maximum;

export const safeErrorCode = (error) => {
  const message = error instanceof Error ? error.message : "";
  return message.length <= 160 &&
    /^reset-[a-z0-9-]+(?::[a-z0-9-]+)?$/.test(message)
    ? message
    : "reset-operation-failed";
};

// Stored domain identifiers permit printable non-whitespace ASCII. Canonical
// JSON spelling below prevents a second textual identity for fixture keys.
const COMPONENT = /^[\x21-\x7e]{1,512}$/;
const HEX_64 = /^[a-f0-9]{64}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const component = (value) => COMPONENT.test(value);
const prefixedComponent = (value, prefix) =>
  value.startsWith(prefix) && component(value.slice(prefix.length));
const snapshotSortKey = (value) => {
  const match = /^SNAPSHOT#(.+)#([a-f0-9]{64})$/.exec(value);
  return !!match && ISO.test(match[1]) && HEX_64.test(match[2]);
};
const fixturePartition = (pk) => {
  if (!pk.startsWith("FIXTURE_ODDS#")) return false;
  try {
    const dimensions = JSON.parse(pk.slice("FIXTURE_ODDS#".length));
    return (
      Array.isArray(dimensions) &&
      dimensions.length === 6 &&
      component(dimensions[0]) &&
      Number.isSafeInteger(dimensions[1]) &&
      dimensions[1] > 0 &&
      dimensions.slice(2).every(component) &&
      JSON.stringify(dimensions) === pk.slice("FIXTURE_ODDS#".length)
    );
  } catch {
    return false;
  }
};
const eventProjectionPk = (pk) => {
  const match =
    /^EVENTS#SPORT#([^#\s]+)#(?:LEAGUE#([^#\s]+)#)?STATUS#([a-z-]+)#DAY#(\d{4}-\d{2}-\d{2})$/.exec(
      pk,
    );
  return (
    !!match &&
    component(match[1]) &&
    (match[2] === undefined || component(match[2])) &&
    component(match[3])
  );
};
const eventProjectionSk = (sk) => {
  const match = /^(.+Z)#(.+)#(\d{16})$/.exec(sk);
  return !!match && ISO.test(match[1]) && component(match[2]);
};
const isoComposite = (sk, suffixPattern) => {
  const separator = sk.indexOf("#");
  return (
    separator > 0 &&
    ISO.test(sk.slice(0, separator)) &&
    suffixPattern.test(sk.slice(separator + 1))
  );
};

const deleteClassification = (pk, sk) => {
  if (pk === "EVENT_PROJECTIONS" && sk === "READINESS")
    return "event-projection-readiness";
  if (eventProjectionPk(pk) && eventProjectionSk(sk))
    return "event-list-projection";
  if (prefixedComponent(pk, "EVENT_DETAIL#") && sk === "CURRENT")
    return "event-detail";
  if (
    prefixedComponent(pk, "EVENT#") &&
    (sk === "CURRENT" ||
      /^PROVIDER_REVISION#[a-f0-9]{64}$/.test(sk) ||
      /^HISTORY#[^\s]+$/.test(sk))
  )
    return "canonical-event";
  if (
    ["IDENTITY#", "IDENTITY_OWNER#", "MAPPING#"].some((prefix) =>
      prefixedComponent(pk, prefix),
    ) &&
    (sk === "CURRENT" ||
      (pk.startsWith("IDENTITY#") && /^EVENT#[^\s]+$/.test(sk)))
  )
    return pk.startsWith("MAPPING#")
      ? "provider-event-mapping"
      : "event-identity";
  if (prefixedComponent(pk, "EVENT_RECONCILIATION#") && sk === "CURRENT")
    return "event-reconciliation";
  if (
    prefixedComponent(pk, "UNRESOLVED#") &&
    (sk === "CURRENT" ||
      /^(?:OBSERVATION_ID|OBSERVATION)#[a-f0-9]{64}$/.test(sk))
  )
    return "unresolved-event";
  if (prefixedComponent(pk, "BOOTSTRAP_MARKER#") && /^[a-f0-9]{64}$/.test(sk))
    return "bootstrap-marker";
  if (
    /^BOOTSTRAP_RESPONSE#[a-f0-9]{64}$/.test(pk) &&
    (sk === "CURRENT" || /^CHUNK#\d{4}$/.test(sk))
  )
    return "bootstrap-response";
  if (prefixedComponent(pk, "CHECKPOINT#") && sk === "CURRENT")
    return "ingestion-checkpoint";
  if (prefixedComponent(pk, "CURSOR_MARKER#") && HEX_64.test(sk))
    return "ingestion-cursor";
  if (prefixedComponent(pk, "PROVIDER_EVENT_FENCE#") && HEX_64.test(sk))
    return "provider-event-fence";
  if (prefixedComponent(pk, "PROVIDER_PAGE#") && HEX_64.test(sk))
    return "provider-page";
  if (prefixedComponent(pk, "RUN#") && sk === "CURRENT") return "ingestion-run";
  if (
    ["OUTBOX_PENDING#", "OUTBOX_DELIVERED#"].some((prefix) =>
      prefixedComponent(pk, prefix),
    ) &&
    (pk.startsWith("OUTBOX_PENDING#")
      ? /^\d{16}#\d{16}#[a-f0-9]{64}$/.test(sk)
      : HEX_64.test(sk))
  )
    return pk.startsWith("OUTBOX_PENDING#")
      ? "ingestion-outbox-pending"
      : "ingestion-outbox-delivered";
  if (
    /^ODDS_CONTROL#(?:ATTEMPT|RUN|HEALTH|PAGE|CHECKPOINT|CONTINUATION|GAP|MAINTENANCE)#[^\s]{1,1024}$/.test(
      pk,
    ) &&
    sk === "CURRENT"
  )
    return "odds-control-plane";
  if (fixturePartition(pk) && sk === "CURRENT") return "fixture-odds-current";
  if (/^FIXTURE_ODDS_GROUP#[a-f0-9]{64}$/.test(pk) && sk === "AVAILABILITY")
    return "fixture-odds-group-availability";
  if (fixturePartition(pk) && sk === "AVAILABILITY")
    return "fixture-odds-availability";
  if (
    prefixedComponent(pk, "BETTING_SPLIT#") &&
    (/^CURRENT#[^\s]+$/.test(sk) || /^HISTORY#.+#split:[a-f0-9]{64}$/.test(sk))
  )
    return "betting-split";
  if (
    /^BETTING_SPLIT_GAP#[A-Za-z0-9._:@/+~-]+#[A-Za-z0-9._:@/+~-]+$/.test(pk) &&
    /^.+Z#[a-f0-9]{64}$/.test(sk)
  )
    return "betting-split-gap";
  return undefined;
};

const preserveClassification = (pk, sk) => {
  if (fixturePartition(pk) && snapshotSortKey(sk))
    return "fixture-odds-snapshot";
  if (pk === "ODDS_SNAPSHOTS_BY_ID" && HEX_64.test(sk))
    return "odds-exact-index";
  if (prefixedComponent(pk, "ODDS_HISTORY#") && snapshotSortKey(sk))
    return "odds-history";
  const preservedProduct =
    (pk === "EXPERIMENTS" && isoComposite(sk, COMPONENT)) ||
    (pk === "PERFORMANCE_COHORTS" && component(sk)) ||
    (pk === "PERFORMANCE_REPORTS" &&
      /^\d{4}-\d{2}-\d{2}T.+Z#\d{8}#[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,511}$/.test(
        sk,
      )) ||
    (pk === "RETROSPECTIVES" && /^\d{16}#[A-Za-z0-9][^\s]{0,511}$/.test(sk)) ||
    (["STRATEGY_ACTIVATION", "STRATEGY_DECISION"].includes(pk) &&
      component(sk)) ||
    (/^EVALUATION#[a-f0-9]{64}$/.test(pk) &&
      ["RECORD", "PAPER_BET"].includes(sk)) ||
    (prefixedComponent(pk, "EVALUATION_ATTEMPT#") && sk === "RECORD") ||
    (/^EVALUATION_TERMINAL#[a-f0-9]{64}$/.test(pk) && sk === "CLAIM") ||
    (prefixedComponent(pk, "EXPERIMENT#") && sk === "RECORD") ||
    (prefixedComponent(pk, "EXPERIMENT_AUDIT#") &&
      isoComposite(sk, COMPONENT)) ||
    ([
      "EXPERIMENT_WINDOW#",
      "STRATEGY_GATE_POLICY#",
      "STRATEGY_PERFORMANCE_EVIDENCE#",
      "WALK_FORWARD_REQUEST#",
    ].some((prefix) => prefixedComponent(pk, prefix)) &&
      sk === "RECORD") ||
    (/^PAPER_BETS_BY_DAY#\d{4}-\d{2}-\d{2}$/.test(pk) &&
      /^paper-bet:[a-f0-9]{64}$/.test(sk)) ||
    (prefixedComponent(pk, "PAPER_BETS_BY_EVENT#") &&
      /^paper-bet:[a-f0-9]{64}$/.test(sk)) ||
    (prefixedComponent(pk, "PAPER_GRADE#") &&
      (sk === "CURRENT" ||
        /^HISTORY#\d{8}#paper-grade:[a-f0-9]{64}$/.test(sk))) ||
    (prefixedComponent(pk, "PAPER_PICK_GENERATION#") &&
      (sk === "META" ||
        /^EVENT#[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,511}$/.test(sk))) ||
    (prefixedComponent(pk, "PAPER_PICK_RUN#") &&
      (sk === "META" ||
        /^ITEM#[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,511}$/.test(sk))) ||
    (prefixedComponent(pk, "PERFORMANCE_COHORT#") &&
      (sk === "DEFINITION" ||
        sk === "FINAL" ||
        /^MEMBER#[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,511}$/.test(sk))) ||
    (/^PERFORMANCE_COHORT_CUTOFF#[a-f0-9]{64}$/.test(pk) && ISO.test(sk)) ||
    (prefixedComponent(pk, "PERFORMANCE_REPORT#") && sk === "RECORD") ||
    (prefixedComponent(pk, "RESULT#") &&
      (sk === "CURRENT" || /^HISTORY#[^\s]+$/.test(sk))) ||
    (prefixedComponent(pk, "RESULT_EXACT#") && component(sk)) ||
    (/^RESULT_CHECKPOINT#[A-Za-z0-9._:@/+~-]+(?:#[A-Za-z0-9._:@/+~-]+)*$/.test(
      pk,
    ) &&
      sk === "CURRENT") ||
    (/^RESULT_RUN#[A-Za-z0-9._:@/+~-]+#[A-Za-z0-9._:@/+~-]+$/.test(pk) &&
      isoComposite(sk, COMPONENT)) ||
    (prefixedComponent(pk, "UNRESOLVED_RESULT#") && /^ITEM#[^\s]+$/.test(sk)) ||
    (prefixedComponent(pk, "RETROSPECTIVE#") &&
      (sk === "CURRENT" || /^VERSION#\d{8}$/.test(sk))) ||
    (prefixedComponent(pk, "RETROSPECTIVE_VERSION#") && sk === "RECORD") ||
    (prefixedComponent(pk, "RETROSPECTIVE_REPORT#") && component(sk)) ||
    (prefixedComponent(pk, "RETROSPECTIVE_AUDIT#") &&
      isoComposite(sk, COMPONENT)) ||
    (prefixedComponent(pk, "RETROSPECTIVE_REPLAY#") && component(sk)) ||
    (prefixedComponent(pk, "STRATEGY#") && /^ARTIFACT#[^\s]+$/.test(sk)) ||
    (prefixedComponent(pk, "STRATEGY_ACTIVE_HEAD#") && sk === "HEAD") ||
    (prefixedComponent(pk, "STRATEGY_ACTIVE#") &&
      isoComposite(sk, COMPONENT)) ||
    (["STRATEGY_APPROVAL#", "STRATEGY_EVIDENCE#"].some((prefix) =>
      prefixedComponent(pk, prefix),
    ) &&
      HEX_64.test(sk));
  if (preservedProduct) return "product-record";
  return undefined;
};

export function classifyFeedKey(key) {
  if (!key || typeof key !== "object" || Array.isArray(key))
    return { disposition: "unexpected", family: "invalid-key" };
  const { pk, sk } = key;
  if (!boundedText(pk) || !boundedText(sk))
    return { disposition: "unexpected", family: "invalid-key" };
  const deletion = deleteClassification(pk, sk);
  if (deletion) return { disposition: "delete", family: deletion };
  const preservation = preserveClassification(pk, sk);
  if (preservation) return { disposition: "preserve", family: preservation };
  return { disposition: "unexpected", family: "unknown-key-family" };
}

export function buildFeedManifest(keys) {
  if (!Array.isArray(keys)) throw new Error("reset-key-list-invalid");
  if (keys.length > RESET_MAX_MANIFEST_KEYS)
    throw new Error("reset-manifest-key-limit");
  const unique = new Map();
  for (const key of keys) {
    const classification = classifyFeedKey(key);
    if (classification.disposition === "unexpected")
      throw new Error(`reset-key-family-unclassified:${classification.family}`);
    const identity = `${key.pk}\0${key.sk}`;
    if (unique.has(identity)) throw new Error("reset-scan-key-duplicate");
    unique.set(identity, { pk: key.pk, sk: key.sk, ...classification });
  }
  const rows = [...unique.values()].sort((left, right) =>
    left.pk === right.pk
      ? left.sk.localeCompare(right.sk)
      : left.pk.localeCompare(right.pk),
  );
  const deleteKeys = rows
    .filter(({ disposition }) => disposition === "delete")
    .map(({ pk, sk }) => ({ pk, sk }));
  const preservedKeys = rows
    .filter(({ disposition }) => disposition === "preserve")
    .map(({ pk, sk }) => ({ pk, sk }));
  const counts = {};
  const preserveCounts = {};
  for (const row of rows) {
    const target = row.disposition === "delete" ? counts : preserveCounts;
    target[row.family] = (target[row.family] ?? 0) + 1;
  }
  const keyDigest = (selected) =>
    createHash("sha256")
      .update(selected.map(({ pk, sk }) => `${pk}\0${sk}`).join("\n"))
      .digest("hex");
  const digest = keyDigest(deleteKeys);
  const preserveDigest = keyDigest(preservedKeys);
  return {
    scanned: rows.length,
    deleteCount: deleteKeys.length,
    preserveCount: rows.length - deleteKeys.length,
    counts: Object.fromEntries(Object.entries(counts).sort()),
    preserveCounts: Object.fromEntries(Object.entries(preserveCounts).sort()),
    digest,
    preserveDigest,
    deleteKeys,
    preservedKeys,
  };
}

export function validateResetEnvironment(environment) {
  const mode = environment.FTE_PHASE1_RESET_MODE ?? "dry-run";
  if (!RESET_MODES.has(mode)) throw new Error("reset-mode-invalid");
  if (
    environment.AWS_ACCOUNT_ID !== RESET_ACCOUNT ||
    environment.AWS_REGION !== RESET_REGION
  )
    throw new Error("reset-environment-target-invalid");
  if (mode === "apply") {
    if (environment.FTE_PHASE1_RESET_APPLY !== "RESET")
      throw new Error("reset-apply-confirmation-required");
    if (
      environment.GITHUB_ACTIONS !== "true" ||
      environment.GITHUB_REPOSITORY !== "kevishie/find-the-edge" ||
      environment.GITHUB_REF !== "refs/heads/main" ||
      environment.GITHUB_EVENT_NAME !== "workflow_dispatch" ||
      environment.GITHUB_WORKFLOW_REF !==
        "kevishie/find-the-edge/.github/workflows/reset-phase1-feed.yml@refs/heads/main" ||
      environment.GITHUB_JOB !== "reset" ||
      !boundedText(environment.GITHUB_RUN_ID, 128)
    )
      throw new Error("reset-apply-workflow-required");
  }
  return { mode };
}

export function validateAwsIdentity(identity) {
  if (
    identity?.Account !== RESET_ACCOUNT ||
    !boundedText(identity?.Arn) ||
    !boundedText(identity?.UserId)
  )
    throw new Error("reset-aws-identity-invalid");
}

const oneResource = (resources, type, logicalPrefix) => {
  const matches = resources.filter(
    (resource) =>
      resource.ResourceType === type &&
      resource.LogicalResourceId?.startsWith(logicalPrefix) &&
      boundedText(resource.PhysicalResourceId, 1024),
  );
  if (matches.length !== 1)
    throw new Error(`reset-resource-binding-invalid:${logicalPrefix}`);
  return matches[0];
};

export function validateResetTarget({
  stack,
  resources,
  outputs,
  lambdaConfigurations,
}) {
  const expectedStackPrefix = `arn:aws:cloudformation:${RESET_REGION}:${RESET_ACCOUNT}:stack/${RESET_STACK}/`;
  if (
    stack?.StackName !== RESET_STACK ||
    !stack?.StackId?.startsWith(expectedStackPrefix) ||
    ![
      "CREATE_COMPLETE",
      "UPDATE_COMPLETE",
      "UPDATE_ROLLBACK_COMPLETE",
      "IMPORT_COMPLETE",
      "IMPORT_ROLLBACK_COMPLETE",
    ].includes(stack?.StackStatus) ||
    !Array.isArray(resources)
  )
    throw new Error("reset-stack-target-invalid");
  const table = oneResource(
    resources,
    "AWS::DynamoDB::Table",
    "EventIngestionTable",
  );
  const lambda = oneResource(
    resources,
    "AWS::Lambda::Function",
    "LiveOddsIngestion",
  );
  const queue = oneResource(
    resources,
    "AWS::SQS::Queue",
    "LiveOddsControlPlaneQueue",
  );
  const scheduler = oneResource(
    resources,
    "AWS::Events::Rule",
    "LiveOddsScheduler",
  );
  const mapping = oneResource(
    resources,
    "AWS::Lambda::EventSourceMapping",
    "LiveOddsIngestionSqsEventSource",
  );
  const projection = oneResource(
    resources,
    "AWS::Lambda::Function",
    "FixtureOddsProjection",
  );
  const projectionMapping = oneResource(
    resources,
    "AWS::Lambda::EventSourceMapping",
    "FixtureOddsProjectionDynamoDBEventSource",
  );
  const upcoming = oneResource(
    resources,
    "AWS::Lambda::Function",
    "UpcomingEventsWorker",
  );
  const upcomingMapping = oneResource(
    resources,
    "AWS::Lambda::EventSourceMapping",
    "UpcomingEventsWorkerSqsEventSource",
  );
  const upcomingQueue = oneResource(
    resources,
    "AWS::SQS::Queue",
    "UpcomingEventsQueue",
  );
  const upcomingProducer = oneResource(
    resources,
    "AWS::Lambda::Function",
    "UpcomingEventsProducer",
  );
  const upcomingRule = oneResource(
    resources,
    "AWS::Events::Rule",
    "UpcomingEventsSchedulerReady",
  );
  const api = oneResource(resources, "AWS::ApiGatewayV2::Api", "EventsHttpApi");
  const apiStage = oneResource(
    resources,
    "AWS::ApiGatewayV2::Stage",
    "EventApiStage",
  );
  const fixtureSeeds = resources.filter(
    ({ ResourceType, LogicalResourceId }) =>
      ResourceType === "AWS::Lambda::Function" &&
      LogicalResourceId?.startsWith("FixtureOddsSeed"),
  );
  if (fixtureSeeds.length !== 0) throw new Error("reset-fixture-seed-present");
  const configurations = Array.isArray(lambdaConfigurations)
    ? lambdaConfigurations
    : [];
  const configurationFor = (resource) => {
    const matches = configurations.filter(
      ({ FunctionName }) => FunctionName === resource.PhysicalResourceId,
    );
    if (matches.length !== 1)
      throw new Error("reset-writer-configuration-invalid");
    return matches[0];
  };
  const liveConfiguration = configurationFor(lambda);
  const projectionConfiguration = configurationFor(projection);
  const upcomingConfiguration = configurationFor(upcoming);
  const producerConfiguration = configurationFor(upcomingProducer);
  const validTimeout = (configuration) =>
    Number.isSafeInteger(configuration?.Timeout) &&
    configuration.Timeout >= 1 &&
    configuration.Timeout <= 900;
  const endpoint = validApiBase(outputs?.EventsApiEndpoint)
    ? new URL(outputs.EventsApiEndpoint)
    : undefined;
  if (
    outputs?.LiveOddsIngestionFunctionName !== lambda.PhysicalResourceId ||
    outputs?.FixtureOddsProjectionFunctionName !==
      projection.PhysicalResourceId ||
    liveConfiguration?.Environment?.Variables?.FTE_EVENT_TABLE !==
      table.PhysicalResourceId ||
    liveConfiguration?.Environment?.Variables?.FTE_LIVE_ODDS_QUEUE_URL !==
      queue.PhysicalResourceId ||
    projectionConfiguration?.Environment?.Variables?.FTE_EVENT_TABLE !==
      table.PhysicalResourceId ||
    upcomingConfiguration?.Environment?.Variables?.FTE_EVENT_TABLE !==
      table.PhysicalResourceId ||
    upcomingConfiguration?.Environment?.Variables?.FTE_UPCOMING_QUEUE_URL !==
      upcomingQueue.PhysicalResourceId ||
    producerConfiguration?.Environment?.Variables?.FTE_UPCOMING_QUEUE_URL !==
      upcomingQueue.PhysicalResourceId ||
    liveConfiguration?.Environment?.Variables?.FTE_SHARP_API_ENABLED !==
      "true" ||
    ![
      liveConfiguration,
      projectionConfiguration,
      upcomingConfiguration,
      producerConfiguration,
    ].every(validTimeout) ||
    !boundedText(
      liveConfiguration?.Environment?.Variables?.FTE_SHARP_API_SECRET_ID,
      512,
    ) ||
    liveConfiguration?.Environment?.Variables?.FTE_SHARP_API_SECRET_ID !==
      "find-the-edge/dev/sharpapi" ||
    endpoint?.hostname.split(".")[0] !== api.PhysicalResourceId ||
    apiStage.PhysicalResourceId !== "dev" ||
    endpoint?.pathname !== "/dev"
  )
    throw new Error("reset-live-ingestion-binding-invalid");
  return {
    stackId: stack.StackId,
    tableName: table.PhysicalResourceId,
    writers: {
      live: {
        functionName: lambda.PhysicalResourceId,
        timeoutSeconds: liveConfiguration.Timeout,
      },
      projection: {
        functionName: projection.PhysicalResourceId,
        timeoutSeconds: projectionConfiguration.Timeout,
      },
      upcoming: {
        functionName: upcoming.PhysicalResourceId,
        timeoutSeconds: upcomingConfiguration.Timeout,
      },
      producer: {
        functionName: upcomingProducer.PhysicalResourceId,
        timeoutSeconds: producerConfiguration.Timeout,
      },
    },
    queues: {
      live: queue.PhysicalResourceId,
      upcoming: upcomingQueue.PhysicalResourceId,
    },
    rules: {
      live: scheduler.PhysicalResourceId,
      upcoming: upcomingRule.PhysicalResourceId,
    },
    mappings: {
      live: mapping.PhysicalResourceId,
      projection: projectionMapping.PhysicalResourceId,
      upcoming: upcomingMapping.PhysicalResourceId,
    },
    apiBase: outputs.EventsApiEndpoint,
  };
}

export function assertPointInTimeRecovery(value) {
  if (
    value?.ContinuousBackupsStatus !== "ENABLED" ||
    value?.PointInTimeRecoveryDescription?.PointInTimeRecoveryStatus !==
      "ENABLED"
  )
    throw new Error("reset-pitr-required");
}

export function backupName(now = new Date()) {
  const stamp = now.toISOString().replaceAll(/[-:.]/g, "");
  return `find-the-edge-dev-feed-reset-${stamp}`;
}

const waitWithChecks = async (milliseconds, delay, check) => {
  let remaining = milliseconds;
  while (remaining > 0) {
    check?.();
    const chunk = Math.min(2_000, remaining);
    await delay(chunk);
    remaining -= chunk;
  }
  check?.();
};

export async function waitForBackup(read, options = {}) {
  const attempts = options.attempts ?? 120;
  const delay =
    options.delay ??
    ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    options.check?.();
    const status = await read();
    if (status === "AVAILABLE") return;
    if (status !== "CREATING") throw new Error("reset-backup-unavailable");
    await waitWithChecks(5_000, delay, options.check);
  }
  throw new Error("reset-backup-timeout");
}

export async function deleteFeedBatches(keys, writeBatch, options = {}) {
  const delay =
    options.delay ??
    ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const maxAttempts = options.maxAttempts ?? 8;
  let deleted = 0;
  for (let offset = 0; offset < keys.length; offset += 25) {
    options.check?.();
    let pending = keys.slice(offset, offset + 25);
    for (let attempt = 0; pending.length > 0; attempt += 1) {
      options.check?.();
      if (attempt >= maxAttempts)
        throw new Error("reset-delete-retry-exhausted");
      const unprocessed = await writeBatch(pending);
      if (!Array.isArray(unprocessed) || unprocessed.length > pending.length)
        throw new Error("reset-delete-response-invalid");
      const submitted = new Set(pending.map(({ pk, sk }) => `${pk}\0${sk}`));
      const returned = new Set();
      for (const item of unprocessed) {
        const identity = `${item?.pk}\0${item?.sk}`;
        if (
          !boundedText(item?.pk) ||
          !boundedText(item?.sk) ||
          !submitted.has(identity) ||
          returned.has(identity)
        )
          throw new Error("reset-delete-response-key-invalid");
        returned.add(identity);
      }
      deleted += pending.length - unprocessed.length;
      pending = unprocessed;
      if (pending.length > 0)
        await waitWithChecks(
          Math.min(2_000, 50 * 2 ** attempt),
          delay,
          options.check,
        );
    }
  }
  return deleted;
}

export async function scanAllKeys(scanPage, options = {}) {
  const maxKeys = options.maxKeys ?? RESET_MAX_MANIFEST_KEYS;
  if (!Number.isSafeInteger(maxKeys) || maxKeys < 1)
    throw new Error("reset-scan-key-limit-invalid");
  const keys = [];
  let cursor;
  const seen = new Set();
  for (let page = 0; page < 100_000; page += 1) {
    options.check?.();
    const result = await scanPage(cursor);
    if (!result || !Array.isArray(result.keys))
      throw new Error("reset-scan-page-invalid");
    if (keys.length + result.keys.length > maxKeys)
      throw new Error("reset-manifest-key-limit");
    keys.push(...result.keys);
    if (result.cursor === undefined) return keys;
    const encoded = JSON.stringify(result.cursor);
    if (seen.has(encoded)) throw new Error("reset-scan-cursor-cycle");
    seen.add(encoded);
    cursor = result.cursor;
  }
  throw new Error("reset-scan-page-limit");
}

const easternDay = (instant) => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(instant);
  const value = (type) => parts.find((part) => part.type === type)?.value;
  return `${value("year")}-${value("month")}-${value("day")}`;
};

const validApiBase = (value) => {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.hostname.endsWith(".execute-api.us-east-1.amazonaws.com") &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
};

export function validateForcedIngestion(
  summary,
  enabledLeagues = RESET_ENABLED_LEAGUES,
) {
  if (!Array.isArray(summary))
    throw new Error("reset-ingestion-summary-invalid");
  if (
    !Array.isArray(enabledLeagues) ||
    enabledLeagues.length === 0 ||
    new Set(enabledLeagues).size !== enabledLeagues.length
  )
    throw new Error("reset-enabled-leagues-invalid");
  if (
    summary.length !== enabledLeagues.length ||
    summary.some(({ leagueKey }) => !enabledLeagues.includes(leagueKey))
  )
    throw new Error("reset-ingestion-league-set-invalid");
  const byLeague = new Map();
  for (const result of summary) {
    if (!enabledLeagues.includes(result?.leagueKey)) continue;
    if (byLeague.has(result.leagueKey))
      throw new Error("reset-ingestion-league-duplicate");
    byLeague.set(result.leagueKey, result);
  }
  for (const leagueKey of enabledLeagues) {
    const result = byLeague.get(leagueKey);
    if (
      result?.status !== "completed" ||
      result?.providerId !== "sharpapi" ||
      !Number.isSafeInteger(result?.pages) ||
      result.pages < 1 ||
      !Number.isSafeInteger(result?.quotaCost) ||
      result.quotaCost < 1
    )
      throw new Error("reset-enabled-league-ingestion-incomplete");
  }
  return {
    leagues: enabledLeagues.length,
    completed: enabledLeagues.length,
    pages: Object.fromEntries(
      enabledLeagues.map((leagueKey) => [
        leagueKey,
        byLeague.get(leagueKey).pages,
      ]),
    ),
  };
}

const validatePage = (page, withSplits) => {
  if (
    !page ||
    typeof page !== "object" ||
    !Array.isArray(page.items) ||
    page.projectionState !== "ready" ||
    !["complete", "partial"].includes(page.evaluationState) ||
    (page.nextCursor !== null && !boundedText(page.nextCursor, 4096)) ||
    page.items.some(
      (game) =>
        !boundedText(game?.id, 512) ||
        game?.sportKey !== "mlb" ||
        game?.leagueKey !== "mlb" ||
        game?.status !== "scheduled" ||
        !boundedText(game?.startsAt, 64) ||
        !Array.isArray(game?.participants) ||
        game.participants.length !== 2 ||
        game.participants.some(({ label }) => !boundedText(label, 256)) ||
        (withSplits && !Array.isArray(game?.splits)),
    )
  )
    throw new Error("reset-public-api-response-invalid");
  return page;
};

async function fetchApiPages(apiBase, endpoint, day, fetcher, check) {
  const items = [];
  let cursor;
  const seen = new Set();
  for (let pageNumber = 0; pageNumber < 100; pageNumber += 1) {
    check?.();
    const query = new URLSearchParams({
      sport: "mlb",
      league: "mlb",
      status: "scheduled",
      day,
      limit: "50",
      ...(cursor ? { cursor } : {}),
    });
    const response = await fetcher(`${apiBase}/${endpoint}?${query}`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
      cache: "no-store",
    });
    check?.();
    if (!response.ok) throw new Error("reset-public-api-unavailable");
    const text = await response.text();
    check?.();
    if (text.length > 2_000_000)
      throw new Error("reset-public-api-response-large");
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error("reset-public-api-response-invalid");
    }
    const page = validatePage(parsed, endpoint === "splits");
    items.push(...page.items);
    if (page.nextCursor === null) return items;
    if (seen.has(page.nextCursor))
      throw new Error("reset-public-api-cursor-cycle");
    seen.add(page.nextCursor);
    cursor = page.nextCursor;
  }
  throw new Error("reset-public-api-page-limit");
}

const freshTimestamp = (value, nowMs, maximumAgeMs) => {
  if (!ISO.test(value)) return false;
  const parsed = Date.parse(value);
  return (
    Number.isFinite(parsed) &&
    parsed <= nowMs + 5 * 60 * 1_000 &&
    parsed >= nowMs - maximumAgeMs
  );
};

export function validatePublicFeed(games, splitGames, day, now = new Date()) {
  if (games.length === 0) throw new Error("reset-current-games-unavailable");
  if (new Set(games.map(({ id }) => id)).size !== games.length)
    throw new Error("reset-duplicate-game-id");
  const matchupWindows = new Set();
  let oddsGames = 0;
  let oddsSelections = 0;
  const oddsGameIds = new Set();
  for (const game of games) {
    if (
      game.eastern?.calendarDay !== day ||
      easternDay(new Date(game.startsAt)) !== day
    )
      throw new Error("reset-game-outside-eastern-day");
    const matchup = game.participants
      .map(({ label }) =>
        label.normalize("NFKC").trim().toLowerCase().replaceAll(/\s+/g, " "),
      )
      .sort()
      .join("|");
    const fifteenMinuteWindow = Math.floor(Date.parse(game.startsAt) / 900_000);
    const identity = `${matchup}|${fifteenMinuteWindow}`;
    if (matchupWindows.has(identity))
      throw new Error("reset-duplicate-matchup");
    matchupWindows.add(identity);
    if (
      game.odds?.state === "available" &&
      Array.isArray(game.odds.selections)
    ) {
      const valid = game.odds.selections.filter(
        ({ sportsbookId, americanOdds, observedAt, retrievedAt }) =>
          boundedText(sportsbookId, 128) &&
          Number.isSafeInteger(americanOdds) &&
          Math.abs(americanOdds) >= 100 &&
          Math.abs(americanOdds) <= 100_000 &&
          freshTimestamp(observedAt, now.getTime(), 2 * 60 * 60 * 1_000) &&
          freshTimestamp(retrievedAt, now.getTime(), 2 * 60 * 60 * 1_000),
      ).length;
      if (valid > 0) {
        oddsGames += 1;
        oddsGameIds.add(game.id);
      }
      oddsSelections += valid;
    }
  }
  const gameIds = new Set(games.map(({ id }) => id));
  const splitGameIds = new Set(splitGames.map(({ id }) => id));
  if (
    splitGameIds.size !== splitGames.length ||
    splitGameIds.size !== gameIds.size ||
    [...gameIds].some((id) => !splitGameIds.has(id))
  )
    throw new Error("reset-split-game-mismatch");
  const splitObservationGameIds = new Set();
  const splitObservations = splitGames.reduce((total, game) => {
    if (!gameIds.has(game.id)) throw new Error("reset-split-game-mismatch");
    const valid = game.splits.filter(
      (split) =>
        split?.canonicalEventId === game.id &&
        split?.providerId === "sharpapi" &&
        freshTimestamp(
          split?.providerTimestamp,
          now.getTime(),
          24 * 60 * 60 * 1_000,
        ) &&
        freshTimestamp(
          split?.retrievedAt,
          now.getTime(),
          24 * 60 * 60 * 1_000,
        ) &&
        [split?.betPercent, split?.moneyPercent].every(
          (value) =>
            value === undefined ||
            (Number.isFinite(value) && value >= 0 && value <= 100),
        ) &&
        (Number.isFinite(split?.betPercent) ||
          Number.isFinite(split?.moneyPercent)),
    ).length;
    if (valid > 0) splitObservationGameIds.add(game.id);
    return total + valid;
  }, 0);
  if (oddsGames === 0 || oddsSelections === 0)
    throw new Error("reset-current-odds-unavailable");
  if (splitObservations === 0) throw new Error("reset-splits-unavailable");
  if (![...oddsGameIds].some((gameId) => splitObservationGameIds.has(gameId)))
    throw new Error("reset-complete-game-unavailable");
  return {
    day,
    games: games.length,
    oddsGames,
    oddsSelections,
    splitObservations,
  };
}

export async function verifyPublicFeed({
  apiBase,
  day,
  fetcher = fetch,
  now = () => new Date(),
  attempts = 12,
  delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  check,
}) {
  if (!validApiBase(apiBase) || !/^\d{4}-\d{2}-\d{2}$/.test(day))
    throw new Error("reset-public-api-target-invalid");
  let lastCode = "reset-public-api-unavailable";
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    check?.();
    try {
      const [games, splitGames] = await Promise.all([
        fetchApiPages(apiBase, "games", day, fetcher, check),
        fetchApiPages(apiBase, "splits", day, fetcher, check),
      ]);
      return validatePublicFeed(games, splitGames, day, now());
    } catch (error) {
      lastCode = safeErrorCode(error);
      if (attempt + 1 < attempts)
        await waitWithChecks(
          Math.min(30_000, 2_000 * 2 ** attempt),
          delay,
          check,
        );
    }
  }
  throw new Error(
    lastCode.startsWith("reset-")
      ? `reset-public-verification-exhausted:${lastCode}`
      : "reset-public-verification-exhausted",
  );
}

export async function executeReset(mode, operations) {
  if (!RESET_MODES.has(mode)) throw new Error("reset-mode-invalid");
  const containsAllPreserved = (expected, actual) => {
    const available = new Set(
      actual.preservedKeys.map(({ pk, sk }) => `${pk}\0${sk}`),
    );
    return expected.preservedKeys.every(({ pk, sk }) =>
      available.has(`${pk}\0${sk}`),
    );
  };
  let first;
  try {
    first = buildFeedManifest(await operations.scan());
    await operations.report(first, mode);
  } catch (error) {
    if (safeErrorCode(error) === "reset-operation-failed")
      throw new Error("reset-pre-mutation-failed");
    throw error;
  }
  if (mode === "dry-run") return { mode, manifest: first };
  let prior;
  let primaryError;
  try {
    prior = await operations.quiesce();
    const stable = buildFeedManifest(await operations.scan());
    if (
      stable.digest !== first.digest ||
      stable.deleteCount !== first.deleteCount ||
      !containsAllPreserved(first, stable)
    )
      throw new Error("reset-feed-changed-during-quiesce");
    await operations.requirePitr();
    const backup = await operations.backup();
    await operations.delete(stable.deleteKeys);
    const remaining = buildFeedManifest(await operations.scan());
    if (remaining.deleteCount !== 0) throw new Error("reset-feed-rows-remain");
    if (!containsAllPreserved(stable, remaining))
      throw new Error("reset-preserved-rows-changed");
    const ingestion = await operations.ingest(prior);
    const afterIngestion = buildFeedManifest(await operations.scan());
    if (!containsAllPreserved(stable, afterIngestion))
      throw new Error("reset-preserved-rows-changed");
    const verification = await operations.verify();
    return { mode, manifest: stable, backup, ingestion, verification };
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    if (prior !== undefined) {
      try {
        await operations.restore(prior);
      } catch {
        if (!primaryError) throw new Error("reset-restore-failed");
        throw new Error("reset-operation-and-restore-failed");
      }
    }
  }
}

const awsJson = (arguments_, environment, timeout) => {
  const output = run("aws", [...arguments_, "--output", "json"], {
    capture: true,
    env: environment,
    timeout: timeout ?? 60_000,
  });
  try {
    return JSON.parse(output || "{}");
  } catch {
    throw new Error("reset-aws-response-invalid");
  }
};

const describeTarget = (environment) => {
  const identity = awsJson(["sts", "get-caller-identity"], environment);
  validateAwsIdentity(identity);
  const described = awsJson(
    [
      "cloudformation",
      "describe-stacks",
      "--stack-name",
      RESET_STACK,
      "--region",
      RESET_REGION,
    ],
    environment,
  );
  const stack = described.Stacks?.[0];
  if (described.Stacks?.length !== 1)
    throw new Error("reset-stack-target-invalid");
  // The AWS CLI paginator follows every CloudFormation NextToken and returns
  // one merged summary. Do not use --no-paginate here; large stacks can exceed
  // one service page and hiding a resource would weaken the binding proof.
  const resources =
    awsJson(
      [
        "cloudformation",
        "list-stack-resources",
        "--stack-name",
        stack.StackId,
        "--region",
        RESET_REGION,
      ],
      environment,
    ).StackResourceSummaries ?? [];
  const outputs = Object.fromEntries(
    (stack.Outputs ?? []).map(({ OutputKey, OutputValue }) => [
      OutputKey,
      OutputValue,
    ]),
  );
  const lambdaConfigurations = [
    "LiveOddsIngestion",
    "FixtureOddsProjection",
    "UpcomingEventsWorker",
    "UpcomingEventsProducer",
  ].map((logicalPrefix) => {
    const functionName = oneResource(
      resources,
      "AWS::Lambda::Function",
      logicalPrefix,
    ).PhysicalResourceId;
    return awsJson(
      [
        "lambda",
        "get-function-configuration",
        "--function-name",
        functionName,
        "--region",
        RESET_REGION,
      ],
      environment,
    );
  });
  return validateResetTarget({
    stack,
    resources,
    outputs,
    lambdaConfigurations,
  });
};

const decodeDynamoKey = (item) => {
  if (
    !item ||
    Object.keys(item).sort().join("|") !== "pk|sk" ||
    !boundedText(item.pk?.S) ||
    !boundedText(item.sk?.S)
  )
    throw new Error("reset-scan-key-invalid");
  return { pk: item.pk.S, sk: item.sk.S };
};

const encodeDynamoKey = ({ pk, sk }) => ({ pk: { S: pk }, sk: { S: sk } });

const scanTarget = (target, environment, check) =>
  scanAllKeys(
    async (cursor) => {
      const page = awsJson(
        [
          "dynamodb",
          "scan",
          "--table-name",
          target.tableName,
          "--region",
          RESET_REGION,
          "--projection-expression",
          "#pk,#sk",
          "--expression-attribute-names",
          JSON.stringify({ "#pk": "pk", "#sk": "sk" }),
          "--consistent-read",
          "--no-paginate",
          ...(cursor ? ["--exclusive-start-key", JSON.stringify(cursor)] : []),
        ],
        environment,
      );
      return {
        keys: (page.Items ?? []).map(decodeDynamoKey),
        ...(page.LastEvaluatedKey ? { cursor: page.LastEvaluatedKey } : {}),
      };
    },
    { check },
  );

const queueAttributes = (queueUrl, environment, aws = awsJson) =>
  aws(
    [
      "sqs",
      "get-queue-attributes",
      "--queue-url",
      queueUrl,
      "--attribute-names",
      "QueueArn",
      "ApproximateNumberOfMessages",
      "ApproximateNumberOfMessagesNotVisible",
      "ApproximateNumberOfMessagesDelayed",
      "--region",
      RESET_REGION,
    ],
    environment,
  ).Attributes ?? {};

const waitUntil = async (
  read,
  done,
  code,
  attempts = 120,
  delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  check,
) => {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    check?.();
    if (done(await read())) return;
    await waitWithChecks(2_000, delay, check);
  }
  throw new Error(code);
};

export const resourceState = (target, environment, aws = awsJson, check) => {
  const queues = {};
  for (const [name, queueUrl] of Object.entries(target.queues)) {
    check?.();
    queues[name] = queueAttributes(queueUrl, environment, aws);
  }
  for (const queue of Object.values(queues))
    if (
      !queue.QueueArn?.startsWith(
        `arn:aws:sqs:${RESET_REGION}:${RESET_ACCOUNT}:`,
      )
    )
      throw new Error("reset-ingestion-source-binding-invalid");
  const ruleStates = {};
  for (const [name, ruleName] of Object.entries(target.rules)) {
    check?.();
    const rule = aws(
      ["events", "describe-rule", "--name", ruleName, "--region", RESET_REGION],
      environment,
    );
    check?.();
    const targets = aws(
      [
        "events",
        "list-targets-by-rule",
        "--rule",
        ruleName,
        "--region",
        RESET_REGION,
      ],
      environment,
    ).Targets;
    const expectedArn =
      name === "live"
        ? queues.live.QueueArn
        : `arn:aws:lambda:${RESET_REGION}:${RESET_ACCOUNT}:function:${target.writers.producer.functionName}`;
    if (
      !["ENABLED", "DISABLED"].includes(rule.State) ||
      !Array.isArray(targets) ||
      targets.length !== 1 ||
      targets[0]?.Arn !== expectedArn ||
      !boundedText(targets[0]?.Id, 128)
    )
      throw new Error("reset-ingestion-source-binding-invalid");
    ruleStates[name] = rule.State === "ENABLED";
  }
  const mappingStates = {};
  for (const [name, mappingId] of Object.entries(target.mappings)) {
    check?.();
    const mapping = aws(
      [
        "lambda",
        "get-event-source-mapping",
        "--uuid",
        mappingId,
        "--region",
        RESET_REGION,
      ],
      environment,
    );
    const expectedFunction = target.writers[name].functionName;
    const sourceMatches =
      name === "projection"
        ? mapping.EventSourceArn?.startsWith(
            `arn:aws:dynamodb:${RESET_REGION}:${RESET_ACCOUNT}:table/${target.tableName}/stream/`,
          )
        : mapping.EventSourceArn === queues[name].QueueArn;
    if (
      !["Enabled", "Disabled"].includes(mapping.State) ||
      mapping.FunctionArn?.split(":").at(-1) !== expectedFunction ||
      !sourceMatches
    )
      throw new Error("reset-ingestion-source-binding-invalid");
    mappingStates[name] = mapping.State === "Enabled";
  }
  const concurrency = {};
  for (const [name, writer] of Object.entries(target.writers)) {
    check?.();
    const value = aws(
      [
        "lambda",
        "get-function-concurrency",
        "--function-name",
        writer.functionName,
        "--region",
        RESET_REGION,
      ],
      environment,
    ).ReservedConcurrentExecutions;
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0))
      throw new Error("reset-ingestion-source-binding-invalid");
    concurrency[name] = value ?? null;
  }
  check?.();
  return {
    rules: ruleStates,
    mappings: mappingStates,
    concurrency,
  };
};

const retryBounded = async (
  action,
  code,
  attempts = 5,
  delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  check,
) => {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    check?.();
    try {
      return await action();
    } catch {
      check?.();
      if (attempt + 1 === attempts) throw new Error(code);
      await waitWithChecks(Math.min(2_000, 100 * 2 ** attempt), delay, check);
    }
  }
};

const setLambdaConcurrency = async (
  writer,
  environment,
  reservedConcurrency,
  dependencies = {},
) => {
  const aws = dependencies.aws ?? awsJson;
  const delay = dependencies.delay;
  await retryBounded(
    async () =>
      aws(
        [
          "lambda",
          reservedConcurrency === null
            ? "delete-function-concurrency"
            : "put-function-concurrency",
          "--function-name",
          writer.functionName,
          ...(reservedConcurrency === null
            ? []
            : [
                "--reserved-concurrent-executions",
                String(reservedConcurrency),
              ]),
          "--region",
          RESET_REGION,
        ],
        environment,
      ),
    "reset-lambda-concurrency-update-failed",
    5,
    delay,
    dependencies.check,
  );
  await waitUntil(
    async () =>
      aws(
        [
          "lambda",
          "get-function-concurrency",
          "--function-name",
          writer.functionName,
          "--region",
          RESET_REGION,
        ],
        environment,
      ).ReservedConcurrentExecutions ?? null,
    (value) => value === reservedConcurrency,
    "reset-lambda-concurrency-state-timeout",
    30,
    delay,
    dependencies.check,
  );
};

export const setResourceState = async (
  target,
  environment,
  state,
  dependencies = {},
) => {
  const aws = dependencies.aws ?? awsJson;
  const delay = dependencies.delay;
  // Restore writers first, then mappings, then producer rules last. This keeps
  // queues from feeding disabled functions and preserves every prior state.
  for (const [name, writer] of Object.entries(target.writers))
    await setLambdaConcurrency(
      writer,
      environment,
      state.concurrency[name],
      dependencies,
    );
  for (const [name, mappingId] of Object.entries(target.mappings)) {
    const enabled = state.mappings[name];
    await retryBounded(
      async () =>
        aws(
          [
            "lambda",
            "update-event-source-mapping",
            "--uuid",
            mappingId,
            enabled ? "--enabled" : "--no-enabled",
            "--region",
            RESET_REGION,
          ],
          environment,
        ),
      "reset-event-source-update-failed",
      5,
      delay,
      dependencies.check,
    );
    await waitUntil(
      async () =>
        aws(
          [
            "lambda",
            "get-event-source-mapping",
            "--uuid",
            mappingId,
            "--region",
            RESET_REGION,
          ],
          environment,
        ).State,
      (value) => value === (enabled ? "Enabled" : "Disabled"),
      "reset-event-source-state-timeout",
      60,
      delay,
      dependencies.check,
    );
  }
  for (const [name, ruleName] of Object.entries(target.rules)) {
    const enabled = state.rules[name];
    await retryBounded(
      async () =>
        aws(
          [
            "events",
            enabled ? "enable-rule" : "disable-rule",
            "--name",
            ruleName,
            "--region",
            RESET_REGION,
          ],
          environment,
        ),
      "reset-scheduler-update-failed",
      5,
      delay,
      dependencies.check,
    );
    await waitUntil(
      async () =>
        aws(
          [
            "events",
            "describe-rule",
            "--name",
            ruleName,
            "--region",
            RESET_REGION,
          ],
          environment,
        ).State,
      (value) => value === (enabled ? "ENABLED" : "DISABLED"),
      "reset-scheduler-state-timeout",
      60,
      delay,
      dependencies.check,
    );
  }
};

const purgeAndWaitForStableZero = async (
  queueUrl,
  environment,
  dependencies = {},
) => {
  const aws = dependencies.aws ?? awsJson;
  const delay = dependencies.delay;
  aws(
    ["sqs", "purge-queue", "--queue-url", queueUrl, "--region", RESET_REGION],
    environment,
  );
  // SQS documents purge as an operation that can take up to 60 seconds.
  // Writers are fenced, so waiting the full window proves no pre-purge
  // message can reappear when consumers are restored.
  await waitWithChecks(60_000, delay, dependencies.check);
  let consecutive = 0;
  await waitUntil(
    async () => queueAttributes(queueUrl, environment, aws),
    (attributes) => {
      const names = [
        "ApproximateNumberOfMessages",
        "ApproximateNumberOfMessagesNotVisible",
        "ApproximateNumberOfMessagesDelayed",
      ];
      if (!names.every((name) => /^\d+$/.test(attributes[name])))
        throw new Error("reset-queue-attributes-invalid");
      const zero = names.every((name) => Number(attributes[name]) === 0);
      consecutive = zero ? consecutive + 1 : 0;
      return consecutive >= 3;
    },
    "reset-queue-stable-zero-timeout",
    90,
    delay,
    dependencies.check,
  );
};

export const quiesceTarget = async (target, environment, dependencies = {}) => {
  const aws = dependencies.aws ?? awsJson;
  const delay =
    dependencies.delay ??
    ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  dependencies.check?.();
  const prior = resourceState(target, environment, aws, dependencies.check);
  if (prior.concurrency.live === 0)
    throw new Error("reset-lambda-prior-concurrency-zero");
  try {
    // Quiescence intentionally uses the reverse order from restore: stop new
    // producers, stop consumers, then fence every writer.
    for (const ruleName of Object.values(target.rules))
      await retryBounded(
        () =>
          aws(
            [
              "events",
              "disable-rule",
              "--name",
              ruleName,
              "--region",
              RESET_REGION,
            ],
            environment,
          ),
        "reset-scheduler-update-failed",
        5,
        dependencies.delay,
        dependencies.check,
      );
    dependencies.check?.();
    for (const ruleName of Object.values(target.rules))
      await waitUntil(
        async () =>
          aws(
            [
              "events",
              "describe-rule",
              "--name",
              ruleName,
              "--region",
              RESET_REGION,
            ],
            environment,
          ).State,
        (value) => value === "DISABLED",
        "reset-scheduler-state-timeout",
        60,
        dependencies.delay,
        dependencies.check,
      );
    await setLambdaConcurrency(
      target.writers.producer,
      environment,
      0,
      dependencies,
    );
    for (const mappingId of Object.values(target.mappings))
      await retryBounded(
        () =>
          aws(
            [
              "lambda",
              "update-event-source-mapping",
              "--uuid",
              mappingId,
              "--no-enabled",
              "--region",
              RESET_REGION,
            ],
            environment,
          ),
        "reset-event-source-update-failed",
        5,
        dependencies.delay,
        dependencies.check,
      );
    dependencies.check?.();
    for (const mappingId of Object.values(target.mappings))
      await waitUntil(
        async () =>
          aws(
            [
              "lambda",
              "get-event-source-mapping",
              "--uuid",
              mappingId,
              "--region",
              RESET_REGION,
            ],
            environment,
          ).State,
        (value) => value === "Disabled",
        "reset-event-source-state-timeout",
        60,
        dependencies.delay,
        dependencies.check,
      );
    for (const [name, writer] of Object.entries(target.writers))
      if (name !== "producer")
        await setLambdaConcurrency(writer, environment, 0, dependencies);
    const fenced = resourceState(target, environment, aws, dependencies.check);
    if (
      Object.values(fenced.rules).some(Boolean) ||
      Object.values(fenced.mappings).some(Boolean) ||
      Object.values(fenced.concurrency).some((value) => value !== 0)
    )
      throw new Error("reset-writer-fence-invalid");
    await waitWithChecks(
      Math.max(
        ...Object.values(target.writers).map(({ timeoutSeconds }) =>
          Number(timeoutSeconds),
        ),
      ) * 1_000,
      delay,
      dependencies.check,
    );
    for (const queueUrl of Object.values(target.queues))
      await purgeAndWaitForStableZero(queueUrl, environment, {
        ...dependencies,
        delay,
      });
    return prior;
  } catch {
    try {
      await setResourceState(target, environment, prior, {
        aws,
        delay: dependencies.delay,
      });
    } catch {
      throw new Error("reset-quiesce-and-restore-failed");
    }
    throw new Error("reset-quiesce-failed");
  }
};

export const requirePitr = (target, environment, aws = awsJson) => {
  const result = aws(
    [
      "dynamodb",
      "describe-continuous-backups",
      "--table-name",
      target.tableName,
      "--region",
      RESET_REGION,
    ],
    environment,
  );
  assertPointInTimeRecovery(result.ContinuousBackupsDescription);
};

export const createBackup = async (target, environment, dependencies = {}) => {
  const aws = dependencies.aws ?? awsJson;
  dependencies.check?.();
  const name = backupName(dependencies.now?.() ?? new Date());
  const result = aws(
    [
      "dynamodb",
      "create-backup",
      "--table-name",
      target.tableName,
      "--backup-name",
      name,
      "--region",
      RESET_REGION,
    ],
    environment,
  );
  const arn = result.BackupDetails?.BackupArn;
  if (
    !arn?.startsWith(
      `arn:aws:dynamodb:${RESET_REGION}:${RESET_ACCOUNT}:table/${target.tableName}/backup/`,
    )
  )
    throw new Error("reset-backup-target-invalid");
  await waitForBackup(
    async () => {
      const described = aws(
        [
          "dynamodb",
          "describe-backup",
          "--backup-arn",
          arn,
          "--region",
          RESET_REGION,
        ],
        environment,
      );
      return described.BackupDescription?.BackupDetails?.BackupStatus;
    },
    {
      ...(dependencies.attempts ? { attempts: dependencies.attempts } : {}),
      ...(dependencies.delay ? { delay: dependencies.delay } : {}),
      ...(dependencies.check ? { check: dependencies.check } : {}),
    },
  );
  process.stdout.write(
    `${JSON.stringify({ event: "phase1-feed-backup-available", name, arn })}\n`,
  );
  return { name, arn };
};

const deleteTargetKeys = (target, environment, keys, check) =>
  deleteFeedBatches(
    keys,
    async (pending) => {
      const request = {
        [target.tableName]: pending.map((key) => ({
          DeleteRequest: { Key: encodeDynamoKey(key) },
        })),
      };
      const result = awsJson(
        [
          "dynamodb",
          "batch-write-item",
          "--request-items",
          JSON.stringify(request),
          "--region",
          RESET_REGION,
        ],
        environment,
      );
      const unprocessed = result.UnprocessedItems?.[target.tableName] ?? [];
      return unprocessed.map((item) =>
        decodeDynamoKey(item.DeleteRequest?.Key),
      );
    },
    { check },
  );

const acquireMaintenanceLease = (target, environment) => {
  const token = randomUUID();
  const expiresAt = new Date(Date.now() + 20 * 60 * 1_000).toISOString();
  awsJson(
    [
      "dynamodb",
      "put-item",
      "--table-name",
      target.tableName,
      "--item",
      JSON.stringify({
        pk: { S: "ODDS_CONTROL#MAINTENANCE#feed-reset" },
        sk: { S: "CURRENT" },
        value: { M: { token: { S: token }, expiresAt: { S: expiresAt } } },
      }),
      "--condition-expression",
      "attribute_not_exists(#pk)",
      "--expression-attribute-names",
      JSON.stringify({ "#pk": "pk" }),
      "--region",
      RESET_REGION,
    ],
    environment,
  );
  return token;
};

const releaseMaintenanceLease = (target, environment, token) =>
  awsJson(
    [
      "dynamodb",
      "delete-item",
      "--table-name",
      target.tableName,
      "--key",
      JSON.stringify({
        pk: { S: "ODDS_CONTROL#MAINTENANCE#feed-reset" },
        sk: { S: "CURRENT" },
      }),
      "--condition-expression",
      "#value.#token = :token",
      "--expression-attribute-names",
      JSON.stringify({ "#value": "value", "#token": "token" }),
      "--expression-attribute-values",
      JSON.stringify({ ":token": { S: token } }),
      "--region",
      RESET_REGION,
    ],
    environment,
  );

const invokeIngestion = async (
  target,
  environment,
  prior,
  dependencies = {},
) => {
  if (prior.concurrency.live === 0)
    throw new Error("reset-lambda-prior-concurrency-zero");
  let directory;
  let maintenanceToken;
  let temporarilyUnfenced = false;
  let invocationError;
  try {
    dependencies.check?.();
    maintenanceToken = acquireMaintenanceLease(target, environment);
    temporarilyUnfenced = true;
    await setLambdaConcurrency(
      target.writers.live,
      environment,
      1,
      dependencies,
    );
    const invokeState = resourceState(
      target,
      environment,
      awsJson,
      dependencies.check,
    );
    if (
      Object.values(invokeState.rules).some(Boolean) ||
      Object.values(invokeState.mappings).some(Boolean) ||
      invokeState.concurrency.live !== 1 ||
      Object.entries(invokeState.concurrency).some(
        ([name, value]) => name !== "live" && value !== 0,
      )
    )
      throw new Error("reset-forced-invoke-fence-invalid");
    directory = await mkdtemp(`${tmpdir()}/fte-feed-reset-`);
    const responseFile = `${directory}/response.json`;
    dependencies.check?.();
    const invocation = awsJson(
      [
        "lambda",
        "invoke",
        "--function-name",
        target.writers.live.functionName,
        "--payload",
        JSON.stringify({ forceRefresh: true, maintenanceToken }),
        "--cli-binary-format",
        "raw-in-base64-out",
        "--cli-connect-timeout",
        "30",
        "--cli-read-timeout",
        String(target.writers.live.timeoutSeconds + 60),
        "--region",
        RESET_REGION,
        responseFile,
      ],
      environment,
      (target.writers.live.timeoutSeconds + 90) * 1_000,
    );
    dependencies.check?.();
    if (invocation.StatusCode !== 200 || invocation.FunctionError)
      throw new Error("reset-ingestion-invocation-failed");
    let summary;
    try {
      summary = JSON.parse(await readFile(responseFile, "utf8"));
    } catch {
      throw new Error("reset-ingestion-response-invalid");
    }
    return validateForcedIngestion(summary);
  } catch (error) {
    invocationError = error;
    throw error;
  } finally {
    let refenceFailed = false;
    let releaseFailed = false;
    let temporaryCleanupFailed = false;
    try {
      if (temporarilyUnfenced)
        await setLambdaConcurrency(target.writers.live, environment, 0);
    } catch {
      refenceFailed = true;
    }
    try {
      if (maintenanceToken)
        releaseMaintenanceLease(target, environment, maintenanceToken);
    } catch {
      releaseFailed = true;
    }
    try {
      if (directory) await rm(directory, { recursive: true, force: true });
    } catch {
      temporaryCleanupFailed = true;
    }
    if (refenceFailed || releaseFailed || temporaryCleanupFailed)
      throw new Error(
        invocationError
          ? "reset-ingestion-and-cleanup-failed"
          : "reset-ingestion-cleanup-failed",
      );
  }
};

export async function phase1ResetFeed(environment = process.env) {
  const { mode } = validateResetEnvironment(environment);
  const deadline =
    mode === "apply" ? Date.now() + 75 * 60 * 1_000 : Number.POSITIVE_INFINITY;
  let terminationRequested = false;
  const requestTermination = () => {
    terminationRequested = true;
  };
  process.once("SIGINT", requestTermination);
  process.once("SIGTERM", requestTermination);
  const check = (budgetMs = 0) => {
    if (terminationRequested) throw new Error("reset-termination-requested");
    if (Date.now() + budgetMs >= deadline)
      throw new Error("reset-operation-deadline");
  };
  const guarded =
    (budgetMs, operation) =>
    async (...arguments_) => {
      check(budgetMs);
      const value = await operation(...arguments_);
      check();
      return value;
    };
  let result;
  try {
    const target = describeTarget(environment);
    result = await executeReset(mode, {
      scan: () => scanTarget(target, environment, check),
      report: async (manifest, currentMode) => {
        process.stdout.write(
          `${JSON.stringify({
            event: "phase1-feed-reset-plan",
            mode: currentMode,
            target: {
              account: RESET_ACCOUNT,
              region: RESET_REGION,
              stack: RESET_STACK,
              table: target.tableName,
            },
            scanned: manifest.scanned,
            deleteCount: manifest.deleteCount,
            preserveCount: manifest.preserveCount,
            counts: manifest.counts,
            digest: manifest.digest,
            preserveDigest: manifest.preserveDigest,
          })}\n`,
        );
      },
      quiesce: guarded(10 * 60 * 1_000, () =>
        quiesceTarget(target, environment, { check }),
      ),
      requirePitr: guarded(3 * 60 * 1_000, async () =>
        requirePitr(target, environment),
      ),
      backup: guarded(12 * 60 * 1_000, () =>
        createBackup(target, environment, { check }),
      ),
      delete: (keys) => deleteTargetKeys(target, environment, keys, check),
      ingest: guarded(
        (target.writers.live.timeoutSeconds + 120) * 1_000,
        (prior) => invokeIngestion(target, environment, prior, { check }),
      ),
      verify: guarded(10 * 60 * 1_000, () =>
        verifyPublicFeed({
          apiBase: target.apiBase,
          day: easternDay(new Date()),
          check,
        }),
      ),
      restore: (prior) => setResourceState(target, environment, prior),
    });
  } finally {
    process.removeListener("SIGINT", requestTermination);
    process.removeListener("SIGTERM", requestTermination);
  }
  process.stdout.write(
    `${JSON.stringify({
      event: "phase1-feed-reset-complete",
      mode,
      ...(result.backup ? { backup: result.backup } : {}),
      ...(result.ingestion ? { ingestion: result.ingestion } : {}),
      ...(result.verification ? { verification: result.verification } : {}),
    })}\n`,
  );
  return result;
}

const invokedDirectly =
  process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly)
  phase1ResetFeed().catch((error) => {
    process.stderr.write(
      `${JSON.stringify({
        event: "phase1-feed-reset-failed",
        code: safeErrorCode(error),
      })}\n`,
    );
    process.exitCode = 1;
  });
