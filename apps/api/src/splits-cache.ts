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

export interface SplitLookupCache<T> {
  (key: string, load: () => Promise<T>): Promise<T>;
  /** Drops every entry; exists so tests can isolate module-scope caches. */
  clear(): void;
}

export const createSplitLookupCache = <T>({
  ttlMs,
  maxEntries,
  now = Date.now,
}: SplitLookupCacheOptions): SplitLookupCache<T> => {
  const entries = new Map<
    string,
    { readonly value: Promise<T>; readonly expiresAt: number }
  >();
  const lookup = (key: string, load: () => Promise<T>): Promise<T> => {
    const current = entries.get(key);
    if (current && current.expiresAt > now()) return current.value;
    // Storing the promise rather than its result also collapses concurrent
    // requests for the same game into one read.
    const value = load().catch((error: unknown) => {
      // A failed read must never be served to a later caller.
      if (entries.get(key)?.value === value) entries.delete(key);
      throw error;
    });
    entries.set(key, { value, expiresAt: now() + ttlMs });
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
