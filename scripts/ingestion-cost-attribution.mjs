#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const NAMESPACE = "FindTheEdge/DynamoCapacity";
const METRICS = ["ReadCapacityUnits", "WriteCapacityUnits"];
const DEFAULT_PRICING = {
  currency: "USD",
  readCapacityUnitPerMillion: 0.125,
  writeCapacityUnitPerMillion: 0.625,
};

const record = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value
    : undefined;

const finite = (value) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

const requireRows = (name, value) => {
  if (!Array.isArray(value) || value.length === 0)
    throw new Error(`required-series-empty:${name}`);
  return value;
};

const sum = (values) => values.reduce((total, value) => total + value, 0);

const sumDatapoints = (name, datapoints) => {
  const rows = requireRows(name, datapoints);
  const values = rows.map((row) => record(row)?.Sum).filter(finite);
  if (values.length === 0) throw new Error(`required-series-empty:${name}`);
  return sum(values);
};

const safePrefix = (value) => {
  if (typeof value !== "string") return "UNATTRIBUTED";
  const control = /^ODDS_CONTROL#([A-Z][A-Z0-9_]{0,23})(?:#|$)/.exec(value);
  if (control) return `ODDS_CONTROL#${control[1]}`;
  const general = /^([A-Z][A-Z0-9_]{1,31})(?:#|$)/.exec(value);
  return general?.[1] ?? "UNATTRIBUTED";
};

const bounded = (value, pattern, fallback) =>
  typeof value === "string" && pattern.test(value) ? value : fallback;

const parseUtcDay = (name, value) => {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value))
    throw new Error(`invalid-${name}:expected-YYYY-MM-DD`);
  const date = new Date(`${value}T00:00:00.000Z`);
  if (date.toISOString().slice(0, 10) !== value)
    throw new Error(`invalid-${name}:expected-calendar-day`);
  return date;
};

export const validateWindow = (from, to, now = new Date()) => {
  const start = parseUtcDay("from", from);
  const end = parseUtcDay("to", to);
  if (start >= end) throw new Error("invalid-window:from-must-precede-to");
  const today = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  if (end > today) throw new Error("invalid-window:to-must-be-closed-utc-day");
  return {
    from,
    to,
    startTime: start.toISOString(),
    endTimeExclusive: end.toISOString(),
  };
};

const normalizeNative = (native) =>
  requireRows("native", native).map((row, index) => {
    const value = record(row);
    if (!value) throw new Error(`required-series-invalid:native:${index}`);
    const resource = bounded(
      value.resource,
      /^(?:table|index:[A-Za-z0-9_.-]{1,128})$/,
      undefined,
    );
    if (!resource)
      throw new Error(`required-series-invalid:native:${index}:resource`);
    return {
      resource,
      readUnits: sumDatapoints(`native:${resource}:read`, value.readDatapoints),
      writeUnits: sumDatapoints(
        `native:${resource}:write`,
        value.writeDatapoints,
      ),
    };
  });

const normalizeCustom = (custom, stage) =>
  requireRows("custom", custom).map((row, index) => {
    const value = record(row);
    if (!value) throw new Error(`required-series-invalid:custom:${index}`);
    if (value.stage !== stage)
      throw new Error(`required-series-invalid:custom:${index}:stage`);
    const prefix = safePrefix(value.prefix);
    const operation = bounded(
      value.operation,
      /^[a-z][a-z0-9-]{0,31}$/,
      "unknown",
    );
    const resource = value.resource === "index" ? "index" : "table";
    const readUnits = sumDatapoints(
      `custom:${index}:read`,
      value.readDatapoints,
    );
    const writeUnits = sumDatapoints(
      `custom:${index}:write`,
      value.writeDatapoints,
    );
    return { prefix, operation, resource, readUnits, writeUnits };
  });

const normalizeContributorInsights = (rules) => {
  const grouped = new Map();
  for (const [ruleIndex, ruleValue] of requireRows(
    "contributorInsights",
    rules,
  ).entries()) {
    const rule = record(ruleValue);
    const contributors = requireRows(
      `contributorInsights:${ruleIndex}:contributors`,
      rule?.contributors,
    );
    for (const [index, contributorValue] of contributors.entries()) {
      const contributor = record(contributorValue);
      const rawKeys = contributor?.keys;
      const accessCount = contributor?.accessCount;
      if (
        !Array.isArray(rawKeys) ||
        rawKeys.length === 0 ||
        !finite(accessCount)
      )
        throw new Error(
          `required-series-invalid:contributorInsights:${ruleIndex}:${index}`,
        );
      // Full contributor keys are deliberately reduced in memory and never
      // copied to the baseline artifact.
      const prefixes = new Set(rawKeys.map(safePrefix));
      const prefix = prefixes.size === 1 ? [...prefixes][0] : "UNATTRIBUTED";
      grouped.set(prefix, (grouped.get(prefix) ?? 0) + accessCount);
    }
  }
  return [...grouped]
    .map(([prefix, accessCount]) => ({ prefix, accessCount }))
    .sort((left, right) => right.accessCount - left.accessCount);
};

