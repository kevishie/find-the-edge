#!/usr/bin/env node

import { createHash, randomBytes } from "node:crypto";
import { link, open, readFile, stat, unlink } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import {
  GAME_STATE_MAX_EVIDENCE_BYTES,
  normalizeIdentityManifest,
  normalizeTruthProtocolHeader,
  validateRequestBudget,
} from "./game-state-spike.mjs";

const MAX_INPUT_BYTES = 50_000_000;
const MAX_CHECKPOINTS = 100_000;
const PHASES = new Set(["pregame", "live", "break", "delayed", "final"]);
const SPORTS = new Set(["baseball", "football", "soccer", "off-roster"]);
const ERROR_CODES = new Set([
  "configuration",
  "invalid-evidence",
  "invalid-truth",
]);

class TruthAnalysisError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

const record = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value
    : undefined;

const exactKeys = (value, keys) => {
  const object = record(value);
  return (
    object &&
    Object.keys(object).length === keys.length &&
    Object.keys(object).every((key) => keys.includes(key))
  );
};

const canonical = (value, maximum = 256) =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= maximum &&
  value === value.trim();

const instant = (value) =>
  canonical(value, 40) && Number.isFinite(Date.parse(value))
    ? new Date(value).toISOString()
    : undefined;

const hash = (value) =>
  createHash("sha256").update(value, "utf8").digest("hex");

const digest = (value) =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);

const score = (value) =>
  value === null || (Number.isInteger(value) && value >= 0 && value <= 999);

export const safeTruthError = (error) => ({
  code:
    record(error) && ERROR_CODES.has(error.code) ? error.code : "configuration",
});

export const parseTruthArgs = (argv) => {
  const mode = argv[0];
  const modeArgs = argv.slice(1);
  const args = modeArgs[0] === "--" ? modeArgs.slice(1) : modeArgs;
  const values = {};
  const allowed =
    mode === "initialize"
      ? new Set([
          "manifest",
          "source-kind",
          "source-reference-hash",
          "comparison-tolerance-seconds",
          "frozen-at",
          "output",
        ])
      : mode === "analyze"
        ? new Set(["evidence", "truth", "output"])
        : new Set();
  for (let index = 0; index < args.length; index += 2) {
    const option = args[index];
    const key = option?.startsWith("--") ? option.slice(2) : "";
    const value = args[index + 1];
    if (
      !allowed.has(key) ||
      values[key] !== undefined ||
      !canonical(value, 4_096) ||
      value.startsWith("--")
    )
      throw new TruthAnalysisError("configuration");
    values[key] = value;
  }
  const required =
    mode === "initialize"
      ? [
          "manifest",
          "source-kind",
          "source-reference-hash",
          "comparison-tolerance-seconds",
          "frozen-at",
          "output",
        ]
      : mode === "analyze"
        ? ["evidence", "truth", "output"]
        : [];
  if (required.length === 0 || required.some((key) => !values[key]))
    throw new TruthAnalysisError("configuration");
  return { mode, ...values };
};

const readBounded = async (inputPath, code, maximum = MAX_INPUT_BYTES) => {
  try {
    const details = await stat(inputPath);
    if (!details.isFile() || details.size > maximum)
      throw new Error("bounded-input");
    return await readFile(inputPath, "utf8");
  } catch {
    throw new TruthAnalysisError(code);
  }
};

const normalizeCheckpoint = (value) => {
  if (
    !exactKeys(value, [
      "kind",
      "canonicalEventId",
      "observedAt",
      "awayScore",
      "homeScore",
      "gameClock",
      "period",
      "phase",
      "inPlay",
      "isFinal",
    ]) ||
    value.kind !== "checkpoint" ||
    !canonical(value.canonicalEventId) ||
    !instant(value.observedAt) ||
    !score(value.awayScore) ||
    !score(value.homeScore) ||
    !(
      value.gameClock === null ||
      (canonical(value.gameClock, 64) &&
        /^[a-z0-9 ._/-]+$/i.test(value.gameClock))
    ) ||
    !(
      value.period === null ||
      (Number.isInteger(value.period) &&
        value.period >= 0 &&
        value.period <= 100) ||
      (canonical(value.period, 32) && /^[a-z0-9 ._/-]+$/i.test(value.period))
    ) ||
    !PHASES.has(value.phase) ||
    ![null, true, false].includes(value.inPlay) ||
    ![null, true, false].includes(value.isFinal)
  )
    throw new TruthAnalysisError("invalid-truth");
  return { ...value, observedAt: instant(value.observedAt) };
};

