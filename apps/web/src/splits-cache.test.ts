import { beforeEach, expect, it, vi } from "vitest";
import {
  clearSplitsCache,
  loadSplits,
  prefetchSplits,
  readCachedSplits,
  splitsCacheKey,
} from "./splits-cache";

beforeEach(clearSplitsCache);

const page = (items: number) => ({
  items: Array.from({ length: items }, (_, index) => ({ id: `game-${index}` })),
  freshness: null,
  snapshotAt: null,
});

type Page = ReturnType<typeof page>;

it("keys boards by sport and day", () => {
  expect(splitsCacheKey("mlb", "2026-08-07")).toBe("mlb:2026-08-07");
  expect(splitsCacheKey("soccer", "2026-08-07")).not.toBe(
    splitsCacheKey("mlb", "2026-08-07"),
  );
});

it("caches a loaded board for later readers", async () => {
  const listSplits = vi.fn(() => Promise.resolve(page(2)));

  expect(readCachedSplits("mlb", "2026-08-07")).toBeUndefined();
  await loadSplits({ listSplits }, "mlb", "2026-08-07");

  expect(readCachedSplits<Page>("mlb", "2026-08-07")?.page.items).toHaveLength(
    2,
  );
  expect(readCachedSplits("mlb", "2026-08-08")).toBeUndefined();
});

it("shares one request between callers that overlap", async () => {
  let resolve: (value: Page) => void = () => {};
  const listSplits = vi.fn(
    () =>
      new Promise<Page>((settle) => {
        resolve = settle;
      }),
  );

  const first = loadSplits({ listSplits }, "mlb", "2026-08-07");
  const second = loadSplits({ listSplits }, "mlb", "2026-08-07");
  resolve(page(1));
  await Promise.all([first, second]);

  expect(listSplits).toHaveBeenCalledTimes(1);
});

it("refetches after a request settles so polling still revalidates", async () => {
  const listSplits = vi.fn(() => Promise.resolve(page(1)));

  await loadSplits({ listSplits }, "mlb", "2026-08-07");
  await loadSplits({ listSplits }, "mlb", "2026-08-07");

  expect(listSplits).toHaveBeenCalledTimes(2);
});

it("does not cache a failed load", async () => {
  const listSplits = vi.fn(() => Promise.reject(new Error("unavailable")));

  await expect(loadSplits({ listSplits }, "mlb", "2026-08-07")).rejects.toThrow(
    "unavailable",
  );
  expect(readCachedSplits("mlb", "2026-08-07")).toBeUndefined();
});

it("warms a board once and swallows warm-up failures", async () => {
  const listSplits = vi.fn(() => Promise.resolve(page(3)));
  const client = { listSplits };

  prefetchSplits(client, "mlb", "2026-08-07");
  await vi.waitFor(() =>
    expect(readCachedSplits("mlb", "2026-08-07")).toBeDefined(),
  );
  // An already warm board is not fetched again.
  prefetchSplits(client, "mlb", "2026-08-07");
  expect(listSplits).toHaveBeenCalledTimes(1);

  const failing = {
    listSplits: vi.fn(() => Promise.reject(new Error("unavailable"))),
  };
  expect(() => prefetchSplits(failing, "mlb", "2026-08-08")).not.toThrow();
});

it("ignores a client that cannot list splits", () => {
  expect(() => prefetchSplits(undefined, "mlb", "2026-08-07")).not.toThrow();
  expect(() => prefetchSplits({}, "mlb", "2026-08-07")).not.toThrow();
  expect(readCachedSplits("mlb", "2026-08-07")).toBeUndefined();
});
