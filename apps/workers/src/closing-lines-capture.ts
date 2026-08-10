import type {
  ClosingLinesRepository,
  GamesRepository,
} from "@find-the-edge/database";
import {
  CLOSING_CAPTURE_WINDOW_MS,
  createClosingLinesRecord,
} from "@find-the-edge/domain";

const CAPTURE_TARGETS = [
  { sportKey: "mlb", leagueKey: "mlb" },
  { sportKey: "soccer", leagueKey: "mls" },
] as const;

const easternDayFormat = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

export interface ClosingLinesCaptureResult {
  readonly captured: number;
  readonly failed: number;
}

/** Captures each just-started game's served prices as its immutable closing
 * record. The provider drops started games from its odds feed, so the first
 * post-start snapshot is the closing line; the write-once repository keeps
 * later ticks from touching it. Never allowed to fail ingestion. */
export async function captureClosingLines(
  dependencies: {
    readonly games: GamesRepository;
    readonly closingLines: ClosingLinesRepository;
    readonly targets?: readonly {
      readonly sportKey: string;
      readonly leagueKey: string;
    }[];
  },
  now: Date,
): Promise<ClosingLinesCaptureResult> {
  // A game starting before midnight sits on the previous eastern day's board
  // while its capture window is still open.
  const days = [
    ...new Set([
      easternDayFormat.format(new Date(now.getTime() - 86_400_000)),
      easternDayFormat.format(now),
    ]),
  ];
  let captured = 0;
  let failed = 0;
  for (const target of dependencies.targets ?? CAPTURE_TARGETS) {
    for (const day of days) {
      let items;
      try {
        items = (
          await dependencies.games.list(
            {
              sportKey: target.sportKey,
              leagueKey: target.leagueKey,
              status: "all",
              day,
            },
            50,
          )
        ).items;
      } catch {
        failed += 1;
        continue;
      }
      for (const game of items) {
        const sinceStart = now.getTime() - Date.parse(game.startsAt);
        if (
          sinceStart < 0 ||
          sinceStart > CLOSING_CAPTURE_WINDOW_MS ||
          game.odds.state !== "available" ||
          game.odds.selections.length === 0
        )
          continue;
        try {
          const outcome = await dependencies.closingLines.capture(
            createClosingLinesRecord({
              canonicalEventId: game.id,
              canonicalEventVersion: game.version,
              sportKey: game.sportKey,
              leagueKey: game.leagueKey,
              startsAt: game.startsAt,
              capturedAt: now.toISOString(),
              selections: game.odds.selections,
            }),
          );
          if (outcome === "created") captured += 1;
        } catch (error) {
          failed += 1;
          console.log(
            JSON.stringify({
              event: "closing-lines-capture-failed",
              eventId: game.id,
              errorName: error instanceof Error ? error.name : "unknown",
              errorMessage:
                error instanceof Error
                  ? error.message.slice(0, 300)
                  : "unknown",
            }),
          );
        }
      }
    }
  }
  return { captured, failed };
}
