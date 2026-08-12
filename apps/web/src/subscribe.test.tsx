import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { GamesClientError } from "./api";
import { SubscribeScreen, SUBSCRIBE_PLANS } from "./subscribe";

const TOKEN = `fte1.${"payload".padEnd(40, "x")}.${"a".repeat(64)}`;
const STRIPE_URL = "https://checkout.stripe.com/c/pay/cs_test_1";

let replace: ReturnType<typeof vi.fn>;

beforeEach(() => {
  replace = vi.fn();
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { replace, href: "https://staging.kevishie.com/subscribe" },
  });
});
afterEach(() => vi.restoreAllMocks());

describe("the paywall", () => {
  it("offers exactly the plans the API sells", () => {
    // If these ever drift the reader is shown a plan checkout will refuse.
    expect([...SUBSCRIBE_PLANS]).toEqual(["monthly", "annual"]);
    render(
      <SubscribeScreen
        client={{ ok: true, value: { startCheckout: vi.fn() } }}
        token={TOKEN}
      />,
    );
    expect(screen.getByText("$99")).toBeVisible();
    expect(screen.getByText("$999")).toBeVisible();
  });

  it("sends the plan name and hands the reader to Stripe", async () => {
    const startCheckout = vi.fn(() => Promise.resolve(STRIPE_URL));
    render(
      <SubscribeScreen
        client={{ ok: true, value: { startCheckout } }}
        token={TOKEN}
      />,
    );

    fireEvent.click(
      screen.getAllByRole("button", { name: "Start free trial" })[1]!,
    );

    await waitFor(() => expect(replace).toHaveBeenCalledWith(STRIPE_URL));
    // The annual card is second, and the name is what travels — never a price.
    expect(startCheckout).toHaveBeenCalledWith(
      TOKEN,
      "annual",
      expect.anything(),
    );
  });

  it("says what went wrong and lets the reader try again", async () => {
    const startCheckout = vi.fn(() =>
      Promise.reject(
        new GamesClientError(
          "request-failed",
          "Checkout could not be started.",
        ),
      ),
    );
    render(
      <SubscribeScreen
        client={{ ok: true, value: { startCheckout } }}
        token={TOKEN}
      />,
    );

    fireEvent.click(
      screen.getAllByRole("button", { name: "Start free trial" })[0]!,
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Checkout could not be started.",
    );
    // Still usable: a failed attempt must not strand the reader on a dead
    // screen with no way to pay.
    expect(
      screen.getAllByRole("button", { name: "Start free trial" })[0],
    ).toBeEnabled();
    expect(replace).not.toHaveBeenCalled();
  });

  it("is honest when checkout is not configured at all", () => {
    render(<SubscribeScreen client={{ ok: true, value: {} }} token={TOKEN} />);
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Checkout is unavailable in this environment.",
    );
    for (const button of screen.getAllByRole("button", {
      name: "Start free trial",
    }))
      expect(button).toBeDisabled();
  });

  it("never navigates without a session token", () => {
    const startCheckout = vi.fn(() => Promise.resolve(STRIPE_URL));
    render(
      <SubscribeScreen
        client={{ ok: true, value: { startCheckout } }}
        token={null}
      />,
    );
    for (const button of screen.getAllByRole("button", {
      name: "Start free trial",
    }))
      expect(button).toBeDisabled();
    expect(startCheckout).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
  });
});
