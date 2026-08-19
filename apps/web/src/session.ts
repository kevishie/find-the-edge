import {
  createContext,
  useContext,
  useEffect,
  useSyncExternalStore,
} from "react";

import {
  GamesClientError,
  isAccountId,
  isSessionToken,
  type OwnedSessionAuthorization,
} from "./api";

/**
 * The client half of our own identity (FTE-071). The token is persisted in
 * localStorage per the recorded product decision, which means any script on
 * this origin can read it: the app therefore keeps a strict CSP, loads no
 * third-party script, and holds only short-lived tokens that are refreshed
 * while the reader is present rather than long-lived ones.
 */
export interface Session {
  readonly token: string;
  readonly expiresAt: string;
  readonly accountId: string;
}

/** Versioned so a future token shape never has to read this one's entries. */
export const SESSION_STORAGE_KEY = "fte.session.v1";

/** A token inside this window of its expiry is renewed before it is used. */
export const SESSION_REFRESH_LEAD_MS = 10 * 60_000;

/** How often a signed-in tab re-checks whether the token needs renewing. */
export const SESSION_WATCH_INTERVAL_MS = 60_000;

export const DEFAULT_RETURN_PATH = "/events";

/** Where the reader lands once signed in, if they arrived without a target. */
export const SIGNED_IN_HOME = "/dashboard";

/** The sign-in form's own address. Returning to it would be a loop. */
export const LOGIN_PATH = "/login";

/** Where a signed-in reader without paid access is sent. */
export const SUBSCRIBE_PATH = "/subscribe";

/**
 * Every route this app actually serves, as literal segments and as parented
 * prefixes for the ones that take an id. A return address is checked against
 * this rather than merely against the origin: "same origin" still admits
 * paths we do not have, which land the reader on a 404 they cannot explain
 * after a step as fragile as signing in.
 */
const KNOWN_ROUTES: readonly string[] = [
  "/",
  "/terms",
  "/privacy",
  SUBSCRIBE_PATH,
  "/dashboard",
  "/events",
  "/games",
  "/splits",
  "/watchlist",
  "/performance",
  "/admin/users",
  "/data-sources",
  "/retrospectives",
  "/experiments",
];
const KNOWN_PARENTS: readonly string[] = [
  "/events/",
  "/games/",
  "/data-sources/",
  "/retrospectives/",
  "/experiments/",
  "/scout-jobs/",
];

const isKnownRoute = (pathname: string) =>
  KNOWN_ROUTES.includes(pathname) ||
  KNOWN_PARENTS.some(
    (parent) => pathname.startsWith(parent) && pathname.length > parent.length,
  );

/** Routes a signed-out reader may see. Everything else needs a session. */
export const PUBLIC_ROUTES: readonly string[] = [
  "/",
  "/terms",
  "/privacy",
  LOGIN_PATH,
  // The paywall needs a session but not an entitlement, so the session guard
  // skips it; its own route sends a signed-out reader to the form.
  SUBSCRIBE_PATH,
];

export const requiresSession = (pathname: string): boolean =>
  !PUBLIC_ROUTES.includes(pathname);

/**
 * Where sign-in is allowed to send the reader afterwards. Anything that is not
 * a single-slash path on this origin — a scheme, a protocol-relative host, a
 * backslash the browser will normalise into one — becomes the default, so a
 * crafted `?from=` can never turn our own form into an open redirect.
 */
export const safeReturnPath = (value: unknown): string => {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 512 ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.startsWith("/\\") ||
    Array.from(value).some((character) => {
      const code = character.charCodeAt(0);
      return code <= 0x20 || code === 0x7f;
    })
  )
    return DEFAULT_RETURN_PATH;
  const base = "https://find-the-edge.invalid";
  let resolved: URL;
  try {
    resolved = new URL(value, base);
  } catch {
    return DEFAULT_RETURN_PATH;
  }
  // Returning to the form itself would be a loop rather than a destination,
  // and a path we do not serve is a 404 handed to someone who just signed in.
  if (
    resolved.origin !== base ||
    `${resolved.pathname}${resolved.search}${resolved.hash}` !== value ||
    resolved.pathname === LOGIN_PATH ||
    !isKnownRoute(resolved.pathname)
  )
    return DEFAULT_RETURN_PATH;
  return value;
};

