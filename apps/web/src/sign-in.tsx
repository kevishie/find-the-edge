/* eslint-disable react-refresh/only-export-components -- the phone
   normalizer is shared with the route and its tests. */
import { useEffect, useRef, useState } from "react";

import {
  GamesClientError,
  isRateLimited,
  type AuthOtpRequestDto,
  type AuthSessionDto,
} from "./api";
import { safeReturnPath, type SessionStore } from "./session";

export interface SignInClient {
  readonly requestOtp?: (
    phone: string,
    signal: AbortSignal,
  ) => Promise<AuthOtpRequestDto>;
  readonly verifyOtp?: (
    phone: string,
    code: string,
    signal: AbortSignal,
  ) => Promise<AuthSessionDto>;
}

export type SignInClientResult =
  | { readonly ok: true; readonly value: SignInClient }
  | { readonly ok: false; readonly error: { readonly message: string } };

/**
 * A typing aid, not an authority: the server decides what it will send a code
 * to. US numbers are completed to +1 because that is who this product serves;
 * anything already written in E.164 is passed through untouched.
 */
export const normalizePhoneInput = (input: string): string | null => {
  const trimmed = input.trim();
  if (trimmed.length === 0 || trimmed.length > 32) return null;
  const digits = trimmed.replace(/\D/g, "");
  const candidate = trimmed.startsWith("+")
    ? `+${digits}`
    : digits.length === 11 && digits.startsWith("1")
      ? `+${digits}`
      : digits.length === 10
        ? `+1${digits}`
        : "";
  return /^\+[1-9]\d{7,14}$/.test(candidate) ? candidate : null;
};

/** `+15551234567` reads back as `+1 (555) 123-4567` for confirmation. */
const displayPhone = (phone: string): string =>
  /^\+1\d{10}$/.test(phone)
    ? `+1 (${phone.slice(2, 5)}) ${phone.slice(5, 8)}-${phone.slice(8)}`
    : phone;

const countdown = (seconds: number): string =>
  `${String(Math.floor(seconds / 60))}:${String(seconds % 60).padStart(2, "0")}`;

type Step =
  | { readonly kind: "phone" }
  | { readonly kind: "code"; readonly phone: string };

/**
 * A wait the reader has to sit through. "resend" is the ordinary window
 * between texts and leaves code entry alone; "all" is the API refusing more
 * attempts, which stops everything until it lapses.
 */
interface Cooldown {
  readonly seconds: number;
  readonly scope: "resend" | "all";
}

const NO_COOLDOWN: Cooldown = { seconds: 0, scope: "resend" };

/**
 * Our own two-step sign-in. Nothing on this screen leaves the origin: there is
 * no hosted login, no provider script, and no link off the app. A failure says
 * only what the API said, which never distinguishes a wrong code from a number
 * it has never seen.
 */
