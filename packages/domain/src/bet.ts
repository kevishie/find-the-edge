/**
 * FTE-048/050. A bet the reader placed at a sportsbook, recorded by hand.
 *
 * This product does not place bets and cannot read a sportsbook account, so
 * every field here is the reader's own claim about something that happened
 * elsewhere. That shapes the whole model: it records what they say, stamps
 * when they said it, and never infers a result. Settlement is a separate,
 * deliberate act, and the arithmetic that follows it is exact.
 */

export const BET_SCHEMA_VERSION = "bet-v1" as const;

/**
 * The lifecycle a wager can be in. `open` until the reader settles it; the
 * rest are terminal and each one means something different to the money:
 *
 *  - `won` returns the stake plus profit.
 *  - `lost` returns nothing.
 *  - `push` and `void` both return the stake and leave profit at zero. They
 *    are kept apart because they mean different things to a bettor reading
 *    their own history — a push is a tie, a void is a bet that never really
 *    happened — even though the money is identical.
 *  - `cashed-out` is settled at a price the book offered, so the return is
 *    whatever the reader actually received and nothing can derive it.
 */
export const BET_STATUSES = [
  "open",
  "won",
  "lost",
  "push",
  "void",
  "cashed-out",
] as const;
export type BetStatus = (typeof BET_STATUSES)[number];

export const isBetStatus = (value: unknown): value is BetStatus =>
  typeof value === "string" &&
  (BET_STATUSES as readonly string[]).includes(value);

/** Where the reader found this bet. Kept so performance can be read by source. */
export const BET_SOURCES = ["opportunity", "report", "manual"] as const;
export type BetSource = (typeof BET_SOURCES)[number];

export const isBetSource = (value: unknown): value is BetSource =>
  typeof value === "string" &&
  (BET_SOURCES as readonly string[]).includes(value);

const ID = /^[A-Za-z0-9][A-Za-z0-9:%._-]{0,255}$/;
const LABEL_MAX = 160;
const NOTES_MAX = 1_000;

/** Stakes are held in minor units. A float here would lose cents to binary. */
export const BET_STAKE_MIN_CENTS = 1;
export const BET_STAKE_MAX_CENTS = 100_000_000;

export interface BetInput {
  readonly betId: string;
  readonly accountId: string;
  readonly canonicalEventId: string;
  readonly sportKey: string;
  readonly marketKey: string;
  readonly selectionKey: string;
  readonly selectionLabel: string;
  readonly sportsbookId: string;
  readonly americanOdds: number;
  readonly stakeCents: number;
  readonly placedAt: string;
  readonly source: BetSource;
  readonly sourceRef?: string | null;
  readonly notes?: string | null;
  readonly status?: BetStatus;
  readonly settledAt?: string | null;
  /** Only meaningful for `cashed-out`, where no formula can derive it. */
  readonly returnedCents?: number | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly version?: number;
}

export interface Bet {
  readonly schemaVersion: typeof BET_SCHEMA_VERSION;
  readonly betId: string;
  readonly accountId: string;
  readonly canonicalEventId: string;
  readonly sportKey: string;
  readonly marketKey: string;
  readonly selectionKey: string;
  readonly selectionLabel: string;
  readonly sportsbookId: string;
  readonly americanOdds: number;
  readonly stakeCents: number;
  readonly placedAt: string;
  readonly source: BetSource;
  readonly sourceRef: string | null;
  readonly notes: string | null;
  readonly status: BetStatus;
  readonly settledAt: string | null;
  readonly returnedCents: number | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly version: number;
}

const instant = (value: unknown, code: string): string => {
  if (
    typeof value !== "string" ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  )
    throw new Error(code);
  return value;
};

const identifier = (value: unknown, code: string): string => {
  if (typeof value !== "string" || !ID.test(value)) throw new Error(code);
  return value;
};

const bounded = (value: unknown, max: number, code: string): string => {
  if (typeof value !== "string") throw new Error(code);
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > max) throw new Error(code);
  // Control characters would corrupt a table cell and a CSV export alike.
  if (Array.from(trimmed).some((c) => c.charCodeAt(0) < 0x20))
    throw new Error(code);
  return trimmed;
};

/**
 * American odds. Anything between -99 and +99 is not a price a book offers,
 * and zero is not a price at all, so the gap around the middle is rejected
 * rather than quietly accepted and later divided by.
 */
export const isAmericanOdds = (value: unknown): value is number =>
  Number.isSafeInteger(value) &&
  Math.abs(value as number) >= 100 &&
  Math.abs(value as number) <= 100_000;

