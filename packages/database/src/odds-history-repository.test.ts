import { describe, expect, it } from "vitest";
import { normalizeFixtureOddsObservation } from "@find-the-edge/domain";
import { impliedProbability } from "@find-the-edge/odds";
import { EventCursorCodec } from "./event-repository";
import {
  JoinedOddsHistoryRepository,
  MemoryOddsHistoryRepository,
  OddsHistoryInputError,
  OddsHistoryStorageError,
  oddsHistoryPartition,
  type OddsHistoryStoredRow,
} from "./odds-history-repository";

const eventId = "event:mlb:history";
const cursor = new EventCursorCodec({
  current: { id: "test", secret: new Uint8Array(32).fill(7) },
});
const sharpProvenance = {
  providerId: "sharpapi",
  policyVersion: "v1",
  bookRole: "comparison",
  sourceState: "active",
} as const;
const snapshot = (
  sportsbookId: string,
  observedAt: string,
  americanOdds: number,
  options: {
    version?: number;
    marketKey?: string;
    selectionKey?: string;
    point?: number;
  } = {},
) =>
  normalizeFixtureOddsObservation({
    canonicalEventId: eventId,
    canonicalEventVersion: options.version ?? 1,
    sportKey: "mlb",
    marketKey: options.marketKey ?? "moneyline",
    selectionKey: options.selectionKey ?? "participant:away",
    selectionLabel: "Away",
    sportsbookId,
    sportsbookLabel: `untrusted-${sportsbookId}`,
    ...(options.point === undefined ? {} : { point: options.point }),
    americanOdds,
    observedAt,
    retrievedAt: observedAt,
    provenance: sharpProvenance,
  });

