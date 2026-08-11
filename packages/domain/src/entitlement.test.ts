import { describe, expect, it } from "vitest";
import {
  applyStripeEvent,
  createEntitlement,
  entitlementView,
  ENTITLEMENT_TRIAL_DAYS,
  hasProductAccess,
  normalizeEntitlement,
  normalizeStripeEvent,
  STRIPE_EVENT_UNSUPPORTED,
  type Entitlement,
  type StripeEvent,
} from "./entitlement.js";
import { deriveAccountId } from "./identity.js";

const ACCOUNT_ID = deriveAccountId(
  "+15557654321",
  "account-pepper-value-0123456789ab",
);
const CUSTOMER = "cus_TestCustomer001";
const SUBSCRIPTION = "sub_TestSubscription1";
const NOW = "2026-08-10T12:00:00.000Z";
const NOW_SECONDS = Math.floor(Date.parse(NOW) / 1_000);
const DAY_SECONDS = 86_400;

const iso = (seconds: number): string =>
  new Date(seconds * 1_000).toISOString();

const subscriptionPayload = (overrides: {
  readonly id?: string;
  readonly created?: number;
  readonly status?: string;
  readonly type?: string;
  readonly currentPeriodEnd?: number | null;
  readonly trialEnd?: number | null;
  readonly cancelAtPeriodEnd?: boolean;
}): unknown => ({
  id: overrides.id ?? "evt_subscription0001",
  type: overrides.type ?? "customer.subscription.updated",
  created: overrides.created ?? NOW_SECONDS,
  data: {
    object: {
      id: SUBSCRIPTION,
      object: "subscription",
      customer: CUSTOMER,
      status: overrides.status ?? "active",
      current_period_end:
        overrides.currentPeriodEnd === undefined
          ? NOW_SECONDS + 30 * DAY_SECONDS
          : overrides.currentPeriodEnd,
      trial_end: overrides.trialEnd ?? null,
      cancel_at_period_end: overrides.cancelAtPeriodEnd ?? false,
    },
  },
});

const invoicePayload = (overrides: {
  readonly id?: string;
  readonly created?: number;
  readonly type?: "invoice.payment_succeeded" | "invoice.payment_failed";
  readonly periodEnd?: number;
}): unknown => ({
  id: overrides.id ?? "evt_invoice0000001",
  type: overrides.type ?? "invoice.payment_succeeded",
  created: overrides.created ?? NOW_SECONDS,
  data: {
    object: {
      id: "in_TestInvoice0001",
      object: "invoice",
      customer: CUSTOMER,
      subscription: SUBSCRIPTION,
      lines: {
        data: [
          {
            period: {
              end: overrides.periodEnd ?? NOW_SECONDS + 30 * DAY_SECONDS,
            },
          },
        ],
      },
    },
  },
});

const checkoutPayload = (id = "evt_checkout00000001"): unknown => ({
  id,
  type: "checkout.session.completed",
  created: NOW_SECONDS,
  data: {
    object: {
      id: "cs_test_Session00001",
      object: "checkout.session",
      mode: "subscription",
      status: "complete",
      customer: CUSTOMER,
      subscription: SUBSCRIPTION,
    },
  },
});

const event = (raw: unknown): StripeEvent => normalizeStripeEvent(raw);

const fold = (
  start: Entitlement | null,
  events: readonly unknown[],
  now = NOW,
): Entitlement => {
  let current = start;
  for (const raw of events)
    current = applyStripeEvent(current, event(raw), now, ACCOUNT_ID).next;
  if (!current) throw new Error("no-entitlement");
  return current;
};

