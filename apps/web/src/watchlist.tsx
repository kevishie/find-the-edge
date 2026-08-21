import { useEffect, useMemo, useState } from "react";
import { eventMatchupLabel } from "@find-the-edge/ui";

import {
  currentEasternDay,
  kickoffDisplay,
  useWatchlistControl,
  type UiGamesClient,
  type UiGamesPage,
  type WatchlistControl,
} from "./App";
import type { GamesSport, WatchlistEntryDto } from "./api";

export type WatchlistClientResult =
  | { readonly ok: true; readonly value: UiGamesClient }
  | { readonly ok: false; readonly error: { readonly message: string } };

type BoardGame = UiGamesPage["items"][number];

type BoardCell =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly page: UiGamesPage }
  | { readonly status: "unavailable" };

const BOARD_LOADING: BoardCell = { status: "loading" };

/** A watched event's board is the explorer board for its sport and its day. */
const boardKey = (entry: WatchlistEntryDto): string | null =>
  entry.sportKey === "mlb" || entry.sportKey === "soccer"
    ? `${entry.sportKey}|${currentEasternDay(new Date(entry.startsAt))}`
    : null;

/**
 * Every cell that has no evidence behind it says so in the same words. The
 * watchlist never fills a column with a plausible value.
 */
function Unavailable({ reason }: { readonly reason: string }) {
  return (
    <span className="watchlist-unavailable">
      <strong>Not connected</strong>
      <small>{reason}</small>
    </span>
  );
}

const relativeMinutes = (from: string, to: string): number | null => {
  const delta = Date.parse(to) - Date.parse(from);
  return Number.isFinite(delta)
    ? Math.max(0, Math.round(delta / 60_000))
    : null;
};

