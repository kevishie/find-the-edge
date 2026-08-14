import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  analyzeTruth,
  parseTruthArgs,
  parseTruthSidecar,
  runTruthCli,
} from "./game-state-truth.mjs";

const MANIFEST_INPUT_HASH = "a".repeat(64);
const NORMALIZED_MANIFEST_HASH = "c".repeat(64);
const REFERENCE_HASH = "b".repeat(64);

const headerLine = () =>
  `${JSON.stringify({
    schemaVersion: "game-state-spike-truth-v1",
    kind: "header",
    frozenAt: "2026-08-14T16:55:00.000Z",
    manifestInputHash: MANIFEST_INPUT_HASH,
    source: {
      kind: "official-scoreboard",
      referenceHash: REFERENCE_HASH,
    },
    comparisonToleranceSeconds: 60,
  })}\n`;

const HEADER_HASH = createHash("sha256")
  .update(headerLine(), "utf8")
  .digest("hex");

const evidence = () => ({
  schemaVersion: "game-state-spike-derived-v1",
  source: "live-provider",
  stage: "staging",
  mode: "sample",
  startedAt: "2026-08-14T17:00:00.000Z",
  completedAt: "2026-08-14T18:30:00.000Z",
  attemptCount: 4,
  protocol: {
    intervalSeconds: 300,
    durationMinutes: 1,
    postFinalMinutes: 0,
    maxRequests: 4,
    plannedRequests: 4,
  },
  manifest: {
    normalizedHash: NORMALIZED_MANIFEST_HASH,
    inputHash: MANIFEST_INPUT_HASH,
    frozenAt: "2026-08-14T16:50:00.000Z",
  },
  truthProtocol: { headerHash: HEADER_HASH },
  samples: [
    {
      tick: 0,
      routeId: "aggregate",
      retrievedAt: "2026-08-14T18:00:10.000Z",
      observations: [
        {
          sport: "baseball",
          consensusAt: "2026-08-14T18:00:00.000Z",
          mapping: { canonicalEventId: "event:one" },
          awayScore: 2,
          homeScore: 1,
          gameClock: "FINAL",
          period: "FINAL",
          phase: "final",
          inPlay: false,
          isFinal: true,
        },
      ],
    },
    { tick: 0, routeId: "baseball", observations: [] },
    { tick: 0, routeId: "football", observations: [] },
    { tick: 0, routeId: "soccer", observations: [] },
  ],
});

const checkpoint = (overrides = {}) => ({
  kind: "checkpoint",
  canonicalEventId: "event:one",
  observedAt: "2026-08-14T17:59:50.000Z",
  awayScore: 2,
  homeScore: 1,
  gameClock: "FINAL",
  period: "FINAL",
  phase: "final",
  inPlay: false,
  isFinal: true,
  ...overrides,
});

const sidecarText = (evidenceText, checkpoints = [checkpoint()]) =>
  (() => {
    const transcript = [
      headerLine().trimEnd(),
      ...checkpoints.map(JSON.stringify),
      "",
    ].join("\n");
    return `${transcript}${JSON.stringify({
      kind: "seal",
      evidenceHash: createHash("sha256")
        .update(evidenceText, "utf8")
        .digest("hex"),
      transcriptHash: createHash("sha256")
        .update(transcript, "utf8")
        .digest("hex"),
    })}\n`;
  })();

test("truth CLI accepts exactly one pnpm delimiter and three closed paths", () => {
  assert.deepEqual(
    parseTruthArgs([
      "analyze",
      "--",
      "--evidence",
      "/tmp/evidence.json",
      "--truth",
      "/tmp/truth.jsonl",
      "--output",
      "/tmp/analysis.json",
    ]),
    {
      mode: "analyze",
      evidence: "/tmp/evidence.json",
      truth: "/tmp/truth.jsonl",
      output: "/tmp/analysis.json",
    },
  );
  assert.throws(
    () =>
      parseTruthArgs([
        "analyze",
        "--evidence",
        "a",
        "--truth",
        "b",
        "--output",
        "c",
        "--stage",
        "prod",
      ]),
    /configuration/,
  );
});

test("truth sidecar is predeclared, append-only, sealed, and duplicate safe", () => {
  const evidenceText = JSON.stringify(evidence());
  const parsed = parseTruthSidecar(sidecarText(evidenceText));
  assert.equal(parsed.checkpoints.length, 1);
  assert.throws(
    () =>
      parseTruthSidecar(
        sidecarText(evidenceText, [checkpoint(), checkpoint()]),
      ),
    /invalid-truth/,
  );
  assert.throws(
    () => parseTruthSidecar(sidecarText(evidenceText).replaceAll("\n", "\r\n")),
    /invalid-truth/,
  );
  assert.throws(
    () =>
      parseTruthSidecar(
        sidecarText(evidenceText).replace('"awayScore":2', '"awayScore":3'),
      ),
    /invalid-truth/,
  );
  assert.throws(
    () =>
      parseTruthSidecar(
        sidecarText(evidenceText, [checkpoint({ awayScore: 1.5 })]),
      ),
    /invalid-truth/,
  );
  assert.throws(
    () =>
      parseTruthSidecar(
        sidecarText(evidenceText, [checkpoint({ rawProviderBody: "no" })]),
      ),
    /invalid-truth/,
  );
});