describe("entitlement record", () => {
  it("defaults to an unentitled account", () => {
    const record = createEntitlement({ accountId: ACCOUNT_ID, updatedAt: NOW });
    expect(record.state).toBe("none");
    expect(record.accessUntil).toBeNull();
    expect(record.lastEventId).toBeNull();
    expect(record.lastEventCreated).toBeNull();
    expect(Object.isFrozen(record)).toBe(true);
    expect(ENTITLEMENT_TRIAL_DAYS).toBe(7);
  });

  it("rejects a foreign account id, a bad state, and a bad Stripe id", () => {
    expect(() =>
      createEntitlement({ accountId: "account:nope", updatedAt: NOW }),
    ).toThrow("entitlement-account-id-invalid");
    expect(() =>
      createEntitlement({
        accountId: ACCOUNT_ID,
        updatedAt: NOW,
        stripeCustomerId: "sub_WrongPrefix01",
      }),
    ).toThrow("entitlement-customer-id-invalid");
    expect(() =>
      createEntitlement({
        accountId: ACCOUNT_ID,
        updatedAt: "2026-08-10T12:00:00Z",
      }),
    ).toThrow("entitlement-updated-at-invalid");
  });

  it("re-derives stored records and refuses edited ones", () => {
    const record = createEntitlement({
      accountId: ACCOUNT_ID,
      updatedAt: NOW,
      state: "active",
      accessUntil: iso(NOW_SECONDS + DAY_SECONDS),
      stripeCustomerId: CUSTOMER,
    });
    expect(normalizeEntitlement(JSON.parse(JSON.stringify(record)))).toEqual(
      record,
    );
    expect(() => normalizeEntitlement({ ...record, state: "comped" })).toThrow(
      "stored-entitlement-invalid",
    );
    expect(() =>
      normalizeEntitlement({ ...record, schemaVersion: "v2" }),
    ).toThrow("stored-entitlement-invalid");
    expect(() => normalizeEntitlement(null)).toThrow(
      "stored-entitlement-invalid",
    );
  });
});

describe("hasProductAccess", () => {
  const at = (state: Entitlement["state"], accessUntil: string | null) =>
    createEntitlement({
      accountId: ACCOUNT_ID,
      updatedAt: NOW,
      state,
      accessUntil,
    });

  it("grants trialing and active before the boundary", () => {
    const until = iso(NOW_SECONDS + 60);
    expect(hasProductAccess(at("trialing", until), NOW)).toBe(true);
    expect(hasProductAccess(at("active", until), NOW)).toBe(true);
  });

  it("keeps access through the past_due grace and drops it after", () => {
    expect(hasProductAccess(at("past_due", iso(NOW_SECONDS + 60)), NOW)).toBe(
      true,
    );
    expect(hasProductAccess(at("past_due", iso(NOW_SECONDS - 60)), NOW)).toBe(
      false,
    );
  });

  it("ends access exactly at accessUntil, not a tick later", () => {
    const boundary = at("active", NOW);
    expect(hasProductAccess(boundary, NOW)).toBe(false);
    expect(
      hasProductAccess(boundary, new Date(Date.parse(NOW) - 1).toISOString()),
    ).toBe(true);
    expect(
      hasProductAccess(boundary, new Date(Date.parse(NOW) + 1).toISOString()),
    ).toBe(false);
  });

  it("never grants for canceled, expired, none, a null boundary, or no record", () => {
    const future = iso(NOW_SECONDS + 10 * DAY_SECONDS);
    expect(hasProductAccess(at("canceled", future), NOW)).toBe(false);
    expect(hasProductAccess(at("expired", future), NOW)).toBe(false);
    expect(hasProductAccess(at("none", future), NOW)).toBe(false);
    expect(hasProductAccess(at("active", null), NOW)).toBe(false);
    expect(hasProductAccess(null, NOW)).toBe(false);
    expect(hasProductAccess(undefined, NOW)).toBe(false);
  });

  it("refuses a malformed clock rather than guessing", () => {
    expect(() => hasProductAccess(at("active", null), "yesterday")).toThrow(
      "entitlement-now-invalid",
    );
  });
});

