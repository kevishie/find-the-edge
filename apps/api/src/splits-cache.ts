/**
 * The splits board fans out one query per game on every request. That evidence
 * is public, identical for every caller, and the provider only refreshes it
 * every five minutes, so a short time-to-live cache removes nearly all of the
 * repeated reads without making the board meaningfully staler.
 */
export interface SplitLookupCacheOptions {
  readonly ttlMs: number;
  readonly maxEntries: number;
  readonly now?: () => number;
}

export interface ValueBoundedCacheOptions<T> extends SplitLookupCacheOptions {
  /** An absolute instant after which this particular value is unsafe. */
  readonly expiresAt?: (value: T) => number | null;
  /** Allows a freshly loaded value to be returned, but not cached, after its
   * boundary. Used for fail-closed unavailable boards that carry no prices. */
  readonly safeAfterExpiry?: (value: T) => boolean;
}

export interface SplitLookupCache<T> {
  (key: string, load: () => Promise<T>): Promise<T>;
  /** Drops every entry; exists so tests can isolate module-scope caches. */
  clear(): void;
}

export const createSplitLookupCache = <T>({
  ttlMs,
  maxEntries,
  now = () => Date.now(),
  expiresAt,
  safeAfterExpiry,
}: ValueBoundedCacheOptions<T>): SplitLookupCache<T> => {
  const entries = new Map<
    string,
    { readonly value: Promise<T>; readonly expiresAt: number }
  >();
  const lookup = (key: string, load: () => Promise<T>): Promise<T> => {
    const current = entries.get(key);
    if (current && current.expiresAt > now())
      return current.value.then((resolved) => {
        // A cache hit can begin immediately before its absolute boundary and
        // resume after it. Recheck at delivery time so even an already-settled
        // promise cannot carry pregame prices across kickoff.
        if (current.expiresAt > now() || safeAfterExpiry?.(resolved) === true)
          return resolved;
        if (entries.get(key)?.value === current.value) entries.delete(key);
        return lookup(key, load);
      });
    const loadedAt = now();
    const ttlExpiresAt = loadedAt + ttlMs;
    let resolvedExpiresAt = ttlExpiresAt;
    // Storing the promise rather than its result also collapses concurrent
    // requests for the same game into one read.
    const resolve = async (
      startedAt: number,
      mayReload: boolean,
    ): Promise<T> => {
      const resolved = await load();
      if (!expiresAt) return resolved;
      const absolute = expiresAt(resolved);
      if (absolute !== null && !Number.isFinite(absolute))
        throw new Error("cache-value-expiry-invalid");
      if (absolute !== null && now() >= absolute) {
        if (safeAfterExpiry?.(resolved) === true) {
          resolvedExpiresAt = absolute;
          return resolved;
        }
        if (mayReload && startedAt < absolute) return resolve(now(), false);
        throw new Error("cache-value-expired");
      }
      resolvedExpiresAt =
        absolute === null ? ttlExpiresAt : Math.min(ttlExpiresAt, absolute);
      return resolved;
    };
    const value = resolve(loadedAt, true).catch((error: unknown) => {
      // A failed read must never be served to a later caller.
      if (entries.get(key)?.value === value) entries.delete(key);
      throw error;
    });
    entries.set(key, { value, expiresAt: ttlExpiresAt });
    void value.then(
      (resolved) => {
        void resolved;
        if (entries.get(key)?.value !== value) return;
        entries.set(key, { value, expiresAt: resolvedExpiresAt });
      },
      () => undefined,
    );
    // Insertion order is eviction order, which is enough to bound a working
    // set that only ever holds one slate of games.
    for (const stale of entries.keys()) {
      if (entries.size <= maxEntries) break;
      entries.delete(stale);
    }
    return value;
  };
  lookup.clear = () => entries.clear();
  return lookup;
};
