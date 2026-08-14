#!/usr/bin/env node

import { createHash, createHmac, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  access,
  link,
  open,
  readFile,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { pathToFileURL } from "node:url";

const BASE_URL = "https://api.sharpapi.io/api/v1";
const EXPECTED_AWS_ACCOUNT = "228246988391";
const DEFAULT_REGION = "us-east-1";
const DEFAULT_INTERVAL_SECONDS = 300;
const DEFAULT_POST_FINAL_MINUTES = 180;
const MAX_REQUESTS = 5_000;
const MAX_RESPONSE_BYTES = 10_000_000;
const MAX_ROWS = 50_000;
const MAX_DERIVED_OBSERVATIONS = 2_000_000;
const MAX_DERIVED_BYTES = 250_000_000;
export const GAME_STATE_MAX_EVIDENCE_BYTES = 500_000_000;
const MAX_LOCAL_INPUT_BYTES = 5_000_000;
const CLOCK_SKEW_TOLERANCE_MS = 60_000;
const GAME_STATE_FIELDS = Object.freeze([
  "away_score",
  "home_score",
  "game_clock",
  "in_play",
  "is_live",
  "is_final",
  "book_count",
  "consensus_at",
  "primary_book",
  "status",
  "period",
  "game_period",
  "possession",
  "possession_team",
  "provider_event_uuid",
  "scheduled_start",
  "start_time",
  "away_team",
  "home_team",
]);
const GAME_STATE_FIELD_SET = new Set(GAME_STATE_FIELDS);

export const GAME_STATE_ROUTES = Object.freeze(
  [
    {
      id: "aggregate",
      path: "/gamestate",
      sport: null,
      sourceSportKeys: Object.freeze([]),
    },
    {
      id: "baseball",
      path: "/gamestate/baseball",
      sport: "baseball",
      sourceSportKeys: Object.freeze(["mlb"]),
    },
    {
      id: "football",
      path: "/gamestate/football",
      sport: "football",
      sourceSportKeys: Object.freeze(["nfl"]),
    },
    {
      id: "soccer",
      path: "/gamestate/soccer",
      sport: "soccer",
      sourceSportKeys: Object.freeze([
        "mls",
        "epl",
        "liga-mx",
        "uefa-champions-league",
      ]),
    },
  ].map(Object.freeze),
);

const ROUTE_SPORTS = new Set(
  GAME_STATE_ROUTES.map(({ sport }) => sport).filter(Boolean),
);
const SAFE_ERROR_CODES = new Set([
  "configuration",
  "invalid-response",
  "not-entitled",
  "provider-rejected",
  "provider-request-ambiguous",
  "provider-unavailable",
  "rate-limited",
  "request-budget-exhausted",
  "unauthorized",
]);

class GameStateSpikeError extends Error {
  constructor(code, attemptCount) {
    super(code);
    this.name = "GameStateSpikeError";
    this.code = code;
    if (integer(attemptCount, 0, MAX_REQUESTS))
      this.attemptCount = attemptCount;
  }
}

const record = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value
    : undefined;

const canonical = (value, maximum = 256) =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= maximum &&
  value === value.trim();

const integer = (value, minimum, maximum) =>
  Number.isSafeInteger(value) && value >= minimum && value <= maximum;

const parseInteger = (name, value, minimum, maximum) => {
  if (!/^\d+$/.test(value ?? "")) throw new Error(`invalid-${name}`);
  const parsed = Number(value);
  if (!integer(parsed, minimum, maximum)) throw new Error(`invalid-${name}`);
  return parsed;
};

const canonicalJson = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (record(value))
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
};

const sha256 = (value) =>
  createHash("sha256").update(value, "utf8").digest("hex");

const hmac = (key, value) =>
  createHmac("sha256", key).update(value, "utf8").digest("hex");

const typeShape = (value) => {
  if (value === null) return "null";
  if (Array.isArray(value))
    return {
      array: [
        ...new Set(value.map((item) => canonicalJson(typeShape(item)))),
      ].sort(),
    };
  if (record(value))
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key.slice(0, 128), typeShape(value[key])]),
    );
  if (typeof value === "number")
    return Number.isInteger(value) ? "integer" : "number";
  return typeof value;
};

const observedType = (value) => {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (record(value)) return "object";
  if (typeof value === "number")
    return Number.isInteger(value) ? "integer" : "number";
  return typeof value;
};

export const buildSchemaHash = (value) =>
  sha256(canonicalJson(typeShape(value)));

export const buildStateHash = (value) => sha256(canonicalJson(value));

export const safeSpikeError = (error) => ({
  code:
    record(error) &&
    typeof error.code === "string" &&
    SAFE_ERROR_CODES.has(error.code)
      ? error.code
      : "unknown",
  ...(record(error) && integer(error.attemptCount, 0, MAX_REQUESTS)
    ? { attemptCount: error.attemptCount }
    : {}),
  ...(record(error?.rateMetadata) &&
  (Object.keys(error.rateMetadata.rateWindow ?? {}).length > 0 ||
    error.rateMetadata.retryAt)
    ? { rateMetadata: error.rateMetadata }
    : {}),
});

export const parseSharpApiSecret = (value) => {
  if (!canonical(value, 512)) throw new Error("provider-api-secret-invalid");
  if (value.startsWith("{")) {
    let parsed;
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new Error("provider-api-secret-invalid");
    }
    if (
      !record(parsed) ||
      Object.keys(parsed).length !== 1 ||
      !canonical(parsed.apiKey, 512)
    )
      throw new Error("provider-api-secret-invalid");
    return parsed.apiKey;
  }
  return value;
};

export const validateRequestBudget = ({
  mode,
  intervalSeconds,
  durationMinutes,
  postFinalMinutes = 0,
  maxRequests,
}) => {
  if (!integer(intervalSeconds, 30, 3_600))
    throw new Error("invalid-interval-seconds");
  if (!integer(maxRequests, 1, MAX_REQUESTS))
    throw new Error("request-budget-exceeds-limit");
  let ticks;
  if (mode === "preflight") {
    if (durationMinutes !== 0) throw new Error("invalid-duration-minutes");
    if (postFinalMinutes !== 0) throw new Error("invalid-post-final-minutes");
    ticks = 1;
  } else if (mode === "sample") {
    if (!integer(durationMinutes, 1, 2_160))
      throw new Error("invalid-duration-minutes");
    if (!integer(postFinalMinutes, 0, 10_080))
      throw new Error("invalid-post-final-minutes");
    ticks =
      Math.floor(
        ((durationMinutes + postFinalMinutes) * 60) / intervalSeconds,
      ) + 1;
  } else {
    throw new Error("invalid-mode");
  }
  const plannedRequests = ticks * GAME_STATE_ROUTES.length;
  if (plannedRequests > MAX_REQUESTS)
    throw new Error("request-budget-exceeds-limit");
  if (maxRequests < plannedRequests)
    throw new Error("request-budget-too-small");
  return { ticks, plannedRequests };
};

