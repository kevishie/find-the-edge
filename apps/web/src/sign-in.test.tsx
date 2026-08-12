import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "./App";
import { GamesClientError, RateLimitedError } from "./api";
import {
  SignIn,
  normalizePhoneInput,
  type SignInClient,
  type SignInClientResult,
} from "./sign-in";
import {
  createSessionStore,
  SESSION_STORAGE_KEY,
  type Session,
} from "./session";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  window.localStorage.clear();
});

const TOKEN = `fte1.${"payload".padEnd(40, "x")}.${"a".repeat(64)}`;
const ACCOUNT = `account:${"b".repeat(64)}`;

const authSession = {
  schemaVersion: "auth-session-v1" as const,
  token: TOKEN,
  expiresAt: "2026-08-11T13:00:00.000Z",
  accountId: ACCOUNT,
};

const accepted = {
  schemaVersion: "auth-otp-request-v1" as const,
  status: "accepted" as const,
  expiresInSeconds: 300,
  resendAfterSeconds: 30,
};

const client = (overrides: SignInClient = {}): SignInClientResult => ({
  ok: true,
  value: {
    requestOtp: vi.fn(() => Promise.resolve(accepted)),
    verifyOtp: vi.fn(() => Promise.resolve(authSession)),
    ...overrides,
  },
});

const store = () => createSessionStore({ storage: window.localStorage });

const typePhone = (value: string) => {
  fireEvent.change(screen.getByLabelText("Mobile number"), {
    target: { value },
  });
};

// The code field arrives in a later render than the click that asks for it.
const typeCode = async (value: string) => {
  fireEvent.change(await screen.findByLabelText("6-digit code"), {
    target: { value },
  });
};

describe("phone normalization", () => {
  it.each([
    ["(555) 123-4567", "+15551234567"],
    ["555 123 4567", "+15551234567"],
    ["1-555-123-4567", "+15551234567"],
    ["+15551234567", "+15551234567"],
    ["+44 808 157 0000", "+448081570000"],
  ])("reads %s as %s", (input, expected) => {
    expect(normalizePhoneInput(input)).toBe(expected);
  });

  it.each(["", "555", "0555 123 4567", "+0123456789", "abcdefghij"])(
    "refuses %s rather than guessing",
    (input) => {
      expect(normalizePhoneInput(input)).toBeNull();
    },
  );
});

