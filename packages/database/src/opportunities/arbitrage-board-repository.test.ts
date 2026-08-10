import {
  createArbitrageFinding,
  fixtureOddsGroupAvailabilityIdentity,
  normalizeFixtureOddsObservation,
  type ArbitrageFinding,
} from "@find-the-edge/domain";
import { describe, expect, it } from "vitest";
import { MemoryArbitrageBoardRepository } from "./arbitrage-board-repository";

const evaluatedAt = "2026-08-06T12:05:00.000Z";
const quote = (sportsbookId: string, selectionKey: string, odds: number) => {
  const normalized = normalizeFixtureOddsObservation({
    canonicalEventId: "event-1",
    canonicalEventVersion: 2,
    sportKey: "mlb",
    marketKey: "moneyline",
    selectionKey,
    sportsbookId,
    americanOdds: odds,
    observedAt: "2026-08-06T12:00:00.000Z",
    retrievedAt: "2026-08-06T12:00:01.000Z",
  });
  return {
    ...normalized,
    point: null,
    selectionAvailability: {
      identity: normalized.partitionKey,
      evidenceId: `availability-${sportsbookId}-${selectionKey}`,
      state: "active" as const,
      observedAt: "2026-08-06T12:00:01.000Z",
    },
    groupAvailability: {
      identity: fixtureOddsGroupAvailabilityIdentity(normalized),
      evidenceId: `group-availability-${sportsbookId}`,
      state: "active" as const,
      observedAt: "2026-08-06T12:00:01.000Z",
    },
  };
};

const finding = (): ArbitrageFinding =>
  createArbitrageFinding({
    canonicalEventId: "event-1",
    canonicalEventVersion: 2,
    sportKey: "mlb",
    leagueKey: "mlb",
    marketKey: "moneyline",
    startsAt: "2026-08-06T17:00:00.000Z",
    evaluatedAt,
    legs: [
      {
        selectionKey: "team-a",
        point: null,
        best: quote("novig", "team-a", 125),
        competing: [],
      },
      {
        selectionKey: "team-b",
        point: null,
        best: quote("prophetx", "team-b", -115),
        competing: [],
      },
    ],
    excludedBooks: [],
    policy: {
      id: "find-the-edge-arbitrage",
      version: "1.0.0",
      lowHoldThreshold: 1.01,
      maximumPriceAgeMinutes: 15,
    },
  });

describe("arbitrage board repository", () => {
  it("serves the latest board and filters expired findings", async () => {
    const repository = new MemoryArbitrageBoardRepository();
    await repository.putBoard("mlb", [finding()], evaluatedAt);
    const fresh = await repository.listCurrent(
      "mlb",
      "2026-08-06T12:10:00.000Z",
    );
    expect(fresh?.findings).toHaveLength(1);
    expect(fresh?.totalCount).toBe(1);
    // expiresAt = evaluatedAt + 15 minutes; past it the finding is gone.
    const expired = await repository.listCurrent(
      "mlb",
      "2026-08-06T12:25:00.000Z",
    );
    expect(expired?.findings).toHaveLength(0);
    expect(await repository.listCurrent("soccer", evaluatedAt)).toBeNull();
  });

  it("never lets an older scan replace a newer board", async () => {
    const repository = new MemoryArbitrageBoardRepository();
    await repository.putBoard("mlb", [finding()], "2026-08-06T12:06:00.000Z");
    await repository.putBoard("mlb", [], "2026-08-06T12:05:30.000Z");
    const board = await repository.listCurrent(
      "mlb",
      "2026-08-06T12:07:00.000Z",
    );
    expect(board?.scannedAt).toBe("2026-08-06T12:06:00.000Z");
    expect(board?.findings).toHaveLength(1);
  });

  it("rejects tampered stored findings on read", async () => {
    const repository = new MemoryArbitrageBoardRepository();
    await repository.putBoard("mlb", [finding()], evaluatedAt);
    const stored = repository.boards.get("mlb")!;
    const tampered = JSON.parse(JSON.stringify(stored)) as {
      findings: { sumInverseDecimal: number }[];
    };
    tampered.findings[0]!.sumInverseDecimal = 0.5;
    repository.boards.set("mlb", tampered as never);
    await expect(
      repository.listCurrent("mlb", "2026-08-06T12:10:00.000Z"),
    ).rejects.toThrow();
  });
});
