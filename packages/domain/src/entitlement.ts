import { isAccountId } from "./identity.js";

export const ENTITLEMENT_SCHEMA_VERSION = "entitlement-v1" as const;

/** Seven days, matching the story. Sent to Stripe on checkout; the trial
 * boundary the product honours is always the one Stripe reports back. */
export const ENTITLEMENT_TRIAL_DAYS = 7;

/**
 * The closed set of things the product may believe about an account. Every
 * member is reached only by a Stripe event or by time passing — never by a
 * client assertion, and never by a local guess about what Stripe "probably"
 * did next.
 */
export const ENTITLEMENT_STATES = [
  "none",
  "trialing",
  "active",
  "past_due",
  "canceled",
  "expired",
] as const;

export type EntitlementState = (typeof ENTITLEMENT_STATES)[number];

export const isEntitlementState = (value: unknown): value is EntitlementState =>
  typeof value === "string" &&
  (ENTITLEMENT_STATES as readonly string[]).includes(value);

const CUSTOMER_ID = /^cus_[A-Za-z0-9_]{1,80}$/;
const SUBSCRIPTION_ID = /^sub_[A-Za-z0-9_]{1,80}$/;
const EVENT_ID = /^evt_[A-Za-z0-9_]{1,80}$/;
const PRICE_ID = /^price_[A-Za-z0-9_]{1,80}$/;

/** Unix seconds. The lower bound rejects a zero or negative epoch that a
 * malformed payload would otherwise turn into 1970; the upper bound keeps a
 * millisecond value from being read as seconds. */
const EPOCH_SECONDS_MIN = 1_000_000_000;
const EPOCH_SECONDS_MAX = 4_102_444_800;

export const isStripeCustomerId = (value: unknown): value is string =>
  typeof value === "string" && CUSTOMER_ID.test(value);

export const isStripeSubscriptionId = (value: unknown): value is string =>
  typeof value === "string" && SUBSCRIPTION_ID.test(value);

export const isStripePriceId = (value: unknown): value is string =>
  typeof value === "string" && PRICE_ID.test(value);

const instant = (value: unknown, code: string): string => {
  if (
    typeof value !== "string" ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  )
    throw new Error(code);
  return value;
};

const optionalInstant = (value: unknown, code: string): string | null =>
  value === null || value === undefined ? null : instant(value, code);

/**
 * The durable answer to "what has this account paid for". It stores Stripe
 * identifiers and boundaries and nothing else: no card, no last four, no
 * brand, no billing address. Those never leave Stripe.
 *
 * `lastEventId` and `lastEventCreated` are the replay fence. Together they
 * make webhook delivery — which is at-least-once and unordered — safe to
 * apply directly to the record the API reads.
 */
export interface Entitlement {
  readonly schemaVersion: typeof ENTITLEMENT_SCHEMA_VERSION;
  readonly accountId: string;
  readonly state: EntitlementState;
  /** The instant access stops, or null when there is none to stop. */
  readonly accessUntil: string | null;
  readonly stripeCustomerId: string | null;
  readonly stripeSubscriptionId: string | null;
  readonly currentPeriodEnd: string | null;
  readonly trialEndsAt: string | null;
  readonly updatedAt: string;
  /** The id of the last Stripe event folded in; a repeat is a duplicate. */
  readonly lastEventId: string | null;
  /** That event's `created`, in unix seconds; an older one is dropped. */
  readonly lastEventCreated: number | null;
}

export interface EntitlementInput {
  readonly accountId: string;
  readonly state?: EntitlementState;
  readonly accessUntil?: string | null;
  readonly stripeCustomerId?: string | null;
  readonly stripeSubscriptionId?: string | null;
  readonly currentPeriodEnd?: string | null;
  readonly trialEndsAt?: string | null;
  readonly updatedAt: string;
  readonly lastEventId?: string | null;
  readonly lastEventCreated?: number | null;
}

const optionalMatch = (
  value: unknown,
  predicate: (candidate: unknown) => boolean,
  code: string,
): string | null => {
  if (value === null || value === undefined) return null;
  if (!predicate(value)) throw new Error(code);
  return value as string;
};

