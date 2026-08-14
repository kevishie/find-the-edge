import { expect, describe, it, vi } from "vitest";

import { GamesClientError } from "./api";
import {
  createProductRefusalHandler,
  createSessionStore,
  DEFAULT_RETURN_PATH,
  LOGIN_PATH,
  requiresSession,
  safeReturnPath,
  SESSION_STORAGE_KEY,
  SUBSCRIBE_PATH,
  type Session,
} from "./session";

class MemoryStorage implements Storage {
  private readonly entries = new Map<string, string>();

  get length() {
    return this.entries.size;
  }
  clear() {
    this.entries.clear();
  }
  getItem(key: string) {
    return this.entries.get(key) ?? null;
  }
  key(index: number) {
    return [...this.entries.keys()][index] ?? null;
  }
  removeItem(key: string) {
    this.entries.delete(key);
  }
  setItem(key: string, value: string) {
    this.entries.set(key, value);
  }
}

const NOW = Date.parse("2026-08-11T12:00:00.000Z");
const token = (marker: string) =>
  `fte1.${marker.padEnd(40, "x")}.${"a".repeat(64)}`;
const ACCOUNT = `account:${"b".repeat(64)}`;
const OTHER_ACCOUNT = `account:${"c".repeat(64)}`;
const authorization = (marker: string, accountId = ACCOUNT) => ({
  token: token(marker),
  accountId,
});

const session = (minutesLeft: number, marker = "first"): Session => ({
  token: token(marker),
  expiresAt: new Date(NOW + minutesLeft * 60_000).toISOString(),
  accountId: ACCOUNT,
});

const storeWith = (
  stored: unknown,
  options: { readonly refresh?: (token: string) => Promise<Session> } = {},
) => {
  const storage = new MemoryStorage();
  if (stored !== undefined)
    storage.setItem(
      SESSION_STORAGE_KEY,
      typeof stored === "string" ? stored : JSON.stringify(stored),
    );
  const refresh = options.refresh;
  const store = createSessionStore({
    storage,
    now: () => NOW,
    ...(refresh ? { refresh: (value: string) => refresh(value) } : {}),
  });
  return { storage, store };
};

describe("persistence", () => {
  it("keeps a signed-in session across a reload of the store", () => {
    const { storage, store } = storeWith(undefined);
    store.signIn(session(60));

    expect(store.getSnapshot()).toEqual(session(60));
    // A fresh store over the same storage is what a page reload looks like.
    expect(
      createSessionStore({ storage, now: () => NOW }).getSnapshot(),
    ).toEqual(session(60));
  });

  it("stores only the three session fields under one versioned key", () => {
    const { storage, store } = storeWith(undefined);
    const withExtra: Session & { readonly extra: string } = {
      ...session(60),
      extra: "ignored",
    };
    store.signIn(withExtra);

    expect(
      JSON.parse(storage.getItem(SESSION_STORAGE_KEY) ?? "null") as unknown,
    ).toEqual(session(60));
    expect(storage.length).toBe(1);
  });

  it("notifies subscribers on sign-in and clears the key on sign-out", () => {
    const { storage, store } = storeWith(undefined);
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);

    store.signIn(session(60));
    expect(listener).toHaveBeenCalledTimes(1);

    store.signOut();
    expect(listener).toHaveBeenCalledTimes(2);
    expect(store.getSnapshot()).toBeNull();
    expect(storage.getItem(SESSION_STORAGE_KEY)).toBeNull();

    unsubscribe();
    store.signIn(session(60));
    expect(listener).toHaveBeenCalledTimes(2);
  });
});

describe("stored entries that are not a live session", () => {
  it.each([
    ["unparseable text", "not json at all"],
    ["a session that has already expired", JSON.stringify(session(-1))],
    [
      "a foreign token",
      JSON.stringify({ ...session(60), token: `x.${"y".repeat(40)}.z` }),
    ],
    [
      "an account id that is not a digest",
      JSON.stringify({ ...session(60), accountId: "account:+15551234567" }),
    ],
    [
      "an entry carrying extra fields",
      JSON.stringify({ ...session(60), scope: "admin" }),
    ],
    ["a non-object entry", JSON.stringify([session(60)])],
  ])("discards %s silently and removes it", (_label, stored) => {
    const { storage, store } = storeWith(stored);

    expect(store.getSnapshot()).toBeNull();
    expect(storage.getItem(SESSION_STORAGE_KEY)).toBeNull();
  });
});

