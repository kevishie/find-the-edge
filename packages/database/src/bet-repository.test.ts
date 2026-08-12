import { describe, expect, it } from "vitest";
import { createBet, settleBet, type BetInput } from "@find-the-edge/domain";
import {
  betPartition,
  betSortKey,
  MemoryBetRepository,
} from "./bet-repository";

const ACCOUNT = `account:${"a".repeat(64)}`;
const NOW = "2026-08-12T02:00:00.000Z";

const bet = (overrides: Partial<BetInput> = {}) =>
  createBet({
    betId: "bet-1",
    accountId: ACCOUNT,
    canonicalEventId: "event:mlb%3Amlb:game-1",
    sportKey: "mlb",
    marketKey: "moneyline",
    selectionKey: "participant:royals",
    selectionLabel: "Kansas City Royals",
    sportsbookId: "draftkings",
    americanOdds: -125,
    stakeCents: 10_000,
    placedAt: "2026-08-12T00:00:00.000Z",
    source: "manual",
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  });

describe("where a bet lives", () => {
  it("partitions by account and orders by placement", () => {
    // The partition is the account, so a list is one query that cannot reach
    // another account's rows.
    expect(betPartition(ACCOUNT)).toBe(`BET#${ACCOUNT}`);
    const early = betSortKey({
      placedAt: "2026-08-12T00:00:00.000Z",
      betId: "a",
    });
    const late = betSortKey({
      placedAt: "2026-08-12T03:00:00.000Z",
      betId: "a",
    });
    expect(early < late).toBe(true);
  });
});

describe("recording and settling", () => {
  it("returns the stored bet when a create is retried", async () => {
    const repository = new MemoryBetRepository();
    const first = await repository.create(bet());
    const second = await repository.create(bet({ stakeCents: 50_000 }));
    // A double-submitted form must not create a second wager, nor silently
    // restate the stake of the one that exists.
    expect(second).toEqual(first);
    expect(second.stakeCents).toBe(10_000);
    expect(await repository.list(ACCOUNT)).toHaveLength(1);
  });

  it("lists newest placement first", async () => {
    const repository = new MemoryBetRepository();
    await repository.create(
      bet({ betId: "old", placedAt: "2026-08-10T00:00:00.000Z" }),
    );
    await repository.create(
      bet({ betId: "new", placedAt: "2026-08-12T00:00:00.000Z" }),
    );
    expect((await repository.list(ACCOUNT)).map((b) => b.betId)).toEqual([
      "new",
      "old",
    ]);
  });

  it("never returns another account's bets", async () => {
    const repository = new MemoryBetRepository();
    await repository.create(bet());
    await repository.create(
      bet({ accountId: `account:${"b".repeat(64)}`, betId: "theirs" }),
    );
    expect((await repository.list(ACCOUNT)).map((b) => b.betId)).toEqual([
      "bet-1",
    ]);
  });

  it("settles, records the change, and computes the money", async () => {
    const repository = new MemoryBetRepository();
    await repository.create(bet());
    const won = await repository.settle(
      ACCOUNT,
      "bet-1",
      { status: "won", settledAt: NOW },
      NOW,
    );
    expect(settleBet(won)).toEqual({
      returnedCents: 18_000,
      profitCents: 8_000,
      roi: 0.8,
    });
    expect(await repository.audit(ACCOUNT, "bet-1")).toEqual([
      { betId: "bet-1", at: NOW, from: "open", to: "won", returnedCents: null },
    ]);
  });

  it("keeps the whole history when a result is corrected", async () => {
    // Readers mis-enter results. A performance number that moved because of a
    // correction should be explainable afterwards.
    const repository = new MemoryBetRepository();
    await repository.create(bet());
    await repository.settle(
      ACCOUNT,
      "bet-1",
      { status: "won", settledAt: NOW },
      NOW,
    );
    const corrected = await repository.settle(
      ACCOUNT,
      "bet-1",
      { status: "lost", settledAt: NOW },
      "2026-08-12T02:05:00.000Z",
    );
    expect(corrected.status).toBe("lost");
    expect(await repository.audit(ACCOUNT, "bet-1")).toHaveLength(2);
    expect(corrected.version).toBe(3);
  });

  it("refuses to reopen a settled bet or restate the same result", async () => {
    const repository = new MemoryBetRepository();
    await repository.create(bet());
    await repository.settle(
      ACCOUNT,
      "bet-1",
      { status: "won", settledAt: NOW },
      NOW,
    );
    for (const status of ["open", "won"] as const)
      await expect(
        repository.settle(ACCOUNT, "bet-1", { status, settledAt: NOW }, NOW),
      ).rejects.toThrow("bet-transition-invalid");
  });

  it("refuses a settlement the domain would not allow", async () => {
    const repository = new MemoryBetRepository();
    await repository.create(bet());
    // A supplied return on a win would let a typo rewrite a P/L the formula
    // owns; a cash-out without one has no derivable answer.
    await expect(
      repository.settle(
        ACCOUNT,
        "bet-1",
        { status: "won", settledAt: NOW, returnedCents: 999_999 },
        NOW,
      ),
    ).rejects.toThrow("bet-return-not-allowed");
    await expect(
      repository.settle(
        ACCOUNT,
        "bet-1",
        { status: "cashed-out", settledAt: NOW },
        NOW,
      ),
    ).rejects.toThrow("bet-return-required");
  });

  it("will not settle a bet that is not there", async () => {
    const repository = new MemoryBetRepository();
    await expect(
      repository.settle(
        ACCOUNT,
        "missing",
        { status: "won", settledAt: NOW },
        NOW,
      ),
    ).rejects.toThrow("bet-not-found");
  });
});