export function createEntitlement(input: EntitlementInput): Entitlement {
  if (!isAccountId(input.accountId))
    throw new Error("entitlement-account-id-invalid");
  const state = input.state ?? "none";
  if (!isEntitlementState(state)) throw new Error("entitlement-state-invalid");
  const lastEventId = optionalMatch(
    input.lastEventId,
    (candidate) => typeof candidate === "string" && EVENT_ID.test(candidate),
    "entitlement-last-event-id-invalid",
  );
  const lastEventCreated = input.lastEventCreated ?? null;
  if (
    lastEventCreated !== null &&
    (!Number.isSafeInteger(lastEventCreated) ||
      lastEventCreated < EPOCH_SECONDS_MIN ||
      lastEventCreated > EPOCH_SECONDS_MAX)
  )
    throw new Error("entitlement-last-event-created-invalid");
  return Object.freeze({
    schemaVersion: ENTITLEMENT_SCHEMA_VERSION,
    accountId: input.accountId,
    state,
    accessUntil: optionalInstant(
      input.accessUntil,
      "entitlement-access-until-invalid",
    ),
    stripeCustomerId: optionalMatch(
      input.stripeCustomerId,
      isStripeCustomerId,
      "entitlement-customer-id-invalid",
    ),
    stripeSubscriptionId: optionalMatch(
      input.stripeSubscriptionId,
      isStripeSubscriptionId,
      "entitlement-subscription-id-invalid",
    ),
    currentPeriodEnd: optionalInstant(
      input.currentPeriodEnd,
      "entitlement-current-period-end-invalid",
    ),
    trialEndsAt: optionalInstant(
      input.trialEndsAt,
      "entitlement-trial-ends-at-invalid",
    ),
    updatedAt: instant(input.updatedAt, "entitlement-updated-at-invalid"),
    lastEventId,
    lastEventCreated,
  });
}

/** Stored records are re-derived, never trusted: a row edited in storage is
 * rejected rather than handed to the access decision. */
export function normalizeEntitlement(stored: unknown): Entitlement {
  if (
    !stored ||
    typeof stored !== "object" ||
    Array.isArray(stored) ||
    (stored as { schemaVersion?: unknown }).schemaVersion !==
      ENTITLEMENT_SCHEMA_VERSION
  )
    throw new Error("stored-entitlement-invalid");
  const value = stored as Partial<Entitlement>;
  try {
    return createEntitlement({
      accountId: value.accountId ?? "",
      state: value.state ?? "none",
      accessUntil: value.accessUntil ?? null,
      stripeCustomerId: value.stripeCustomerId ?? null,
      stripeSubscriptionId: value.stripeSubscriptionId ?? null,
      currentPeriodEnd: value.currentPeriodEnd ?? null,
      trialEndsAt: value.trialEndsAt ?? null,
      updatedAt: value.updatedAt ?? "",
      lastEventId: value.lastEventId ?? null,
      lastEventCreated: value.lastEventCreated ?? null,
    });
  } catch {
    throw new Error("stored-entitlement-invalid");
  }
}

/**
 * The single authority on paid access. Every product surface asks this
 * function and nothing else — not the client, not a token claim, not a
 * cached flag in the browser.
 *
 * The reasoning, because this function decides who gets a paid product:
 *
 *  - `trialing` and `active` are the two states Stripe reports while the
 *    account is in good standing. Both are bounded by `accessUntil` rather
 *    than trusted open-endedly, so a webhook we never receive costs the
 *    account access at the end of the period it already paid for — it does
 *    not grant access forever.
 *  - `past_due` still grants, up to the same boundary. That is deliberate:
 *    Stripe retries a failed charge for days, and cutting a paying customer
 *    off on the first network blip would be wrong. The grace is bounded by
 *    the period they already paid for, and Stripe closes it by moving the
 *    subscription to `canceled` or `unpaid` when the retries run out.
 *  - `canceled`, `expired`, and `none` never grant, whatever `accessUntil`
 *    says. A cancellation is the boundary Stripe reported; honouring a
 *    stale future timestamp after it would be a paid product given away.
 *  - A null `accessUntil` never grants. "Entitled with no known end" is not
 *    a state this product has; it would be an unbounded free subscription.
 *  - The comparison is strictly greater-than, so access ends *at*
 *    `accessUntil`, not one tick after it.
 */
