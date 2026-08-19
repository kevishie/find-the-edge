import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import type { AdminUserDirectoryItemDto } from "./api";
import type { UiGamesClient } from "./App";

const e164 = /^\+[1-9][0-9]{7,14}$/;
const requestKey = (action: string) =>
  `${action}:${globalThis.crypto.randomUUID()}`;

export default function AdminUsers({
  client,
}: {
  readonly client: UiGamesClient | null;
}) {
  const [items, setItems] = useState<readonly AdminUserDirectoryItemDto[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [phone, setPhone] = useState("");
  const [phoneError, setPhoneError] = useState<string | null>(null);
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const [announcement, setAnnouncement] = useState("");
  const mutationKeys = useRef(
    new Map<string, { readonly fingerprint: string; readonly key: string }>(),
  );
  const retainedKey = (slot: string, fingerprint: string, action: string) => {
    const retained = mutationKeys.current.get(slot);
    if (retained?.fingerprint === fingerprint) return retained.key;
    const key = requestKey(action);
    mutationKeys.current.set(slot, { fingerprint, key });
    return key;
  };

  const load = useCallback(
    async (next: string | null, append: boolean, signal: AbortSignal) => {
      if (!client?.listAdminUsers)
        throw new Error("Admin access is unavailable.");
      const page = await client.listAdminUsers(next, signal);
      setItems((current) =>
        append ? [...current, ...page.items] : page.items,
      );
      setCursor(page.cursor);
    },
    [client],
  );

  useEffect(() => {
    const controller = new AbortController();
    if (!client?.listAdminUsers) {
      void Promise.resolve().then(() => {
        if (controller.signal.aborted) return;
        setError("Admin access is unavailable.");
        setLoading(false);
      });
      return () => controller.abort();
    }
    void client
      .listAdminUsers(null, controller.signal)
      .then((page) => {
        if (controller.signal.aborted) return;
        setItems(page.items);
        setCursor(page.cursor);
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setError("Users could not be loaded. Try again.");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [client]);

  const replace = (user: AdminUserDirectoryItemDto) =>
    setItems((current) => {
      const found = current.some(
        ({ directoryId }) => directoryId === user.directoryId,
      );
      return found
        ? current.map((item) =>
            item.directoryId === user.directoryId ? user : item,
          )
        : [user, ...current];
    });

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const normalized = phone.trim();
    if (!e164.test(normalized)) {
      setPhoneError("Use E.164 format, such as +15551234567.");
      return;
    }
    if (!client?.grantAdminUserAccess) {
      setPhoneError("Admin access is unavailable.");
      return;
    }
    setPhoneError(null);
    setPending((current) => new Set(current).add("phone"));
    try {
      const key = retainedKey("grant", normalized, "grant");
      const user = await client.grantAdminUserAccess(
        normalized,
        key,
        new AbortController().signal,
      );
      replace(user);
      mutationKeys.current.delete("grant");
      setPhone("");
      setAnnouncement(`Manual access granted for ${user.displayReference}.`);
    } catch {
      setPhoneError("Access could not be granted. Refresh and try again.");
    } finally {
      setPending((current) => {
        const next = new Set(current);
        next.delete("phone");
        return next;
      });
    }
  };

  const revoke = async (user: AdminUserDirectoryItemDto) => {
    if (!client?.revokeAdminUserAccess) return;
    setPending((current) => new Set(current).add(user.directoryId));
    try {
      const slot = `revoke:${user.directoryId}`;
      const key = retainedKey(
        slot,
        `${user.directoryId}:${user.manualGrant.version}`,
        "revoke",
      );
      const updated = await client.revokeAdminUserAccess(
        user.directoryId,
        user.manualGrant.version,
        key,
        new AbortController().signal,
      );
      replace(updated);
      mutationKeys.current.delete(slot);
      setAnnouncement(
        `Manual access revoked for ${updated.displayReference}. Stripe access was not changed.`,
      );
    } catch {
      setAnnouncement(
        `Manual access for ${user.displayReference} could not be changed. Refresh and try again.`,
      );
    } finally {
      setPending((current) => {
        const next = new Set(current);
        next.delete(user.directoryId);
        return next;
      });
    }
  };

  if (loading) return <p role="status">Loading users…</p>;
  return (
    <section className="admin-users" aria-labelledby="admin-users-title">
      <header>
        <p className="eyebrow">SUPER ADMIN</p>
        <h1 id="admin-users-title">User access</h1>
        <p>
          Manual access is independent from Stripe. Revoking it never cancels a
          paid subscription.
        </p>
      </header>
      <form
        className="admin-grant-form"
        onSubmit={(event) => void submit(event)}
        noValidate
      >
        <label htmlFor="admin-phone">Grant access by phone number</label>
        <div>
          <input
            id="admin-phone"
            name="phone"
            inputMode="tel"
            autoComplete="tel"
            placeholder="+15551234567"
            value={phone}
            onChange={(event) => setPhone(event.target.value)}
            aria-describedby={phoneError ? "admin-phone-error" : undefined}
          />
          <button type="submit" disabled={pending.has("phone")}>
            {pending.has("phone") ? "Granting…" : "Grant access"}
          </button>
        </div>
        {phoneError && (
          <p id="admin-phone-error" role="alert">
            {phoneError}
          </p>
        )}
      </form>
      <p className="sr-only" aria-live="polite" aria-atomic="true">
        {announcement}
      </p>
      {error ? (
        <div role="alert">
          <p>{error}</p>
          <button type="button" onClick={() => window.location.reload()}>
            Retry
          </button>
        </div>
      ) : items.length === 0 ? (
        <p role="status">No users or pending grants yet.</p>
      ) : (
        <div className="admin-table-scroll">
          <table>
            <caption>Accounts and pending manual access grants</caption>
            <thead>
              <tr>
                <th scope="col">User</th>
                <th scope="col">Status</th>
                <th scope="col">Access sources</th>
                <th scope="col">Effective access</th>
                <th scope="col">Action</th>
              </tr>
            </thead>
            <tbody>
              {items.map((user) => (
                <tr key={user.directoryId}>
                  <th scope="row">
                    <strong>{user.displayReference}</strong>
                    <small>
                      {user.accountId
                        ? `Account ${user.accountId.slice(-8)}`
                        : `Phone ending ${user.phoneHint.slice(-2)}`}
                    </small>
                  </th>
                  <td>
                    <span className={`admin-state ${user.lifecycle}`}>
                      {user.lifecycle}
                    </span>
                  </td>
                  <td>
                    <span>{user.access.superAdmin ? "Super admin" : ""}</span>
                    <span>
                      {user.access.stripe === "active"
                        ? "Stripe"
                        : user.access.stripe === "unavailable"
                          ? "Stripe unavailable"
                          : ""}
                    </span>
                    <span>
                      {user.manualGrant.active ? "Manual override" : ""}
                    </span>
                    {user.access.sources.length === 0 && "None"}
                  </td>
                  <td>
                    {user.access.effective === "granted"
                      ? "Full access"
                      : user.access.effective === "unavailable"
                        ? "Unavailable"
                        : "No access"}
                  </td>
                  <td>
                    {user.manualGrant.active ? (
                      <button
                        type="button"
                        disabled={pending.has(user.directoryId)}
                        onClick={() => void revoke(user)}
                        aria-label={`Revoke manual access for ${user.displayReference}`}
                      >
                        {pending.has(user.directoryId)
                          ? "Revoking…"
                          : "Revoke manual"}
                      </button>
                    ) : (
                      <span>Manual off</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {cursor && (
        <button
          type="button"
          disabled={loadingMore}
          onClick={() => {
            const controller = new AbortController();
            setLoadingMore(true);
            void load(cursor, true, controller.signal)
              .catch(() =>
                setError("More users could not be loaded. Try again."),
              )
              .finally(() => setLoadingMore(false));
          }}
        >
          {loadingMore ? "Loading…" : "Load more"}
        </button>
      )}
    </section>
  );
}