describe("normalizeStripeEvent", () => {
  it("reads a subscription event", () => {
    const normalized = event(
      subscriptionPayload({
        status: "trialing",
        trialEnd: NOW_SECONDS + 7 * DAY_SECONDS,
      }),
    );
    expect(normalized).toEqual({
      id: "evt_subscription0001",
      type: "customer.subscription.updated",
      created: NOW_SECONDS,
      customerId: CUSTOMER,
      subscriptionId: SUBSCRIPTION,
      status: "trialing",
      currentPeriodEnd: iso(NOW_SECONDS + 30 * DAY_SECONDS),
      trialEnd: iso(NOW_SECONDS + 7 * DAY_SECONDS),
      cancelAtPeriodEnd: false,
    });
  });

  it("reads the period end off subscription items when the top level is absent", () => {
    const normalized = event({
      id: "evt_itemsvariant0001",
      type: "customer.subscription.updated",
      created: NOW_SECONDS,
      data: {
        object: {
          id: SUBSCRIPTION,
          customer: { id: CUSTOMER, object: "customer" },
          status: "active",
          items: {
            data: [{ current_period_end: NOW_SECONDS + 14 * DAY_SECONDS }],
          },
        },
      },
    });
    expect(normalized.currentPeriodEnd).toBe(
      iso(NOW_SECONDS + 14 * DAY_SECONDS),
    );
    expect(normalized.customerId).toBe(CUSTOMER);
  });

  it("reads the subscription off a nested invoice parent", () => {
    const normalized = event({
      id: "evt_invoicenested001",
      type: "invoice.payment_failed",
      created: NOW_SECONDS,
      data: {
        object: {
          object: "invoice",
          customer: CUSTOMER,
          parent: { subscription_details: { subscription: SUBSCRIPTION } },
          period_end: NOW_SECONDS + DAY_SECONDS,
        },
      },
    });
    expect(normalized.subscriptionId).toBe(SUBSCRIPTION);
    expect(normalized.currentPeriodEnd).toBe(iso(NOW_SECONDS + DAY_SECONDS));
  });

  it("reads a checkout session", () => {
    const normalized = event(checkoutPayload());
    expect(normalized.type).toBe("checkout.session.completed");
    expect(normalized.subscriptionId).toBe(SUBSCRIPTION);
    expect(normalized.status).toBeNull();
  });

  it("separates an unsupported type from a malformed payload", () => {
    expect(() =>
      event({
        id: "evt_unsupported0001",
        type: "payment_intent.succeeded",
        created: NOW_SECONDS,
        data: { object: { customer: CUSTOMER } },
      }),
    ).toThrow(STRIPE_EVENT_UNSUPPORTED);
  });

  it("rejects every malformed shape rather than defaulting", () => {
    const cases: readonly unknown[] = [
      null,
      "evt_string",
      [],
      { type: "checkout.session.completed", created: NOW_SECONDS, data: {} },
      {
        id: "not-an-event-id",
        type: "checkout.session.completed",
        created: NOW_SECONDS,
        data: { object: { customer: CUSTOMER } },
      },
      {
        id: "evt_a1",
        type: "checkout.session.completed",
        created: "now",
        data: { object: { customer: CUSTOMER } },
      },
      {
        id: "evt_a1",
        type: "checkout.session.completed",
        created: NOW_SECONDS * 1_000,
        data: { object: { customer: CUSTOMER } },
      },
      {
        id: "evt_a1",
        type: "checkout.session.completed",
        created: NOW_SECONDS,
      },
      {
        id: "evt_a1",
        type: "checkout.session.completed",
        created: NOW_SECONDS,
        data: { object: {} },
      },
      {
        id: "evt_a1",
        type: "checkout.session.completed",
        created: NOW_SECONDS,
        data: { object: { customer: 42 } },
      },
      subscriptionPayload({ status: "comped" }),
      // A subscription event whose object is not a subscription.
      {
        id: "evt_a1",
        type: "customer.subscription.updated",
        created: NOW_SECONDS,
        data: {
          object: {
            id: "in_notasubscription",
            customer: CUSTOMER,
            status: "active",
          },
        },
      },
      // A period end that is not a plausible epoch second.
      subscriptionPayload({ currentPeriodEnd: 5 }),
    ];
    for (const raw of cases) expect(() => event(raw)).toThrow(/stripe-event/);
  });
});