export const parseTruthSidecar = (text) => {
  if (
    typeof text !== "string" ||
    Buffer.byteLength(text) > MAX_INPUT_BYTES ||
    text.includes("\r") ||
    !text.endsWith("\n")
  )
    throw new TruthAnalysisError("invalid-truth");
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  if (
    lines.length < 3 ||
    lines.length > MAX_CHECKPOINTS + 2 ||
    lines.some((line) => line.length === 0)
  )
    throw new TruthAnalysisError("invalid-truth");
  let header;
  let seal;
  try {
    header = JSON.parse(lines[0]);
    seal = JSON.parse(lines.at(-1));
  } catch {
    throw new TruthAnalysisError("invalid-truth");
  }
  if (
    !exactKeys(header, [
      "schemaVersion",
      "kind",
      "frozenAt",
      "manifestInputHash",
      "source",
      "comparisonToleranceSeconds",
    ]) ||
    header.schemaVersion !== "game-state-spike-truth-v1" ||
    header.kind !== "header" ||
    !instant(header.frozenAt) ||
    !digest(header.manifestInputHash) ||
    !exactKeys(header.source, ["kind", "referenceHash"]) ||
    !new Set([
      "official-scoreboard",
      "official-broadcast",
      "manual-official",
    ]).has(header.source.kind) ||
    !digest(header.source.referenceHash) ||
    !Number.isInteger(header.comparisonToleranceSeconds) ||
    header.comparisonToleranceSeconds < 0 ||
    header.comparisonToleranceSeconds > 900
  )
    throw new TruthAnalysisError("invalid-truth");
  const canonicalTranscript = `${lines.slice(0, -1).join("\n")}\n`;
  if (
    !exactKeys(seal, ["kind", "evidenceHash", "transcriptHash"]) ||
    seal.kind !== "seal" ||
    !digest(seal.evidenceHash) ||
    !digest(seal.transcriptHash) ||
    seal.transcriptHash !== hash(canonicalTranscript)
  )
    throw new TruthAnalysisError("invalid-truth");
  const seen = new Set();
  const checkpoints = lines.slice(1, -1).map((line) => {
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new TruthAnalysisError("invalid-truth");
    }
    const checkpoint = normalizeCheckpoint(parsed);
    const key = `${checkpoint.canonicalEventId}\0${checkpoint.observedAt}`;
    if (seen.has(key)) throw new TruthAnalysisError("invalid-truth");
    seen.add(key);
    return checkpoint;
  });
  return {
    header,
    headerHash: hash(`${lines[0]}\n`),
    checkpoints,
    seal,
  };
};

const classify = (observation, truth) => {
  const errors = [];
  if (
    (truth.awayScore !== null && observation.awayScore !== truth.awayScore) ||
    (truth.homeScore !== null && observation.homeScore !== truth.homeScore)
  )
    errors.push("wrong-score");
  if (observation.phase !== truth.phase) errors.push("status");
  if (
    (truth.gameClock !== null && observation.gameClock !== truth.gameClock) ||
    (truth.period !== null && observation.period !== truth.period)
  )
    errors.push("clock-period");
  if (truth.inPlay === false && observation.inPlay === true)
    errors.push("false-live");
  if (
    truth.isFinal === false &&
    (observation.isFinal === true || observation.phase === "final")
  )
    errors.push("false-final");
  return errors;
};