const isSession = (value: unknown): value is Session => {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const candidate: Record<string, unknown> = value as Record<string, unknown>;
  return (
    Object.keys(candidate).sort().join("|") === "accountId|expiresAt|token" &&
    isSessionToken(candidate["token"]) &&
    isAccountId(candidate["accountId"]) &&
    typeof candidate["expiresAt"] === "string" &&
    Number.isFinite(Date.parse(candidate["expiresAt"])) &&
    new Date(candidate["expiresAt"]).toISOString() === candidate["expiresAt"]
  );
};

export type SessionRefresher = (
  token: string,
  signal: AbortSignal,
) => Promise<Session>;

export interface SessionStore {
  /** Stable between notifications, so React may read it during render. */
  readonly getSnapshot: () => Session | null;
  readonly subscribe: (listener: () => void) => () => void;
  readonly signIn: (session: Session) => void;
  readonly signOut: () => void;
  /** Wired once the runtime client exists; null disables renewal. */
  readonly setRefresher: (refresh: SessionRefresher | null) => void;
  /**
   * The token to attach to the next authenticated request, renewed first when
   * it is close to expiry. Null means the reader is signed out.
   */
  readonly authorize: () => Promise<string | null>;
}

export type ProductAccessRefusal = "authentication" | "payment-required";

/**
 * Authentication refusals belong to an exact token. Payment refusals belong
 * to an account, because routine token refresh must not erase an entitlement
 * decision while an account switch must not leak it to the next reader.
 */
