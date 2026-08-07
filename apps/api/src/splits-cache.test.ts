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