export function SignIn({
  client,
  store,
  from,
  onSignedIn,
}: {
  readonly client: SignInClientResult;
  readonly store: SessionStore;
  readonly from?: string;
  readonly onSignedIn: (path: string) => void;
}) {
  const [step, setStep] = useState<Step>({ kind: "phone" });
  const [phoneInput, setPhoneInput] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [cooldown, setCooldown] = useState<Cooldown>(NO_COOLDOWN);
  const requests = useRef<AbortController | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    requests.current = controller;
    return () => {
      controller.abort();
      requests.current = null;
    };
  }, []);

  // The countdown ticks on a timer, never off the clock during render.
  const counting = cooldown.seconds > 0;
  const blocked = counting && cooldown.scope === "all";
  useEffect(() => {
    if (!counting) return;
    const timer = window.setInterval(
      () =>
        setCooldown((value) =>
          value.seconds > 0
            ? { seconds: value.seconds - 1, scope: value.scope }
            : NO_COOLDOWN,
        ),
      1_000,
    );
    return () => window.clearInterval(timer);
  }, [counting]);

  const requestOtp = client.ok ? client.value.requestOtp : undefined;
  const verifyOtp = client.ok ? client.value.verifyOtp : undefined;
  const configurationError = client.ok
    ? requestOtp && verifyOtp
      ? null
      : "Sign in is unavailable in this environment."
    : client.error.message;

  const normalized = normalizePhoneInput(phoneInput);
  const digits = code.replace(/\D/g, "").slice(0, 6);

  const failed = (cause: unknown, fallback: string) => {
    if (isRateLimited(cause)) {
      setCooldown({ seconds: cause.retryAfterSeconds, scope: "all" });
      setError("Too many attempts.");
      return;
    }
    setError(cause instanceof GamesClientError ? cause.message : fallback);
  };

  const sendCode = (phone: string) => {
    const signal = requests.current?.signal;
    // The keyboard can submit a form whose button is disabled, so the wait is
    // enforced here as well as in the control.
    if (!requestOtp || !signal || busy || counting) return;
    setBusy(true);
    setError(null);
    requestOtp(phone, signal)
      .then((accepted) => {
        if (signal.aborted) return;
        setStep({ kind: "code", phone });
        setCode("");
        setCooldown({
          seconds: accepted.resendAfterSeconds,
          scope: "resend",
        });
        setNotice(
          `If ${displayPhone(phone)} can receive texts, a code is on its way. It expires in ${countdown(
            accepted.expiresInSeconds,
          )}.`,
        );
      })
      .catch((cause: unknown) => {
        if (signal.aborted) return;
        failed(cause, "A code could not be sent right now. Try again.");
      })
      .finally(() => {
        if (!signal.aborted) setBusy(false);
      });
  };

  const submitCode = (phone: string) => {
    const signal = requests.current?.signal;
    if (!verifyOtp || !signal || busy || blocked || digits.length !== 6) return;
    setBusy(true);
    setError(null);
    verifyOtp(phone, digits, signal)
      .then((session) => {
        if (signal.aborted) return;
        store.signIn({
          token: session.token,
          expiresAt: session.expiresAt,
          accountId: session.accountId,
        });
        onSignedIn(safeReturnPath(from));
      })
      .catch((cause: unknown) => {
        if (signal.aborted) return;
        setCode("");
        failed(cause, "Sign in could not be completed right now. Try again.");
      })
      .finally(() => {
        if (!signal.aborted) setBusy(false);
      });
  };

  return (
    <main className="sign-in-page">
      <section className="sign-in-card" aria-labelledby="sign-in-heading">
        <p className="eyebrow">FIND THE EDGE</p>
        <h1 id="sign-in-heading">Sign in</h1>

        {configurationError !== null && (
          <p className="sign-in-error" role="alert">
            {configurationError}
          </p>
        )}

        {step.kind === "phone" ? (
          <form
            className="sign-in-form"
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              if (normalized !== null) sendCode(normalized);
            }}
          >
            <p className="sign-in-lede">
              We text a six-digit code. There is no password and no third-party
              login.
            </p>
            <label className="sign-in-field" htmlFor="sign-in-phone">
              <span>Mobile number</span>
              <input
                id="sign-in-phone"
                name="phone"
                type="tel"
                inputMode="tel"
                autoComplete="tel"
                placeholder="(555) 123-4567"
                maxLength={32}
                value={phoneInput}
                disabled={busy}
                onChange={(event) => {
                  setPhoneInput(event.target.value);
                  setError(null);
                }}
              />
            </label>
            <p className="sign-in-hint">
              {normalized === null
                ? "US numbers can be typed any way you like."
                : `We will text ${displayPhone(normalized)}.`}
            </p>
            <button
              type="submit"
              className="sign-in-submit"
              disabled={
                normalized === null ||
                busy ||
                counting ||
                configurationError !== null
              }
            >
              {busy ? "Sending…" : "Send code"}
            </button>
          </form>
        ) : (
          <form
            className="sign-in-form"
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              submitCode(step.phone);
            }}
          >
            {notice !== null && (
              <p className="sign-in-lede" role="status">
                {notice}
              </p>
            )}
            <label className="sign-in-field" htmlFor="sign-in-code">
              <span>6-digit code</span>
              <input
                id="sign-in-code"
                name="code"
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9]*"
                maxLength={6}
                placeholder="000000"
                value={digits}
                disabled={busy}
                autoFocus
                onChange={(event) => {
                  setCode(event.target.value.replace(/\D/g, "").slice(0, 6));
                  setError(null);
                }}
              />
            </label>
            <button
              type="submit"
              className="sign-in-submit"
              disabled={digits.length !== 6 || busy || blocked}
            >
              {busy ? "Checking…" : "Verify code"}
            </button>
            <div className="sign-in-actions">
              <button
                type="button"
                disabled={busy || counting}
                onClick={() => sendCode(step.phone)}
              >
                {counting
                  ? `Resend code in ${countdown(cooldown.seconds)}`
                  : "Resend code"}
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setStep({ kind: "phone" });
                  setCode("");
                  setNotice(null);
                  setError(null);
                }}
              >
                Change number
              </button>
            </div>
          </form>
        )}

        {error !== null && (
          <p className="sign-in-error" role="alert">
            {error}
          </p>
        )}
        {blocked && (
          <p className="sign-in-hint" role="status">
            Try again in {countdown(cooldown.seconds)}.
          </p>
        )}
      </section>
    </main>
  );
}