export const parseCliArgs = (argv) => {
  const args = argv[0] === "--" ? argv.slice(1) : argv;
  const allowed = new Set([
    "stage",
    "mode",
    "output",
    "max-requests",
    "region",
    "interval-seconds",
    "duration-minutes",
    "post-final-minutes",
    "fixture",
    "manifest",
    "truth-sidecar",
    "rate-reserve",
  ]);
  const values = {};
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    const key = option.startsWith("--") ? option.slice(2) : "";
    const value = args[index + 1];
    if (
      option === "--" ||
      !allowed.has(key) ||
      values[key] !== undefined ||
      !value?.length ||
      value.startsWith("--")
    )
      throw new Error(`invalid-argument:${option}`);
    values[key] = value;
    index += 1;
  }
  for (const key of ["stage", "mode", "output", "max-requests"])
    if (!values[key]) throw new Error(`missing-argument:--${key}`);
  if (!new Set(["staging", "prod"]).has(values.stage))
    throw new Error("invalid-stage");
  if (!new Set(["preflight", "sample"]).has(values.mode))
    throw new Error("invalid-mode");
  if (!canonical(values.output, 4_096) || values.output === "-")
    throw new Error("invalid-output");
  const region = values.region ?? DEFAULT_REGION;
  if (region !== DEFAULT_REGION) throw new Error("invalid-region");
  const intervalSeconds = values["interval-seconds"]
    ? parseInteger("interval-seconds", values["interval-seconds"], 30, 3_600)
    : DEFAULT_INTERVAL_SECONDS;
  const durationMinutes = values["duration-minutes"]
    ? parseInteger("duration-minutes", values["duration-minutes"], 0, 2_160)
    : values.mode === "preflight"
      ? 0
      : 60;
  const postFinalMinutes = values["post-final-minutes"]
    ? parseInteger(
        "post-final-minutes",
        values["post-final-minutes"],
        0,
        10_080,
      )
    : values.mode === "preflight"
      ? 0
      : DEFAULT_POST_FINAL_MINUTES;
  const rateReserve = values["rate-reserve"]
    ? parseInteger("rate-reserve", values["rate-reserve"], 1, 1_000)
    : GAME_STATE_ROUTES.length;
  const maxRequests = parseInteger(
    "max-requests",
    values["max-requests"],
    1,
    MAX_REQUESTS,
  );
  const budget = validateRequestBudget({
    mode: values.mode,
    intervalSeconds,
    durationMinutes,
    postFinalMinutes,
    maxRequests,
  });
  if (values.fixture && !canonical(values.fixture, 4_096))
    throw new Error("invalid-fixture");
  if (values.manifest && !canonical(values.manifest, 4_096))
    throw new Error("invalid-manifest");
  if (values["truth-sidecar"] && !canonical(values["truth-sidecar"], 4_096))
    throw new Error("invalid-truth-sidecar");
  if (values.mode === "sample" && !values.manifest)
    throw new Error("missing-argument:--manifest");
  if (values.mode === "sample" && !values["truth-sidecar"])
    throw new Error("missing-argument:--truth-sidecar");
  if (values.mode === "preflight" && values["truth-sidecar"])
    throw new Error("invalid-truth-sidecar-mode");
  if (
    values.fixture &&
    (values.mode !== "preflight" || values.stage !== "staging")
  )
    throw new Error("invalid-fixture-mode");
  return {
    stage: values.stage,
    mode: values.mode,
    output: values.output,
    region,
    intervalSeconds,
    durationMinutes,
    postFinalMinutes,
    rateReserve,
    maxRequests,
    ...(values.fixture ? { fixture: values.fixture } : {}),
    ...(values.manifest ? { manifest: values.manifest } : {}),
    ...(values["truth-sidecar"]
      ? { truthSidecar: values["truth-sidecar"] }
      : {}),
    ...budget,
  };
};

const boundedHeaderInteger = (value) => {
  if (!/^\d{1,16}$/.test(value ?? "")) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
};

const isoFromMilliseconds = (value) => {
  if (!Number.isFinite(value) || Math.abs(value) > 8_640_000_000_000_000)
    return undefined;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
};

const parseResponseMetadata = (headers, now) => {
  const limit = boundedHeaderInteger(
    headers.get("x-ratelimit-limit") ?? headers.get("ratelimit-limit"),
  );
  const remaining = boundedHeaderInteger(
    headers.get("x-ratelimit-remaining") ?? headers.get("ratelimit-remaining"),
  );
  const rawReset =
    headers.get("x-ratelimit-reset") ?? headers.get("ratelimit-reset");
  const resetNumber = boundedHeaderInteger(rawReset);
  const resetMs =
    resetNumber === undefined
      ? rawReset
        ? Date.parse(rawReset)
        : Number.NaN
      : resetNumber > 10_000_000_000
        ? resetNumber
        : resetNumber > now.getTime() / 2_000
          ? resetNumber * 1_000
          : now.getTime() + resetNumber * 1_000;
  const rawRetry = headers.get("retry-after");
  const retrySeconds = boundedHeaderInteger(rawRetry);
  const retryMs =
    retrySeconds !== undefined
      ? now.getTime() + retrySeconds * 1_000
      : rawRetry
        ? Date.parse(rawRetry)
        : Number.NaN;
  const resetsAt = isoFromMilliseconds(resetMs);
  const retryAt = isoFromMilliseconds(retryMs);
  return {
    rateWindow: {
      ...(limit === undefined ? {} : { limit }),
      ...(remaining === undefined ? {} : { remaining }),
      ...(resetsAt ? { resetsAt } : {}),
    },
    ...(retryAt ? { retryAt } : {}),
  };
};

const boundedJson = async (providerResponse, maxResponseBytes) => {
  const declared = Number(providerResponse.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxResponseBytes)
    throw new GameStateSpikeError("invalid-response");
  if (!providerResponse.body) throw new GameStateSpikeError("invalid-response");
  const reader = providerResponse.body.getReader();
  const decoder = new TextDecoder();
  let raw = "";
  let byteLength = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    byteLength += value.byteLength;
    if (byteLength > maxResponseBytes) {
      await reader.cancel();
      throw new GameStateSpikeError("invalid-response");
    }
    raw += decoder.decode(value, { stream: true });
  }
  raw += decoder.decode();
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    throw new GameStateSpikeError("invalid-response");
  }
  return { payload, byteLength };
};

