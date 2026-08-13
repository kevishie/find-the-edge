/**
 * Replay a captured SharpAPI odds payload through the REAL ingestion path and
 * report, per provider event, what it would do — without writing anything.
 *
 * Reads (mappings, canonical events) hit the real table. The two write paths,
 * `ingestEvent` and `reconcileScheduledEvent`, are recorded and refused:
 * reaching `reconcileScheduledEvent` is how a row mints a NEW canonical event,
 * which is the duplicate-fixture hazard that makes the combined
 * MLS+leagues_cup request dangerous. It must be counted, never performed.
 *
 * Each event is replayed on its own single-event page so one failure cannot
 * mask the rest — the point is a census of every row, not the first throw.
 *
 * Usage (bundle first; the sources are TypeScript):
 *   pnpm esbuild scripts/replay-odds-capture.mjs --bundle --platform=node \
 *     --format=esm --outfile=/tmp/replay.mjs --packages=external
 *   FTE_EVENT_TABLE=<table> node /tmp/replay.mjs <capture.json> [leagueKey]
 */
import { readFileSync } from "node:fs";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { parseSharpApiOddsPage } from "../packages/providers/src/sharp-api.ts";
import {
  AwsDynamoGateway,
  DynamoEventIngestionStore,
} from "../packages/database/src/index.ts";
import { persistSharpApiOddsPage } from "../apps/workers/src/sharp-api-ingestion.ts";
import { productionOddsCollectionPolicies } from "../packages/config/src/index.ts";

const [capturePath, leagueKey = "mls"] = process.argv.slice(2);
const tableName = process.env["FTE_EVENT_TABLE"];
if (!capturePath || !tableName)
  throw new Error("usage: FTE_EVENT_TABLE=<table> node replay.mjs <capture>");

const league = {
  sportKey: "soccer",
  leagueKey,
  providerLeague: "MLS,leagues_cup",
};

// The real entitled-book roles for this league. A stubbed role map would
// reject every price as an unknown bookmaker and make the census meaningless.
const policies = Array.isArray(productionOddsCollectionPolicies)
  ? productionOddsCollectionPolicies
  : Object.values(productionOddsCollectionPolicies);
const bookRoles =
  policies.find((p) => p.leagueKey === leagueKey)?.providers?.[0]?.books ?? {};
console.log(
  `book roles for ${leagueKey}: ${Object.keys(bookRoles).length} configured`,
);

const documentClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const real = new DynamoEventIngestionStore(
  new AwsDynamoGateway(documentClient, tableName),
);

let attempted = { ingestEvent: 0, reconcile: 0 };
const store = new Proxy(real, {
  get(target, prop, receiver) {
    if (prop === "ingestEvent")
      return async () => {
        attempted.ingestEvent += 1;
        return { kind: "unresolved", reason: "no-candidate" };
      };
    if (prop === "reconcileScheduledEvent")
      return async () => {
        attempted.reconcile += 1;
        return { kind: "unresolved", reason: "no-candidate" };
      };
    const value = Reflect.get(target, prop, receiver);
    return typeof value === "function" ? value.bind(target) : value;
  },
});

// Parse every captured page through the real parser, then dedupe by provider
// event id exactly as the paginated loader does.
const pages = JSON.parse(readFileSync(capturePath, "utf8"));
const events = new Map();
let retrievedAt;
pages.forEach((payload, index) => {
  const parsed = parseSharpApiOddsPage(
    payload,
    league,
    new Date().toISOString(),
    200,
    index === 0 ? "initial" : "cursor",
  );
  retrievedAt ??= parsed.retrievedAt;
  for (const event of parsed.events)
    if (!events.has(event.providerEventId))
      events.set(event.providerEventId, event);
});

console.log(
  `parsed ${events.size} distinct events from ${pages.length} page(s)\n`,
);

const outcomes = new Map();
const record = (bucket, id) => {
  if (!outcomes.has(bucket)) outcomes.set(bucket, []);
  outcomes.get(bucket).push(id);
};

for (const [providerEventId, event] of events) {
  const before = { ...attempted };
  try {
    const result = await persistSharpApiOddsPage(
      store,
      { persist: async () => ({}) },
      league,
      { retrievedAt, events: [event] },
      bookRoles,
    );
    const mintAttempted = attempted.reconcile > before.reconcile;
    const rejected = Object.entries(result.rejectionCounts ?? {})
      .filter(([, n]) => n > 0)
      .map(([reason]) => reason);
    if (mintAttempted)
      record("WOULD MINT a new canonical event", providerEventId);
    else if (result.observations > 0)
      record(`priced (${rejected.join(",") || "clean"})`, providerEventId);
    else
      record(
        `no observations (${rejected.join(",") || "none"})`,
        providerEventId,
      );
  } catch (error) {
    const mintAttempted = attempted.reconcile > before.reconcile;
    record(
      `${mintAttempted ? "WOULD MINT then " : ""}THREW ${error instanceof Error ? error.message : String(error)}`,
      providerEventId,
    );
  }
}

for (const [bucket, ids] of [...outcomes].sort(
  (a, b) => b[1].length - a[1].length,
)) {
  console.log(`${String(ids.length).padStart(3)}  ${bucket}`);
  for (const id of ids.slice(0, 4)) console.log(`       ${id}`);
  if (ids.length > 4) console.log(`       … ${ids.length - 4} more`);
}
console.log(
  `\nwrite attempts refused — ingestEvent: ${attempted.ingestEvent}, reconcileScheduledEvent: ${attempted.reconcile}`,
);
