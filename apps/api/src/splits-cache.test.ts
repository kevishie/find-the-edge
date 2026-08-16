import { expect, it, vi } from "vitest";
import { createSplitLookupCache } from "./splits-cache";

const clock = (start = 0) => {
  let value = start;
  return {
    now: () => value,
    advance: (ms: number) => {
      value += ms;
    },
  };
};

it("serves a game from cache until its time-to-live expires", async () => {
  const time = clock();
  const cache = createSplitLookupCache<string>({
    ttlMs: 1_000,
    maxEntries: 8,
    now: time.now,
  });
  const load = vi.fn(() => Promise.resolve("splits"));

  await expect(cache("game-1", load)).resolves.toBe("splits");
  time.advance(999);
  await expect(cache("game-1", load)).resolves.toBe("splits");
  expect(load).toHaveBeenCalledTimes(1);

  time.advance(2);
  await expect(cache("game-1", load)).resolves.toBe("splits");
  expect(load).toHaveBeenCalledTimes(2);
});

it("collapses concurrent reads of the same game into one lookup", async () => {
  const time = clock();
  const cache = createSplitLookupCache<string>({
    ttlMs: 1_000,
    maxEntries: 8,
    now: time.now,
  });
  const load = vi.fn(() => Promise.resolve("splits"));

  const results = await Promise.all([
    cache("game-1", load),
    cache("game-1", load),
    cache("game-1", load),
  ]);

  expect(results).toEqual(["splits", "splits", "splits"]);
  expect(load).toHaveBeenCalledTimes(1);
});

it("never serves a failed lookup to a later caller", async () => {
  const time = clock();
  const cache = createSplitLookupCache<string>({
    ttlMs: 1_000,
    maxEntries: 8,
    now: time.now,
  });

  await expect(
    cache("game-1", () => Promise.reject(new Error("dynamo unavailable"))),
  ).rejects.toThrow("dynamo unavailable");
  await expect(cache("game-1", () => Promise.resolve("splits"))).resolves.toBe(
    "splits",
  );
});

it("bounds the cache to its configured working set", async () => {
  const time = clock();
  const cache = createSplitLookupCache<string>({
    ttlMs: 10_000,
    maxEntries: 2,
    now: time.now,
  });
  const load = vi.fn((id: string) => Promise.resolve(id));

  await cache("game-1", () => load("game-1"));
  await cache("game-2", () => load("game-2"));
  await cache("game-3", () => load("game-3"));
  // game-1 was evicted first, so reading it again is a fresh lookup.
  await cache("game-1", () => load("game-1"));

  expect(load).toHaveBeenCalledTimes(4);
  await cache("game-3", () => load("game-3"));
  expect(load).toHaveBeenCalledTimes(4);
});

it("clamps a value to its derived absolute expiry", async () => {
  const time = clock(5_000);
  const cache = createSplitLookupCache<{ value: string; unsafeAt: number }>({
    ttlMs: 10_000,
    maxEntries: 8,
    now: time.now,
    expiresAt: ({ unsafeAt }) => unsafeAt,
    safeAfterExpiry: () => true,
  });
  const load = vi.fn(() =>
    Promise.resolve({ value: "pregame", unsafeAt: 6_000 }),
  );

  await cache("board", load);
  time.advance(999);
  await cache("board", load);
  expect(load).toHaveBeenCalledTimes(1);

  time.advance(1);
  await cache("board", load);
  expect(load).toHaveBeenCalledTimes(2);
});

it("keeps the ordinary TTL when a value has no absolute boundary", async () => {
  const time = clock();
  const cache = createSplitLookupCache<string>({
    ttlMs: 1_000,
    maxEntries: 8,
    now: time.now,
    expiresAt: () => null,
  });
  const load = vi.fn(() => Promise.resolve("canonical-close"));

  await cache("board", load);
  time.advance(999);
  await cache("board", load);
  expect(load).toHaveBeenCalledTimes(1);
  time.advance(1);
  await cache("board", load);
  expect(load).toHaveBeenCalledTimes(2);
});

it("reloads one slow pregame value for every waiter when kickoff passes", async () => {
  const time = clock(5_000);
  let finishPregame!: (value: {
    readonly state: "pregame";
    readonly unsafeAt: number;
  }) => void;
  const pending = new Promise<{
    readonly state: "pregame";
    readonly unsafeAt: number;
  }>((resolve) => {
    finishPregame = resolve;
  });
  const load = vi
    .fn<() => Promise<{ state: "pregame" | "unavailable"; unsafeAt: number }>>()
    .mockImplementationOnce(() => pending)
    .mockResolvedValue({ state: "unavailable", unsafeAt: 6_000 });
  const cache = createSplitLookupCache<{
    state: "pregame" | "unavailable";
    unsafeAt: number;
  }>({
    ttlMs: 10_000,
    maxEntries: 8,
    now: time.now,
    expiresAt: ({ unsafeAt }) => unsafeAt,
    safeAfterExpiry: ({ state }) => state === "unavailable",
  });

  const first = cache("board", load);
  const concurrent = cache("board", load);
  time.advance(1_000);
  finishPregame({ state: "pregame", unsafeAt: 6_000 });

  await expect(Promise.all([first, concurrent])).resolves.toEqual([
    { state: "unavailable", unsafeAt: 6_000 },
    { state: "unavailable", unsafeAt: 6_000 },
  ]);
  expect(load).toHaveBeenCalledTimes(2);
});

it("rechecks a settled cache hit before delivering it across its boundary", async () => {
  const time = clock(5_000);
  const load = vi
    .fn<() => Promise<{ state: "pregame" | "unavailable"; unsafeAt: number }>>()
    .mockResolvedValueOnce({ state: "pregame", unsafeAt: 6_000 })
    .mockResolvedValue({ state: "unavailable", unsafeAt: 6_000 });
  const cache = createSplitLookupCache<{
    state: "pregame" | "unavailable";
    unsafeAt: number;
  }>({
    ttlMs: 10_000,
    maxEntries: 8,
    now: time.now,
    expiresAt: ({ unsafeAt }) => unsafeAt,
    safeAfterExpiry: ({ state }) => state === "unavailable",
  });

  await cache("board", load);
  time.advance(999);
  const crossing = cache("board", load);
  time.advance(1);

  await expect(crossing).resolves.toEqual({
    state: "unavailable",
    unsafeAt: 6_000,
  });
  expect(load).toHaveBeenCalledTimes(2);
});
