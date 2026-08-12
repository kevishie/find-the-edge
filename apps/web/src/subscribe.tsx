import { useCallback, useState } from "react";
import { CHECKOUT_PLANS, GamesClientError, type CheckoutPlan } from "./api";

export interface SubscribeClient {
  readonly startCheckout?: (
    token: string,
    plan: CheckoutPlan,
    signal: AbortSignal,
  ) => Promise<string>;
}

export type SubscribeClientResult =
  | { readonly ok: true; readonly value: SubscribeClient }
  | { readonly ok: false; readonly error: { readonly message: string } };

const PLANS: readonly {
  readonly plan: CheckoutPlan;
  readonly label: string;
  readonly price: string;
  readonly cadence: string;
  readonly note: string;
}[] = [
  {
    plan: "monthly",
    label: "Monthly",
    price: "$99",
    cadence: "/ month",
    note: "Billed monthly. Cancel anytime.",
  },
  {
    plan: "annual",
    label: "Annual",
    price: "$999",
    cadence: "/ year",
    note: "Works out to $83/mo — $189 off the monthly rate.",
  },
];

/**
 * What a signed-in reader without paid access sees instead of the product.
 *
 * It is a screen rather than a redirect on purpose: the reader has an account
 * and a session, and bouncing them back to sign-in would say the wrong thing
 * about why they cannot get in. The one honest message is that access needs a
 * trial or a subscription, and the way to get one is right here.
 */
export function SubscribeScreen({
  client,
  token,
  onSignOut,
}: {
  readonly client: SubscribeClientResult;
  readonly token: string | null;
  readonly onSignOut?: () => void;
}) {
  const [busy, setBusy] = useState<CheckoutPlan | null>(null);
  const [error, setError] = useState<string | null>(null);

  const start = useCallback(
    (plan: CheckoutPlan) => {
      if (!token || !client.ok || !client.value.startCheckout) {
        setError("Checkout is unavailable in this environment.");
        return;
      }
      setError(null);
      setBusy(plan);
      const controller = new AbortController();
      client.value
        .startCheckout(token, plan, controller.signal)
        .then((url) => {
          // Replaced rather than pushed: going back from Stripe must not
          // return the reader to a spent checkout attempt.
          window.location.replace(url);
        })
        .catch((cause: unknown) => {
          setBusy(null);
          setError(
            cause instanceof GamesClientError
              ? cause.message
              : "Checkout could not be started. Try again.",
          );
        });
    },
    [client, token],
  );

  const unavailable = !client.ok || !client.value.startCheckout || !token;

  return (
    <main className="subscribe" aria-labelledby="subscribe-heading">
      <h1 id="subscribe-heading">Start your seven days</h1>
      <p className="subscribe-lede">
        Your account is ready. Find The Edge needs an active trial or
        subscription before the boards, splits and scouting open up.
      </p>
      <p className="subscribe-note">
        Seven days free. No card is charged until day eight, and cancelling
        before then costs nothing.
      </p>
      {error === null ? null : (
        <p role="alert" className="subscribe-error">
          {error}
        </p>
      )}
      {unavailable && error === null ? (
        <p role="alert" className="subscribe-error">
          Checkout is unavailable in this environment.
        </p>
      ) : null}
      <ul className="subscribe-plans">
        {PLANS.map(({ plan, label, price, cadence, note }) => (
          <li key={plan} className={`subscribe-plan subscribe-plan-${plan}`}>
            <small>{label}</small>
            <p className="subscribe-price">
              <b>{price}</b> <span>{cadence}</span>
            </p>
            <p className="subscribe-plan-note">{note}</p>
            <button
              type="button"
              disabled={busy !== null || unavailable}
              onClick={() => start(plan)}
            >
              {busy === plan ? "Opening checkout…" : `Start free trial`}
            </button>
          </li>
        ))}
      </ul>
      <p className="subscribe-footer">
        Payment is handled by Stripe. We never see or store a card number.
        {onSignOut === undefined ? null : (
          <>
            {" "}
            <button
              type="button"
              className="subscribe-signout"
              onClick={onSignOut}
            >
              Sign out
            </button>
          </>
        )}
      </p>
    </main>
  );
}

/** Exported for the test that pins the two plans against the API's contract. */
export const SUBSCRIBE_PLANS = CHECKOUT_PLANS;