it("carries a normalized number to the code step and stores the session at the destination", async () => {
  const verifyOtp = vi.fn(() => Promise.resolve(authSession));
  const requestOtp = vi.fn(() => Promise.resolve(accepted));
  const onSignedIn = vi.fn();
  const sessionStore = store();
  render(
    <SignIn
      client={client({ requestOtp, verifyOtp })}
      store={sessionStore}
      from="/splits"
      onSignedIn={onSignedIn}
    />,
  );

  const send = screen.getByRole("button", { name: "Send code" });
  expect(send).toBeDisabled();

  typePhone("(555) 123-4567");
  expect(screen.getByText("We will text +1 (555) 123-4567.")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Send code" }));

  expect(await screen.findByLabelText("6-digit code")).toBeVisible();
  expect(requestOtp).toHaveBeenCalledWith("+15551234567", expect.anything());
  // The same neutral sentence whether or not the number is known.
  expect(
    screen.getByText(/If \+1 \(555\) 123-4567 can receive texts/),
  ).toBeVisible();

  const verify = screen.getByRole("button", { name: "Verify code" });
  expect(verify).toBeDisabled();
  await typeCode("12ab34");
  expect(screen.getByLabelText("6-digit code")).toHaveValue("1234");
  await typeCode("123456");
  fireEvent.click(screen.getByRole("button", { name: "Verify code" }));

  await vi.waitFor(() => {
    expect(onSignedIn).toHaveBeenCalledWith("/splits");
  });
  expect(verifyOtp).toHaveBeenCalledWith(
    "+15551234567",
    "123456",
    expect.anything(),
  );
  expect(sessionStore.getSnapshot()).toEqual({
    token: TOKEN,
    expiresAt: authSession.expiresAt,
    accountId: ACCOUNT,
  });
  expect(
    JSON.parse(window.localStorage.getItem(SESSION_STORAGE_KEY) ?? "null"),
  ).toEqual(sessionStore.getSnapshot());
});

it("never returns the reader to another origin", async () => {
  const onSignedIn = vi.fn();
  render(
    <SignIn
      client={client()}
      store={store()}
      from="https://evil.example/harvest"
      onSignedIn={onSignedIn}
    />,
  );

  typePhone("5551234567");
  fireEvent.click(screen.getByRole("button", { name: "Send code" }));
  await typeCode("123456");
  fireEvent.click(await screen.findByRole("button", { name: "Verify code" }));

  await vi.waitFor(() => {
    expect(onSignedIn).toHaveBeenCalledWith("/events");
  });
  // Nothing on this screen points off the origin either.
  expect(screen.queryByRole("link")).not.toBeInTheDocument();
});

it("says only that the code did not work and stores nothing", async () => {
  const sessionStore = store();
  const onSignedIn = vi.fn();
  render(
    <SignIn
      client={client({
        verifyOtp: vi.fn(() =>
          Promise.reject(
            new GamesClientError(
              "invalid-credentials",
              "That code did not work.",
            ),
          ),
        ),
      })}
      store={sessionStore}
      onSignedIn={onSignedIn}
    />,
  );

  typePhone("5551234567");
  fireEvent.click(screen.getByRole("button", { name: "Send code" }));
  await typeCode("000000");
  fireEvent.click(await screen.findByRole("button", { name: "Verify code" }));

  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent("That code did not work.");
  // Nothing hints at whether the number is known to us.
  expect(alert.textContent).not.toMatch(/number|account|unknown|expired/i);
  expect(sessionStore.getSnapshot()).toBeNull();
  expect(onSignedIn).not.toHaveBeenCalled();
  expect(screen.getByLabelText("6-digit code")).toHaveValue("");
});

it("counts down a rate limit and refuses attempts until it lapses", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  render(
    <SignIn
      client={client({
        verifyOtp: vi.fn(() =>
          Promise.reject(new RateLimitedError(3, "Too many attempts.")),
        ),
      })}
      store={store()}
      onSignedIn={vi.fn()}
    />,
  );

  typePhone("5551234567");
  fireEvent.click(screen.getByRole("button", { name: "Send code" }));
  await typeCode("123456");
  fireEvent.click(await screen.findByRole("button", { name: "Verify code" }));

  expect(await screen.findByText("Try again in 0:03.")).toBeVisible();
  expect(screen.getByRole("button", { name: "Verify code" })).toBeDisabled();

  await act(async () => {
    vi.advanceTimersByTime(2_000);
    await Promise.resolve();
  });
  expect(screen.getByText("Try again in 0:01.")).toBeVisible();

  await act(async () => {
    vi.advanceTimersByTime(1_000);
    await Promise.resolve();
  });
  expect(screen.queryByText(/Try again in/)).not.toBeInTheDocument();
  await typeCode("123456");
  expect(screen.getByRole("button", { name: "Verify code" })).toBeEnabled();
});

it("holds the resend control for the window the API published", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const requestOtp = vi.fn(() =>
    Promise.resolve({ ...accepted, resendAfterSeconds: 2 }),
  );
  render(
    <SignIn
      client={client({ requestOtp })}
      store={store()}
      onSignedIn={vi.fn()}
    />,
  );

  typePhone("5551234567");
  fireEvent.click(screen.getByRole("button", { name: "Send code" }));

  expect(
    await screen.findByRole("button", { name: "Resend code in 0:02" }),
  ).toBeDisabled();
  // The cooldown is about resending, so the code can still be entered.
  await typeCode("123456");
  expect(screen.getByRole("button", { name: "Verify code" })).toBeEnabled();

  await act(async () => {
    vi.advanceTimersByTime(2_000);
    await Promise.resolve();
  });
  const resend = await screen.findByRole("button", { name: "Resend code" });
  expect(resend).toBeEnabled();
  fireEvent.click(resend);
  await vi.waitFor(() => {
    expect(requestOtp).toHaveBeenCalledTimes(2);
  });
});

it("offers the same attempt again when the network fails", async () => {
  let attempt = 0;
  const requestOtp = vi.fn(() => {
    attempt += 1;
    return attempt === 1
      ? Promise.reject(
          new GamesClientError("request-failed", "A code could not be sent."),
        )
      : Promise.resolve(accepted);
  });
  render(
    <SignIn
      client={client({ requestOtp })}
      store={store()}
      onSignedIn={vi.fn()}
    />,
  );

  typePhone("5551234567");
  fireEvent.click(screen.getByRole("button", { name: "Send code" }));

  expect(await screen.findByRole("alert")).toHaveTextContent(
    "A code could not be sent.",
  );
  const retry = screen.getByRole("button", { name: "Send code" });
  expect(retry).toBeEnabled();
  fireEvent.click(retry);

  expect(await screen.findByLabelText("6-digit code")).toBeVisible();
});

