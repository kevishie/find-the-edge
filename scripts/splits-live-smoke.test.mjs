import assert from "node:assert/strict";
import test from "node:test";
import { runSplitsLiveSmoke } from "./splits-live-smoke.mjs";

const NOW = new Date("2026-08-07T18:00:00.000Z");
const game = (id) => ({ id, status: "scheduled" });
const split = (id, canonicalEventId, scope, overrides = {}) => ({
  id,
  canonicalEventId,
  scope,
  betPercent: 45,
  moneyPercent: 55,
  providerTimestamp: "2026-08-07T17:50:00.000Z",
  retrievedAt: "2026-08-07T17:51:00.000Z",
  ...overrides,
});
const page = (items) => ({
  items,
  nextCursor: null,
  evaluationState: "complete",
  hasMoreUnknown: false,
});
const fetcherFor =
  ({ games, splits, statuses = {} }) =>
  async (input) => {
    const endpoint = new URL(input).pathname.slice(1);
    return new Response(
      JSON.stringify(page(endpoint === "games" ? games : splits)),
      { status: statuses[endpoint] ?? 200 },
    );
  };

test("accepts unique complete current MLB coverage with DraftKings and Circa", async () => {
  const games = [game("event:one"), game("event:two")];
  const splits = [
    {
      ...games[0],
      splits: [
        split("dk", "event:one", "draftkings"),
        split("circa", "event:one", "circa"),
      ],
    },
    { ...games[1], splits: [] },
  ];
  const result = await runSplitsLiveSmoke({
    apiBase: "https://api.example.test",
    day: "2026-08-07",
    now: NOW,
    maxAgeMinutes: 30,
    fetcher: fetcherFor({ games, splits }),
  });
  assert.deepEqual(result, {
    day: "2026-08-07",
    scheduledGames: 2,
    splitGames: 2,
    observationCount: 2,
    scopes: ["circa", "draftkings"],
    freshestAt: "2026-08-07T17:51:00.000Z",
    mode: "book-scoped",
  });
});

test("fails closed for endpoint, coverage, identity, scope, percentage, and freshness errors", async () => {
  const games = [game("event:one"), game("event:two")];
  const validSplits = [
    {
      ...games[0],
      splits: [
        split("dk", "event:one", "draftkings"),
        split("circa", "event:one", "circa"),
      ],
    },
    { ...games[1], splits: [] },
  ];
  const cases = [
    {
      expected: "splits-endpoint-unavailable",
      fetcher: fetcherFor({
        games,
        splits: validSplits,
        statuses: { splits: 503 },
      }),
    },
    {
      expected: "splits-scheduled-coverage-incomplete",
      fetcher: fetcherFor({ games, splits: validSplits.slice(0, 1) }),
    },
    {
      expected: "splits-game-identity-invalid",
      fetcher: fetcherFor({ games, splits: [validSplits[0], validSplits[0]] }),
    },
    {
      expected: "splits-observation-invalid",
      fetcher: fetcherFor({
        games,
        splits: [
          {
            ...validSplits[0],
            splits: [split("bad", "event:one", "fanduel")],
          },
          validSplits[1],
        ],
      }),
    },
    {
      expected: "splits-observation-invalid",
      fetcher: fetcherFor({
        games,
        splits: [
          {
            ...validSplits[0],
            splits: [
              split("bad", "event:one", "draftkings", { betPercent: 101 }),
            ],
          },
          validSplits[1],
        ],
      }),
    },
    {
      expected: "splits-observation-invalid",
      fetcher: fetcherFor({
        games,
        splits: [
          {
            ...validSplits[0],
            splits: [
              split("duplicate", "event:one", "draftkings"),
              split("duplicate", "event:one", "circa"),
            ],
          },
          validSplits[1],
        ],
      }),
    },
    {
      expected: "splits-evidence-stale",
      fetcher: fetcherFor({
        games,
        splits: validSplits.map((item) => ({
          ...item,
          splits: item.splits.map((observation) => ({
            ...observation,
            providerTimestamp: "2026-08-07T15:00:00.000Z",
            retrievedAt: "2026-08-07T15:01:00.000Z",
          })),
        })),
      }),
    },
    {
      expected: "splits-evidence-stale",
      fetcher: fetcherFor({
        games,
        splits: validSplits.map((item) => ({
          ...item,
          splits: item.splits.map((observation) => ({
            ...observation,
            providerTimestamp: "2026-08-07T15:00:00.000Z",
          })),
        })),
      }),
    },
  ];
  for (const { expected, fetcher } of cases)
    await assert.rejects(
      runSplitsLiveSmoke({
        apiBase: "https://api.example.test",
        day: "2026-08-07",
        now: NOW,
        maxAgeMinutes: 30,
        fetcher,
      }),
      new RegExp(expected),
    );
});

test("allows consensus only through the explicit degraded fallback switch", async () => {
  const games = [game("event:one")];
  const splits = [
    {
      ...games[0],
      splits: [split("consensus", "event:one", "consensus")],
    },
  ];
  const fetcher = fetcherFor({ games, splits });
  await assert.rejects(
    runSplitsLiveSmoke({
      apiBase: "https://api.example.test",
      day: "2026-08-07",
      now: NOW,
      fetcher,
    }),
    /splits-observation-invalid/,
  );
  await assert.doesNotReject(
    runSplitsLiveSmoke({
      apiBase: "https://api.example.test",
      day: "2026-08-07",
      now: NOW,
      fetcher,
      allowConsensusFallback: true,
    }),
  );
});