test("truth initializer binds an exact validated manifest before collection", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "fte-game-state-init-"));
  const manifestPath = path.join(directory, "manifest.json");
  const outputPath = path.join(directory, "truth.jsonl");
  const manifestText = `${JSON.stringify({
    schemaVersion: "game-state-spike-manifest-v1",
    frozenAt: "2026-08-14T16:50:00.000Z",
    identitySource: {
      kind: "official-scoreboard",
      referenceHash: "d".repeat(64),
    },
    events: [
      {
        canonicalEventId: "event:one",
        sport: "baseball",
        providerEventId: "provider:one",
        scheduledStart: "2026-08-14T17:00:00.000Z",
      },
    ],
  })}\n`;
  await writeFile(manifestPath, manifestText);
  const initialized = await runTruthCli([
    "initialize",
    "--manifest",
    manifestPath,
    "--source-kind",
    "official-scoreboard",
    "--source-reference-hash",
    REFERENCE_HASH,
    "--comparison-tolerance-seconds",
    "60",
    "--frozen-at",
    "2026-08-14T16:55:00.000Z",
    "--output",
    outputPath,
  ]);
  const text = await readFile(outputPath, "utf8");
  assert.equal(
    initialized.manifestInputHash,
    createHash("sha256").update(manifestText, "utf8").digest("hex"),
  );
  assert.equal(
    initialized.headerHash,
    createHash("sha256").update(text, "utf8").digest("hex"),
  );
  assert.equal(text.split("\n").filter(Boolean).length, 1);

  await assert.rejects(
    runTruthCli([
      "initialize",
      "--manifest",
      manifestPath,
      "--source-kind",
      "official-scoreboard",
      "--source-reference-hash",
      REFERENCE_HASH,
      "--comparison-tolerance-seconds",
      "60",
      "--frozen-at",
      "2026-08-14T16:49:59.999Z",
      "--output",
      path.join(directory, "backdated-truth.jsonl"),
    ]),
    /configuration/,
  );
});

test("analysis uses the latest non-future truth checkpoint and emits bounded errors", () => {
  const evidenceText = JSON.stringify(evidence());
  const truth = parseTruthSidecar(
    sidecarText(evidenceText, [
      checkpoint({
        observedAt: "2026-08-14T17:59:40.000Z",
        awayScore: 1,
      }),
      checkpoint(),
      checkpoint({
        observedAt: "2026-08-14T18:00:05.000Z",
        awayScore: 99,
      }),
    ]),
  );
  const analysis = analyzeTruth(evidenceText, truth);
  assert.deepEqual(analysis.counts, {
    compared: 1,
    unavailable: 0,
    match: 1,
    error: 0,
    "wrong-score": 0,
    status: 0,
    "clock-period": 0,
    "false-live": 0,
    "false-final": 0,
  });
  assert.deepEqual(analysis.bySport, {
    baseball: { compared: 1, unavailable: 0, match: 1, error: 0 },
  });
  assert.equal(JSON.stringify(analysis).includes("event:one"), false);
});

test("analysis rejects unlike evidence and truth hashes", () => {
  const evidenceText = JSON.stringify(evidence());
  const truth = parseTruthSidecar(sidecarText(evidenceText));
  truth.seal.evidenceHash = "c".repeat(64);
  assert.throws(() => analyzeTruth(evidenceText, truth), /invalid-evidence/);
});

test("analysis rejects incomplete route and tick evidence", () => {
  const incomplete = evidence();
  incomplete.samples = [];
  const incompleteText = JSON.stringify(incomplete);
  assert.throws(
    () =>
      analyzeTruth(
        incompleteText,
        parseTruthSidecar(sidecarText(incompleteText)),
      ),
    /invalid-evidence/,
  );

  const understated = evidence();
  understated.protocol.durationMinutes = 5;
  const understatedText = JSON.stringify(understated);
  assert.throws(
    () =>
      analyzeTruth(
        understatedText,
        parseTruthSidecar(sidecarText(understatedText)),
      ),
    /invalid-evidence/,
  );
});

test("analysis rejects a post-start protocol and unbounded sport labels", () => {
  const evidenceText = JSON.stringify(evidence());
  const lateTruth = parseTruthSidecar(sidecarText(evidenceText));
  lateTruth.header.frozenAt = "2026-08-14T17:00:00.001Z";
  assert.throws(() => analyzeTruth(evidenceText, lateTruth), /invalid-truth/);

  const backdatedEvidence = evidence();
  backdatedEvidence.manifest.frozenAt = "2026-08-14T16:55:00.001Z";
  const backdatedText = JSON.stringify(backdatedEvidence);
  assert.throws(
    () =>
      analyzeTruth(
        backdatedText,
        parseTruthSidecar(sidecarText(backdatedText)),
      ),
    /invalid-truth/,
  );

  const unbounded = evidence();
  unbounded.samples[0].observations[0].sport = "provider-injected-sport";
  const unboundedText = JSON.stringify(unbounded);
  assert.throws(
    () =>
      analyzeTruth(
        unboundedText,
        parseTruthSidecar(sidecarText(unboundedText)),
      ),
    /invalid-evidence/,
  );
});

test("truth CLI publishes atomically and never overwrites an analysis", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "fte-game-state-truth-"));
  const evidencePath = path.join(directory, "evidence.json");
  const truthPath = path.join(directory, "truth.jsonl");
  const outputPath = path.join(directory, "analysis.json");
  const evidenceText = `${JSON.stringify(evidence())}\n`;
  await writeFile(evidencePath, evidenceText);
  await writeFile(truthPath, sidecarText(evidenceText));
  const result = await runTruthCli([
    "analyze",
    "--evidence",
    evidencePath,
    "--truth",
    truthPath,
    "--output",
    outputPath,
  ]);
  assert.equal(result.counts.match, 1);
  const first = await readFile(outputPath, "utf8");
  await assert.rejects(
    runTruthCli([
      "analyze",
      "--evidence",
      evidencePath,
      "--truth",
      truthPath,
      "--output",
      outputPath,
    ]),
    /configuration/,
  );
  assert.equal(await readFile(outputPath, "utf8"), first);
});
