import { describe, expect, it } from "vitest";
import { normalizeFixtureOddsObservation } from "@find-the-edge/domain";
import { EventCursorCodec } from "./event-repository";
import {
  MemoryOddsHistoryRepository,
  OddsHistoryInputError,
} from "./odds-history-repository";

const eventId = "event:mlb:history";
const cursor = new EventCursorCodec({
  current: { id: "test", secret: new Uint8Array(32).fill(7) },
});
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
  });

describe("odds history repository", () => {
  it("projects chronological all-book series across canonical event versions", async () => {
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
        pinnacle: "Pinnacle",
      },
      () => new Date("2026-08-05T13:00:00.000Z"),
    );
    const page = await repository.list({
      eventId,
      from: "2026-08-05T12:00:00.000Z",
      to: "2026-08-05T13:00:00.000Z",
      limit: 50,
    });
    expect(page).toEqual({
      eventId,
      generatedAt: "2026-08-05T13:00:00.000Z",
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
              observedAt: "2026-08-05T12:00:00.000Z",
              retrievedAt: "2026-08-05T12:00:00.000Z",
            },
            {
              americanOdds: -115,
              observedAt: "2026-08-05T12:10:00.000Z",
              retrievedAt: "2026-08-05T12:10:00.000Z",
            },
          ],
        },
        {
          marketKey: "spread",
          selectionKey: "participant:away",
          selectionLabel: "Away",
          sportsbookId: "pinnacle",
          sportsbookLabel: "Pinnacle",
          points: [
            {
              point: 1.5,
              americanOdds: 105,
              observedAt: "2026-08-05T12:05:00.000Z",
              retrievedAt: "2026-08-05T12:05:00.000Z",
            },
          ],
        },
      ],
      nextCursor: null,
    });
  });

  it("paginates stable immutable observations with no skip or repeat", async () => {
    const repository = new MemoryOddsHistoryRepository(
      [
        snapshot("draftkings", "2026-08-05T12:00:00.000Z", -110),
        snapshot("draftkings", "2026-08-05T12:01:00.000Z", -112),
        snapshot("draftkings", "2026-08-05T12:02:00.000Z", -115),
      ],
      cursor,
      { draftkings: "DraftKings" },
      () => new Date("2026-08-05T13:00:00.000Z"),
    );
    const range = {
      eventId,
      from: "2026-08-05T12:00:00.000Z",
      to: "2026-08-05T13:00:00.000Z",
      limit: 2,
    } as const;
    const first = await repository.list(range);
    expect(first.series[0]?.points.map((point) => point.americanOdds)).toEqual([
      -110, -112,
    ]);
    expect(first.nextCursor).toBeTypeOf("string");
    const second = await repository.list({
      ...range,
      cursor: first.nextCursor!,
    });
    expect(second.series[0]?.points.map((point) => point.americanOdds)).toEqual(
      [-115],
    );
    expect(second.nextCursor).toBeNull();
    await expect(
      repository.list({
        ...range,
        to: "2026-08-05T12:30:00.000Z",
        cursor: first.nextCursor!,
      }),
    ).rejects.toBeInstanceOf(OddsHistoryInputError);
  });

  it("rejects malformed, oversized, reversed, and unsupported requests", async () => {
    const repository = new MemoryOddsHistoryRepository([], cursor, {
      draftkings: "DraftKings",
    });
    const base = {
      eventId,
      from: "2026-08-05T12:00:00.000Z",
      to: "2026-08-05T13:00:00.000Z",
      limit: 50,
    };
    for (const input of [
      { ...base, eventId: "not canonical/" },
      { ...base, from: "yesterday" },
      { ...base, from: base.to, to: base.from },
      { ...base, to: "2026-11-05T13:00:00.000Z" },
      { ...base, limit: 0 },
      { ...base, limit: 201 },
      { ...base, cursor: "not-a-cursor" },
    ])
      await expect(repository.list(input)).rejects.toBeInstanceOf(
        OddsHistoryInputError,
      );
  });
});