export function createBet(input: BetInput): Bet {
  const status = input.status ?? "open";
  if (!isBetStatus(status)) throw new Error("bet-status-invalid");
  if (!isBetSource(input.source)) throw new Error("bet-source-invalid");
  if (!isAmericanOdds(input.americanOdds)) throw new Error("bet-odds-invalid");
  if (
    !Number.isSafeInteger(input.stakeCents) ||
    input.stakeCents < BET_STAKE_MIN_CENTS ||
    input.stakeCents > BET_STAKE_MAX_CENTS
  )
    throw new Error("bet-stake-invalid");

  const settledAt =
    input.settledAt === undefined || input.settledAt === null
      ? null
      : instant(input.settledAt, "bet-settled-at-invalid");
  // An open bet with a settlement time, or a settled one without, would make
  // every later reading of the history ambiguous.
  if ((status === "open") !== (settledAt === null))
    throw new Error("bet-settlement-inconsistent");

  const returnedCents =
    input.returnedCents === undefined || input.returnedCents === null
      ? null
      : input.returnedCents;
  if (returnedCents !== null) {
    if (
      !Number.isSafeInteger(returnedCents) ||
      returnedCents < 0 ||
      returnedCents > BET_STAKE_MAX_CENTS * 1_000
    )
      throw new Error("bet-return-invalid");
    // Only a cash-out has a return the reader must supply; for every other
    // status the arithmetic is exact and an override would let a typo
    // silently rewrite the P/L.
    if (status !== "cashed-out") throw new Error("bet-return-not-allowed");
  }
  if (status === "cashed-out" && returnedCents === null)
    throw new Error("bet-return-required");

  const placedAt = instant(input.placedAt, "bet-placed-at-invalid");
  if (settledAt !== null && Date.parse(settledAt) < Date.parse(placedAt))
    throw new Error("bet-settlement-inconsistent");

  return Object.freeze({
    schemaVersion: BET_SCHEMA_VERSION,
    betId: identifier(input.betId, "bet-id-invalid"),
    accountId: identifier(input.accountId, "bet-account-invalid"),
    canonicalEventId: identifier(input.canonicalEventId, "bet-event-invalid"),
    sportKey: identifier(input.sportKey, "bet-sport-invalid"),
    marketKey: identifier(input.marketKey, "bet-market-invalid"),
    selectionKey: identifier(input.selectionKey, "bet-selection-invalid"),
    selectionLabel: bounded(
      input.selectionLabel,
      LABEL_MAX,
      "bet-selection-label-invalid",
    ),
    sportsbookId: identifier(input.sportsbookId, "bet-sportsbook-invalid"),
    americanOdds: input.americanOdds,
    stakeCents: input.stakeCents,
    placedAt,
    source: input.source,
    sourceRef:
      input.sourceRef === undefined || input.sourceRef === null
        ? null
        : identifier(input.sourceRef, "bet-source-ref-invalid"),
    notes:
      input.notes === undefined || input.notes === null || input.notes === ""
        ? null
        : bounded(input.notes, NOTES_MAX, "bet-notes-invalid"),
    status,
    settledAt,
    returnedCents,
    createdAt: instant(input.createdAt, "bet-created-at-invalid"),
    updatedAt: instant(input.updatedAt, "bet-updated-at-invalid"),
    version: input.version ?? 1,
  });
}

/** Stored rows are re-derived, never trusted. A row edited in storage is
 * rejected rather than handed to the money arithmetic. */
export function normalizeBet(stored: unknown): Bet {
  if (
    !stored ||
    typeof stored !== "object" ||
    Array.isArray(stored) ||
    (stored as { schemaVersion?: unknown }).schemaVersion !== BET_SCHEMA_VERSION
  )
    throw new Error("stored-bet-invalid");
  try {
    return createBet(stored as BetInput);
  } catch {
    throw new Error("stored-bet-invalid");
  }
}

/**
 * What a winning wager returns, stake included, in cents.
 *
 * Rounded half-up at the last step and only there: rounding the profit and
 * the stake separately would drift by a cent on some prices, and a bet
 * tracker that cannot reproduce a sportsbook's own arithmetic is not worth
 * reading.
 */
export const winningReturnCents = (
  stakeCents: number,
  americanOdds: number,
): number => {
  if (!isAmericanOdds(americanOdds)) throw new Error("bet-odds-invalid");
  const profit =
    americanOdds > 0
      ? (stakeCents * americanOdds) / 100
      : (stakeCents * 100) / Math.abs(americanOdds);
  return stakeCents + Math.round(profit);
};

export interface BetSettlement {
  /** Stake plus profit, in cents. Zero for a loss. */
  readonly returnedCents: number;
  /** Return minus stake. Negative for a loss, zero for push and void. */
  readonly profitCents: number;
  /** Profit over stake. Null while the bet is open — there is no answer yet. */
  readonly roi: number | null;
}

/**
 * The money, derived from the status and nothing else. Deterministic by
 * design: the same bet always produces the same numbers, and no reading of
 * it ever consults a live price.
 */
export function settleBet(bet: Bet): BetSettlement {
  const record = normalizeBet(bet);
  const { stakeCents } = record;
  const returned = (() => {
    switch (record.status) {
      case "open":
        return null;
      case "won":
        return winningReturnCents(stakeCents, record.americanOdds);
      case "lost":
        return 0;
      case "push":
      case "void":
        return stakeCents;
      case "cashed-out":
        // The book decided this one; there is nothing to compute.
        return record.returnedCents ?? 0;
    }
  })();
  if (returned === null) return { returnedCents: 0, profitCents: 0, roi: null };
  const profitCents = returned - stakeCents;
  return {
    returnedCents: returned,
    profitCents,
    roi: profitCents / stakeCents,
  };
}

/**
 * Which settlements a bet may move to. An open bet can be settled any way;
 * a settled one can be corrected to another terminal status, because readers
 * do mis-enter results and the audit trail records the change. Nothing may
 * return to `open`: re-opening would erase a settlement that a performance
 * aggregate has already counted.
 */
export const canTransitionTo = (from: BetStatus, to: BetStatus): boolean =>
  to !== "open" && isBetStatus(to) && (from === "open" || from !== to);