export function hasProductAccess(
  entitlement: Entitlement | null | undefined,
  now: string,
): boolean {
  const at = Date.parse(instant(now, "entitlement-now-invalid"));
  if (!entitlement) return false;
  const record = normalizeEntitlement(entitlement);
  if (
    record.state !== "trialing" &&
    record.state !== "active" &&
    record.state !== "past_due"
  )
    return false;
  if (record.accessUntil === null) return false;
  return Date.parse(record.accessUntil) > at;
}

/** Stripe's subscription statuses, verbatim. Anything outside this set is a
 * payload we do not understand, and an unknown status must not be coerced
 * into a state that grants access. */
export const STRIPE_SUBSCRIPTION_STATUSES = [
  "incomplete",
  "incomplete_expired",
  "trialing",
  "active",
  "past_due",
  "canceled",
  "unpaid",
  "paused",
] as const;

export type StripeSubscriptionStatus =
  (typeof STRIPE_SUBSCRIPTION_STATUSES)[number];

export const isStripeSubscriptionStatus = (
  value: unknown,
): value is StripeSubscriptionStatus =>
  typeof value === "string" &&
  (STRIPE_SUBSCRIPTION_STATUSES as readonly string[]).includes(value);

/** The only Stripe events this product acts on. The webhook endpoint accepts
 * any well-formed event and ignores the rest; adding a type here is a
 * deliberate act, not a consequence of Stripe adding one. */
export const HANDLED_STRIPE_EVENT_TYPES = [
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "invoice.payment_succeeded",
  "invoice.payment_failed",
  "checkout.session.completed",
] as const;

export type StripeEventType = (typeof HANDLED_STRIPE_EVENT_TYPES)[number];

export const isHandledStripeEventType = (
  value: unknown,
): value is StripeEventType =>
  typeof value === "string" &&
  (HANDLED_STRIPE_EVENT_TYPES as readonly string[]).includes(value);

/**
 * The shape the reducer sees. Stripe's payloads are large, versioned, and
 * differ per event type; normalizing to this narrow record means the state
 * machine reads one shape and the parsing risk lives in exactly one place.
 */
export interface StripeEvent {
  readonly id: string;
  readonly type: StripeEventType;
  /** Unix seconds, as Stripe sends it. Used as the ordering fence. */
  readonly created: number;
  readonly customerId: string;
  readonly subscriptionId: string | null;
  readonly status: StripeSubscriptionStatus | null;
  readonly currentPeriodEnd: string | null;
  readonly trialEnd: string | null;
  readonly cancelAtPeriodEnd: boolean;
}

const EVENT_INVALID = "stripe-event-invalid";
export const STRIPE_EVENT_UNSUPPORTED = "stripe-event-unsupported";

const record = (value: unknown): Readonly<Record<string, unknown>> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;

const epochToInstant = (value: unknown): string | null => {
  if (value === null || value === undefined) return null;
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < EPOCH_SECONDS_MIN ||
    value > EPOCH_SECONDS_MAX
  )
    throw new Error(EVENT_INVALID);
  return new Date(value * 1_000).toISOString();
};

/** Stripe expands references inconsistently: a field may be an id string or
 * the whole object. Both spellings resolve to the id, and anything else is
 * refused rather than coerced. */
const referenceId = (
  value: unknown,
  predicate: (candidate: unknown) => boolean,
): string | null => {
  if (value === null || value === undefined) return null;
  if (predicate(value)) return value as string;
  const expanded = record(value);
  if (expanded && predicate(expanded["id"])) return expanded["id"] as string;
  throw new Error(EVENT_INVALID);
};

const firstRow = (value: unknown): Readonly<Record<string, unknown>> | null => {
  const container = record(value);
  if (!container) return null;
  const rows = container["data"];
  return Array.isArray(rows) && rows.length > 0 ? record(rows[0]) : null;
};