const ageText = (minutes: number): string => {
  if (minutes < 1) return "under a minute old";
  if (minutes < 60) return `${String(minutes)} min old`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${String(hours)} h old`;
  return `${String(Math.floor(hours / 24))} d old`;
};

/**
 * Odds evidence for one watched event, read from the same board the events
 * explorer renders. `retrievedAt` is the newest collection time across the
 * published prices and is the only real "last change" signal the platform
 * stores for an event today.
 */
interface OddsEvidence {
  readonly retrievedAt: string;
  readonly ageMinutes: number | null;
  readonly started: boolean;
}

const oddsEvidence = (
  game: BoardGame,
  snapshotAt: string | null,
): OddsEvidence | null => {
  const prices = game.odds.state === "available" ? game.odds.selections : [];
  const retrievedAt = prices
    .map((price) => price.retrievedAt)
    .sort()
    .at(-1);
  if (retrievedAt === undefined) return null;
  return {
    retrievedAt,
    ageMinutes:
      snapshotAt === null ? null : relativeMinutes(retrievedAt, snapshotAt),
    started:
      snapshotAt !== null &&
      Date.parse(game.startsAt) <= Date.parse(snapshotAt),
  };
};

function WatchlistRow({
  entry,
  cell,
  control,
  onRemoved,
}: {
  readonly entry: WatchlistEntryDto;
  readonly cell: BoardCell;
  readonly control: WatchlistControl;
  readonly onRemoved: (entry: WatchlistEntryDto) => void;
}) {
  const game =
    cell.status === "ready"
      ? cell.page.items.find((item) => item.id === entry.eventId)
      : undefined;
  const snapshotAt =
    cell.status === "ready" ? (cell.page.snapshotAt ?? null) : null;
  const evidence = game ? oddsEvidence(game, snapshotAt) : null;
  const busy = control.pending.has(entry.eventId);

  const freshness = (() => {
    if (cell.status === "loading")
      return <span className="watchlist-pending">Checking the board…</span>;
    if (cell.status === "unavailable")
      return (
        <Unavailable reason="The board for this day could not be loaded." />
      );
    if (!game)
      return (
        <Unavailable reason="This event is not on the board for its day." />
      );
    if (!evidence)
      return <Unavailable reason="No prices are published for this event." />;
    if (evidence.started)
      return (
        <span>
          {game.odds.state === "available" &&
          game.odds.source === "canonical-closing"
            ? "Closing lines"
            : "Pregame snapshot"}
        </span>
      );
    if (evidence.ageMinutes === null)
      return <Unavailable reason="The board did not report a snapshot time." />;
    const stale = evidence.ageMinutes > 15;
    return (
      <span className={stale ? "watchlist-stale" : undefined}>
        Odds {ageText(evidence.ageMinutes)}
        {stale && " — stale"}
      </span>
    );
  })();

  return (
    <li className="watchlist-row" data-event-id={entry.eventId}>
      <div className="watchlist-row-head">
        <h2>{game ? eventMatchupLabel(game) : entry.eventId}</h2>
        <p className="watchlist-kickoff">{kickoffDisplay(entry.startsAt)}</p>
      </div>
      <dl className="watchlist-cells">
        <div>
          <dt>Odds freshness</dt>
          <dd>{freshness}</dd>
        </div>
        <div>
          <dt>Report status</dt>
          <dd>
            {/* FTE-045 publishes only the watchlist entry, and a stored
                scouting report can be addressed only by job or report id —
                there is no per-event report lookup to call. Rather than guess,
                the cell states that nothing is connected. */}
            <Unavailable reason="Reports are addressed by scouting job; there is no per-event lookup yet." />
          </dd>
        </div>
        <div>
          <dt>Lineups</dt>
          <dd>
            <Unavailable reason="No lineup provider is connected." />
          </dd>
        </div>
        <div>
          <dt>Last change</dt>
          <dd>
            {/* The only change evidence the platform stores per event today is
                when its prices were last collected. Nothing else is claimed. */}
            {evidence ? (
              <time dateTime={evidence.retrievedAt}>
                Odds collected {kickoffDisplay(evidence.retrievedAt)}
                {evidence.ageMinutes !== null &&
                  ` · ${ageText(evidence.ageMinutes)}`}
              </time>
            ) : (
              <Unavailable reason="No change evidence is stored for this event." />
            )}
          </dd>
        </div>
        <div>
          <dt>Watched since</dt>
          <dd>
            <time dateTime={entry.addedAt}>
              {kickoffDisplay(entry.addedAt)}
            </time>
          </dd>
        </div>
      </dl>
      <div className="watchlist-row-actions">
        <a
          className="detail-link"
          href={`/events/${encodeURIComponent(entry.eventId)}`}
        >
          Open event
        </a>
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            void control.remove(entry.eventId).then((removed) => {
              if (removed) onRemoved(entry);
            });
          }}
        >
          {busy ? "Removing…" : "Remove"}
        </button>
      </div>
    </li>
  );
}

/**
 * The watchlist screen (FTE-046). Rows are the API's own ordering; the odds
 * columns are read from the explorer board for each watched day, and every
 * column with no evidence behind it is labelled as not connected instead of
 * being filled in.
 */
export function Watchlist({
  client,
}: {
  readonly client: WatchlistClientResult;
}) {
  const control = useWatchlistControl(client);
  // Kept as a stable closure so the board effect below is not re-run by a
  // fresh method reference on every render.
  const listGames = useMemo((): UiGamesClient["list"] | undefined => {
    if (!client.ok) return undefined;
    const source = client.value;
    return (filter, signal) => source.list(filter, signal);
  }, [client]);
  const entries = control.entries;
  const [boards, setBoards] = useState<ReadonlyMap<string, BoardCell>>(
    () => new Map<string, BoardCell>(),
  );
  // A row that was just removed stays available for one undo, which re-adds it
  // through the same API the explorer uses.
  const [undoable, setUndoable] = useState<WatchlistEntryDto | null>(null);
  const [undoError, setUndoError] = useState<string | null>(null);

  // The board request set is derived from a stable token so a removal that
  // leaves the watched days unchanged does not refetch the boards.
  const boardToken = useMemo(() => {
    const keys = new Set<string>();
    for (const entry of entries) {
      const key = boardKey(entry);
      if (key !== null) keys.add(key);
    }
    return [...keys].sort().join(",");
  }, [entries]);
  const boardTargets = useMemo(
    (): readonly {
      readonly key: string;
      readonly sport: GamesSport;
      readonly day: string;
    }[] =>
      boardToken === ""
        ? []
        : boardToken.split(",").map((key) => {
            const [sport, day] = key.split("|");
            return {
              key,
              sport:
                sport === "soccer" ? ("soccer" as const) : ("mlb" as const),
              day: day ?? "",
            };
          }),
    [boardToken],
  );

  useEffect(() => {
    if (!listGames || boardTargets.length === 0) return;
    const controller = new AbortController();
    void Promise.all(
      boardTargets.map(
        async (target): Promise<readonly [string, BoardCell]> => {
          try {
            const page = await listGames(
              { sport: target.sport, day: target.day, status: "all" },
              controller.signal,
            );
            return [target.key, { status: "ready", page }];
          } catch {
            return [target.key, { status: "unavailable" }];
          }
        },
      ),
    ).then((cells) => {
      if (controller.signal.aborted) return;
      setBoards(new Map(cells));
    });
    return () => controller.abort();
  }, [boardTargets, listGames]);

  if (control.availability === "loading")
    return (
      <section className="watchlist-state" role="status">
        <h1>Watchlist</h1>
        <p>Loading your watchlist…</p>
        <div className="dashboard-skeleton" aria-hidden="true">
          <div />
          <div />
        </div>
      </section>
    );

  if (control.availability === "signed-out")
    return (
      <section className="watchlist-state" role="alert">
        <h1>Sign in required</h1>
        <p>
          A watchlist belongs to one account, so sign in is required to see it.
        </p>
        <a className="detail-link" href="/events">
          Browse events
        </a>
      </section>
    );

  if (control.availability === "unavailable")
    return (
      <section className="watchlist-state error" role="alert">
        <h1>Watchlist unavailable</h1>
        <p>
          {control.unavailableReason ??
            "The watchlist is temporarily unavailable."}
        </p>
        <div className="watchlist-state-actions">
          <button type="button" onClick={control.retry}>
            Try again
          </button>
          <a className="detail-link" href="/events">
            Browse events
          </a>
        </div>
      </section>
    );

  return (
    <section className="watchlist" aria-labelledby="watchlist-heading">
      <header className="watchlist-header">
        <p className="eyebrow">WATCHLIST</p>
        <h1 id="watchlist-heading">Watched events</h1>
        <p className="lede">
          Events you chose to follow, soonest kickoff first. Columns are filled
          only where stored evidence exists.
        </p>
      </header>

      {control.mutationError !== null && (
        <p className="watchlist-error" role="alert">
          {control.mutationError}
        </p>
      )}
      {undoError !== null && (
        <p className="watchlist-error" role="alert">
          {undoError}
        </p>
      )}
      {undoable !== null && (
        <div className="watchlist-undo" role="status">
          <span>Removed from your watchlist.</span>
          <button
            type="button"
            disabled={control.pending.has(undoable.eventId)}
            onClick={() => {
              const entry = undoable;
              setUndoError(null);
              void control.add(entry.eventId).then((added) => {
                if (added) setUndoable(null);
                else
                  setUndoError(
                    "That event could not be restored to your watchlist.",
                  );
              });
            }}
          >
            Undo
          </button>
          <button type="button" onClick={() => setUndoable(null)}>
            Dismiss
          </button>
        </div>
      )}

      {entries.length === 0 ? (
        <div className="watchlist-empty" role="status">
          <h2>Nothing is on your watchlist yet</h2>
          <p>
            Add an event from the events explorer and it will appear here with
            its kickoff, odds freshness, and what changed.
          </p>
          <a className="detail-link" href="/events">
            Browse events
          </a>
        </div>
      ) : (
        <ul className="watchlist-rows">
          {entries.map((entry) => {
            const key = boardKey(entry);
            return (
              <WatchlistRow
                key={entry.eventId}
                entry={entry}
                cell={
                  key === null || !listGames
                    ? { status: "unavailable" }
                    : (boards.get(key) ?? BOARD_LOADING)
                }
                control={control}
                onRemoved={(removed) => {
                  setUndoError(null);
                  setUndoable(removed);
                }}
              />
            );
          })}
        </ul>
      )}
    </section>
  );
}