const normalizeBilling = (billing, stackName) => {
  const envelope = record(billing);
  const scope = record(envelope?.scope);
  if (envelope?.settled !== true)
    throw new Error("required-series-invalid:billing:not-settled");
  if (
    scope?.kind !== "cost-allocation-tag" ||
    typeof scope.key !== "string" ||
    scope.value !== stackName
  )
    throw new Error("required-series-invalid:billing:scope");
  const rows = requireRows("billing", envelope?.rows).map((row, index) => {
    const value = record(row);
    if (
      !value ||
      typeof value.usageType !== "string" ||
      !finite(value.cost) ||
      value.currency !== "USD"
    )
      throw new Error(`required-series-invalid:billing:${index}`);
    return {
      usageType: value.usageType.slice(0, 128),
      cost: value.cost,
      currency: "USD",
    };
  });
  if (sum(rows.map(({ cost }) => cost)) <= 0)
    throw new Error("required-series-empty:billing:positive-cost");
  return { rows, scope };
};

const aggregatePrefixes = (custom) => {
  const grouped = new Map();
  for (const row of custom) {
    const current = grouped.get(row.prefix) ?? {
      prefix: row.prefix,
      readUnits: 0,
      writeUnits: 0,
    };
    current.readUnits += row.readUnits;
    current.writeUnits += row.writeUnits;
    grouped.set(row.prefix, current);
  }
  return [...grouped.values()];
};

const percentage = (numerator, denominator) =>
  denominator === 0 ? 0 : Number(((numerator / denominator) * 100).toFixed(4));