/**
 * A subscription's period end moved from the subscription object onto its
 * items in a later API version. Both are read, newest spelling first, so the
 * webhook does not silently lose the access boundary after a version bump.
 */
const subscriptionPeriodEnd = (
  object: Readonly<Record<string, unknown>>,
): string | null =>
  object["current_period_end"] === undefined ||
  object["current_period_end"] === null
    ? epochToInstant(firstRow(object["items"])?.["current_period_end"] ?? null)
    : epochToInstant(object["current_period_end"]);

/** An invoice's period end lives on its line item; the invoice-level
 * `period_end` is the fallback. */
const invoicePeriodEnd = (
  object: Readonly<Record<string, unknown>>,
): string | null => {
  const line = firstRow(object["lines"]);
  const period = record(line?.["period"]);
  return period?.["end"] === undefined || period["end"] === null
    ? epochToInstant(object["period_end"] ?? null)
    : epochToInstant(period["end"]);
};

/** Newer invoice payloads nest the subscription under `parent`. */
const invoiceSubscriptionId = (
  object: Readonly<Record<string, unknown>>,
): string | null => {
  const direct = referenceId(
    object["subscription"] ?? null,
    isStripeSubscriptionId,
  );
  if (direct) return direct;
  const details = record(record(object["parent"])?.["subscription_details"]);
  return referenceId(
    details?.["subscription"] ?? null,
    isStripeSubscriptionId,
  );
};

/**
 * Validates a raw webhook body into the narrow shape above. It never trusts a
 * shape: every field is checked, an unexpected type is refused rather than
 * defaulted, and a well-formed envelope carrying an event type this product
 * does not act on is refused separately so the endpoint can answer 200 to it
 * instead of asking Stripe to retry forever.
 */
export function normalizeStripeEvent(raw: unknown): StripeEvent {
  const envelope = record(raw);
  if (!envelope) throw new Error(EVENT_INVALID);
  const id = envelope["id"];
  const created = envelope["created"];
  if (
    typeof id !== "string" ||
    !EVENT_ID.test(id) ||
    typeof created !== "number" ||
    !Number.isSafeInteger(created) ||
    created < EPOCH_SECONDS_MIN ||
    created > EPOCH_SECONDS_MAX ||
    typeof envelope["type"] !== "string"
  )
    throw new Error(EVENT_INVALID);
  const object = record(record(envelope["data"])?.["object"]);
  if (!object) throw new Error(EVENT_INVALID);
  const type = envelope["type"];
  if (!isHandledStripeEventType(type)) throw new Error(STRIPE_EVENT_UNSUPPORTED);
  const customerId = referenceId(object["customer"] ?? null, isStripeCustomerId);
  // Every event this product acts on is about one customer. Without one there
  // is no account to attribute it to, so the payload is malformed for us.
  if (!customerId) throw new Error(EVENT_INVALID);
  const cancelAtPeriodEnd = object["cancel_at_period_end"];
  if (
    cancelAtPeriodEnd !== undefined &&
    cancelAtPeriodEnd !== null &&
    typeof cancelAtPeriodEnd !== "boolean"
  )
    throw new Error(EVENT_INVALID);
  if (type === "customer.subscription.created" ||
    type === "customer.subscription.updated" ||
    type === "customer.subscription.deleted") {
    const subscriptionId = object["id"];
    if (!isStripeSubscriptionId(subscriptionId)) throw new Error(EVENT_INVALID);
    if (!isStripeSubscriptionStatus(object["status"]))
      throw new Error(EVENT_INVALID);
    return Object.freeze({
      id,
      type,
      created,
      customerId,
      subscriptionId,
      status: object["status"],
      currentPeriodEnd: subscriptionPeriodEnd(object),
      trialEnd: epochToInstant(object["trial_end"] ?? null),
      cancelAtPeriodEnd: cancelAtPeriodEnd === true,
    });
  }
  if (type === "invoice.payment_succeeded" || type === "invoice.payment_failed")
    return Object.freeze({
      id,
      type,
      created,
      customerId,
      subscriptionId: invoiceSubscriptionId(object),
      status: null,
      currentPeriodEnd: invoicePeriodEnd(object),
      trialEnd: null,
      cancelAtPeriodEnd: cancelAtPeriodEnd === true,
    });
  return Object.freeze({
    id,
    type,
    created,
    customerId,
    subscriptionId: referenceId(
      object["subscription"] ?? null,
      isStripeSubscriptionId,
    ),
    status: null,
    currentPeriodEnd: null,
    trialEnd: null,
    cancelAtPeriodEnd: cancelAtPeriodEnd === true,
  });
}

