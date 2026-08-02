import { describe, expect, it, vi } from "vitest";

import { createGamesClient, GamesClientError } from "./api";
import type { RuntimeBootstrap } from "./runtime-config";

const payload = {
  items: [
    {
      id: "event:mlb%3Amlb:fixture-1",
      version: 1,
      sportKey: "mlb",
      leagueKey: "mlb",
      competition: { key: "mlb", state: "provisional" },
      participants: [
        { id: "participant:mlb:boston", label: "Boston" },
        { id: "participant:mlb:new-york", label: "New York" },
      ],
      startsAt: "2026-08-01T23:05:00.000Z",
      eastern: {
        timeZone: "America/New_York",
        calendarDay: "2026-08-01",
        display: "Aug 1, 2026, 7:05 PM",
      },
      status: "scheduled",
      freshness: "2026-08-01T12:30:00.000Z",
      odds: {
        state: "available",
        selections: [
          {
            marketKey: "moneyline",
            selectionKey: "away",
            selectionLabel: "Boston",
            sportsbookId: "fixture-book",
            sportsbookLabel: "Fixture Book",
            americanOdds: 120,
            observedAt: "2026-08-01T12:00:00.000Z",
            retrievedAt: "2026-08-01T12:00:00.000Z",
          },
        ],
      },
    },
  ],
  nextCursor: null,
  projectionState: "ready",
  evaluationState: "complete",
  hasMoreUnknown: false,
  snapshotAt: "2026-08-01T12:30:00.000Z",
  freshness: "2026-08-01T12:30:00.000Z",
};

const bootstrap = (token = "safe-token"): RuntimeBootstrap => ({
  config: {
    schemaVersion: 1,
    apiBase: "https://api.example.test",
    tokenProviderKey: "session",
  },
  acquireAccessToken: vi.fn().mockResolvedValue({ ok: true, value: token }),
});

describe("games client", () => {
  it("uses the B2 bootstrap token and exact games request", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify(payload)));
    const result = createGamesClient({ ok: true, value: bootstrap() }, fetcher);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    await expect(
      result.value.list(
        { sport: "mlb", day: "2026-08-01" },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ items: [{ id: payload.items[0]!.id }] });
    expect(fetcher).toHaveBeenCalledWith(
      "https://api.example.test/games?sport=mlb&league=mlb&status=scheduled&day=2026-08-01&limit=50",
      expect.objectContaining({
        headers: { authorization: "Bearer safe-token" },
      }),
    );
  });

  it.each([
    [
      "wrong sport",
      { ...payload, items: [{ ...payload.items[0], sportKey: "soccer" }] },
    ],
    [
      "wrong day",
      {
        ...payload,
        items: [{ ...payload.items[0], startsAt: "2026-08-02T17:10:00.000Z" }],
      },
    ],
    ["extra key", { ...payload, unexpected: true }],
    [
      "duplicate participant",
      {
        ...payload,
        items: [
          {
            ...payload.items[0],
            participants: [
              payload.items[0]!.participants[0]!,
              payload.items[0]!.participants[0]!,
            ],
          },
        ],
      },
    ],
    ["pagination", { ...payload, nextCursor: "hidden-page" }],
    [
      "unrelated market",
      {
        ...payload,
        items: [
          {
            ...payload.items[0],
            odds: {
              ...payload.items[0]!.odds,
              selections: [
                {
                  ...payload.items[0]!.odds.selections[0],
                  marketKey: "run_line",
                },
              ],
            },
          },
        ],
      },
    ],
    [
      "unrelated sportsbook",
      {
        ...payload,
        items: [
          {
            ...payload.items[0],
            odds: {
              ...payload.items[0]!.odds,
              selections: [
                {
                  ...payload.items[0]!.odds.selections[0],
                  sportsbookId: "other-book",
                },
              ],
            },
          },
        ],
      },
    ],
    [
      "selection label not bound to away participant",
      {
        ...payload,
        items: [
          {
            ...payload.items[0],
            odds: {
              ...payload.items[0]!.odds,
              selections: [
                {
                  ...payload.items[0]!.odds.selections[0],
                  selectionLabel: "New York",
                },
              ],
            },
          },
        ],
      },
    ],
  ])("rejects %s response binding", async (_name, body) => {
    const result = createGamesClient(
      { ok: true, value: bootstrap() },
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response(JSON.stringify(body))),
    );
    if (!result.ok) throw result.error;
    await expect(
      result.value.list(
        { sport: "mlb", day: "2026-08-01" },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "invalid-response" });
  });

  it("returns bootstrap failures without a client", () => {
    const result = createGamesClient({
      ok: false,
      error: {
        kind: "runtime-config-error",
        code: "missing-config",
        message: "Runtime configuration has not been installed.",
      },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeInstanceOf(GamesClientError);
    expect(result.error.code).toBe("configuration");
  });
});