describe("applyStripeEvent state machine", () => {
  it("grants a trial without a charge and expires it at the trial end", () => {
    const trialEnd = NOW_SECONDS + ENTITLEMENT_TRIAL_DAYS * DAY_SECONDS;
    const record = fold(null, [
      checkoutPayload(),
      subscriptionPayload({
        id: "evt_trialcreated001",
        type: "customer.subscription.created",
        status: "trialing",
        trialEnd,
        currentPeriodEnd: trialEnd,
      }),
    ]);
    expect(record.state).toBe("trialing");
    expect(record.accessUntil).toBe(iso(trialEnd));
    expect(record.accountId).toBe(ACCOUNT_ID);
    expect(record.stripeCustomerId).toBe(CUSTOMER);
    expect(hasProductAccess(record, NOW)).toBe(true);
    expect(hasProductAccess(record, iso(trialEnd))).toBe(false);
  });

  it("walks trial to active to past_due and back to active on recovery", () => {
    const trialEnd = NOW_SECONDS + 7 * DAY_SECONDS;
    const firstPeriodEnd = trialEnd + 30 * DAY_SECONDS;
    const trialing = fold(null, [
      subscriptionPayload({
        id: "evt_trialcreated001",
        type: "customer.subscription.created",
        status: "trialing",
        trialEnd,
        currentPeriodEnd: trialEnd,
      }),
    ]);
    expect(trialing.state).toBe("trialing");

    const active = fold(trialing, [
      invoicePayload({
        id: "evt_firstinvoice001",
        created: trialEnd,
        periodEnd: firstPeriodEnd,
      }),
      subscriptionPayload({
        id: "evt_becameactive001",
        created: trialEnd + 1,
        status: "active",
        trialEnd,
        currentPeriodEnd: firstPeriodEnd,
      }),
    ]);
    expect(active.state).toBe("active");
    expect(active.accessUntil).toBe(iso(firstPeriodEnd));

    const pastDue = fold(active, [
      invoicePayload({
        id: "evt_paymentfailed01",
        type: "invoice.payment_failed",
        created: firstPeriodEnd,
        periodEnd: firstPeriodEnd + 30 * DAY_SECONDS,
      }),
    ]);
    expect(pastDue.state).toBe("past_due");
    // The failed invoice covers the next period; adopting its boundary would
    // hand out a month nobody paid for.
    expect(pastDue.accessUntil).toBe(iso(firstPeriodEnd));
    expect(hasProductAccess(pastDue, iso(firstPeriodEnd - 60))).toBe(true);
    expect(hasProductAccess(pastDue, iso(firstPeriodEnd + 60))).toBe(false);

    const recovered = fold(pastDue, [
      invoicePayload({
        id: "evt_paymentretry01",
        created: firstPeriodEnd + 3_600,
        periodEnd: firstPeriodEnd + 30 * DAY_SECONDS,
      }),
    ]);
    expect(recovered.state).toBe("active");
    expect(recovered.accessUntil).toBe(iso(firstPeriodEnd + 30 * DAY_SECONDS));
  });

  it("keeps a zero-amount trial invoice reported as trialing", () => {
    const trialEnd = NOW_SECONDS + 7 * DAY_SECONDS;
    const record = fold(null, [
      subscriptionPayload({
        id: "evt_trialcreated001",
        type: "customer.subscription.created",
        status: "trialing",
        trialEnd,
        currentPeriodEnd: trialEnd,
      }),
      invoicePayload({
        id: "evt_trialinvoice001",
        created: NOW_SECONDS + 5,
        periodEnd: trialEnd,
      }),
    ]);
    expect(record.state).toBe("trialing");
    expect(record.accessUntil).toBe(iso(trialEnd));
  });

  it("ends a trial that is canceled before it converts", () => {
    const trialEnd = NOW_SECONDS + 7 * DAY_SECONDS;
    const record = fold(null, [
      subscriptionPayload({
        id: "evt_trialcreated001",
        type: "customer.subscription.created",
        status: "trialing",
        trialEnd,
        currentPeriodEnd: trialEnd,
      }),
      subscriptionPayload({
        id: "evt_trialdeleted001",
        created: NOW_SECONDS + DAY_SECONDS,
        type: "customer.subscription.deleted",
        status: "canceled",
        trialEnd,
        currentPeriodEnd: trialEnd,
      }),
    ]);
    expect(record.state).toBe("canceled");
    expect(record.accessUntil).toBeNull();
    expect(hasProductAccess(record, NOW)).toBe(false);
  });

  it("keeps access to the period end when cancel_at_period_end is set, then drops it", () => {
    const periodEnd = NOW_SECONDS + 20 * DAY_SECONDS;
    const scheduled = fold(null, [
      subscriptionPayload({
        id: "evt_activecreated1",
        type: "customer.subscription.created",
        status: "active",
        currentPeriodEnd: periodEnd,
      }),
      subscriptionPayload({
        id: "evt_cancelqueued01",
        created: NOW_SECONDS + 60,
        status: "active",
        currentPeriodEnd: periodEnd,
        cancelAtPeriodEnd: true,
      }),
    ]);
    expect(scheduled.state).toBe("active");
    expect(scheduled.accessUntil).toBe(iso(periodEnd));
    expect(hasProductAccess(scheduled, iso(periodEnd - 1))).toBe(true);

    const ended = fold(scheduled, [
      subscriptionPayload({
        id: "evt_periodenddel01",
        created: periodEnd,
        type: "customer.subscription.deleted",
        status: "canceled",
        currentPeriodEnd: periodEnd,
      }),
    ]);
    expect(ended.state).toBe("canceled");
    expect(hasProductAccess(ended, iso(periodEnd - 1))).toBe(false);
  });

  it("revokes access immediately on an immediate cancel", () => {
    const periodEnd = NOW_SECONDS + 20 * DAY_SECONDS;
    const active = fold(null, [
      subscriptionPayload({
        id: "evt_activecreated1",
        type: "customer.subscription.created",
        status: "active",
        currentPeriodEnd: periodEnd,
      }),
    ]);
    expect(hasProductAccess(active, NOW)).toBe(true);
    const canceled = fold(active, [
      subscriptionPayload({
        id: "evt_hardcancel0001",
        created: NOW_SECONDS + 5,
        type: "customer.subscription.deleted",
        status: "canceled",
        currentPeriodEnd: periodEnd,
      }),
    ]);
    expect(canceled.accessUntil).toBeNull();
    expect(hasProductAccess(canceled, NOW)).toBe(false);
  });

  it("maps incomplete, unpaid, and paused without granting anything new", () => {
    const periodEnd = NOW_SECONDS + 20 * DAY_SECONDS;
    const incomplete = fold(null, [
      subscriptionPayload({
        id: "evt_incomplete0001",
        type: "customer.subscription.created",
        status: "incomplete",
        currentPeriodEnd: periodEnd,
      }),
    ]);
    expect(incomplete.state).toBe("none");
    expect(incomplete.accessUntil).toBeNull();

    const unpaid = fold(incomplete, [
      subscriptionPayload({
        id: "evt_unpaid00000001",
        created: NOW_SECONDS + 1,
        status: "unpaid",
        currentPeriodEnd: periodEnd,
      }),
    ]);
    expect(unpaid.state).toBe("past_due");

    const paused = fold(unpaid, [
      subscriptionPayload({
        id: "evt_paused000000001",
        created: NOW_SECONDS + 2,
        status: "paused",
        currentPeriodEnd: periodEnd,
      }),
    ]);
    expect(paused.state).toBe("expired");
    expect(paused.accessUntil).toBeNull();
  });
});