describe("proactive refresh", () => {
  it("leaves a token alone while it is far from expiry", async () => {
    const refresh = vi.fn(() => Promise.resolve(session(60, "second")));
    const { store } = storeWith(JSON.stringify(session(59)), { refresh });

    await expect(store.authorize()).resolves.toBe(token("first"));
    expect(refresh).not.toHaveBeenCalled();
  });

  it("renews a token inside the refresh window before the request uses it", async () => {
    const refresh = vi.fn(() => Promise.resolve(session(60, "second")));
    const { storage, store } = storeWith(JSON.stringify(session(9)), {
      refresh,
    });
    const listener = vi.fn();
    store.subscribe(listener);

    await expect(store.authorize()).resolves.toBe(token("second"));
    expect(refresh).toHaveBeenCalledWith(token("first"));
    expect(store.getSnapshot()?.token).toBe(token("second"));
    expect(
      JSON.parse(storage.getItem(SESSION_STORAGE_KEY) ?? "null") as unknown,
    ).toEqual(session(60, "second"));
    expect(listener).toHaveBeenCalled();
  });

  it("shares one renewal between concurrent callers", async () => {
    const refresh = vi.fn(() => Promise.resolve(session(60, "second")));
    const { store } = storeWith(JSON.stringify(session(5)), { refresh });

    await expect(
      Promise.all([store.authorize(), store.authorize()]),
    ).resolves.toEqual([token("second"), token("second")]);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("does not overwrite a replacement account when an old refresh succeeds", async () => {
    let resolveRefresh!: (value: Session) => void;
    const refresh = vi.fn(
      () =>
        new Promise<Session>((resolve) => {
          resolveRefresh = resolve;
        }),
    );
    const { storage, store } = storeWith(JSON.stringify(session(5)), {
      refresh,
    });
    const pending = store.authorize();
    const replacement = {
      ...session(60, "replacement"),
      accountId: OTHER_ACCOUNT,
    };
    store.signIn(replacement);

    resolveRefresh(session(60, "renewed-old"));

    await expect(pending).resolves.toBeNull();
    expect(store.getSnapshot()).toEqual(replacement);
    expect(
      JSON.parse(storage.getItem(SESSION_STORAGE_KEY) ?? "null") as unknown,
    ).toEqual(replacement);
  });

  it("does not clear a replacement account when an old refresh is refused", async () => {
    let rejectRefresh!: (reason: Error) => void;
    const refresh = vi.fn(
      () =>
        new Promise<Session>((_resolve, reject) => {
          rejectRefresh = reject;
        }),
    );
    const { storage, store } = storeWith(JSON.stringify(session(5)), {
      refresh,
    });
    const pending = store.authorize();
    const replacement = {
      ...session(60, "replacement"),
      accountId: OTHER_ACCOUNT,
    };
    store.signIn(replacement);

    rejectRefresh(new GamesClientError("unauthorized", "Old token ended."));

    await expect(pending).resolves.toBeNull();
    expect(store.getSnapshot()).toEqual(replacement);
    expect(
      JSON.parse(storage.getItem(SESSION_STORAGE_KEY) ?? "null") as unknown,
    ).toEqual(replacement);
  });

  it("starts a distinct renewal when a replacement account authorizes", async () => {
    const resolvers = new Map<string, (value: Session) => void>();
    const refresh = vi.fn(
      (sourceToken: string) =>
        new Promise<Session>((resolve) => {
          resolvers.set(sourceToken, resolve);
        }),
    );
    const { store } = storeWith(JSON.stringify(session(5)), { refresh });
    const oldAuthorization = store.authorize();
    const replacement = {
      ...session(5, "replacement"),
      accountId: OTHER_ACCOUNT,
    };
    store.signIn(replacement);
    const replacementAuthorization = store.authorize();

    expect(refresh).toHaveBeenCalledTimes(2);
    expect(refresh).toHaveBeenNthCalledWith(1, token("first"));
    expect(refresh).toHaveBeenNthCalledWith(2, token("replacement"));

    const renewedReplacement = {
      ...session(60, "renewed-replacement"),
      accountId: OTHER_ACCOUNT,
    };
    resolvers.get(token("replacement"))!(renewedReplacement);
    await expect(replacementAuthorization).resolves.toBe(
      token("renewed-replacement"),
    );

    // The old account settles last and cannot clear or replace B's result.
    resolvers.get(token("first"))!(session(60, "renewed-old"));
    await expect(oldAuthorization).resolves.toBeNull();
    expect(store.getSnapshot()).toEqual(renewedReplacement);
  });

  it("signs out cleanly on a refused renewal and never retries it", async () => {
    const refresh = vi.fn(() =>
      Promise.reject(new GamesClientError("unauthorized", "gone")),
    );
    const { storage, store } = storeWith(JSON.stringify(session(3)), {
      refresh,
    });
    const listener = vi.fn();
    store.subscribe(listener);

    await expect(store.authorize()).resolves.toBeNull();
    expect(store.getSnapshot()).toBeNull();
    expect(storage.getItem(SESSION_STORAGE_KEY)).toBeNull();
    expect(listener).toHaveBeenCalledTimes(1);

    // The second call has nothing left to renew, so the refresher is never
    // asked again: a rejected session cannot become a retry loop.
    await expect(store.authorize()).resolves.toBeNull();
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("keeps a still-valid token when renewal fails on the wire", async () => {
    const refresh = vi.fn(() =>
      Promise.reject(new GamesClientError("request-failed", "offline")),
    );
    const { store } = storeWith(JSON.stringify(session(5)), { refresh });

    await expect(store.authorize()).resolves.toBe(token("first"));
    expect(store.getSnapshot()?.token).toBe(token("first"));
  });

  it("signs out rather than renewing a token that has already expired", async () => {
    const refresh = vi.fn(() => Promise.resolve(session(60, "second")));
    const { storage, store } = storeWith(undefined, { refresh });
    // Signed in while live, then held past expiry without a reload.
    store.signIn(session(-1));

    await expect(store.authorize()).resolves.toBeNull();
    expect(refresh).not.toHaveBeenCalled();
    expect(store.getSnapshot()).toBeNull();
    expect(storage.getItem(SESSION_STORAGE_KEY)).toBeNull();
  });

  it("authorizes nothing when nobody is signed in", async () => {
    const { store } = storeWith(undefined);
    await expect(store.authorize()).resolves.toBeNull();
  });

  it("hands back the token unchanged when no refresher is wired", async () => {
    const { store } = storeWith(JSON.stringify(session(2)));
    await expect(store.authorize()).resolves.toBe(token("first"));
  });
});

describe("product refusal handling", () => {
  const handlerFor = (store: ReturnType<typeof createSessionStore>) => {
    const navigate = vi.fn();
    return {
      navigate,
      handle: createProductRefusalHandler(store, {
        currentPath: () => "/splits?view=heat#top",
        navigate,
      }),
    };
  };

  it("signs out the rejected current token and navigates to login", () => {
    const { store } = storeWith(JSON.stringify(session(30)));
    const { handle, navigate } = handlerFor(store);

    handle(authorization("first"), "authentication");

    expect(store.getSnapshot()).toBeNull();
    expect(navigate).toHaveBeenCalledWith(
      "/login?returnUrl=%2Fsplits%3Fview%3Dheat%23top",
    );
  });

  it("keeps the session and navigates a current 402 to subscribe", () => {
    const { store } = storeWith(JSON.stringify(session(30)));
    const { handle, navigate } = handlerFor(store);

    handle(authorization("first"), "payment-required");

    expect(store.getSnapshot()?.token).toBe(token("first"));
    expect(navigate).toHaveBeenCalledWith(SUBSCRIBE_PATH);
  });

  it("ignores stale authentication but keeps payment authority across refresh", () => {
    const { store } = storeWith(JSON.stringify(session(30)));
    const { handle, navigate } = handlerFor(store);
    store.signIn(session(60, "second"));

    handle(authorization("first"), "authentication");

    expect(store.getSnapshot()?.token).toBe(token("second"));
    expect(navigate).not.toHaveBeenCalled();

    handle(authorization("first"), "payment-required");

    expect(store.getSnapshot()?.token).toBe(token("second"));
    expect(navigate).toHaveBeenCalledWith(SUBSCRIBE_PATH);
  });

  it("ignores a payment refusal from an account that has since changed", () => {
    const { store } = storeWith(JSON.stringify(session(30)));
    const { handle, navigate } = handlerFor(store);
    store.signIn({ ...session(60, "second"), accountId: OTHER_ACCOUNT });

    handle(authorization("first"), "payment-required");

    expect(store.getSnapshot()?.accountId).toBe(OTHER_ACCOUNT);
    expect(navigate).not.toHaveBeenCalled();
  });

  it("routes a vanished session to login without overriding a new session", () => {
    const { store } = storeWith(undefined);
    const { handle, navigate } = handlerFor(store);

    handle(null, "authentication");

    expect(navigate).toHaveBeenCalledWith(
      "/login?returnUrl=%2Fsplits%3Fview%3Dheat%23top",
    );
    navigate.mockClear();
    store.signIn(session(30));

    handle(null, "authentication");

    expect(store.getSnapshot()?.token).toBe(token("first"));
    expect(navigate).not.toHaveBeenCalled();
  });

  it("does not re-navigate a payment refusal already on subscribe", () => {
    const { store } = storeWith(JSON.stringify(session(30)));
    const navigate = vi.fn();
    const handle = createProductRefusalHandler(store, {
      currentPath: () => "/subscribe?plan=annual",
      navigate,
    });

    handle(authorization("first"), "payment-required");

    expect(navigate).not.toHaveBeenCalled();
  });
});

describe("return paths", () => {
  it.each([
    ["/events", "/events"],
    ["/events?sport=mlb&day=2026-08-11", "/events?sport=mlb&day=2026-08-11"],
    ["/splits#top", "/splits#top"],
    ["https://evil.example/steal", "/events"],
    ["//evil.example/steal", "/events"],
    ["/\\evil.example", "/events"],
    ["javascript:alert(1)", "/events"],
    ["events", "/events"],
    ["", "/events"],
    ["/sign-in", "/events"],
    [undefined, "/events"],
    [{ toString: (): string => "/splits" }, "/events"],
    [`/events?q=${"x".repeat(600)}`, "/events"],
  ])("resolves %s to %s", (value, expected) => {
    expect(safeReturnPath(value)).toBe(expected);
  });
});

describe("where a return address may point", () => {
  it("refuses a path this app does not serve", () => {
    // Same-origin is not enough. A path we do not route lands the reader on a
    // 404 immediately after the most fragile step in the product.
    for (const path of ["/admin", "/wp-login.php", "/dashboardx", "/events/"])
      expect(safeReturnPath(path)).toBe(DEFAULT_RETURN_PATH);
  });

  it("keeps the routes we do serve, including parented ones", () => {
    for (const path of [
      // The paywall is a real destination: a reader sent to sign in from it
      // must come back to it, not to a default board they did not ask for.
      "/subscribe",
      "/splits",
      "/dashboard",
      "/watchlist",
      "/events?sport=soccer",
      "/events/event%3Amlb",
      "/scout-jobs/job-1/report",
    ])
      expect(safeReturnPath(path)).toBe(path);
  });

  it("refuses anything that could leave this origin", () => {
    for (const path of [
      "https://evil.example/steal",
      "//evil.example/steal",
      "/\\evil.example",
      "javascript:alert(1)",
      "/splits\nSet-Cookie: x",
      "",
      null,
    ])
      expect(safeReturnPath(path)).toBe(DEFAULT_RETURN_PATH);
  });

  it("never returns to the form itself", () => {
    // Otherwise signing in hands the reader straight back to signing in.
    expect(safeReturnPath(LOGIN_PATH)).toBe(DEFAULT_RETURN_PATH);
  });

  it("knows which routes need a session", () => {
    for (const path of ["/", "/terms", "/privacy", LOGIN_PATH, SUBSCRIBE_PATH])
      expect(requiresSession(path)).toBe(false);
    for (const path of ["/splits", "/dashboard", "/events", "/watchlist"])
      expect(requiresSession(path)).toBe(true);
  });
});
