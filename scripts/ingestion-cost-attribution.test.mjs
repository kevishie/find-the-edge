import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  buildBaseline,
  validateWindow,
} from "./ingestion-cost-attribution.mjs";

const NOW = new Date("2026-08-13T18:00:00.000Z");

const datapoints = (Sum) => [{ Timestamp: "2026-08-01T00:00:00.000Z", Sum }];

const fixture = () => ({
  stage: "prod",
  from: "2026-08-01",
  to: "2026-08-08",
  identity: { account: "123456789012", region: "us-east-1" },
  stack: {
    name: "FindTheEdge-prod-Foundation",
    table: {
      name: "FindTheEdge-prod-EventIngestion",
      arn: "arn:aws:dynamodb:us-east-1:123456789012:table/FindTheEdge-prod-EventIngestion",
      globalSecondaryIndexes: ["opportunity-rank-v1"],
    },
  },
  native: [
    {
      resource: "table",
      readDatapoints: datapoints(800_000),
      writeDatapoints: datapoints(800_000),
    },
    {
      resource: "index:opportunity-rank-v1",
      readDatapoints: datapoints(200_000),
      writeDatapoints: datapoints(200_000),
    },
  ],
  custom: [
    {
      stage: "prod",
      prefix: "ODDS_CONTROL#RUN",
      operation: "query",
      resource: "table",
      readDatapoints: datapoints(500_000),
      writeDatapoints: datapoints(0),
    },
    {
      stage: "prod",
      prefix: "ODDS_SNAPSHOT",
      operation: "put",
      resource: "table",
      readDatapoints: datapoints(0),
      writeDatapoints: datapoints(600_000),
    },
    {
      stage: "prod",
      prefix: "MIXED",
      operation: "transact-write",
      resource: "table",
      readDatapoints: datapoints(0),
      writeDatapoints: datapoints(100_000),
    },
    {
      stage: "prod",
      prefix: "UNATTRIBUTED",
      operation: "scan",
      resource: "table",
      readDatapoints: datapoints(100_000),
      writeDatapoints: datapoints(0),
    },
  ],
  contributorInsights: [
    {
      contributors: [
        { keys: ["ODDS_CONTROL#RUN#private-run-id"], accessCount: 900 },
        { keys: ["ODDS_SNAPSHOT#private-event-id"], accessCount: 600 },
      ],
    },
  ],
  billing: {
    settled: true,
    scope: {
      kind: "cost-allocation-tag",
      key: "aws:cloudformation:stack-name",
      value: "FindTheEdge-prod-Foundation",
    },
    rows: [
      { usageType: "USE1-ReadRequestUnits", cost: 0.125, currency: "USD" },
      { usageType: "USE1-WriteRequestUnits", cost: 0.625, currency: "USD" },
    ],
  },
});

test("builds sanitized capacity attribution while keeping access frequency separate", () => {
  const result = buildBaseline({ ...fixture(), now: NOW });
  assert.deepEqual(result.window, {
    from: "2026-08-01",
    to: "2026-08-08",
    startTime: "2026-08-01T00:00:00.000Z",
    endTimeExclusive: "2026-08-08T00:00:00.000Z",
    semantics: "[from,to) complete UTC days",
  });
  assert.deepEqual(
    result.attributedCapacity.topFivePrefixes.map(
      ({ prefix, capacitySharePercent }) => ({
        prefix,
        capacitySharePercent,
      }),
    ),
    [
      { prefix: "ODDS_SNAPSHOT", capacitySharePercent: 30 },
      { prefix: "ODDS_CONTROL#RUN", capacitySharePercent: 25 },
    ],
  );
  assert.deepEqual(result.attributedCapacity.explicitResidual, [
    { prefix: "MIXED", readUnits: 0, writeUnits: 100_000 },
    { prefix: "UNATTRIBUTED", readUnits: 100_000, writeUnits: 0 },
  ]);
  assert.deepEqual(result.attributedCapacity.unobservedResidual, {
    prefix: "UNATTRIBUTED",
    readUnits: 400_000,
    writeUnits: 300_000,
  });
  assert.equal(result.costReconciliation.estimatedCost, 0.75);
  assert.equal(result.costReconciliation.observedSettledCost, 0.75);
  assert.equal(result.costReconciliation.within15Percent, true);
  assert.match(
    result.contributorInsights.interpretation,
    /access frequency only/,
  );
  const output = JSON.stringify(result);
  assert.doesNotMatch(output, /private-run-id|private-event-id/);
});

test("rejects open, reversed, or non-day UTC windows", () => {
  assert.throws(
    () => validateWindow("2026-08-01T01:00:00Z", "2026-08-08", NOW),
    /invalid-from/,
  );
  assert.throws(
    () => validateWindow("2026-08-08", "2026-08-01", NOW),
    /from-must-precede-to/,
  );
  assert.throws(
    () => validateWindow("2026-08-08", "2026-08-14", NOW),
    /to-must-be-closed-utc-day/,
  );
});

test("fails loud for every mandatory empty evidence family", () => {
  const cases = [
    ["native", /required-series-empty:native/],
    ["custom", /required-series-empty:custom/],
    ["contributorInsights", /required-series-empty:contributorInsights/],
  ];
  for (const [field, expected] of cases) {
    const evidence = fixture();
    evidence[field] = [];
    assert.throws(() => buildBaseline({ ...evidence, now: NOW }), expected);
  }
  const billingEvidence = fixture();
  billingEvidence.billing.rows = [];
  assert.throws(
    () => buildBaseline({ ...billingEvidence, now: NOW }),
    /required-series-empty:billing/,
  );
  const evidence = fixture();
  evidence.native[0].readDatapoints = [];
  assert.throws(
    () => buildBaseline({ ...evidence, now: NOW }),
    /required-series-empty:native:table:read/,
  );
  const customEvidence = fixture();
  customEvidence.custom[0].readDatapoints = [];
  assert.throws(
    () => buildBaseline({ ...customEvidence, now: NOW }),
    /required-series-empty:custom:0:read/,
  );
});

test("CLI exits nonzero and writes nothing when a required metric is empty", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "fte-cost-attribution-"));
  const fixturePath = path.join(directory, "fixture.json");
  const outputPath = path.join(directory, "baseline.json");
  const evidence = fixture();
  evidence.custom = [];
  await writeFile(fixturePath, JSON.stringify(evidence));
  const result = spawnSync(
    process.execPath,
    [
      path.resolve("scripts/ingestion-cost-attribution.mjs"),
      "--stage",
      "prod",
      "--from",
      "2026-08-01",
      "--to",
      "2026-08-08",
      "--output",
      outputPath,
      "--fixture",
      fixturePath,
    ],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /required-series-empty:custom/);
  await assert.rejects(readFile(outputPath), { code: "ENOENT" });
});

test("rejects a dollar model outside the settled-bill tolerance", () => {
  const evidence = fixture();
  evidence.billing.rows = [
    { usageType: "USE1-ReadRequestUnits", cost: 2, currency: "USD" },
  ];
  assert.throws(
    () => buildBaseline({ ...evidence, now: NOW }),
    /cost-reconciliation-outside-15-percent/,
  );
});

test("rejects unsettled or unlike-scope Cost Explorer evidence", () => {
  const unsettled = fixture();
  unsettled.billing.settled = false;
  assert.throws(
    () => buildBaseline({ ...unsettled, now: NOW }),
    /billing:not-settled/,
  );
  const accountWide = fixture();
  accountWide.billing.scope = { kind: "account-wide" };
  assert.throws(
    () => buildBaseline({ ...accountWide, now: NOW }),
    /billing:scope/,
  );
});
