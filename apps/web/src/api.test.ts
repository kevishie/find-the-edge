import { describe, expect, it, vi } from "vitest";
import type { GameOddsSelectionDto } from "@find-the-edge/domain";
import { assessEventMetadata } from "@find-the-edge/domain";

import {
  createGamesClient,
  GamesClientError,
  isCanonicalEventStatus,
} from "./api";
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
      metadata: assessEventMetadata(
        "scheduled",
        "2026-08-01T12:30:00.000Z",
        "2026-08-01T12:30:00.000Z",
      ),
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
          {
            marketKey: "moneyline",
            selectionKey: "home",
            selectionLabel: "New York",
            sportsbookId: "fixture-book",
            sportsbookLabel: "Fixture Book",
            americanOdds: -135,
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
  unavailableReason: null,
};

const bootstrap = (): RuntimeBootstrap => ({
  config: {
    schemaVersion: 1,
    apiBase: "https://api.example.test",
    tokenProviderKey: "session",
  },
});

describe("games client", () => {
  it.each([
    "scheduled",
    "postponed",
    "cancelled",
    "started",
    "completed",
    "unknown",
  ])(
    "recognizes canonical lifecycle %s for reusable event parsing",
    (status) => {
      expect(isCanonicalEventStatus(status)).toBe(true);
    },
  );

  it("accepts structurally valid metadata with reordered object keys", async () => {
    const metadata = payload.items[0]!.metadata;
    const reordered = {
      reasonCodes: metadata.reasonCodes,
      freshness: {
        missingReason: metadata.freshness.missingReason,
        thresholdSeconds: metadata.freshness.thresholdSeconds,
        ageSeconds: metadata.freshness.ageSeconds,
        evidenceAt: metadata.freshness.evidenceAt,
        state: metadata.freshness.state,
      },
      availability: metadata.availability,
      lifecycle: {
        known: metadata.lifecycle.known,
        state: metadata.lifecycle.state,
      },
      evaluatedAt: metadata.evaluatedAt,
      policyVersion: metadata.policyVersion,
    };
    const client = createGamesClient(
      { ok: true, value: bootstrap() },
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          JSON.stringify({
            ...payload,
            items: [{ ...payload.items[0], metadata: reordered }],
          }),
        ),
      ),
    );
    if (!client.ok) throw client.error;
    await expect(
      client.value.list(
        { sport: "mlb", day: "2026-08-01" },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ items: [{ id: payload.items[0]!.id }] });
  });

  it.each([
    ["items", { items: [payload.items[0]] }],
    ["cursor", { nextCursor: "forged" }],
    ["evaluation", { evaluationState: "partial", hasMoreUnknown: true }],
    ["snapshot", { snapshotAt: payload.snapshotAt }],
    ["freshness", { freshness: payload.freshness }],
    ["reason", { unavailableReason: null }],
  ])(
    "rejects contradictory uninitialized envelope %s",
    async (_case, patch) => {
      const body = {
        ...payload,
        items: [],
        nextCursor: null,
        projectionState: "uninitialized",
        evaluationState: "complete",
        hasMoreUnknown: false,
        snapshotAt: null,
        freshness: null,
        unavailableReason: "projection-uninitialized",
        ...patch,
      };
      const client = createGamesClient(
        { ok: true, value: bootstrap() },
        vi
          .fn<typeof fetch>()
          .mockResolvedValue(new Response(JSON.stringify(body))),
      );
      if (!client.ok) throw client.error;
      await expect(
        client.value.list(
          { sport: "mlb", day: "2026-08-01" },
          new AbortController().signal,
        ),
      ).rejects.toMatchObject({ code: "invalid-response" });
    },
  );

  it.each([null, "2026-08-01T12:29:59.000Z"])(
    "rejects ready envelope freshness %s when it differs from item evidence",
    async (freshness) => {
      const client = createGamesClient(
        { ok: true, value: bootstrap() },
        vi
          .fn<typeof fetch>()
          .mockResolvedValue(
            new Response(JSON.stringify({ ...payload, freshness })),
          ),
      );
      if (!client.ok) throw client.error;
      await expect(
        client.value.list(
          { sport: "mlb", day: "2026-08-01" },
          new AbortController().signal,
        ),
      ).rejects.toMatchObject({ code: "invalid-response" });
    },
  );
  it.each([
    ["missing", undefined],
    [
      "contradictory",
      { ...payload.items[0]!.metadata, availability: "partial" },
    ],
    [
      "forged",
      {
        ...payload.items[0]!.metadata,
        evaluatedAt: "2026-08-01T12:29:59.000Z",
      },
    ],
  ])("rejects %s event metadata", async (_label, metadata) => {
    const item = { ...payload.items[0] } as Record<string, unknown>;
    if (metadata === undefined) delete item["metadata"];
    else item["metadata"] = metadata;
    const client = createGamesClient(
      { ok: true, value: bootstrap() },
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          new Response(JSON.stringify({ ...payload, items: [item] })),
        ),
    );
    if (!client.ok) throw client.error;
    await expect(
      client.value.list(
        { sport: "mlb", day: "2026-08-01" },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "invalid-response" });
  });
  it("exhausts retrospective audit pages without dropping decisions", async () => {
    const versionId = `retrospective-version:${"b".repeat(64)}`;
    const base = {
      retrospectiveId: `retrospective:${"a".repeat(64)}`,
      versionId,
      version: 1,
      predecessorVersionId: null,
      cohortId: `cohort:${"c".repeat(64)}`,
      reportId: `performance-report:${"d".repeat(64)}`,
      reportRevision: 1,
      createdAt: "2026-08-04T00:00:00.000Z",
      state: "approved",
      stateVersion: 2,
      taxonomyVersion: "retrospective-taxonomy-v1",
      evidence: {
        evaluationCutoff: "2026-08-03T00:00:00.000Z",
        decisionTime: [],
        postDecision: [],
        decisionTimeDigest: "e".repeat(64),
        postDecisionDigest: "f".repeat(64),
        manifestDigest: "1".repeat(64),
      },
      slices: [],
      observations: [],
      candidates: [],
      memberCount: 1,
      caution: "single-member",
      falseNegativeEvaluation: "not-evaluable",
      contentDigest: "2".repeat(64),
    };
    const decision = (id: string, at: string) => ({
      decisionId: `retrospective-decision:${id.repeat(64)}`,
      versionId,
      fromState: "draft",
      toState: "approved",
      reasonCode: "approve",
      decidedAt: at,
    });
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ...base,
            audit: {
              items: [decision("3", "2026-08-04T01:00:00.000Z")],
              nextCursor: "next",
            },
          }),
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ...base,
            audit: { items: [decision("4", "2026-08-04T02:00:00.000Z")] },
          }),
        ),
      );
    const result = createGamesClient({ ok: true, value: bootstrap() }, fetcher);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const loaded = await result.value.getRetrospective?.(
      versionId,
      new AbortController().signal,
    );
    expect(loaded?.audit?.items).toHaveLength(2);
    expect(
      loaded?.audit?.items.every((item) =>
        /^retrospective-decision:[a-f0-9]{64}$/.test(item.decisionId),
      ),
    ).toBe(true);
    const secondRequest = fetcher.mock.calls[1]?.[0];
    const secondUrl =
      typeof secondRequest === "string"
        ? secondRequest
        : secondRequest instanceof URL
          ? secondRequest.toString()
          : secondRequest?.url;
    expect(secondUrl).toContain("cursor=next");
  });
  it("enables review only for approval-scoped reviewer-group sessions and sends concurrency guards", async () => {
    const token = `x.${btoa(JSON.stringify({ scope: "events/events:read events/retrospectives:approve", "cognito:groups": ["fte-retrospective-reviewers"] }))}.x`;
    Object.defineProperty(globalThis, "session", {
      configurable: true,
      value: { getAccessToken: vi.fn(() => Promise.resolve(token)) },
    });
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("{}", { status: 409 }));
    const result = createGamesClient({ ok: true, value: bootstrap() }, fetcher);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    await expect(result.value.canReviewRetrospectives?.()).resolves.toBe(true);
    const version = {
      versionId: `retrospective-version:${"a".repeat(64)}`,
      state: "draft",
      stateVersion: 1,
    } as never;
    await expect(
      result.value.reviewRetrospective?.(
        version,
        {
          reasonCode: "approve",
          note: "Reviewed evidence.",
          idempotencyKey: "key-1",
        },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
    });
    const requestBody = fetcher.mock.calls[0]?.[1]?.body;
    expect(typeof requestBody).toBe("string");
    expect(JSON.parse(requestBody as string)).toMatchObject({
      expectedState: "draft",
      expectedStateVersion: 1,
      idempotencyKey: "key-1",
    });
    Reflect.deleteProperty(globalThis, "session");
  });
  it("uses the runtime API base without an authorization header", async () => {
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
    expect(fetcher.mock.calls[0]?.[0]).toBe(
      "https://api.example.test/games?sport=mlb&league=mlb&status=scheduled&day=2026-08-01&limit=50",
    );
    expect(fetcher.mock.calls[0]?.[1]?.headers).toBeUndefined();
  });

  it("accepts a complete ordered soccer three-way market", async () => {
    const soccerPayload = {
      ...payload,
      items: [
        {
          ...payload.items[0],
          id: "event:soccer%3Amls:fixture-1",
          sportKey: "soccer",
          leagueKey: "mls",
          competition: { key: "mls", state: "provisional" },
          participants: [
            { id: "participant:soccer:miami", label: "Miami" },
            { id: "participant:soccer:atlanta", label: "Atlanta" },
          ],
          odds: {
            state: "available",
            selections: [
              {
                ...payload.items[0]!.odds.selections[0],
                marketKey: "moneyline",
                selectionLabel: "Miami",
              },
              {
                ...payload.items[0]!.odds.selections[0],
                marketKey: "moneyline",
                selectionKey: "draw",
                selectionLabel: "Draw",
                americanOdds: 220,
              },
              {
                ...payload.items[0]!.odds.selections[0],
                marketKey: "moneyline",
                selectionKey: "home",
                selectionLabel: "Atlanta",
                americanOdds: 175,
              },
            ],
          },
        },
      ],
    };
    const result = createGamesClient(
      { ok: true, value: bootstrap() },
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response(JSON.stringify(soccerPayload))),
    );
    if (!result.ok) throw result.error;
    await expect(
      result.value.list(
        { sport: "soccer", day: "2026-08-01" },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({
      items: [
        {
          odds: {
            selections: [
              { selectionKey: "away" },
              { selectionKey: "draw" },
              { selectionKey: "home" },
            ],
          },
        },
      ],
    });
  });

  it("accepts coherent spread and total lines with their prices", async () => {
    const base = payload.items[0]!.odds.selections[0]!;
    const selections: GameOddsSelectionDto[] = [
      ...payload.items[0]!.odds.selections,
      {
        ...base,
        marketKey: "spread",
        selectionKey: "away",
        point: 1.5,
        americanOdds: -110,
      },
      {
        ...base,
        marketKey: "spread",
        selectionKey: "home",
        selectionLabel: "New York",
        point: -1.5,
        americanOdds: -110,
      },
      {
        ...base,
        marketKey: "total",
        selectionKey: "over",
        selectionLabel: "Over",
        point: 8.5,
        americanOdds: -105,
      },
      {
        ...base,
        marketKey: "total",
        selectionKey: "under",
        selectionLabel: "Under",
        point: 8.5,
        americanOdds: -115,
      },
    ];
    const fullMarketPayload = {
      ...payload,
      items: [
        {
          ...payload.items[0]!,
          odds: { state: "available", selections },
        },
      ],
    };
    const result = createGamesClient(
      { ok: true, value: bootstrap() },
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response(JSON.stringify(fullMarketPayload))),
    );
    if (!result.ok) throw result.error;
    const page = await result.value.list(
      { sport: "mlb", day: "2026-08-01" },
      new AbortController().signal,
    );
    const odds = page.items[0]?.odds;
    expect(odds?.state).toBe("available");
    if (!odds || odds.state !== "available") return;
    expect(odds.selections).toHaveLength(6);
    expect(odds.selections).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ marketKey: "spread", point: 1.5 }),
        expect.objectContaining({ marketKey: "total", point: 8.5 }),
      ]),
    );
  });

  it.each(["games", "splits"] as const)(
    "exhausts ordered %s pages and forwards the opaque cursor",
    async (endpoint) => {
      const secondGame = {
        ...payload.items[0]!,
        id: "event:mlb%3Amlb:fixture-2",
        startsAt: "2026-08-02T00:05:00.000Z",
        eastern: {
          ...payload.items[0]!.eastern,
          display: "Aug 1, 2026, 8:05 PM",
        },
        freshness: "2026-08-01T12:00:00.000Z",
        metadata: assessEventMetadata(
          "scheduled",
          "2026-08-01T12:00:00.000Z",
          payload.snapshotAt,
        ),
      };
      const withSplits = (item: (typeof payload.items)[0]) => ({
        ...item,
        splits: [
          {
            id: `split:${item.id}`,
            providerId: "sharpapi",
            providerEventId: "provider-event",
            canonicalEventId: item.id,
            canonicalEventVersion: item.version,
            sportKey: "mlb",
            leagueKey: "mlb",
            marketKey: "moneyline",
            selectionKey: "away",
            betPercent: 45,
            moneyPercent: 55,
            betCount: 12_345,
            moneyAmount: 987_654.32,
            providerTimestamp: "2026-08-01T12:30:00.000Z",
            retrievedAt: "2026-08-01T12:30:00.000Z",
            scope: "consensus",
          },
        ],
      });
      const first = {
        ...payload,
        items:
          endpoint === "splits"
            ? [withSplits(payload.items[0]!)]
            : payload.items,
        nextCursor: "opaque+/= cursor",
        evaluationState: "partial",
        hasMoreUnknown: true,
      };
      const second = {
        ...payload,
        items: endpoint === "splits" ? [withSplits(secondGame)] : [secondGame],
        freshness: secondGame.freshness,
      };
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(new Response(JSON.stringify(first)))
        .mockResolvedValueOnce(new Response(JSON.stringify(second)));
      const result = createGamesClient(
        { ok: true, value: bootstrap() },
        fetcher,
      );
      if (!result.ok) throw result.error;
      const page = await (endpoint === "games"
        ? result.value.list(
            { sport: "mlb", day: "2026-08-01" },
            new AbortController().signal,
          )
        : result.value.listSplits!(
            { sport: "mlb", day: "2026-08-01" },
            new AbortController().signal,
          ));
      expect(page).toMatchObject({
        items: [{ id: payload.items[0]!.id }, { id: secondGame.id }],
        nextCursor: null,
        evaluationState: "complete",
        hasMoreUnknown: false,
        freshness: "2026-08-01T12:00:00.000Z",
      });
      if (endpoint === "splits") {
        const splitItem = page.items[0] as (typeof payload.items)[0] & {
          readonly splits: readonly {
            readonly betCount?: number;
            readonly moneyAmount?: number;
          }[];
        };
        expect(splitItem.splits[0]).toMatchObject({
          betCount: 12_345,
          moneyAmount: 987_654.32,
        });
      }
      const secondRequest = fetcher.mock.calls[1]?.[0];
      if (typeof secondRequest !== "string")
        throw new Error("Expected a string request URL.");
      const secondUrl = new URL(secondRequest);
      expect(secondUrl.searchParams.get("cursor")).toBe("opaque+/= cursor");
      expect(secondUrl.searchParams.get("sport")).toBe("mlb");
      expect(secondUrl.searchParams.get("day")).toBe("2026-08-01");
      expect(secondUrl.searchParams.get("limit")).toBe("50");
    },
  );

  it("accepts current split evidence from an earlier canonical schedule version", async () => {
    const game = payload.items[0]!;
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          ...payload,
          items: [
            {
              ...game,
              version: 10,
              splits: [
                {
                  id: "split:older-event-version",
                  providerId: "sharpapi",
                  providerEventId: "provider-event",
                  canonicalEventId: game.id,
                  canonicalEventVersion: 9,
                  sportKey: "mlb",
                  leagueKey: "mlb",
                  marketKey: "moneyline",
                  selectionKey: "away",
                  betPercent: 45,
                  moneyPercent: 55,
                  providerTimestamp: "2026-08-01T12:30:00.000Z",
                  retrievedAt: "2026-08-01T12:30:01.000Z",
                  scope: "consensus",
                },
              ],
            },
          ],
        }),
      ),
    );
    const client = createGamesClient({ ok: true, value: bootstrap() }, fetcher);
    if (!client.ok) throw client.error;
    await expect(
      client.value.listSplits!(
        { sport: "mlb", day: "2026-08-01" },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({
      items: [{ version: 10, splits: [{ canonicalEventVersion: 9 }] }],
    });
  });

  it("continues after a complete page when its authoritative cursor is non-null", async () => {
    const secondGame = {
      ...payload.items[0]!,
      id: "event:mlb%3Amlb:fixture-after-limit",
      startsAt: "2026-08-02T00:05:00.000Z",
      eastern: {
        ...payload.items[0]!.eastern,
        display: "Aug 1, 2026, 8:05 PM",
      },
    };
    const first = { ...payload, nextCursor: "more-physical-rows" };
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify(first)))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ...payload, items: [secondGame] })),
      );
    const result = createGamesClient({ ok: true, value: bootstrap() }, fetcher);
    if (!result.ok) throw result.error;
    await expect(
      result.value.list(
        { sport: "mlb", day: "2026-08-01" },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({
      items: [{ id: payload.items[0]!.id }, { id: secondGame.id }],
      nextCursor: null,
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["negative bet count", { betCount: -1 }],
    ["fractional bet count", { betCount: 1.5 }],
    ["infinite money amount", { moneyAmount: Number.POSITIVE_INFINITY }],
    ["negative money amount", { moneyAmount: -0.01 }],
  ])("rejects splits with %s", async (_name, sample) => {
    const split = {
      id: "split:invalid-sample",
      providerId: "sharpapi",
      providerEventId: "provider-event",
      canonicalEventId: payload.items[0]!.id,
      canonicalEventVersion: 1,
      sportKey: "mlb",
      leagueKey: "mlb",
      marketKey: "moneyline",
      selectionKey: "away",
      betPercent: 45,
      moneyPercent: 55,
      providerTimestamp: "2026-08-01T12:30:00.000Z",
      retrievedAt: "2026-08-01T12:30:00.000Z",
      ...sample,
    };
    const result = createGamesClient(
      { ok: true, value: bootstrap() },
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          JSON.stringify({
            ...payload,
            items: [{ ...payload.items[0]!, splits: [split] }],
          }),
        ),
      ),
    );
    if (!result.ok) throw result.error;
    await expect(
      result.value.listSplits!(
        { sport: "mlb", day: "2026-08-01" },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "invalid-response" });
  });

  it.each([
    [
      "cursor cycle",
      (page: typeof payload) => ({
        ...page,
        nextCursor: "again",
        evaluationState: "partial",
        hasMoreUnknown: true,
      }),
    ],
    [
      "snapshot mismatch",
      (page: typeof payload) => ({
        ...page,
        snapshotAt: "2026-08-01T12:31:00.000Z",
      }),
    ],
    ["duplicate game", (page: typeof payload) => page],
  ])("rejects a paginated %s", async (_name, secondPage) => {
    const first = {
      ...payload,
      nextCursor: "again",
      evaluationState: "partial",
      hasMoreUnknown: true,
    };
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify(first)))
      .mockResolvedValueOnce(new Response(JSON.stringify(secondPage(payload))));
    const result = createGamesClient({ ok: true, value: bootstrap() }, fetcher);
    if (!result.ok) throw result.error;
    await expect(
      result.value.list(
        { sport: "mlb", day: "2026-08-01" },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "invalid-response" });
  });

  it("rejects incoherent pagination metadata", async () => {
    const result = createGamesClient(
      { ok: true, value: bootstrap() },
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          JSON.stringify({
            ...payload,
            evaluationState: "partial",
            hasMoreUnknown: false,
            nextCursor: "cursor",
          }),
        ),
      ),
    );
    if (!result.ok) throw result.error;
    await expect(
      result.value.list(
        { sport: "mlb", day: "2026-08-01" },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "invalid-response" });
  });

  it("bounds pagination and preserves abort errors", async () => {
    const partial = {
      ...payload,
      items: [],
      freshness: null,
      evaluationState: "partial",
      hasMoreUnknown: true,
    };
    let call = 0;
    const boundedFetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({ ...partial, nextCursor: `cursor-${call++}` }),
          ),
        ),
      );
    const bounded = createGamesClient(
      { ok: true, value: bootstrap() },
      boundedFetcher,
    );
    if (!bounded.ok) throw bounded.error;
    await expect(
      bounded.value.list(
        { sport: "mlb", day: "2026-08-01" },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "invalid-response" });
    expect(boundedFetcher).toHaveBeenCalledTimes(100);

    const controller = new AbortController();
    const abortError = new DOMException("Aborted", "AbortError");
    const abortFetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ...partial, nextCursor: "abort-next" })),
      )
      .mockImplementationOnce(() => {
        controller.abort();
        return Promise.reject(abortError);
      });
    const aborted = createGamesClient(
      { ok: true, value: bootstrap() },
      abortFetcher,
    );
    if (!aborted.ok) throw aborted.error;
    await expect(
      aborted.value.list(
        { sport: "mlb", day: "2026-08-01" },
        controller.signal,
      ),
    ).rejects.toBe(abortError);
    expect(abortFetcher).toHaveBeenCalledTimes(2);
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
      "extra participant",
      {
        ...payload,
        items: [
          {
            ...payload.items[0],
            participants: [
              ...payload.items[0]!.participants,
              { id: "participant:mlb:extra", label: "Extra" },
            ],
          },
        ],
      },
    ],
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
    [
      "incomplete market",
      {
        ...payload,
        items: [
          {
            ...payload.items[0],
            odds: {
              ...payload.items[0]!.odds,
              selections: [payload.items[0]!.odds.selections[0]],
            },
          },
        ],
      },
    ],
    [
      "wrong market order",
      {
        ...payload,
        items: [
          {
            ...payload.items[0],
            odds: {
              ...payload.items[0]!.odds,
              selections: [...payload.items[0]!.odds.selections].reverse(),
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