describe("replay and ordering fences", () => {
  it("treats a redelivered event as a duplicate and mutates nothing", () => {
    const raw = subscriptionPayload({
      id: "evt_activecreated1",
      type: "customer.subscription.created",
      status: "active",
    });
    const first = applyStripeEvent(null, event(raw), NOW, ACCOUNT_ID);
    expect(first.outcome).toBe("applied");
    const second = applyStripeEvent(
      first.next,
      event(raw),
      "2026-09-01T00:00:00.000Z",
    );
    expect(second.outcome).toBe("duplicate");
    expect(second.next).toEqual(first.next);
    const third = applyStripeEvent(second.next, event(raw), NOW);
    expect(third.outcome).toBe("duplicate");
    expect(third.next).toEqual(first.next);
  });

  it("drops an event created before the one already applied", () => {
    const periodEnd = NOW_SECONDS + 20 * DAY_SECONDS;
    const canceled = fold(null, [
      subscriptionPayload({
        id: "evt_activecreated1",
        type: "customer.subscription.created",
        status: "active",
        currentPeriodEnd: periodEnd,
      }),
      subscriptionPayload({
        id: "evt_hardcancel0001",
        created: NOW_SECONDS + 100,
        type: "customer.subscription.deleted",
        status: "canceled",
        currentPeriodEnd: periodEnd,
      }),
    ]);
    // The update Stripe generated before the cancellation arrives after it.
    const late = applyStripeEvent(
      canceled,
      event(
        subscriptionPayload({
          id: "evt_lateupdate00001",
          created: NOW_SECONDS + 50,
          status: "active",
          currentPeriodEnd: periodEnd,
        }),
      ),
      NOW,
    );
    expect(late.outcome).toBe("ignored-older");
    expect(late.next).toEqual(canceled);
    expect(hasProductAccess(late.next, NOW)).toBe(false);
  });

  it("applies events that share a created second", () => {
    const first = applyStripeEvent(
      null,
      event(checkoutPayload("evt_sameseconda001")),
      NOW,
      ACCOUNT_ID,
    );
    const second = applyStripeEvent(
      first.next,
      event(
        subscriptionPayload({
          id: "evt_samesecondb001",
          created: NOW_SECONDS,
          type: "customer.subscription.created",
          status: "active",
        }),
      ),
      NOW,
    );
    expect(second.outcome).toBe("applied");
    expect(second.next.state).toBe("active");
  });

  it("advances the fence on every applied event, including a link-only one", () => {
    const applied = applyStripeEvent(
      null,
      event(checkoutPayload()),
      NOW,
      ACCOUNT_ID,
    );
    expect(applied.next.lastEventId).toBe("evt_checkout00000001");
    expect(applied.next.lastEventCreated).toBe(NOW_SECONDS);
    // Linking never grants on its own: the subscription event decides.
    expect(applied.next.state).toBe("none");
    expect(applied.next.stripeSubscriptionId).toBe(SUBSCRIPTION);
  });

  it("needs an account id when there is no stored record", () => {
    expect(() => applyStripeEvent(null, event(checkoutPayload()), NOW)).toThrow(
      "entitlement-account-id-invalid",
    );
  });
});