describe("odds history repository", () => {
  it("projects continuous chronological all-book series across canonical event versions", async () => {
    const repository = new MemoryOddsHistoryRepository(
      [
        snapshot("draftkings", "2026-08-05T12:10:00.000Z", -115, {
          version: 2,
        }),
        snapshot("draftkings", "2026-08-05T12:00:00.000Z", -110),
        snapshot("pinnacle", "2026-08-05T12:05:00.000Z", 105, {
          marketKey: "spread",
          point: 1.5,
        }),
        snapshot("consensus", "2026-08-05T12:06:00.000Z", 100),
      ],
      cursor,
      {
        draftkings: "DraftKings",
        fanduel: "FanDuel",
        pinnacle: "Pinnacle",
      },
      impliedProbability,
      () => new Date("2026-08-05T13:00:00.000Z"),
    );
    const page = await repository.list({
      eventId,
      canonicalEventVersion: 2,
      from: "2026-08-05T12:00:00.000Z",
      to: "2026-08-05T13:00:00.000Z",
      limit: 50,
      marketKey: "moneyline",
      selectionKey: "participant:away",
      sportsbookIds: ["draftkings", "fanduel"],
    });
    expect(page).toEqual({
      eventId,
      generatedAt: "2026-08-05T13:00:00.000Z",
      markerScope: "page",
      series: [
        {
          marketKey: "moneyline",
          selectionKey: "participant:away",
          selectionLabel: "Away",
          sportsbookId: "draftkings",
          sportsbookLabel: "DraftKings",
          points: [
            {
              americanOdds: -110,
              impliedProbability: 11 / 21,
              isCurrent: false,
              isOpening: true,
              observationId: snapshot(
                "draftkings",
                "2026-08-05T12:00:00.000Z",
                -110,
              ).snapshotId,
              observedAt: "2026-08-05T12:00:00.000Z",
              retrievedAt: "2026-08-05T12:00:00.000Z",
              state: "active",
            },
            {
              americanOdds: -115,
              impliedProbability: 1 / (1 + 100 / 115),
              isCurrent: true,
              isOpening: false,
              observationId: snapshot(
                "draftkings",
                "2026-08-05T12:10:00.000Z",
                -115,
                { version: 2 },
              ).snapshotId,
              observedAt: "2026-08-05T12:10:00.000Z",
              retrievedAt: "2026-08-05T12:10:00.000Z",
              state: "active",
            },
          ],
        },
      ],
      coverage: [
        {
          sportsbookId: "draftkings",
          sportsbookLabel: "DraftKings",
          status: "available",
        },
        {
          sportsbookId: "fanduel",
          sportsbookLabel: "FanDuel",
          status: "unavailable",
        },
      ],
      nextCursor: null,
    });
  });

  it("projects suspended state, stable identity, probability, and line markers", async () => {
    const suspended = normalizeFixtureOddsObservation({
      canonicalEventId: eventId,
      canonicalEventVersion: 1,
      sportKey: "mlb",
      marketKey: "spread",
      selectionKey: "participant:home",
      selectionLabel: "Home",
      sportsbookId: "pinnacle",
      point: -1.5,
      americanOdds: 120,
      observedAt: "2026-08-05T12:00:00.000Z",
      retrievedAt: "2026-08-05T12:00:01.000Z",
      provenance: {
        providerId: "sharpapi",
        policyVersion: "v1",
        bookRole: "collected",
        sourceState: "suspended",
      },
    });
    const repository = new MemoryOddsHistoryRepository(
      [suspended],
      cursor,
      { pinnacle: "Pinnacle" },
      impliedProbability,
      () => new Date("2026-08-05T13:00:00.000Z"),
    );

    const page = await repository.list({
      eventId,
      canonicalEventVersion: 1,
      from: "2026-08-05T11:00:00.000Z",
      to: "2026-08-05T13:00:00.000Z",
      limit: 10,
      marketKey: "spread",
      selectionKey: "participant:home",
      sportsbookIds: ["pinnacle"],
    });

    expect(page.series[0]?.points).toEqual([
      {
        observationId: suspended.snapshotId,
        state: "suspended",
        point: -1.5,
        americanOdds: 120,
        impliedProbability: 5 / 11,
        observedAt: suspended.observedAt,
        retrievedAt: suspended.retrievedAt,
        isOpening: false,
        isCurrent: false,
      },
    ]);
  });

  it.each(["stale", "closed", "partial", "missing", "unsupported"] as const)(
    "projects %s provenance as unavailable rather than active",
    async (sourceState) => {
      const unavailable = normalizeFixtureOddsObservation({
        canonicalEventId: eventId,
        canonicalEventVersion: 1,
        sportKey: "mlb",
        marketKey: "moneyline",
        selectionKey: "participant:away",
        sportsbookId: "draftkings",
        americanOdds: -110,
        observedAt: "2026-08-05T12:00:00.000Z",
        retrievedAt: "2026-08-05T12:00:01.000Z",
        provenance: {
          providerId: "sharpapi",
          policyVersion: "v1",
          bookRole: "comparison",
          sourceState,
        },
      });
      const repository = new MemoryOddsHistoryRepository(
        [unavailable],
        cursor,
        { draftkings: "DraftKings" },
        impliedProbability,
        () => new Date("2026-08-05T13:00:00.000Z"),
      );

      const page = await repository.list({
        eventId,
        canonicalEventVersion: 1,
        from: "2026-08-05T11:00:00.000Z",
        to: "2026-08-05T13:00:00.000Z",
        limit: 10,
      });

      expect(page.series[0]?.points[0]?.state).toBe("unavailable");
    },
  );

  it("paginates stable immutable observations with no skip or repeat", async () => {
    const repository = new MemoryOddsHistoryRepository(
      [
        snapshot("draftkings", "2026-08-05T12:00:00.000Z", -110),
        snapshot("draftkings", "2026-08-05T12:01:00.000Z", -112),
        snapshot("draftkings", "2026-08-05T12:02:00.000Z", -115),
      ],
      cursor,
      { draftkings: "DraftKings" },
      impliedProbability,
      () => new Date("2026-08-05T13:00:00.000Z"),
    );
    const range = {
      eventId,
      canonicalEventVersion: 1,
      from: "2026-08-05T12:00:00.000Z",
      to: "2026-08-05T13:00:00.000Z",
      limit: 2,
      marketKey: "moneyline",
      selectionKey: "participant:away",
      sportsbookIds: ["draftkings"],
    } as const;
    const first = await repository.list(range);
    expect(first.series[0]?.points.map((point) => point.americanOdds)).toEqual([
      -110, -112,
    ]);
    expect(first.markerScope).toBe("page");
    expect(
      first.series[0]?.points.map(({ isOpening, isCurrent }) => [
        isOpening,
        isCurrent,
      ]),
    ).toEqual([
      [true, false],
      [false, true],
    ]);
    expect(first.nextCursor).toBeTypeOf("string");
    const second = await repository.list({
      ...range,
      canonicalEventVersion: 2,
      cursor: first.nextCursor!,
    });
    expect(second.series[0]?.points.map((point) => point.americanOdds)).toEqual(
      [-115],
    );
    expect(second.series[0]?.points[0]).toMatchObject({
      isOpening: true,
      isCurrent: true,
    });
    expect(second.nextCursor).toBeNull();
    await expect(
      repository.list({
        ...range,
        to: "2026-08-05T12:30:00.000Z",
        cursor: first.nextCursor!,
      }),
    ).rejects.toBeInstanceOf(OddsHistoryInputError);
    for (const changedFilter of [
      { marketKey: "spread" },
      { selectionKey: "participant:home" },
      { sportsbookIds: ["pinnacle"] },
    ])
      await expect(
        repository.list({
          ...range,
          ...changedFilter,
          cursor: first.nextCursor!,
        }),
      ).rejects.toBeInstanceOf(OddsHistoryInputError);
  });

  it("fences later mirror writes out of an in-progress traversal", async () => {
    let now = new Date("2026-08-05T13:00:00.000Z");
    const rows: OddsHistoryStoredRow[] = [
      snapshot("draftkings", "2026-08-05T12:00:00.000Z", -110),
      snapshot("draftkings", "2026-08-05T12:01:00.000Z", -112),
      snapshot("draftkings", "2026-08-05T12:02:00.000Z", -115),
    ].map((value) => ({
      pk: oddsHistoryPartition(value.canonicalEventId),
      sk: value.sortKey,
      value,
    }));
    const repository = new JoinedOddsHistoryRepository(
      {
        query: async (input) => {
          await Promise.resolve();
          const matching = rows
            .filter(
              (row) =>
                row.pk === input.pk &&
                row.sk >= input.fromSk &&
                row.sk <= input.toSk &&
                (!input.startSk || row.sk > input.startSk),
            )
            .sort((left, right) => left.sk.localeCompare(right.sk));
          return {
            items: matching.slice(0, input.limit),
            hasMore: matching.length > input.limit,
          };
        },
      },
      cursor,
      { draftkings: "DraftKings" },
      impliedProbability,
      () => now,
    );
    const range = {
      eventId,
      canonicalEventVersion: 1,
      from: "2026-08-05T12:00:00.000Z",
      to: "2026-08-05T13:00:00.000Z",
      limit: 2,
    } as const;
    const first = await repository.list(range);
    expect(
      first.series[0]?.points.map(({ americanOdds }) => americanOdds),
    ).toEqual([-110, -112]);

    now = new Date("2026-08-05T13:01:00.000Z");
    const lateMirror = normalizeFixtureOddsObservation({
      canonicalEventId: eventId,
      canonicalEventVersion: 1,
      sportKey: "mlb",
      marketKey: "moneyline",
      selectionKey: "participant:away",
      selectionLabel: "Away",
      sportsbookId: "draftkings",
      americanOdds: -113,
      observedAt: "2026-08-05T12:01:30.000Z",
      retrievedAt: "2026-08-05T13:01:00.000Z",
      provenance: sharpProvenance,
    });
    rows.push({
      pk: oddsHistoryPartition(eventId),
      sk: lateMirror.sortKey,
      value: lateMirror,
    });

    const second = await repository.list({
      ...range,
      cursor: first.nextCursor!,
    });
    expect(second.generatedAt).toBe(first.generatedAt);
    expect(
      second.series[0]?.points.map(({ americanOdds }) => americanOdds),
    ).toEqual([-115]);
    expect(second.nextCursor).toBeNull();
  });

  it("uses the newest selection label within one history page", async () => {
    const original = snapshot("draftkings", "2026-08-05T12:00:00.000Z", -110);
    const corrected = normalizeFixtureOddsObservation({
      canonicalEventId: eventId,
      canonicalEventVersion: 1,
      sportKey: "mlb",
      marketKey: "moneyline",
      selectionKey: "participant:away",
      selectionLabel: "Away corrected",
      sportsbookId: "draftkings",
      americanOdds: -112,
      observedAt: "2026-08-05T12:01:00.000Z",
      retrievedAt: "2026-08-05T12:01:01.000Z",
      provenance: sharpProvenance,
    });
    const repository = new MemoryOddsHistoryRepository(
      [original, corrected],
      cursor,
      { draftkings: "DraftKings" },
      impliedProbability,
      () => new Date("2026-08-05T13:00:00.000Z"),
    );

    const page = await repository.list({
      eventId,
      canonicalEventVersion: 1,
      from: "2026-08-05T12:00:00.000Z",
      to: "2026-08-05T13:00:00.000Z",
      limit: 10,
    });

    expect(page.series).toHaveLength(1);
    expect(page.series[0]?.selectionLabel).toBe("Away corrected");
    expect(page.series[0]?.points).toHaveLength(2);
  });

  it("uses retrieval time to break same-observation label corrections", async () => {
    const original = normalizeFixtureOddsObservation({
      canonicalEventId: eventId,
      canonicalEventVersion: 1,
      sportKey: "mlb",
      marketKey: "moneyline",
      selectionKey: "participant:away",
      selectionLabel: "Away old",
      sportsbookId: "draftkings",
      americanOdds: -110,
      observedAt: "2026-08-05T12:00:00.000Z",
      retrievedAt: "2026-08-05T12:00:01.000Z",
      provenance: sharpProvenance,
    });
    const corrected = normalizeFixtureOddsObservation({
      canonicalEventId: eventId,
      canonicalEventVersion: 1,
      sportKey: "mlb",
      marketKey: "moneyline",
      selectionKey: "participant:away",
      selectionLabel: "Away corrected",
      sportsbookId: "draftkings",
      americanOdds: -112,
      observedAt: "2026-08-05T12:00:00.000Z",
      retrievedAt: "2026-08-05T12:00:02.000Z",
      provenance: sharpProvenance,
    });
    const repository = new MemoryOddsHistoryRepository(
      [original, corrected],
      cursor,
      { draftkings: "DraftKings" },
      impliedProbability,
      () => new Date("2026-08-05T13:00:00.000Z"),
    );

    const page = await repository.list({
      eventId,
      canonicalEventVersion: 1,
      from: "2026-08-05T12:00:00.000Z",
      to: "2026-08-05T13:00:00.000Z",
      limit: 10,
    });

    expect(page.series[0]?.selectionLabel).toBe("Away corrected");
  });

  it("accepts encoded canonical selections and rejects inherited book names", async () => {
    const encoded = snapshot("draftkings", "2026-08-05T12:00:00.000Z", -110, {
      selectionKey: "participant:club%3A42",
    });
    const repository = new MemoryOddsHistoryRepository(
      [encoded],
      cursor,
      { draftkings: "DraftKings" },
      impliedProbability,
      () => new Date("2026-08-05T13:00:00.000Z"),
    );
    await expect(
      repository.list({
        eventId,
        canonicalEventVersion: 1,
        from: "2026-08-05T12:00:00.000Z",
        to: "2026-08-05T13:00:00.000Z",
        limit: 10,
        selectionKey: "participant:club%3A42",
      }),
    ).resolves.toMatchObject({
      series: [{ selectionKey: "participant:club%3A42" }],
    });
    expect(() => repository.validateSportsbookIds(["constructor"])).toThrow(
      OddsHistoryInputError,
    );
  });

  it("excludes missing or foreign provider provenance", async () => {
    const unverified = normalizeFixtureOddsObservation({
      canonicalEventId: eventId,
      canonicalEventVersion: 1,
      sportKey: "mlb",
      marketKey: "moneyline",
      selectionKey: "participant:away",
      sportsbookId: "draftkings",
      americanOdds: -110,
      observedAt: "2026-08-05T12:00:00.000Z",
      retrievedAt: "2026-08-05T12:00:01.000Z",
    });
    const foreign = normalizeFixtureOddsObservation({
      canonicalEventId: eventId,
      canonicalEventVersion: 1,
      sportKey: "mlb",
      marketKey: "moneyline",
      selectionKey: "participant:away",
      sportsbookId: "draftkings",
      americanOdds: -110,
      observedAt: "2026-08-05T12:01:00.000Z",
      retrievedAt: "2026-08-05T12:01:01.000Z",
      provenance: { ...sharpProvenance, providerId: "other-provider" },
    });
    const repository = new MemoryOddsHistoryRepository(
      [unverified, foreign],
      cursor,
      { draftkings: "DraftKings" },
      impliedProbability,
      () => new Date("2026-08-05T13:00:00.000Z"),
    );
    await expect(
      repository.list({
        eventId,
        canonicalEventVersion: 1,
        from: "2026-08-05T12:00:00.000Z",
        to: "2026-08-05T13:00:00.000Z",
        limit: 10,
      }),
    ).resolves.toMatchObject({
      series: [],
      coverage: [{ sportsbookId: "draftkings", status: "unavailable" }],
    });
  });

  it("rejects malformed market points and deduplicates version mirrors", async () => {
    const malformed = snapshot("draftkings", "2026-08-05T12:00:00.000Z", -110, {
      marketKey: "spread",
    });
    const malformedRepository = new MemoryOddsHistoryRepository(
      [malformed],
      cursor,
      { draftkings: "DraftKings" },
      impliedProbability,
      () => new Date("2026-08-05T13:00:00.000Z"),
    );
    await expect(
      malformedRepository.list({
        eventId,
        canonicalEventVersion: 1,
        from: "2026-08-05T12:00:00.000Z",
        to: "2026-08-05T13:00:00.000Z",
        limit: 10,
      }),
    ).rejects.toBeInstanceOf(OddsHistoryStorageError);

    const first = snapshot("draftkings", "2026-08-05T12:00:00.000Z", -110);
    const mirror = snapshot("draftkings", "2026-08-05T12:00:00.000Z", -110, {
      version: 2,
    });
    const repository = new MemoryOddsHistoryRepository(
      [first, mirror],
      cursor,
      { draftkings: "DraftKings" },
      impliedProbability,
      () => new Date("2026-08-05T13:00:00.000Z"),
    );
    const page = await repository.list({
      eventId,
      canonicalEventVersion: 2,
      from: "2026-08-05T12:00:00.000Z",
      to: "2026-08-05T13:00:00.000Z",
      limit: 10,
    });
    expect(page.series[0]?.points).toHaveLength(1);
  });

  it("rejects malformed, oversized, reversed, and unsupported requests", async () => {
    const repository = new MemoryOddsHistoryRepository(
      [],
      cursor,
      { draftkings: "DraftKings" },
      impliedProbability,
    );
    const base = {
      eventId,
      canonicalEventVersion: 1,
      from: "2026-08-05T12:00:00.000Z",
      to: "2026-08-05T13:00:00.000Z",
      limit: 50,
    };
    for (const input of [
      { ...base, eventId: "not canonical/" },
      { ...base, canonicalEventVersion: 0 },
      { ...base, from: "yesterday" },
      { ...base, from: base.to, to: base.from },
      { ...base, to: "2026-11-05T13:00:00.000Z" },
      { ...base, limit: 0 },
      { ...base, limit: 201 },
      { ...base, cursor: "not-a-cursor" },
      { ...base, marketKey: "" },
      { ...base, marketKey: "player-prop" },
      { ...base, selectionKey: "bad value" },
      { ...base, selectionKey: "participant:%away" },
      { ...base, selectionKey: "participant:away,home" },
      { ...base, sportsbookIds: [] },
      { ...base, sportsbookIds: ["DraftKings"] },
      { ...base, sportsbookIds: ["draftkings", "draftkings"] },
      { ...base, sportsbookIds: ["unknown"] },
    ])
      await expect(repository.list(input)).rejects.toBeInstanceOf(
        OddsHistoryInputError,
      );
  });
});