it("returns to the number without keeping the code", async () => {
  render(<SignIn client={client()} store={store()} onSignedIn={vi.fn()} />);

  typePhone("5551234567");
  fireEvent.click(screen.getByRole("button", { name: "Send code" }));
  await typeCode("123456");
  fireEvent.click(await screen.findByRole("button", { name: "Change number" }));

  expect(screen.getByLabelText("Mobile number")).toHaveValue("5551234567");
  expect(screen.queryByLabelText("6-digit code")).not.toBeInTheDocument();
});

it("says so plainly when the deployment has no identity API", () => {
  render(
    <SignIn
      client={{ ok: true, value: {} }}
      store={store()}
      onSignedIn={vi.fn()}
    />,
  );

  expect(screen.getByRole("alert")).toHaveTextContent(
    "Sign in is unavailable in this environment.",
  );
  typePhone("5551234567");
  expect(screen.getByRole("button", { name: "Send code" })).toBeDisabled();
});

describe("the shell indicator", () => {
  const shellClient = { ok: true as const, value: { list: vi.fn() } };
  const live = (): Session => ({
    token: TOKEN,
    expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
    accountId: ACCOUNT,
  });

  beforeEach(() => {
    window.localStorage.clear();
  });

  it("sends a signed-out reader to our own form, carrying where they meant to go", async () => {
    window.localStorage.setItem(SESSION_STORAGE_KEY, "{ corrupt");
    const sessionStore = store();
    render(
      <App
        initialPath="/performance"
        gamesClient={shellClient}
        sessionStore={sessionStore}
      />,
    );

    // A product route is not reachable without a session: the reader lands on
    // our own form, never a provider's.
    expect(
      await screen.findByRole("heading", { name: "Sign in" }),
    ).toBeVisible();
    // The corrupt entry was discarded on load rather than surfaced.
    expect(window.localStorage.getItem(SESSION_STORAGE_KEY)).toBeNull();
  });

  it("discards a session that expired while the tab was closed", async () => {
    window.localStorage.setItem(
      SESSION_STORAGE_KEY,
      JSON.stringify({ ...live(), expiresAt: "2020-01-01T00:00:00.000Z" }),
    );
    render(
      <App
        initialPath="/performance"
        gamesClient={shellClient}
        sessionStore={store()}
      />,
    );

    expect(
      await screen.findByRole("heading", { name: "Sign in" }),
    ).toBeVisible();
    expect(window.localStorage.getItem(SESSION_STORAGE_KEY)).toBeNull();
  });

  it("retires the token, empties our storage, and leaves the screen on sign-out", async () => {
    const revokeSession = vi.fn(() => Promise.resolve());
    const sessionStore = store();
    sessionStore.signIn(live());
    // Anything this app stored is a record of the previous reader; on a
    // shared machine the next one should inherit none of it.
    window.localStorage.setItem("fte.splitsView", "grid");
    window.localStorage.setItem("fte.navCollapsed", "1");
    render(
      <App
        initialPath="/performance"
        gamesClient={{
          ok: true as const,
          value: { ...shellClient.value, revokeSession },
        }}
        sessionStore={sessionStore}
      />,
    );

    expect(
      await screen.findByText(`Signed in …${ACCOUNT.slice(-6)}`),
    ).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));

    // Off the product screen entirely: staying would show a shell whose every
    // request is about to fail.
    expect(
      (await screen.findAllByRole("link", { name: "Start free trial" })).length,
    ).toBeGreaterThan(0);
    expect(sessionStore.getSnapshot()).toBeNull();
    expect(window.localStorage.getItem(SESSION_STORAGE_KEY)).toBeNull();
    expect(window.localStorage.getItem("fte.splitsView")).toBeNull();
    expect(window.localStorage.getItem("fte.navCollapsed")).toBeNull();
    // The token is retired server-side, so every other copy of it dies too.
    expect(revokeSession).toHaveBeenCalledWith(TOKEN, expect.anything());
  });

  it("still signs the reader out when revocation cannot be delivered", async () => {
    // A flaky connection must not strand someone on a screen they asked to
    // leave. The local session goes either way and the token lapses on its own.
    const revokeSession = vi.fn(() => Promise.reject(new Error("offline")));
    const sessionStore = store();
    sessionStore.signIn(live());
    render(
      <App
        initialPath="/performance"
        gamesClient={{
          ok: true as const,
          value: { ...shellClient.value, revokeSession },
        }}
        sessionStore={sessionStore}
      />,
    );

    expect(
      await screen.findByText(`Signed in …${ACCOUNT.slice(-6)}`),
    ).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));

    expect(
      (await screen.findAllByRole("link", { name: "Start free trial" })).length,
    ).toBeGreaterThan(0);
    expect(sessionStore.getSnapshot()).toBeNull();
    expect(window.localStorage.getItem(SESSION_STORAGE_KEY)).toBeNull();
  });
});