export const buildBaseline = ({
  stage,
  from,
  to,
  identity,
  stack,
  native,
  custom,
  contributorInsights,
  billing,
  pricing = DEFAULT_PRICING,
  now = new Date(),
}) => {
  const window = validateWindow(from, to, now);
  if (!["staging", "prod"].includes(stage))
    throw new Error("invalid-stage:expected-staging-or-prod");
  const safeIdentity = record(identity);
  const safeStack = record(stack);
  const safeTable = record(safeStack?.table);
  if (
    !/^\d{12}$/.test(safeIdentity?.account ?? "") ||
    !/^[a-z]{2}-[a-z]+-\d$/.test(safeIdentity?.region ?? "") ||
    safeStack?.name !== `FindTheEdge-${stage}-Foundation` ||
    typeof safeTable?.name !== "string" ||
    !safeTable.name ||
    typeof safeTable?.arn !== "string" ||
    !safeTable.arn.endsWith(`:table/${safeTable.name}`)
  )
    throw new Error("stack-table-resolution-invalid");

  const nativeRows = normalizeNative(native);
  const customRows = normalizeCustom(custom, stage);
  const accessEvidence = normalizeContributorInsights(contributorInsights);
  const billingEvidence = normalizeBilling(billing, safeStack.name);
  const billingRows = billingEvidence.rows;
  const prefixRows = aggregatePrefixes(customRows);
  const nativeRead = sum(nativeRows.map(({ readUnits }) => readUnits));
  const nativeWrite = sum(nativeRows.map(({ writeUnits }) => writeUnits));
  const customRead = sum(customRows.map(({ readUnits }) => readUnits));
  const customWrite = sum(customRows.map(({ writeUnits }) => writeUnits));
  if (nativeRead + nativeWrite <= 0)
    throw new Error("required-series-empty:native:positive-capacity");
  if (customRead + customWrite <= 0)
    throw new Error("required-series-empty:custom:positive-capacity");
  if (customRead > nativeRead * 1.01 || customWrite > nativeWrite * 1.01)
    throw new Error("custom-capacity-exceeds-native");

  const named = prefixRows.filter(
    ({ prefix }) => !["MIXED", "UNATTRIBUTED"].includes(prefix),
  );
  const attributableUnits = sum(
    named.map(({ readUnits, writeUnits }) => readUnits + writeUnits),
  );
  if (attributableUnits <= 0)
    throw new Error("required-series-empty:attributable-prefixes");
  const topFive = named
    .map((row) => ({
      ...row,
      capacitySharePercent: percentage(
        row.readUnits + row.writeUnits,
        nativeRead + nativeWrite,
      ),
      readSharePercent: percentage(row.readUnits, nativeRead),
      writeSharePercent: percentage(row.writeUnits, nativeWrite),
    }))
    .sort(
      (left, right) =>
        right.readUnits + right.writeUnits - (left.readUnits + left.writeUnits),
    )
    .slice(0, 5);
  const explicit = prefixRows.filter(({ prefix }) =>
    ["MIXED", "UNATTRIBUTED"].includes(prefix),
  );
  const observedCost = sum(billingRows.map(({ cost }) => cost));
  const estimatedCost =
    (nativeRead / 1_000_000) * pricing.readCapacityUnitPerMillion +
    (nativeWrite / 1_000_000) * pricing.writeCapacityUnitPerMillion;
  const variancePercent = percentage(
    Math.abs(estimatedCost - observedCost),
    observedCost,
  );
  if (variancePercent > 15)
    throw new Error(
      `cost-reconciliation-outside-15-percent:${variancePercent}`,
    );

  return {
    schemaVersion: 1,
    generatedAt: now.toISOString(),
    stage,
    window: { ...window, semantics: "[from,to) complete UTC days" },
    source: {
      account: safeIdentity.account,
      region: safeIdentity.region,
      stackName: safeStack.name,
      tableName: safeTable.name,
      tableArn: safeTable.arn,
      globalSecondaryIndexes: Array.isArray(safeTable.globalSecondaryIndexes)
        ? safeTable.globalSecondaryIndexes
            .filter((value) => /^[A-Za-z0-9_.-]{1,128}$/.test(value))
            .sort()
        : [],
    },
    nativeCapacity: {
      resources: nativeRows,
      totalReadUnits: nativeRead,
      totalWriteUnits: nativeWrite,
    },
    attributedCapacity: {
      namespace: NAMESPACE,
      topFivePrefixes: topFive,
      explicitResidual: explicit,
      unobservedResidual: {
        prefix: "UNATTRIBUTED",
        readUnits: Math.max(0, nativeRead - customRead),
        writeUnits: Math.max(0, nativeWrite - customWrite),
      },
    },
    contributorInsights: {
      interpretation: "access frequency only; not consumed-capacity share",
      prefixAccessEvidence: accessEvidence,
    },
    costReconciliation: {
      pricing: {
        ...pricing,
        model: "native table-plus-index request units",
      },
      billingUsage: billingRows,
      billingScope: billingEvidence.scope,
      estimatedCost: Number(estimatedCost.toFixed(6)),
      observedSettledCost: Number(observedCost.toFixed(6)),
      variancePercent,
      within15Percent: true,
    },
  };
};