export type StripeEventOutcome = "applied" | "duplicate" | "ignored-older";

export interface StripeEventApplication {
  readonly next: Entitlement;
  readonly outcome: StripeEventOutcome;
}

/** Stripe's status is the authority on the state; this is the only mapping,
 * and every unknown-to-us situation lands on a state that grants nothing. */
const stateForStatus = (status: StripeSubscriptionStatus): EntitlementState => {
  switch (status) {
    case "trialing":
      return "trialing";
    case "active":
      return "active";
    // `unpaid` is what a subscription becomes when Stripe gives up retrying
    // but the merchant chose not to cancel. It is past due in every sense
    // the product cares about, and the access boundary still applies.
    case "past_due":
    case "unpaid":
      return "past_due";
    case "canceled":
      return "canceled";
    case "incomplete_expired":
    case "paused":
      return "expired";
    // The first payment has not succeeded. Nothing has been paid for, so
    // nothing is granted.
    case "incomplete":
      return "none";
  }
};

const boundaryFor = (
  state: EntitlementState,
  trialEndsAt: string | null,
  currentPeriodEnd: string | null,
): string | null => {
  // A trial ends when Stripe says the trial ends; the period end is the
  // fallback for a subscription reported as trialing without a trial end.
  if (state === "trialing") return trialEndsAt ?? currentPeriodEnd;
  if (state === "active" || state === "past_due") return currentPeriodEnd;
  return null;
};

const laterOf = (left: string | null, right: string | null): string | null => {
  if (left === null) return right;
  if (right === null) return left;
  return Date.parse(right) > Date.parse(left) ? right : left;
};

/**
 * The pure reducer behind the webhook. It folds one normalized event into the
 * stored record and reports what it did, so the caller can persist only when
 * something changed and answer Stripe 200 in every other case.
 *
 * Replay and ordering are both handled here rather than at the edge:
 *
 *  - An event whose id matches `lastEventId` is a redelivery of the event
 *    already folded in. It returns `duplicate` and the record untouched, so
 *    replaying a month of webhooks changes nothing.
 *  - An event created strictly before `lastEventCreated` lost a race in
 *    Stripe's delivery, not in ours. It returns `ignored-older`, because a
 *    late `subscription.updated` must never undo a `subscription.deleted`
 *    that has already been applied.
 *  - Events sharing a `created` second are applied in arrival order; Stripe
 *    emits several per second and they are not contradictory.
 *
 * `accountId` is only consulted when there is no stored record yet; the
 * caller resolves it from the customer pointer before calling.
 */
