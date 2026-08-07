import type { GamesSport } from "./api";

export interface CachedSplitsBoard<TPage> {
  readonly page: TPage;
  readonly fetchedAt: number;
}

/** A client that is known to support splits. */
export interface SplitsSource<TPage> {
  readonly listSplits: (
    filter: { readonly sport: GamesSport; readonly day: string },
    signal: AbortSignal,
  ) => Promise<TPage>;
}

export const splitsCacheKey = (sport: GamesSport, day: string) =>
  `${sport}:${day}`;

// The board is the same for every viewer and the provider only refreshes it
// every five minutes, so one process-wide entry per sport/day is enough. The
// page shape belongs to the caller, so it is stored opaquely.
const boards = new Map<string, CachedSplitsBoard<unknown>>();
// Callers that arrive while a request is open share its result rather than
// repeating the fan-out behind the splits route.
const inFlight = new Map<string, Promise<unknown>>();

export const readCachedSplits = <TPage>(
  sport: GamesSport,
  day: string,
): CachedSplitsBoard<TPage> | undefined =>
  boards.get(splitsCacheKey(sport, day)) as
    CachedSplitsBoard<TPage> | undefined;

export const clearSplitsCache = () => {
  boards.clear();
  inFlight.clear();
};

/**
 * Adapts a client to a splits source, or reports that it cannot list splits.
 * The method is re-invoked through the client rather than captured, so it keeps
 * its own receiver.
 */
export const asSplitsSource = <TPage>(
  client:
    { readonly listSplits?: SplitsSource<TPage>["listSplits"] } | undefined,
): SplitsSource<TPage> | undefined =>
  client?.listSplits === undefined
    ? undefined
    : { listSplits: (filter, signal) => client.listSplits!(filter, signal) };

/**
 * Loads a board through the shared cache. The returned promise is not bound to
 * any one caller, so a component unmounting never cancels a fetch another
 * caller is still waiting on; callers check their own abort signal instead.
 */
export const loadSplits = <TPage>(
  source: SplitsSource<TPage>,
  sport: GamesSport,
  day: string,
): Promise<TPage> => {
  const key = splitsCacheKey(sport, day);
  const pending = inFlight.get(key);
  if (pending) return pending as Promise<TPage>;
  const request = source
    .listSplits({ sport, day }, new AbortController().signal)
    .then((page) => {
      boards.set(key, { page, fetchedAt: Date.now() });
      return page;
    })
    .finally(() => {
      inFlight.delete(key);
    });
  inFlight.set(key, request);
  return request;
};

/**
 * Warms the board before the splits screen is opened so navigating to it
 * paints from cache instead of waiting on a cold request.
 */
export const prefetchSplits = <TPage>(
  client:
    { readonly listSplits?: SplitsSource<TPage>["listSplits"] } | undefined,
  sport: GamesSport,
  day: string,
) => {
  const source = asSplitsSource(client);
  if (!source || readCachedSplits(sport, day)) return;
  void loadSplits(source, sport, day).catch(() => {
    // A warm-up failure is not actionable; the screen retries on its own.
  });
};