const awsJson = (service, operation, args, { region }) => {
  const output = execFileSync(
    "aws",
    [
      service,
      operation,
      ...args,
      "--region",
      region,
      "--output",
      "json",
      "--no-cli-pager",
    ],
    { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
  );
  const parsed = JSON.parse(output);
  if (!record(parsed))
    throw new Error(`aws-response-invalid:${service}:${operation}`);
  return parsed;
};

const metricDatapoints = (namespace, metricName, dimensions, options) => {
  const result = awsJson(
    "cloudwatch",
    "get-metric-statistics",
    [
      "--namespace",
      namespace,
      "--metric-name",
      metricName,
      "--dimensions",
      ...dimensions.map(({ Name, Value }) => `Name=${Name},Value=${Value}`),
      "--start-time",
      options.startTime,
      "--end-time",
      options.endTimeExclusive,
      "--period",
      String(options.period),
      "--statistics",
      "Sum",
    ],
    options,
  );
  return result.Datapoints ?? [];
};

const resolveInfrastructure = (stage, options) => {
  const stackName = `FindTheEdge-${stage}-Foundation`;
  const stacks = awsJson(
    "cloudformation",
    "describe-stacks",
    ["--stack-name", stackName],
    options,
  ).Stacks;
  if (!Array.isArray(stacks) || stacks.length !== 1)
    throw new Error("stack-table-resolution-invalid");
  const resources = awsJson(
    "cloudformation",
    "list-stack-resources",
    ["--stack-name", stackName],
    options,
  ).StackResourceSummaries;
  const allTables = (Array.isArray(resources) ? resources : []).filter(
    ({ ResourceType }) => ResourceType === "AWS::DynamoDB::Table",
  );
  const tables = allTables.filter(({ LogicalResourceId }) =>
    LogicalResourceId.startsWith("EventIngestionTable"),
  );
  if (
    allTables.length !== 1 ||
    tables.length !== 1 ||
    !tables[0].PhysicalResourceId
  )
    throw new Error("stack-table-resolution-invalid");
  const tableName = tables[0].PhysicalResourceId;
  const described = awsJson(
    "dynamodb",
    "describe-table",
    ["--table-name", tableName],
    options,
  ).Table;
  if (!record(described) || described.TableName !== tableName)
    throw new Error("stack-table-resolution-invalid");
  return {
    name: stackName,
    table: {
      name: tableName,
      arn: described.TableArn,
      globalSecondaryIndexes: (described.GlobalSecondaryIndexes ?? []).map(
        ({ IndexName }) => IndexName,
      ),
    },
  };
};

const collectNative = (table, options) => {
  const resources = [
    {
      resource: "table",
      dimensions: [{ Name: "TableName", Value: table.name }],
    },
    ...(table.globalSecondaryIndexes ?? []).map((indexName) => ({
      resource: `index:${indexName}`,
      dimensions: [
        { Name: "TableName", Value: table.name },
        { Name: "GlobalSecondaryIndexName", Value: indexName },
      ],
    })),
  ];
  return resources.map(({ resource, dimensions }) => ({
    resource,
    readDatapoints: metricDatapoints(
      "AWS/DynamoDB",
      "ConsumedReadCapacityUnits",
      dimensions,
      options,
    ),
    writeDatapoints: metricDatapoints(
      "AWS/DynamoDB",
      "ConsumedWriteCapacityUnits",
      dimensions,
      options,
    ),
  }));
};

const collectCustom = (options) => {
  const listed = awsJson(
    "cloudwatch",
    "list-metrics",
    ["--namespace", NAMESPACE],
    options,
  ).Metrics;
  const identities = new Map();
  for (const metric of Array.isArray(listed) ? listed : []) {
    if (!METRICS.includes(metric.MetricName)) continue;
    const dimensions = Array.isArray(metric.Dimensions)
      ? metric.Dimensions
      : [];
    const values = Object.fromEntries(
      dimensions.map(({ Name, Value }) => [Name, Value]),
    );
    if (
      values.Stage !== options.stage ||
      !values.Prefix ||
      !values.Operation ||
      !values.Resource
    )
      continue;
    const key = `${values.Prefix}\0${values.Operation}\0${values.Cause ?? ""}\0${values.Resource}`;
    const identity = identities.get(key) ?? {
      prefix: values.Prefix,
      stage: values.Stage,
      operation: values.Operation,
      resource: values.Resource,
      dimensions,
      metricNames: new Set(),
    };
    identity.metricNames.add(metric.MetricName);
    identities.set(key, identity);
  }
  return [...identities.values()].map((identity) => ({
    prefix: identity.prefix,
    stage: identity.stage,
    operation: identity.operation,
    resource: identity.resource,
    // The producer omits a direction when its units are zero. Absence from
    // list-metrics is therefore a contract-defined structural zero; a listed
    // metric with no datapoints in the requested window still fails loud.
    readDatapoints: identity.metricNames.has("ReadCapacityUnits")
      ? metricDatapoints(
          NAMESPACE,
          "ReadCapacityUnits",
          identity.dimensions,
          options,
        )
      : [{ Sum: 0 }],
    writeDatapoints: identity.metricNames.has("WriteCapacityUnits")
      ? metricDatapoints(
          NAMESPACE,
          "WriteCapacityUnits",
          identity.dimensions,
          options,
        )
      : [{ Sum: 0 }],
  }));
};

const collectContributorInsights = (table, options) => {
  const description = awsJson(
    "dynamodb",
    "describe-contributor-insights",
    ["--table-name", table.name],
    options,
  );
  const rules = requireRows(
    "contributorInsights:rules",
    description.ContributorInsightsRuleList,
  );
  return rules.map((ruleName) => {
    const report = awsJson(
      "cloudwatch",
      "get-insight-rule-report",
      [
        "--rule-name",
        ruleName,
        "--start-time",
        options.startTime,
        "--end-time",
        options.endTimeExclusive,
        "--period",
        String(options.period),
        "--max-contributor-count",
        "25",
        "--metrics",
        "Sum",
        "--order-by",
        "Sum",
      ],
      options,
    );
    return {
      contributors: (report.Contributors ?? []).map((contributor) => ({
        keys: contributor.Keys,
        accessCount: contributor.ApproximateAggregateValue,
      })),
    };
  });
};

const collectBilling = (stack, options) => {
  const result = awsJson(
    "ce",
    "get-cost-and-usage",
    [
      "--time-period",
      `Start=${options.from},End=${options.to}`,
      "--granularity",
      "DAILY",
      "--metrics",
      "UnblendedCost",
      "--filter",
      JSON.stringify({
        And: [
          { Dimensions: { Key: "SERVICE", Values: ["Amazon DynamoDB"] } },
          {
            Tags: {
              Key: options.costAllocationTag,
              Values: [stack.name],
              MatchOptions: ["EQUALS"],
            },
          },
        ],
      }),
      "--group-by",
      "Type=DIMENSION,Key=USAGE_TYPE",
    ],
    options,
  );
  const periods = requireRows("billing:periods", result.ResultsByTime);
  if (periods.some(({ Estimated }) => Estimated !== false))
    throw new Error("required-series-invalid:billing:not-settled");
  const rows = [];
  for (const period of periods) {
    for (const group of period.Groups ?? []) {
      const usageType = group.Keys?.[0];
      if (!/(ReadRequestUnits|WriteRequestUnits)/.test(usageType ?? ""))
        continue;
      const amount = Number(group.Metrics?.UnblendedCost?.Amount);
      rows.push({
        usageType,
        cost: amount,
        currency: group.Metrics?.UnblendedCost?.Unit,
      });
    }
  }
  return {
    settled: true,
    scope: {
      kind: "cost-allocation-tag",
      key: options.costAllocationTag,
      value: stack.name,
    },
    rows,
  };
};

export const collectAwsEvidence = ({
  stage,
  from,
  to,
  region,
  now = new Date(),
}) => {
  const window = validateWindow(from, to, now);
  const durationSeconds =
    (Date.parse(window.endTimeExclusive) - Date.parse(window.startTime)) / 1000;
  const options = {
    ...window,
    from,
    to,
    region,
    stage,
    costAllocationTag: "aws:cloudformation:stack-name",
    period: Math.min(
      86_400,
      Math.max(60, Math.ceil(durationSeconds / 1_440 / 60) * 60),
    ),
  };
  const identityResponse = awsJson("sts", "get-caller-identity", [], options);
  const stack = resolveInfrastructure(stage, options);
  return {
    stage,
    from,
    to,
    now,
    identity: { account: identityResponse.Account, region },
    stack,
    native: collectNative(stack.table, options),
    custom: collectCustom(options),
    contributorInsights: collectContributorInsights(stack.table, options),
    billing: collectBilling(stack, options),
  };
};

const parseArguments = (argv) => {
  const values = {};
  const args = argv[0] === "--" ? argv.slice(1) : argv;
  const allowedNames = new Set([
    "stage",
    "from",
    "to",
    "output",
    "region",
    "fixture",
  ]);
  for (let index = 0; index < args.length; index += 1) {
    const name = args[index];
    const key = name.startsWith("--") ? name.slice(2) : "";
    const value = args[index + 1];
    if (
      name === "--" ||
      !allowedNames.has(key) ||
      values[key] !== undefined ||
      !value?.length ||
      value.startsWith("--")
    )
      throw new Error(`invalid-argument:${name}`);
    values[key] = value;
    index += 1;
  }
  for (const name of ["stage", "from", "to", "output"])
    if (!values[name]) throw new Error(`missing-argument:--${name}`);
  return values;
};

export const runCli = async (argv, { now = new Date() } = {}) => {
  const args = parseArguments(argv);
  const evidence = args.fixture
    ? { ...JSON.parse(await readFile(args.fixture, "utf8")), now }
    : collectAwsEvidence({
        stage: args.stage,
        from: args.from,
        to: args.to,
        region: args.region ?? process.env.AWS_REGION ?? "us-east-1",
        now,
      });
  const baseline = buildBaseline({
    ...evidence,
    stage: args.stage,
    from: args.from,
    to: args.to,
    now,
  });
  // Validation is complete before this sole write. Failed or empty evidence
  // therefore cannot leave a plausible baseline behind.
  writeFileSync(args.output, `${JSON.stringify(baseline, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
  return baseline;
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  runCli(process.argv.slice(2)).catch((error) => {
    process.stderr.write(
      `ingestion-cost-attribution failed: ${error.message}\n`,
    );
    process.exitCode = 1;
  });
}