describe("entitlementView", () => {
  it("exposes only the state, the boundary, and the decision", () => {
    const record = createEntitlement({
      accountId: ACCOUNT_ID,
      updatedAt: NOW,
      state: "active",
      accessUntil: iso(NOW_SECONDS + 60),
      stripeCustomerId: CUSTOMER,
      stripeSubscriptionId: SUBSCRIPTION,
    });
    const view = entitlementView(record, NOW);
    expect(view).toEqual({
      state: "active",
      accessUntil: iso(NOW_SECONDS + 60),
      hasAccess: true,
    });
    expect(Object.keys(view).sort()).toEqual([
      "accessUntil",
      "hasAccess",
      "state",
    ]);
    expect(JSON.stringify(view)).not.toContain(CUSTOMER);
    expect(JSON.stringify(view)).not.toContain(SUBSCRIPTION);
  });

  it("reports a lapsed record as expired without rewriting it", () => {
    const record = createEntitlement({
      accountId: ACCOUNT_ID,
      updatedAt: NOW,
      state: "active",
      accessUntil: iso(NOW_SECONDS - 60),
    });
    expect(entitlementView(record, NOW).state).toBe("expired");
    expect(record.state).toBe("active");
    expect(entitlementView(null, NOW)).toEqual({
      state: "none",
      accessUntil: null,
      hasAccess: false,
    });
  });
});