export const createProductRefusalHandler =
  (
    store: SessionStore,
    navigation: {
      readonly currentPath: () => string;
      readonly navigate: (path: string) => void;
    },
  ) =>
  (
    rejectedSession: OwnedSessionAuthorization | null,
    reason: ProductAccessRefusal,
  ): void => {
    const current = store.getSnapshot();
    if (reason === "authentication") {
      if (
        rejectedSession === null
          ? current !== null
          : current?.token !== rejectedSession.token
      )
        return;
      const returnPath = safeReturnPath(navigation.currentPath());
      store.signOut();
      navigation.navigate(
        `${LOGIN_PATH}?returnUrl=${encodeURIComponent(returnPath)}`,
      );
      return;
    }
    if (
      rejectedSession === null ||
      current?.accountId !== rejectedSession.accountId ||
      navigation.currentPath().split(/[?#]/u, 1)[0] === SUBSCRIBE_PATH
    )
      return;
    navigation.navigate(SUBSCRIBE_PATH);
  };

const readStorage = (storage: Storage | null): string | null => {
  try {
    return storage?.getItem(SESSION_STORAGE_KEY) ?? null;
  } catch {
    return null;
  }
};

const browserStorage = (): Storage | null => {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    // A blocked storage is a signed-out session, never a thrown error.
    return null;
  }
};

export interface SessionStoreOptions {
  readonly storage?: Storage | null;
  readonly now?: () => number;
  readonly refresh?: SessionRefresher | null;
}

/**
 * A tiny store rather than a state library: the shell subscribes, sign-in and
 * sign-out publish, and the persisted entry is re-validated on every load so a
 * corrupt or expired one is discarded silently instead of reaching a screen.
 */
export function createSessionStore(
  options: SessionStoreOptions = {},
): SessionStore {
  const storage =
    options.storage === undefined ? browserStorage() : options.storage;
  const now = options.now ?? (() => Date.now());
  let refresher: SessionRefresher | null = options.refresh ?? null;
  let current: Session | null = null;
  let inFlight: {
    readonly sourceToken: string;
    readonly promise: Promise<string | null>;
  } | null = null;
  const listeners = new Set<() => void>();

  const notify = () => {
    for (const listener of [...listeners]) listener();
  };

  const write = (session: Session | null) => {
    try {
      if (session === null) storage?.removeItem(SESSION_STORAGE_KEY);
      else storage?.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
    } catch {
      // Persistence is best effort; the in-memory session still stands.
    }
  };

  /** Re-reads storage and drops anything that is not a live session. */
  const hydrate = (): boolean => {
    const raw = readStorage(storage);
    let parsed: unknown = null;
    if (raw !== null)
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = null;
      }
    const next =
      isSession(parsed) && Date.parse(parsed.expiresAt) > now()
        ? Object.freeze({
            token: parsed.token,
            expiresAt: parsed.expiresAt,
            accountId: parsed.accountId,
          })
        : null;
    if (next === null && raw !== null) write(null);
    const changed =
      next === null
        ? current !== null
        : current === null || current.token !== next.token;
    current = changed ? next : current;
    return changed;
  };

  const clear = () => {
    inFlight = null;
    write(null);
    // Signing out clears everything this app stored, not just the token.
    // View preferences and cached boards are still a record of what the
    // previous reader was looking at, and on a shared machine the next
    // person should inherit none of it.
    try {
      const owned: string[] = [];
      for (let index = 0; index < (storage?.length ?? 0); index += 1) {
        const key = storage?.key(index);
        if (key !== null && key !== undefined && key.startsWith("fte."))
          owned.push(key);
      }
      for (const key of owned) storage?.removeItem(key);
    } catch {
      // Storage may be unavailable or full; the in-memory session is still
      // dropped below, which is what actually signs the reader out.
    }
    if (current !== null) {
      current = null;
      notify();
    }
  };

  const save = (session: Session) => {
    const normalized = Object.freeze({
      token: session.token,
      expiresAt: session.expiresAt,
      accountId: session.accountId,
    });
    if (!isSession(normalized)) {
      clear();
      return;
    }
    current = normalized;
    write(normalized);
    notify();
  };

  hydrate();

  const renew = async (session: Session): Promise<string | null> => {
    const refresh = refresher;
    if (!refresh) return session.token;
    const isStillCurrent = () => current?.token === session.token;
    const controller = new AbortController();
    try {
      const renewed = await refresh(session.token, controller.signal);
      if (!isStillCurrent()) return null;
      save(renewed);
      return current?.token ?? null;
    } catch (error) {
      // Sign-in or cross-tab replacement owns the store now. The old request
      // may settle, but it has no authority to save, clear, or authorize.
      if (!isStillCurrent()) return null;
      // A refused refresh is terminal: the session is cleared once and the
      // reader is signed out. Retrying a rejection is the loop this story
      // forbids.
      if (
        error instanceof GamesClientError &&
        (error.code === "unauthorized" || error.code === "authentication")
      ) {
        clear();
        return null;
      }
      // A transport failure says nothing about the token, which is still
      // valid for now; the next attempt is the caller's own.
      return session.token;
    } finally {
      if (inFlight?.sourceToken === session.token) inFlight = null;
    }
  };

  return {
    getSnapshot: () => current,
    subscribe: (listener) => {
      listeners.add(listener);
      const onStorage = (event: StorageEvent) => {
        if (event.key !== null && event.key !== SESSION_STORAGE_KEY) return;
        if (hydrate()) notify();
      };
      if (typeof window !== "undefined")
        window.addEventListener("storage", onStorage);
      return () => {
        listeners.delete(listener);
        if (typeof window !== "undefined")
          window.removeEventListener("storage", onStorage);
      };
    },
    signIn: save,
    signOut: clear,
    setRefresher: (refresh) => {
      refresher = refresh;
    },
    authorize: () => {
      const session = current;
      if (session === null) return Promise.resolve(null);
      const remaining = Date.parse(session.expiresAt) - now();
      if (remaining <= 0) {
        clear();
        return Promise.resolve(null);
      }
      if (remaining > SESSION_REFRESH_LEAD_MS)
        return Promise.resolve(session.token);
      // Concurrent callers for one token share renewal. A replacement token
      // starts its own request instead of inheriting the previous account's.
      if (inFlight?.sourceToken !== session.token)
        inFlight = { sourceToken: session.token, promise: renew(session) };
      return inFlight.promise;
    },
  };
}

export const defaultSessionStore: SessionStore = createSessionStore();

export const SessionContext = createContext<SessionStore>(defaultSessionStore);

export const useSessionStore = (): SessionStore => useContext(SessionContext);

/**
 * The signed-in session, plus the only place expiry is decided: never during
 * render, always on a timer the shell owns. A token that cannot be renewed
 * signs the reader out once and stays out.
 */
export function useSession(store: SessionStore): Session | null {
  const session = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot,
  );
  useEffect(() => {
    if (session === null) return;
    let timer = 0;
    let stopped = false;
    const tick = () => {
      void store.authorize().finally(() => {
        if (stopped) return;
        timer = window.setTimeout(tick, SESSION_WATCH_INTERVAL_MS);
      });
    };
    tick();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [session, store]);
  return session;
}

/** A short, non-identifying handle for the signed-in account. */
export const accountHint = (accountId: string): string =>
  `…${accountId.slice(-6)}`;