export const fetchGameStateRoute = async ({
  route,
  apiKey,
  fetcher = fetch,
  now = () => new Date(),
  maxResponseBytes = MAX_RESPONSE_BYTES,
}) => {
  if (!GAME_STATE_ROUTES.includes(route) || !canonical(apiKey, 512))
    throw new GameStateSpikeError("configuration");
  const requestStartedAt = now().toISOString();
  let providerResponse;
  try {
    providerResponse = await fetcher(`${BASE_URL}${route.path}`, {
      method: "GET",
      headers: { accept: "application/json", "X-API-Key": apiKey },
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    if (error instanceof GameStateSpikeError) throw error;
    throw new GameStateSpikeError("provider-request-ambiguous");
  }
  if (!providerResponse.ok) {
    const code =
      providerResponse.status === 401
        ? "unauthorized"
        : providerResponse.status === 403
          ? "not-entitled"
          : providerResponse.status === 429
            ? "rate-limited"
            : providerResponse.status >= 500
              ? "provider-unavailable"
              : "provider-rejected";
    const error = new GameStateSpikeError(code);
    error.rateMetadata = parseResponseMetadata(providerResponse.headers, now());
    throw error;
  }
  const { payload, byteLength } = await boundedJson(
    providerResponse,
    maxResponseBytes,
  );
  const retrievedAt = now().toISOString();
  const envelope = record(payload);
  if (
    !envelope ||
    envelope.success === false ||
    (envelope.error !== undefined && envelope.error !== null)
  )
    throw new GameStateSpikeError("invalid-response");
  const wrappedData = record(envelope.data);
  if (
    wrappedData &&
    Object.keys(envelope).some(
      (key) => !new Set(["data", "updated_at"]).has(key),
    )
  )
    throw new GameStateSpikeError("invalid-response");
  return {
    payload: wrappedData ?? payload,
    providerEnvelopeUpdatedAt: normalizeInstant(envelope.updated_at),
    requestStartedAt,
    retrievedAt,
    latencyMs: Math.max(
      0,
      Date.parse(retrievedAt) - Date.parse(requestStartedAt),
    ),
    byteLength,
    metadata: parseResponseMetadata(
      providerResponse.headers,
      new Date(retrievedAt),
    ),
  };
};

const normalizeScore = (value) =>
  value === null || value === undefined
    ? null
    : typeof value === "number" &&
        Number.isFinite(value) &&
        value >= -999 &&
        value <= 999
      ? value
      : null;

const normalizeClock = (value) =>
  canonical(value, 64)
    ? value
    : typeof value === "number" && Number.isFinite(value)
      ? value
      : null;

const normalizePeriod = (value) => {
  if (typeof value === "number" && integer(value, 0, 100)) return value;
  return canonical(value, 32) && /^[a-z0-9 ._/-]+$/i.test(value) ? value : null;
};

const normalizePossession = (value, hashKey) => {
  if (typeof value === "boolean") return { kind: "boolean", value };
  if (canonical(value, 128))
    return { kind: "opaque-value", valueHash: hmac(hashKey, value) };
  if (value === null || value === undefined) return { kind: "unavailable" };
  return { kind: "invalid" };
};

const normalizeBooleanEvidence = (value) => {
  if (typeof value === "boolean")
    return {
      value,
      evidence: {
        kind: "consensus-boolean",
        disagreement: "not-exposed",
      },
    };
  const constituents = record(value);
  if (!constituents)
    return {
      value: null,
      evidence: {
        kind: value === null || value === undefined ? "unavailable" : "invalid",
        disagreement: "unmeasurable",
      },
    };
  const values = Object.values(constituents);
  if (values.length > 100)
    return {
      value: null,
      evidence: { kind: "invalid", disagreement: "unmeasurable" },
    };
  const trueCount = values.filter((item) => item === true).length;
  const falseCount = values.filter((item) => item === false).length;
  const nullCount = values.filter(
    (item) => item === null || item === undefined,
  ).length;
  const invalidCount = values.length - trueCount - falseCount - nullCount;
  return {
    value: null,
    evidence: {
      kind: "constituent-map",
      constituentCount: values.length,
      trueCount,
      falseCount,
      nullCount,
      invalidCount,
      disagreement:
        trueCount > 0 && falseCount > 0
          ? "observed"
          : trueCount + falseCount > 0
            ? "not-observed"
            : "unmeasurable",
    },
  };
};

const TERMINAL_CLOCKS = new Set(["FINAL", "FINAL/OT", "FT", "AET"]);

const terminalClockSignal = (clock) =>
  typeof clock === "string" && TERMINAL_CLOCKS.has(clock.toUpperCase())
    ? clock.toUpperCase()
    : null;

const normalizeInstant = (value) =>
  canonical(value, 40) && Number.isFinite(Date.parse(value))
    ? new Date(value).toISOString()
    : Number.isFinite(value) && value >= 1_000_000_000
      ? (isoFromMilliseconds(value > 10_000_000_000 ? value : value * 1_000) ??
        null)
      : null;

const normalizeStatus = (value) => {
  if (!canonical(value, 48)) return "unknown";
  const normalized = value
    .toLowerCase()
    .replaceAll("-", "_")
    .replaceAll(" ", "_");
  return new Set([
    "scheduled",
    "pregame",
    "pre_game",
    "not_started",
    "in_progress",
    "live",
    "halftime",
    "break",
    "delayed",
    "postponed",
    "suspended",
    "final",
    "completed",
    "finished",
    "cancelled",
    "canceled",
  ]).has(normalized)
    ? normalized
    : "unknown";
};

const phaseOf = ({ status, isFinal, inPlay, isLive }) => {
  if (
    isFinal === true ||
    new Set(["final", "completed", "finished"]).has(status)
  )
    return "final";
  if (new Set(["delayed", "postponed", "suspended"]).has(status))
    return "delayed";
  if (new Set(["halftime", "break"]).has(status)) return "break";
  if (
    inPlay === true ||
    isLive === true ||
    status === "in_progress" ||
    status === "live"
  )
    return "live";
  if (new Set(["scheduled", "pregame", "pre_game", "not_started"]).has(status))
    return "pregame";
  return "unknown";
};

const signalConflicts = ({ status, isFinal, inPlay, isLive, gameClock }) => {
  const conflicts = [];
  const live = inPlay === true || isLive === true;
  const statusFinal = new Set(["final", "completed", "finished"]).has(status);
  const terminalClock = terminalClockSignal(gameClock) !== null;
  if (inPlay !== null && isLive !== null && inPlay !== isLive)
    conflicts.push("live-flags-disagree");
  if (
    live &&
    (isFinal === true ||
      new Set([
        "final",
        "completed",
        "finished",
        "delayed",
        "postponed",
        "suspended",
        "halftime",
        "break",
      ]).has(status))
  )
    conflicts.push("status-live-conflict");
  if (
    (statusFinal && isFinal === false) ||
    (isFinal === true &&
      new Set([
        "scheduled",
        "pregame",
        "pre_game",
        "not_started",
        "in_progress",
        "live",
      ]).has(status))
  )
    conflicts.push("final-signals-disagree");
  if (terminalClock && live) conflicts.push("terminal-clock-live-conflict");
  if (terminalClock && isFinal === false)
    conflicts.push("terminal-clock-final-conflict");
  return conflicts;
};

export const normalizeIdentityManifest = (value) => {
  const manifest = record(value);
  const identitySource = record(manifest?.identitySource);
  if (
    manifest?.schemaVersion !== "game-state-spike-manifest-v1" ||
    Object.keys(manifest).some(
      (key) =>
        !new Set(["schemaVersion", "frozenAt", "identitySource", "events"]).has(
          key,
        ),
    ) ||
    !normalizeInstant(manifest?.frozenAt) ||
    !new Set([
      "official-scoreboard",
      "official-broadcast",
      "manual-official",
    ]).has(identitySource?.kind) ||
    Object.keys(identitySource).some(
      (key) => !new Set(["kind", "referenceHash"]).has(key),
    ) ||
    typeof identitySource?.referenceHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(identitySource.referenceHash) ||
    !Array.isArray(manifest?.events) ||
    manifest.events.length === 0 ||
    manifest.events.length > 500
  )
    throw new Error("invalid-manifest");
  const canonicalIds = new Set();
  const events = manifest.events.map((entry) => {
    const event = record(entry);
    if (
      !event ||
      Object.keys(event).some(
        (key) =>
          !new Set([
            "canonicalEventId",
            "sport",
            "providerEventId",
            "providerEventUuid",
            "participantIdentityHash",
            "scheduledStart",
          ]).has(key),
      ) ||
      !canonical(event.canonicalEventId, 256) ||
      !ROUTE_SPORTS.has(event.sport) ||
      !canonical(event.providerEventId, 512) ||
      !normalizeInstant(event.scheduledStart) ||
      (event.providerEventUuid !== undefined &&
        !canonical(event.providerEventUuid, 512)) ||
      (event.participantIdentityHash !== undefined &&
        (typeof event.participantIdentityHash !== "string" ||
          !/^[a-f0-9]{64}$/.test(event.participantIdentityHash)))
    )
      throw new Error("invalid-manifest");
    if (canonicalIds.has(event.canonicalEventId))
      throw new Error("invalid-manifest");
    canonicalIds.add(event.canonicalEventId);
    return {
      canonicalEventId: event.canonicalEventId,
      sport: event.sport,
      providerEventId: event.providerEventId,
      scheduledStart: normalizeInstant(event.scheduledStart),
      ...(canonical(event.providerEventUuid, 512)
        ? { providerEventUuid: event.providerEventUuid }
        : {}),
      ...(typeof event.participantIdentityHash === "string" &&
      /^[a-f0-9]{64}$/.test(event.participantIdentityHash)
        ? { participantIdentityHash: event.participantIdentityHash }
        : {}),
    };
  });
  return {
    schemaVersion: "game-state-spike-manifest-v1",
    frozenAt: normalizeInstant(manifest.frozenAt),
    identitySource: {
      kind: identitySource.kind,
      referenceHash: identitySource.referenceHash,
    },
    events,
  };
};

export const normalizeTruthProtocolHeader = (value) => {
  const header = record(value);
  const source = record(header?.source);
  if (
    !header ||
    Object.keys(header).some(
      (key) =>
        !new Set([
          "schemaVersion",
          "kind",
          "frozenAt",
          "manifestInputHash",
          "source",
          "comparisonToleranceSeconds",
        ]).has(key),
    ) ||
    header.schemaVersion !== "game-state-spike-truth-v1" ||
    header.kind !== "header" ||
    !normalizeInstant(header.frozenAt) ||
    typeof header.manifestInputHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(header.manifestInputHash) ||
    !source ||
    Object.keys(source).some(
      (key) => !new Set(["kind", "referenceHash"]).has(key),
    ) ||
    !new Set([
      "official-scoreboard",
      "official-broadcast",
      "manual-official",
    ]).has(source.kind) ||
    typeof source.referenceHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(source.referenceHash) ||
    !integer(header.comparisonToleranceSeconds, 0, 900)
  )
    throw new Error("invalid-truth-header");
  return {
    schemaVersion: "game-state-spike-truth-v1",
    kind: "header",
    frozenAt: normalizeInstant(header.frozenAt),
    manifestInputHash: header.manifestInputHash,
    source: {
      kind: source.kind,
      referenceHash: source.referenceHash,
    },
    comparisonToleranceSeconds: header.comparisonToleranceSeconds,
  };
};

export const mapGameStateIdentity = (
  manifest,
  sport,
  providerEventId,
  observed = {},
) => {
  if (!manifest) return { kind: "unmapped" };
  const mismatchReasons = (event) => {
    const reasons = [];
    if (
      event.providerEventUuid &&
      observed.providerEventUuid &&
      event.providerEventUuid !== observed.providerEventUuid
    )
      reasons.push("provider-uuid-mismatch");
    if (
      event.participantIdentityHash &&
      observed.participantIdentityHash &&
      event.participantIdentityHash !== observed.participantIdentityHash
    )
      reasons.push("participant-orientation-mismatch");
    if (
      observed.scheduledStart &&
      Math.abs(
        Date.parse(event.scheduledStart) - Date.parse(observed.scheduledStart),
      ) >
        15 * 60 * 1_000
    )
      reasons.push("start-time-mismatch");
    return reasons;
  };
  const direct = manifest.events.filter(
    (event) =>
      event.sport === sport && event.providerEventId === providerEventId,
  );
  if (direct.length > 1) return { kind: "ambiguous" };
  if (direct.length === 1) {
    const [match] = direct;
    const reasons = mismatchReasons(match);
    if (reasons.length > 0) return { kind: "identity-mismatch", reasons };
    return {
      kind: "exact-provider-id",
      canonicalEventId: match.canonicalEventId,
    };
  }
  const aliases = manifest.events.filter(
    (event) =>
      event.sport === sport &&
      ((event.providerEventUuid &&
        observed.providerEventUuid === event.providerEventUuid) ||
        (event.participantIdentityHash &&
          observed.participantIdentityHash === event.participantIdentityHash &&
          observed.scheduledStart &&
          Math.abs(
            Date.parse(event.scheduledStart) -
              Date.parse(observed.scheduledStart),
          ) <=
            15 * 60 * 1_000)),
  );
  if (aliases.length > 1) return { kind: "ambiguous" };
  if (aliases.length === 0) return { kind: "unmapped" };
  const [alias] = aliases;
  const reasons = mismatchReasons(alias);
  if (reasons.length > 0) return { kind: "identity-mismatch", reasons };
  return {
    kind:
      alias.providerEventUuid === observed.providerEventUuid
        ? "exact-provider-uuid"
        : "participant-start-only",
    canonicalEventId: alias.canonicalEventId,
  };
};

const participantIdentityHash = (raw) => {
  if (!canonical(raw.away_team, 256) || !canonical(raw.home_team, 256))
    return undefined;
  return sha256(
    canonicalJson([raw.away_team.toLowerCase(), raw.home_team.toLowerCase()]),
  );
};

const normalizeState = (raw, retrievedAt, hashKey) => {
  const status = normalizeStatus(raw.status);
  const consensusAt = normalizeInstant(raw.consensus_at);
  const inPlay = normalizeBooleanEvidence(raw.in_play);
  const semantic = {
    awayScore: normalizeScore(raw.away_score),
    homeScore: normalizeScore(raw.home_score),
    gameClock: normalizeClock(raw.game_clock),
    period: normalizePeriod(raw.period ?? raw.game_period),
    possession: normalizePossession(
      raw.possession ?? raw.possession_team,
      hashKey,
    ),
    inPlay: inPlay.value,
    inPlayEvidence: inPlay.evidence,
    isLive: typeof raw.is_live === "boolean" ? raw.is_live : null,
    isFinal: typeof raw.is_final === "boolean" ? raw.is_final : null,
    status,
  };
  const bookCount = integer(raw.book_count, 0, 1_000) ? raw.book_count : null;
  const lagMs =
    consensusAt === null
      ? null
      : Date.parse(retrievedAt) - Date.parse(consensusAt);
  return {
    ...semantic,
    bookCount,
    consensusAt,
    phase: phaseOf(semantic),
    terminalSignal: terminalClockSignal(semantic.gameClock),
    signalConflicts: signalConflicts(semantic),
    lagMs,
    lagClassification:
      lagMs === null
        ? "unavailable"
        : lagMs < -CLOCK_SKEW_TOLERANCE_MS
          ? "provider-time-future"
          : lagMs < 0
            ? "within-clock-skew"
            : "observed",
    stateHash: buildStateHash(semantic),
    observationHash: buildStateHash({ semantic, bookCount, consensusAt }),
  };
};

const stateRows = ({ route, payload }) => {
  const root = record(payload);
  if (!root) throw new GameStateSpikeError("invalid-response");
  const rows = [];
  if (route.sport === null) {
    for (const [rawSport, bucketValue] of Object.entries(root)) {
      const bucket = record(bucketValue);
      if (!bucket) throw new GameStateSpikeError("invalid-response");
      const sport = ROUTE_SPORTS.has(rawSport) ? rawSport : "off-roster";
      for (const [eventId, rawState] of Object.entries(bucket))
        rows.push({ sport, identitySport: rawSport, eventId, rawState });
    }
  } else {
    const bucket = record(root[route.sport]) ?? root;
    for (const [eventId, rawState] of Object.entries(bucket))
      rows.push({
        sport: route.sport,
        identitySport: route.sport,
        eventId,
        rawState,
      });
  }
  if (rows.length > MAX_ROWS) throw new GameStateSpikeError("invalid-response");
  return rows;
};

export const normalizeGameStatePayload = ({
  route,
  payload,
  retrievedAt,
  byteLength,
  hashKey,
  identityManifest,
}) => {
  if (
    !GAME_STATE_ROUTES.includes(route) ||
    !normalizeInstant(retrievedAt) ||
    !integer(byteLength, 0, MAX_RESPONSE_BYTES) ||
    !canonical(hashKey, 512)
  )
    throw new GameStateSpikeError("configuration");
  const rows = stateRows({ route, payload });
  const observations = rows.map(
    ({ sport, identitySport, eventId, rawState }) => {
      if (
        !canonical(eventId, 512) ||
        !record(rawState) ||
        !GAME_STATE_FIELDS.some((field) =>
          Object.prototype.hasOwnProperty.call(rawState, field),
        )
      )
        throw new GameStateSpikeError("invalid-response");
      const normalized = normalizeState(rawState, retrievedAt, hashKey);
      const identitySignals = {
        ...(canonical(rawState.provider_event_uuid, 512)
          ? { providerEventUuid: rawState.provider_event_uuid }
          : {}),
        ...(normalizeInstant(rawState.scheduled_start ?? rawState.start_time)
          ? {
              scheduledStart: normalizeInstant(
                rawState.scheduled_start ?? rawState.start_time,
              ),
            }
          : {}),
        ...(participantIdentityHash(rawState)
          ? { participantIdentityHash: participantIdentityHash(rawState) }
          : {}),
      };
      return {
        sport,
        eventHash: hmac(hashKey, `${identitySport}\0${eventId}`),
        mapping: mapGameStateIdentity(
          identityManifest,
          sport,
          eventId,
          identitySignals,
        ),
        ...normalized,
      };
    },
  );
  const countsBySport = {};
  for (const sport of [...ROUTE_SPORTS, "off-roster"]) {
    const count = observations.filter((item) => item.sport === sport).length;
    if (count > 0) countsBySport[sport] = count;
  }
  const schemaShapes = [
    ...new Set(rows.map(({ rawState }) => canonicalJson(typeShape(rawState)))),
  ].sort();
  const fieldPresence = {};
  const fieldTypes = {};
  const unknownFields = new Set();
  for (const field of GAME_STATE_FIELDS) {
    const values = rows
      .map(({ rawState }) => rawState[field])
      .filter((_, index) =>
        Object.prototype.hasOwnProperty.call(rows[index].rawState, field),
      );
    if (values.length > 0) {
      fieldPresence[field] = values.length;
      fieldTypes[field] = [...new Set(values.map(observedType))].sort();
    }
  }
  for (const { rawState } of rows)
    for (const field of Object.keys(rawState))
      if (!GAME_STATE_FIELD_SET.has(field)) unknownFields.add(field);
  const mappingCounts = {};
  for (const { mapping } of observations)
    mappingCounts[mapping.kind] = (mappingCounts[mapping.kind] ?? 0) + 1;
  const mappedCanonicalCounts = new Map();
  for (const { mapping } of observations)
    if (mapping.canonicalEventId)
      mappedCanonicalCounts.set(
        mapping.canonicalEventId,
        (mappedCanonicalCounts.get(mapping.canonicalEventId) ?? 0) + 1,
      );
  const disagreementCounts = {};
  for (const { inPlayEvidence } of observations)
    disagreementCounts[inPlayEvidence.disagreement] =
      (disagreementCounts[inPlayEvidence.disagreement] ?? 0) + 1;
  return {
    routeId: route.id,
    sport: route.sport,
    retrievedAt,
    byteLength,
    rowCount: observations.length,
    countsBySport,
    schemaHash: sha256(canonicalJson(schemaShapes)),
    fieldPresence,
    fieldTypes,
    unknownFieldCount: unknownFields.size,
    mappingCounts,
    duplicateCanonicalMappings: [...mappedCanonicalCounts.values()].filter(
      (count) => count > 1,
    ).length,
    disagreementCounts,
    observations,
  };
};

export const summarizeCoverage = (manifest, sample, sport) => {
  const expected = manifest.events.filter((event) => event.sport === sport);
  const observed = sample.observations.filter((item) => item.sport === sport);
  const mapped = observed.filter((item) => item.mapping.canonicalEventId);
  const byCanonicalId = new Map();
  for (const item of mapped) {
    const items = byCanonicalId.get(item.mapping.canonicalEventId) ?? [];
    items.push(item);
    byCanonicalId.set(item.mapping.canonicalEventId, items);
  }
  const mappedIds = new Set(byCanonicalId.keys());
  const phases = {};
  for (const items of byCanonicalId.values()) {
    const distinct = new Set(items.map(({ phase }) => phase));
    const phase = distinct.size === 1 ? items[0].phase : "ambiguous";
    phases[phase] = (phases[phase] ?? 0) + 1;
  }
  return {
    sport,
    denominator: expected.length,
    observedMapped: mappedIds.size,
    observedUnmapped: observed.length - mapped.length,
    duplicateMappedRows: mapped.length - mappedIds.size,
    missingCanonical: expected.filter(
      (event) => !mappedIds.has(event.canonicalEventId),
    ).length,
    phases,
  };
};

export const reconcileRouteObservations = (aggregate, scoped) => {
  if (scoped.sport === null || !ROUTE_SPORTS.has(scoped.sport))
    throw new GameStateSpikeError("configuration");
  const aggregateRows = aggregate.observations.filter(
    (item) => item.sport === scoped.sport,
  );
  const aggregateById = new Map(
    aggregateRows.map((item) => [item.eventHash, item]),
  );
  const scopedById = new Map(
    scoped.observations.map((item) => [item.eventHash, item]),
  );
  let missingFromScoped = 0;
  let stateMismatches = 0;
  let temporalMovements = 0;
  let indeterminateMismatches = 0;
  for (const [eventHash, item] of aggregateById) {
    const peer = scopedById.get(eventHash);
    if (!peer) missingFromScoped += 1;
    else if (peer.stateHash !== item.stateHash) {
      if (peer.consensusAt && item.consensusAt)
        if (peer.consensusAt === item.consensusAt) stateMismatches += 1;
        else temporalMovements += 1;
      else indeterminateMismatches += 1;
    }
  }
  let extraInScoped = 0;
  for (const eventHash of scopedById.keys())
    if (!aggregateById.has(eventHash)) extraInScoped += 1;
  return {
    sport: scoped.sport,
    aggregateCount: aggregateRows.length,
    scopedCount: scoped.observations.length,
    missingFromScoped,
    extraInScoped,
    stateMismatches,
    temporalMovements,
    indeterminateMismatches,
  };
};

const PHASE_RANK = Object.freeze({
  unknown: 0,
  pregame: 1,
  delayed: 1,
  live: 2,
  break: 2,
  final: 3,
});

export const diffLifecycle = (previous, current) => {
  if (!previous && current) return { kinds: ["first-seen"] };
  if (previous && !current) return { kinds: ["disappeared"] };
  if (!previous || !current) return { kinds: [] };
  const kinds = [];
  if (previous.stateHash !== current.stateHash) kinds.push("changed");
  if (!previous.terminalSignal && current.terminalSignal)
    kinds.push("terminal-clock-first-seen");
  else if (
    previous.terminalSignal &&
    current.terminalSignal &&
    previous.stateHash !== current.stateHash
  )
    kinds.push("terminal-clock-revised");
  else if (previous.terminalSignal && !current.terminalSignal)
    kinds.push("terminal-clock-disappeared");
  if (previous.phase !== "break" && current.phase === "break")
    kinds.push("period-break");
  if (
    new Set(["break", "delayed"]).has(previous.phase) &&
    current.phase === "live"
  )
    kinds.push("resumed");
  if (previous.phase !== "delayed" && current.phase === "delayed")
    kinds.push("delayed");
  if (previous.phase !== "final" && current.phase === "final")
    kinds.push("first-final");
  else if (
    previous.phase === "final" &&
    current.phase === "final" &&
    previous.stateHash !== current.stateHash
  )
    kinds.push("final-revised");
  if ((PHASE_RANK[current.phase] ?? 0) < (PHASE_RANK[previous.phase] ?? 0))
    kinds.push("phase-regressed");
  if (
    previous.consensusAt &&
    current.consensusAt &&
    Date.parse(current.consensusAt) < Date.parse(previous.consensusAt)
  )
    kinds.push("provider-time-regressed");
  return { kinds };
};

const awsCommand = (args) => {
  const result = spawnSync(
    "aws",
    [
      ...args,
      "--cli-connect-timeout",
      "5",
      "--cli-read-timeout",
      "10",
      "--no-cli-pager",
    ],
    {
      encoding: "utf8",
      maxBuffer: 1_000_000,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 15_000,
    },
  );
  if (result.status !== 0 || result.error)
    throw new GameStateSpikeError("configuration");
  return result.stdout;
};

const defaultAssertAwsIdentity = async ({ region }) => {
  let identity;
  try {
    identity = JSON.parse(
      awsCommand([
        "sts",
        "get-caller-identity",
        "--region",
        region,
        "--output",
        "json",
      ]),
    );
  } catch {
    throw new GameStateSpikeError("configuration");
  }
  if (identity.Account !== EXPECTED_AWS_ACCOUNT)
    throw new GameStateSpikeError("configuration");
};

const defaultSecretResolver = async (secretId, { region }) => {
  const secret = awsCommand([
    "secretsmanager",
    "get-secret-value",
    "--secret-id",
    secretId,
    "--region",
    region,
    "--query",
    "SecretString",
    "--output",
    "text",
  ]).replace(/\r?\n$/, "");
  if (!secret.length || secret === "None")
    throw new GameStateSpikeError("configuration");
  return secret;
};

const defaultWriter = async (output, evidence) =>
  writeFile(output, `${JSON.stringify(evidence, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });

const defaultSleep = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

const rateWindowShape = (metadata) => {
  const limit = metadata?.rateWindow?.limit;
  const remaining = metadata?.rateWindow?.remaining;
  const resetsAt = normalizeInstant(metadata?.rateWindow?.resetsAt);
  return integer(limit, 1, Number.MAX_SAFE_INTEGER) &&
    integer(remaining, 0, limit) &&
    resetsAt
    ? { limit, remaining, resetsAt }
    : undefined;
};

const completeRateWindow = (metadata, at) => {
  const window = rateWindowShape(metadata);
  if (!window) return false;
  const resetMs = Date.parse(window.resetsAt);
  return resetMs > at.getTime() && resetMs <= at.getTime() + 24 * 60 * 60_000;
};

export const runGameStateSpike = async (
  options,
  {
    now = () => new Date(),
    hashKey = randomBytes(32).toString("hex"),
    assertAwsIdentity = defaultAssertAwsIdentity,
    secretResolver = defaultSecretResolver,
    fetcher = fetch,
    writer = defaultWriter,
    sleep = defaultSleep,
    monotonicNow = () => performance.now(),
    identityManifest,
    manifestInputHash,
    truthProtocol,
    sourceKind = "live-provider",
  } = {},
) => {
  const budget = validateRequestBudget(options);
  let normalizedTruthHeader;
  try {
    normalizedTruthHeader = truthProtocol
      ? normalizeTruthProtocolHeader(truthProtocol.header)
      : undefined;
  } catch {
    throw new GameStateSpikeError("configuration");
  }
  if (
    options.region !== DEFAULT_REGION ||
    !new Set(["staging", "prod"]).has(options.stage) ||
    options.plannedRequests !== budget.plannedRequests ||
    options.ticks !== budget.ticks ||
    (options.mode === "sample" &&
      (!identityManifest ||
        !/^[a-f0-9]{64}$/.test(manifestInputHash ?? "") ||
        !truthProtocol ||
        !/^[a-f0-9]{64}$/.test(truthProtocol.headerHash ?? "") ||
        truthProtocol.headerHash !==
          sha256(`${JSON.stringify(normalizedTruthHeader)}\n`) ||
        normalizedTruthHeader?.manifestInputHash !== manifestInputHash ||
        Date.parse(normalizedTruthHeader.frozenAt) <
          Date.parse(identityManifest.frozenAt)))
  )
    throw new GameStateSpikeError("configuration");
  if (
    !new Set(["live-provider", "synthetic-fixture", "test"]).has(sourceKind) ||
    (sourceKind === "live-provider" && options.stage !== "staging")
  )
    throw new GameStateSpikeError("configuration");
  const { stage } = options;
  await assertAwsIdentity({ stage: options.stage, region: options.region });
  const secretId = `find-the-edge/${stage}/sharpapi`;
  const apiKey = parseSharpApiSecret(
    await secretResolver(secretId, {
      stage: options.stage,
      region: options.region,
    }),
  );
  const startedAt = now().toISOString();
  if (
    identityManifest &&
    Date.parse(identityManifest.frozenAt) > Date.parse(startedAt)
  )
    throw new GameStateSpikeError("configuration");
  if (
    normalizedTruthHeader &&
    Date.parse(normalizedTruthHeader.frozenAt) > Date.parse(startedAt)
  )
    throw new GameStateSpikeError("configuration");
  const samples = [];
  const reconciliation = [];
  const transitions = [];
  let previousAggregate = new Map();
  const lastCanonicalHashSets = new Map();
  let attemptCount = 0;
  let observationCount = 0;
  let derivedBytes = 0;
  let lastRateMetadata;
  const monotonicStartedAt = monotonicNow();
  for (let tick = 0; tick < budget.ticks; tick += 1) {
    const scheduledOffsetMs = tick * options.intervalSeconds * 1_000;
    if (tick > 0) {
      const waitMs = Math.max(
        0,
        monotonicStartedAt + scheduledOffsetMs - monotonicNow(),
      );
      if (waitMs > 0) await sleep(waitMs);
    }
    const dispatchDriftMs = Math.max(
      0,
      monotonicNow() - (monotonicStartedAt + scheduledOffsetMs),
    );
    if (dispatchDriftMs >= options.intervalSeconds * 1_000)
      throw new GameStateSpikeError("invalid-response", attemptCount);
    const tickSamples = [];
    for (const route of GAME_STATE_ROUTES) {
      const routeDispatchDriftMs = Math.max(
        0,
        monotonicNow() - (monotonicStartedAt + scheduledOffsetMs),
      );
      if (routeDispatchDriftMs >= options.intervalSeconds * 1_000)
        throw new GameStateSpikeError("invalid-response", attemptCount);
      if (attemptCount >= options.maxRequests)
        throw new GameStateSpikeError("request-budget-exhausted", attemptCount);
      if (
        sourceKind === "live-provider" &&
        attemptCount > 0 &&
        (!rateWindowShape(lastRateMetadata) ||
          (lastRateMetadata.rateWindow.remaining <= options.rateReserve &&
            Date.parse(lastRateMetadata.rateWindow.resetsAt) > now().getTime()))
      )
        throw new GameStateSpikeError(
          rateWindowShape(lastRateMetadata)
            ? "rate-limited"
            : "invalid-response",
          attemptCount,
        );
      attemptCount += 1;
      let fetched;
      try {
        fetched = await fetchGameStateRoute({
          route,
          apiKey,
          fetcher,
          now,
        });
      } catch (error) {
        if (record(error)) error.attemptCount = attemptCount;
        throw error;
      }
      try {
        const normalized = normalizeGameStatePayload({
          route,
          payload: fetched.payload,
          retrievedAt: fetched.retrievedAt,
          byteLength: fetched.byteLength,
          hashKey,
          identityManifest,
        });
        if (
          sourceKind === "live-provider" &&
          !completeRateWindow(fetched.metadata, new Date(fetched.retrievedAt))
        )
          throw new GameStateSpikeError("invalid-response", attemptCount);
        lastRateMetadata = fetched.metadata;
        if (
          observationCount + normalized.observations.length >
          MAX_DERIVED_OBSERVATIONS
        )
          throw new GameStateSpikeError(
            "request-budget-exhausted",
            attemptCount,
          );
        observationCount += normalized.observations.length;
        derivedBytes += Buffer.byteLength(JSON.stringify(normalized), "utf8");
        if (derivedBytes > MAX_DERIVED_BYTES)
          throw new GameStateSpikeError(
            "request-budget-exhausted",
            attemptCount,
          );
        tickSamples.push({
          ...normalized,
          metadata: fetched.metadata,
          providerEnvelopeUpdatedAt: fetched.providerEnvelopeUpdatedAt,
          tick,
          scheduledOffsetMs,
          dispatchDriftMs: routeDispatchDriftMs,
          requestStartedAt: fetched.requestStartedAt,
          latencyMs: fetched.latencyMs,
        });
      } catch (error) {
        if (record(error)) error.attemptCount = attemptCount;
        throw error;
      }
    }
    samples.push(...tickSamples);
    const aggregate = tickSamples.find(
      ({ routeId }) => routeId === "aggregate",
    );
    const currentAggregate = new Map(
      aggregate.observations.map((item) => [item.eventHash, item]),
    );
    for (const eventHash of new Set([
      ...previousAggregate.keys(),
      ...currentAggregate.keys(),
    ])) {
      const change = diffLifecycle(
        previousAggregate.get(eventHash),
        currentAggregate.get(eventHash),
      );
      if (change.kinds.length > 0)
        transitions.push({
          tick,
          eventHash,
          sport:
            currentAggregate.get(eventHash)?.sport ??
            previousAggregate.get(eventHash)?.sport ??
            "off-roster",
          observedAt: aggregate.retrievedAt,
          kinds: change.kinds,
        });
    }
    previousAggregate = currentAggregate;
    const currentCanonicalHashSets = new Map();
    for (const item of aggregate.observations) {
      const canonicalEventId = item.mapping.canonicalEventId;
      if (!canonicalEventId) continue;
      const hashes =
        currentCanonicalHashSets.get(canonicalEventId) ?? new Set();
      hashes.add(item.eventHash);
      currentCanonicalHashSets.set(canonicalEventId, hashes);
    }
    for (const [canonicalEventId, currentHashes] of currentCanonicalHashSets) {
      const representative = aggregate.observations.find(
        (item) => item.mapping.canonicalEventId === canonicalEventId,
      );
      if (currentHashes.size > 1)
        transitions.push({
          tick,
          eventHash: [...currentHashes].sort()[0],
          sport: representative?.sport ?? "off-roster",
          kinds: ["duplicate-canonical-mapping"],
        });
      const previousHashes = lastCanonicalHashSets.get(canonicalEventId);
      const overlap = previousHashes
        ? [...currentHashes].some((hash) => previousHashes.has(hash))
        : false;
      if (previousHashes && !overlap)
        transitions.push({
          tick,
          eventHash: [...currentHashes].sort()[0],
          sport: representative?.sport ?? "off-roster",
          kinds: ["identity-churn"],
        });
      else if (
        previousHashes &&
        (currentHashes.size !== previousHashes.size ||
          [...currentHashes].some((hash) => !previousHashes.has(hash)))
      )
        transitions.push({
          tick,
          eventHash: [...currentHashes].sort()[0],
          sport: representative?.sport ?? "off-roster",
          kinds: ["identity-alias-set-changed"],
        });
      lastCanonicalHashSets.set(canonicalEventId, new Set(currentHashes));
    }
    for (const scoped of tickSamples.filter(({ sport }) => sport !== null))
      reconciliation.push({
        tick,
        ...reconcileRouteObservations(aggregate, scoped),
      });
  }
  const evidence = {
    schemaVersion: "game-state-spike-derived-v1",
    source: sourceKind,
    stage: options.stage,
    mode: options.mode,
    startedAt,
    completedAt: now().toISOString(),
    attemptCount,
    observationCount,
    derivedBytes,
    protocol: {
      intervalSeconds: options.intervalSeconds,
      durationMinutes: options.durationMinutes,
      postFinalMinutes: options.postFinalMinutes,
      maxRequests: options.maxRequests,
      plannedRequests: budget.plannedRequests,
      rateReserve: options.rateReserve,
      routes: GAME_STATE_ROUTES.map(({ id, sport }) => ({ id, sport })),
    },
    samples,
    reconciliation,
    transitions,
    ...(identityManifest
      ? {
          manifest: {
            schemaVersion: identityManifest.schemaVersion,
            frozenAt: identityManifest.frozenAt,
            normalizedHash: sha256(canonicalJson(identityManifest)),
            inputHash: manifestInputHash,
            identitySource: identityManifest.identitySource,
            denominators: Object.fromEntries(
              [...ROUTE_SPORTS].map((sport) => [
                sport,
                identityManifest.events.filter((event) => event.sport === sport)
                  .length,
              ]),
            ),
          },
          coverage: samples
            .filter(({ routeId }) => routeId === "aggregate")
            .flatMap((sample) =>
              [...ROUTE_SPORTS].map((sport) => ({
                tick: sample.tick,
                ...summarizeCoverage(identityManifest, sample, sport),
              })),
            ),
        }
      : {}),
    ...(truthProtocol
      ? {
          truthProtocol: {
            headerHash: truthProtocol.headerHash,
            frozenAt: normalizedTruthHeader.frozenAt,
            source: normalizedTruthHeader.source,
            comparisonToleranceSeconds:
              normalizedTruthHeader.comparisonToleranceSeconds,
          },
        }
      : {}),
  };
  if (
    Buffer.byteLength(`${JSON.stringify(evidence)}\n`, "utf8") >
    GAME_STATE_MAX_EVIDENCE_BYTES
  )
    throw new GameStateSpikeError("invalid-response", attemptCount);
  try {
    await writer(options.output, evidence);
  } catch (error) {
    if (record(error)) error.attemptCount = attemptCount;
    throw error;
  }
  return evidence;
};

const readBoundedTextFile = async (inputPath, errorCode) => {
  try {
    const details = await stat(inputPath);
    if (!details.isFile() || details.size > MAX_LOCAL_INPUT_BYTES)
      throw new Error("bounded-input");
    return await readFile(inputPath, "utf8");
  } catch {
    throw new GameStateSpikeError(errorCode);
  }
};

const readBoundedJsonFile = async (inputPath, errorCode) => {
  try {
    return JSON.parse(await readBoundedTextFile(inputPath, errorCode));
  } catch {
    throw new GameStateSpikeError(errorCode);
  }
};

export const loadTruthProtocol = async (inputPath, manifestInputHash) => {
  const text = await readBoundedTextFile(inputPath, "configuration");
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  if (lines.length !== 1 || text !== `${lines[0]}\n`)
    throw new GameStateSpikeError("configuration");
  let header;
  try {
    header = normalizeTruthProtocolHeader(JSON.parse(lines[0]));
  } catch {
    throw new GameStateSpikeError("configuration");
  }
  if (header.manifestInputHash !== manifestInputHash)
    throw new GameStateSpikeError("configuration");
  return { header, headerHash: sha256(`${lines[0]}\n`) };
};

const fixtureDependencies = async (fixturePath) => {
  const fixture = await readBoundedJsonFile(fixturePath, "invalid-response");
  const responses = record(fixture.responses) ?? record(fixture);
  if (!responses) throw new GameStateSpikeError("invalid-response");
  return {
    assertAwsIdentity: async () => {},
    secretResolver: async () => "fixture-key",
    fetcher: async (url) => {
      const route = GAME_STATE_ROUTES.find((candidate) =>
        url.endsWith(candidate.path),
      );
      if (!route || responses[route.id] === undefined)
        return new Response("fixture-route-missing", { status: 500 });
      return new Response(JSON.stringify(responses[route.id]), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
    hashKey: "fixture-derived-evidence-key",
    sourceKind: "synthetic-fixture",
  };
};

const reserveAtomicWriter = async (output) => {
  const suffix = `${process.pid}-${randomBytes(8).toString("hex")}`;
  const lockPath = `${output}.lock`;
  const partialPath = `${output}.partial-${suffix}`;
  const failurePartialPath = `${output}.failure.partial-${suffix}`;
  let lockHandle;
  let partialHandle;
  let ownsLock = false;
  try {
    lockHandle = await open(lockPath, "wx", 0o600);
    ownsLock = true;
    for (const reservedPath of [output, `${output}.failure.json`])
      try {
        await access(reservedPath);
        throw new GameStateSpikeError("configuration");
      } catch (error) {
        if (error instanceof GameStateSpikeError) throw error;
        if (error?.code !== "ENOENT")
          throw new GameStateSpikeError("configuration");
      }
    partialHandle = await open(partialPath, "wx", 0o600);
  } catch {
    await lockHandle?.close().catch(() => {});
    if (ownsLock) await unlink(lockPath).catch(() => {});
    throw new GameStateSpikeError("configuration");
  }
  let published = false;
  return {
    writer: async (_output, evidence) => {
      try {
        await partialHandle.writeFile(`${JSON.stringify(evidence)}\n`, {
          encoding: "utf8",
        });
        await partialHandle.sync();
        await partialHandle.close();
        partialHandle = undefined;
        await link(partialPath, output);
        published = true;
        await unlink(partialPath).catch(() => {});
      } catch {
        throw new GameStateSpikeError("configuration");
      }
    },
    cleanup: async () => {
      await partialHandle?.close().catch(() => {});
      if (!published) await unlink(partialPath).catch(() => {});
      await unlink(failurePartialPath).catch(() => {});
      await lockHandle?.close().catch(() => {});
      await unlink(lockPath).catch(() => {});
    },
    failure: async (error, options) => {
      const safe = safeSpikeError(error);
      const diagnostic = {
        schemaVersion: "game-state-spike-failure-v1",
        source: options.fixture ? "synthetic-fixture" : "live-provider",
        stage: options.stage,
        mode: options.mode,
        failedAt: new Date().toISOString(),
        ...safe,
        protocol: {
          plannedRequests: options.plannedRequests,
          maxRequests: options.maxRequests,
          intervalSeconds: options.intervalSeconds,
          durationMinutes: options.durationMinutes,
          postFinalMinutes: options.postFinalMinutes,
        },
      };
      let failureHandle;
      try {
        failureHandle = await open(failurePartialPath, "wx", 0o600);
        await failureHandle.writeFile(
          `${JSON.stringify(diagnostic, null, 2)}\n`,
          "utf8",
        );
        await failureHandle.sync();
        await failureHandle.close();
        failureHandle = undefined;
        await link(failurePartialPath, `${output}.failure.json`);
        await unlink(failurePartialPath).catch(() => {});
      } catch {
        // A failure diagnostic is best-effort and must never replace the
        // original bounded sampler error or overwrite another terminal file.
      } finally {
        await failureHandle?.close().catch(() => {});
        await unlink(failurePartialPath).catch(() => {});
      }
    },
  };
};

export const runCli = async (argv) => {
  const options = parseCliArgs(argv);
  const reserved = await reserveAtomicWriter(options.output);
  try {
    const manifestText = options.manifest
      ? await readBoundedTextFile(options.manifest, "configuration")
      : undefined;
    const manifestInputHash = manifestText ? sha256(manifestText) : undefined;
    let identityManifest;
    if (manifestText)
      try {
        identityManifest = normalizeIdentityManifest(JSON.parse(manifestText));
      } catch {
        throw new GameStateSpikeError("configuration");
      }
    const dependencies = {
      ...(options.fixture ? await fixtureDependencies(options.fixture) : {}),
      ...(identityManifest
        ? {
            identityManifest,
            manifestInputHash,
            truthProtocol: await loadTruthProtocol(
              options.truthSidecar,
              manifestInputHash,
            ),
          }
        : {}),
      writer: reserved.writer,
    };
    return await runGameStateSpike(options, dependencies);
  } catch (error) {
    await reserved.failure(error, options);
    throw error;
  } finally {
    await reserved.cleanup();
  }
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  runCli(process.argv.slice(2)).catch((error) => {
    const safe = safeSpikeError(error);
    process.stderr.write(
      `game-state-spike failed: ${safe.code} attempts=${safe.attemptCount ?? "unknown"}\n`,
    );
    process.exitCode = 1;
  });
}
