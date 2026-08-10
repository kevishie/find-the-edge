import {
  MemoryArbitrageBoardRepository,
  MemoryOpportunityEvidenceRepository,
  type OpportunityEvidenceResult,
} from "@find-the-edge/database";
import {
  fixtureOddsGroupAvailabilityIdentity,
  normalizeFixtureOddsObservation,
} from "@find-the-edge/domain";
import { describe, expect, it } from "vitest";
import type { OpportunityGenerationEvent } from "../opportunity-candidate-service";
import { ArbitrageScanService } from "./arbitrage-scan-service";

const asOf = "2026-08-06T12:05:00.000Z";
const event: OpportunityGenerationEvent = {
  eventId: "event-1",
  eventVersion: 1,
  sportKey: "mlb",
  leagueKey: "mlb",
  participantIds: ["team-a", "team-b"],
  startsAt: "2026-08-06T17:00:00.000Z",
  status: "scheduled",
  markets: [
    {
      marketKey: "moneyline",
      selections: [
        { selectionKey: "team-a", point: null },
        { selectionKey: "team-b", point: null },
      ],
    },
  ],
};

const policy = {
  id: "find-the-edge-arbitrage",
  version: "1.0.0",
  sportsbookIds: ["hardrock", "novig"],
  lowHoldThreshold: 1.01,
  maximumPriceAgeMinutes: 15,
};

const book = (
  sportsbookId: string,
  odds: readonly [number, number],
  state: "active" | "suspended" = "active",
) => {
  const snapshots = (["team-a", "team-b"] as const).map((selectionKey, index) =>
    normalizeFixtureOddsObservation({
      canonicalEventId: "event-1",
      canonicalEventVersion: 1,
      sportKey: "mlb",
      marketKey: "moneyline",
      selectionKey,
      sportsbookId,
      americanOdds: odds[index]!,
      observedAt: "2026-08-06T12:00:00.000Z",
      retrievedAt: "2026-08-06T12:00:01.000Z",
    }),
  );
  return {
    sportsbookId,
    state,
    snapshots,
    selectionAvailability: snapshots.map((snapshot) => ({
      identity: snapshot.partitionKey,
      state: "active" as const,
      observedAt: snapshot.observedAt,
      evidenceId: snapshot.snapshotId,
      reason: "active-price",
    })),
    groupAvailability: {
      identity: fixtureOddsGroupAvailabilityIdentity(snapshots[0]!),
      state: "active" as const,
      observedAt: snapshots[0]!.observedAt,
      evidenceId: `group-${sportsbookId}`,
      reason: "active-market",
    },
    ageMinutes: 5,
  };
};

describe("arbitrage scan service", () => {
  it("persists a cross-book arbitrage with best-price proof", async () => {
    // Hardrock +125 / novig -115: 1/2.25 + 115/215 = 0.979 < 1.
    const evidence: OpportunityEvidenceResult = {
      target: book("hardrock", [125, -145]),
      comparisons: [book("novig", [-105, -115])],
    };
    const board = new MemoryArbitrageBoardRepository();
    const summary = await new ArbitrageScanService({
      evidence: new MemoryOpportunityEvidenceRepository(evidence),
      board,
      policy,
    }).scanEvents([event], asOf);
    expect(summary).toEqual({
      arbitrageCount: 1,
      lowHoldCount: 0,
      failedMarkets: 0,
    });
    const stored = await board.listCurrent("mlb", asOf);
    expect(stored?.findings).toHaveLength(1);
    const finding = stored!.findings[0]!;
    expect(finding.classification).toBe("arbitrage");
    expect(
      finding.legs.map(({ best }) => [best.sportsbookId, best.americanOdds]),
    ).toEqual([
      ["hardrock", 125],
      ["novig", -115],
    ]);
    expect(finding.legs[0]!.competing).toHaveLength(1);
  });

  it("records exclusions, skips held markets, and clears stale boards", async () => {
    // -120/-110 across both books holds ~4.3%: nothing material.
    const held: OpportunityEvidenceResult = {
      target: book("hardrock", [-120, -110]),
      comparisons: [book("novig", [-120, -110], "suspended")],
    };
    const board = new MemoryArbitrageBoardRepository();
    const service = new ArbitrageScanService({
      evidence: new MemoryOpportunityEvidenceRepository(held),
      board,
      policy,
    });
    const summary = await service.scanEvents([event], asOf);
    expect(summary).toEqual({
      arbitrageCount: 0,
      lowHoldCount: 0,
      failedMarkets: 0,
    });
    // The scan still replaces the sport's board so stale findings retire.
    expect((await board.listCurrent("mlb", asOf))?.findings).toEqual([]);
  });

  it("counts a torn market as failed without aborting the scan", async () => {
    const board = new MemoryArbitrageBoardRepository();
    const service = new ArbitrageScanService({
      evidence: new MemoryOpportunityEvidenceRepository(() => {
        throw new Error("opportunity-availability-changed-during-read");
      }),
      board,
      policy,
    });
    const summary = await service.scanEvents([event], asOf);
    expect(summary).toEqual({
      arbitrageCount: 0,
      lowHoldCount: 0,
      failedMarkets: 1,
    });
    expect((await board.listCurrent("mlb", asOf))?.findings).toEqual([]);
  });
});