export function applyStripeEvent(
  entitlement: Entitlement | null,
  event: StripeEvent,
  now: string,
  accountId?: string,
): StripeEventApplication {
  const at = instant(now, "entitlement-now-invalid");
  const current =
    entitlement === null
      ? createEntitlement({ accountId: accountId ?? "", updatedAt: at })
      : normalizeEntitlement(entitlement);
  if (current.lastEventId === event.id)
    return { next: current, outcome: "duplicate" };
  if (
    current.lastEventCreated !== null &&
    event.created < current.lastEventCreated
  )
    return { next: current, outcome: "ignored-older" };
  const fence = {
    updatedAt: at,
    lastEventId: event.id,
    lastEventCreated: event.created,
    stripeCustomerId: event.customerId,
  } as const;
  if (event.type === "customer.subscription.deleted") {
    // Stripe emits this at the instant access truly ends — immediately for a
    // hard cancel, at the period boundary for `cancel_at_period_end`. There
    // is nothing left to honour, so the boundary is cleared outright.
    return {
      next: createEntitlement({
        ...current,
        ...fence,
        state: "canceled",
        accessUntil: null,
        stripeSubscriptionId: event.subscriptionId ?? current.stripeSubscriptionId,
        currentPeriodEnd: event.currentPeriodEnd ?? current.currentPeriodEnd,
      }),
      outcome: "applied",
    };
  }
  if (
    event.type === "customer.subscription.created" ||
    event.type === "customer.subscription.updated"
  ) {
    // `status` is guaranteed present on a subscription event by the
    // normalizer; the fallback keeps the state machine total.
    const state = event.status ? stateForStatus(event.status) : current.state;
    const trialEndsAt = event.trialEnd ?? current.trialEndsAt;
    const currentPeriodEnd = event.currentPeriodEnd ?? current.currentPeriodEnd;
    // `cancel_at_period_end` deliberately does not change the state: Stripe
    // still reports the subscription as active or trialing until the period
    // closes, and that is the boundary the story says to honour.
    return {
      next: createEntitlement({
        ...current,
        ...fence,
        state,
        accessUntil: boundaryFor(state, trialEndsAt, currentPeriodEnd),
        stripeSubscriptionId: event.subscriptionId ?? current.stripeSubscriptionId,
        currentPeriodEnd,
        trialEndsAt,
      }),
      outcome: "applied",
    };
  }
  if (event.type === "invoice.payment_succeeded") {
    // A paid invoice is the recovery path out of `past_due` and the end of a
    // trial. It stays `trialing` while Stripe's own trial boundary is still
    // in the future — a zero-amount trial invoice also succeeds, and calling
    // that "active" would misreport a trial as a paid subscription.
    const trialLive =
      current.trialEndsAt !== null &&
      Date.parse(current.trialEndsAt) > event.created * 1_000;
    const state: EntitlementState = trialLive ? "trialing" : "active";
    const currentPeriodEnd = event.currentPeriodEnd ?? current.currentPeriodEnd;
    return {
      next: createEntitlement({
        ...current,
        ...fence,
        state,
        // A successful payment can only extend access, never shorten it.
        accessUntil: laterOf(
          current.accessUntil,
          boundaryFor(state, current.trialEndsAt, currentPeriodEnd),
        ),
        stripeSubscriptionId:
          event.subscriptionId ?? current.stripeSubscriptionId,
        currentPeriodEnd,
      }),
      outcome: "applied",
    };
  }
  if (event.type === "invoice.payment_failed") {
    // The boundary is deliberately left alone. The invoice that failed is for
    // the *next* period, so adopting its period end would hand out access
    // that was never paid for; the grace is exactly what is already paid.
    return {
      next: createEntitlement({
        ...current,
        ...fence,
        state: "past_due",
        stripeSubscriptionId:
          event.subscriptionId ?? current.stripeSubscriptionId,
      }),
      outcome: "applied",
    };
  }
  // checkout.session.completed. It links the Stripe objects to the account
  // and nothing more: it never grants access on its own, because the
  // authoritative status arrives on the subscription event that follows.
  return {
    next: createEntitlement({
      ...current,
      ...fence,
      stripeSubscriptionId: event.subscriptionId ?? current.stripeSubscriptionId,
    }),
    outcome: "applied",
  };
}

/** What the API is allowed to tell the browser: the state and the boundary.
 * No Stripe identifiers, no invoice history, no card data. */
export interface EntitlementView {
  readonly state: EntitlementState;
  readonly accessUntil: string | null;
  readonly hasAccess: boolean;
}

export function entitlementView(
  entitlement: Entitlement | null,
  now: string,
): EntitlementView {
  const hasAccess = hasProductAccess(entitlement, now);
  const state = entitlement?.state ?? "none";
  return Object.freeze({
    // A record still reading `active` whose boundary has passed is reported
    // as `expired`: this is where the state comes from, since Stripe has no
    // event for "the clock ran out". The stored record is left untouched —
    // only Stripe events write it.
    state:
      !hasAccess &&
      (state === "trialing" || state === "active" || state === "past_due")
        ? "expired"
        : state,
    accessUntil: entitlement?.accessUntil ?? null,
    hasAccess,
  });
}