export const analyzeTruth = (evidenceText, truthSidecar) => {
  let evidence;
  try {
    evidence = JSON.parse(evidenceText);
  } catch {
    throw new TruthAnalysisError("invalid-evidence");
  }
  const requiredRoutes = new Set([
    "aggregate",
    "baseball",
    "football",
    "soccer",
  ]);
  const plannedRequests = evidence?.protocol?.plannedRequests;
  let validatedBudget;
  try {
    validatedBudget = validateRequestBudget({
      mode: evidence?.mode,
      intervalSeconds: evidence?.protocol?.intervalSeconds,
      durationMinutes: evidence?.protocol?.durationMinutes,
      postFinalMinutes: evidence?.protocol?.postFinalMinutes,
      maxRequests: evidence?.protocol?.maxRequests,
    });
  } catch {
    throw new TruthAnalysisError("invalid-evidence");
  }
  if (
    evidence?.schemaVersion !== "game-state-spike-derived-v1" ||
    evidence.source !== "live-provider" ||
    evidence.mode !== "sample" ||
    !instant(evidence.startedAt) ||
    !instant(evidence.completedAt) ||
    !digest(evidence.manifest?.normalizedHash) ||
    !digest(evidence.manifest?.inputHash) ||
    !instant(evidence.manifest?.frozenAt) ||
    !digest(evidence.truthProtocol?.headerHash) ||
    !Array.isArray(evidence.samples) ||
    !Number.isInteger(plannedRequests) ||
    validatedBudget.plannedRequests !== plannedRequests ||
    plannedRequests < requiredRoutes.size ||
    plannedRequests % requiredRoutes.size !== 0 ||
    evidence.attemptCount !== plannedRequests ||
    evidence.samples.length !== plannedRequests ||
    hash(evidenceText) !== truthSidecar.seal.evidenceHash ||
    evidence.manifest.inputHash !== truthSidecar.header.manifestInputHash ||
    evidence.truthProtocol.headerHash !== truthSidecar.headerHash
  )
    throw new TruthAnalysisError("invalid-evidence");
  const ticks = plannedRequests / requiredRoutes.size;
  const seenSamples = new Set();
  for (const sample of evidence.samples) {
    if (
      !record(sample) ||
      !Number.isInteger(sample.tick) ||
      sample.tick < 0 ||
      sample.tick >= ticks ||
      !requiredRoutes.has(sample.routeId) ||
      !Array.isArray(sample.observations)
    )
      throw new TruthAnalysisError("invalid-evidence");
    const key = `${sample.tick}\0${sample.routeId}`;
    if (seenSamples.has(key)) throw new TruthAnalysisError("invalid-evidence");
    seenSamples.add(key);
  }
  if (seenSamples.size !== ticks * requiredRoutes.size)
    throw new TruthAnalysisError("invalid-evidence");
  if (
    Date.parse(truthSidecar.header.frozenAt) > Date.parse(evidence.startedAt) ||
    Date.parse(truthSidecar.header.frozenAt) <
      Date.parse(evidence.manifest.frozenAt)
  )
    throw new TruthAnalysisError("invalid-truth");
  const checkpointsByEvent = new Map();
  for (const checkpoint of truthSidecar.checkpoints) {
    const list = checkpointsByEvent.get(checkpoint.canonicalEventId) ?? [];
    list.push(checkpoint);
    checkpointsByEvent.set(checkpoint.canonicalEventId, list);
  }
  for (const list of checkpointsByEvent.values())
    list.sort(
      (left, right) =>
        Date.parse(left.observedAt) - Date.parse(right.observedAt),
    );
  const counts = {
    compared: 0,
    unavailable: 0,
    match: 0,
    error: 0,
    "wrong-score": 0,
    status: 0,
    "clock-period": 0,
    "false-live": 0,
    "false-final": 0,
  };
  const bySport = {};
  for (const sample of evidence.samples.filter(
    (candidate) => candidate.routeId === "aggregate",
  ))
    for (const observation of sample.observations ?? []) {
      if (!SPORTS.has(observation.sport))
        throw new TruthAnalysisError("invalid-evidence");
      const sport = observation.sport;
      const sportCounts = bySport[sport] ?? {
        compared: 0,
        unavailable: 0,
        match: 0,
        error: 0,
      };
      const eventId = observation.mapping?.canonicalEventId;
      const comparisonAt = instant(
        observation.consensusAt ?? sample.retrievedAt,
      );
      const candidates = checkpointsByEvent.get(eventId) ?? [];
      const checkpoint = candidates
        .filter(
          (candidate) =>
            Date.parse(candidate.observedAt) <= Date.parse(comparisonAt),
        )
        .at(-1);
      const offsetMs = checkpoint
        ? Date.parse(comparisonAt) - Date.parse(checkpoint.observedAt)
        : Number.POSITIVE_INFINITY;
      if (
        !eventId ||
        !comparisonAt ||
        !checkpoint ||
        offsetMs > truthSidecar.header.comparisonToleranceSeconds * 1_000
      ) {
        counts.unavailable += 1;
        sportCounts.unavailable += 1;
        bySport[sport] = sportCounts;
        continue;
      }
      counts.compared += 1;
      const errors = classify(observation, checkpoint);
      counts[errors.length === 0 ? "match" : "error"] += 1;
      for (const error of errors) counts[error] += 1;
      sportCounts.compared += 1;
      sportCounts[errors.length === 0 ? "match" : "error"] += 1;
      bySport[sport] = sportCounts;
    }
  return {
    schemaVersion: "game-state-spike-truth-analysis-v1",
    evidenceHash: truthSidecar.seal.evidenceHash,
    manifestInputHash: truthSidecar.header.manifestInputHash,
    truthSource: truthSidecar.header.source,
    comparisonToleranceSeconds: truthSidecar.header.comparisonToleranceSeconds,
    checkpointCount: truthSidecar.checkpoints.length,
    counts,
    bySport,
  };
};

const atomicWrite = async (output, value) => {
  const partial = `${output}.partial-${process.pid}-${randomBytes(6).toString("hex")}`;
  let handle;
  try {
    handle = await open(partial, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await link(partial, output);
    await unlink(partial).catch(() => {});
  } catch {
    throw new TruthAnalysisError("configuration");
  } finally {
    await handle?.close().catch(() => {});
    await unlink(partial).catch(() => {});
  }
};

const atomicWriteText = async (output, value) => {
  const partial = `${output}.partial-${process.pid}-${randomBytes(6).toString("hex")}`;
  let handle;
  try {
    handle = await open(partial, "wx", 0o600);
    await handle.writeFile(value, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await link(partial, output);
    await unlink(partial).catch(() => {});
  } catch {
    throw new TruthAnalysisError("configuration");
  } finally {
    await handle?.close().catch(() => {});
    await unlink(partial).catch(() => {});
  }
};

export const initializeTruthSidecar = async (args) => {
  const manifestText = await readBounded(args.manifest, "configuration");
  let manifest;
  try {
    manifest = normalizeIdentityManifest(JSON.parse(manifestText));
  } catch {
    throw new TruthAnalysisError("configuration");
  }
  let header;
  try {
    header = normalizeTruthProtocolHeader({
      schemaVersion: "game-state-spike-truth-v1",
      kind: "header",
      frozenAt: args["frozen-at"],
      manifestInputHash: hash(manifestText),
      source: {
        kind: args["source-kind"],
        referenceHash: args["source-reference-hash"],
      },
      comparisonToleranceSeconds: Number(args["comparison-tolerance-seconds"]),
    });
  } catch {
    throw new TruthAnalysisError("configuration");
  }
  if (Date.parse(header.frozenAt) < Date.parse(manifest.frozenAt))
    throw new TruthAnalysisError("configuration");
  const line = `${JSON.stringify(header)}\n`;
  await atomicWriteText(args.output, line);
  return {
    header,
    headerHash: hash(line),
    manifestInputHash: header.manifestInputHash,
  };
};

export const runTruthCli = async (argv) => {
  const args = parseTruthArgs(argv);
  if (args.mode === "initialize") return initializeTruthSidecar(args);
  const evidenceText = await readBounded(
    args.evidence,
    "invalid-evidence",
    GAME_STATE_MAX_EVIDENCE_BYTES,
  );
  const truthText = await readBounded(args.truth, "invalid-truth");
  const analysis = analyzeTruth(evidenceText, parseTruthSidecar(truthText));
  await atomicWrite(args.output, analysis);
  return analysis;
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href)
  runTruthCli(process.argv.slice(2)).catch((error) => {
    process.stderr.write(
      `game-state-truth failed: ${safeTruthError(error).code}\n`,
    );
    process.exitCode = 1;
  });
