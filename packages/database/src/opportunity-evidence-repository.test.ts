import { describe, expect, it } from "vitest";
import {
  fixtureOddsGroupAvailabilityIdentity,
  normalizeFixtureOddsObservation,
  type FixtureOddsAvailabilityEvidence,
} from "@find-the-edge/domain";
import type {
  FixtureOddsDynamoGateway,
  FixtureOddsItem,
} from "./fixture-odds-adapter";
import {
  DynamoOpportunityEvidenceRepository,
  OpportunityEvidenceCorruptionError,
} from "./opportunity-evidence-repository";

function gatewayFixture(observedAt = "2026-08-06T12:00:00.000Z") {
  const items = new Map<string, FixtureOddsItem>();
  const availability = new Map<string, FixtureOddsAvailabilityEvidence>();
  for (const sportsbookId of ["hardrock", "draftkings", "fanduel", "betmgm"]) {
    for (const [selectionKey, americanOdds] of [
      ["team-a", sportsbookId === "hardrock" ? 125 : -105],
      ["team-b", sportsbookId === "hardrock" ? -145 : -115],
    ] as const) {
      const snapshot = normalizeFixtureOddsObservation({
        canonicalEventId: "event-1",
        canonicalEventVersion: 1,
        sportKey: "mlb",
        marketKey: "moneyline",
        selectionKey,
        sportsbookId,
        americanOdds,
        observedAt,
        retrievedAt: observedAt,
      });
      items.set(`${snapshot.partitionKey}\0${snapshot.sortKey}`, {
        pk: snapshot.partitionKey,
        sk: snapshot.sortKey,
        value: snapshot,
      });
      items.set(`${snapshot.partitionKey}\0CURRENT`, {
        pk: snapshot.partitionKey,
        sk: "CURRENT",
        value: snapshot,
      });
      availability.set(snapshot.partitionKey, {
        identity: snapshot.partitionKey,
        state: "active",
        observedAt,
        evidenceId: snapshot.snapshotId,
        reason: "active-price",
      });
      const group = fixtureOddsGroupAvailabilityIdentity(snapshot);
      availability.set(group, {
        identity: group,
        state: "active",
        observedAt,
        evidenceId: `group-${sportsbookId}`,
        reason: "active-market",
      });
    }
  }
  const gateway: FixtureOddsDynamoGateway = {
    getExact(pk, sk) {
      return Promise.resolve(
        structuredClone(items.get(`${pk}\0${sk}`) ?? null),
      );
    },
    transactSnapshot() {
      return Promise.reject(new Error("unused"));
    },
    putCurrent() {
      return Promise.reject(new Error("unused"));
    },
    getAvailability(identity) {
      return Promise.resolve(
        structuredClone(availability.get(identity) ?? null),
      );
    },
  };
  return { gateway, items, availability };
}

const query = {
  canonicalEventId: "event-1",
  canonicalEventVersion: 1,
  sportKey: "mlb",
  marketKey: "moneyline",
  selections: [
    { selectionKey: "team-a", point: null },
    { selectionKey: "team-b", point: null },
  ],
  targetSportsbookId: "hardrock",
  comparisonSportsbookIds: ["draftkings", "fanduel", "betmgm"],
  asOf: "2026-08-06T12:05:00.000Z",
  maximumAgeMinutes: 15,
} as const;

describe("opportunity evidence repository", () => {
  it("strongly binds CURRENT, immutable snapshots, and availability", async () => {
    const fixture = gatewayFixture();
    const result = await new DynamoOpportunityEvidenceRepository(
      fixture.gateway,
    ).read(query);
    expect(result.target.state).toBe("active");
    expect(result.target.snapshots).toHaveLength(2);
    expect(result.comparisons.every(({ state }) => state === "active")).toBe(
      true,
    );
    expect(result.target.selectionAvailability.every(Boolean)).toBe(true);
    expect(result.target.groupAvailability?.state).toBe("active");
  });

  it("returns business stale and availability states without fabricating data", async () => {
    const fixture = gatewayFixture("2026-08-06T11:00:00.000Z");
    const result = await new DynamoOpportunityEvidenceRepository(
      fixture.gateway,
    ).read(query);
    expect(result.target.state).toBe("stale");
    expect(result.target.snapshots).toHaveLength(2);
  });

  it("fails on availability identity corruption", async () => {
    const fixture = gatewayFixture();
    const corrupt: FixtureOddsDynamoGateway = {
      ...fixture.gateway,
      async getAvailability(identity) {
        const value = await fixture.gateway.getAvailability!(identity);
        return value ? { ...value, identity: "wrong-identity" } : null;
      },
    };
    await expect(
      new DynamoOpportunityEvidenceRepository(corrupt).read(query),
    ).rejects.toThrow("opportunity-availability-invalid");
  });

  it("fails the read when CURRENT changes during exact reread", async () => {
    const fixture = gatewayFixture();
    let currentReads = 0;
    const unstable: FixtureOddsDynamoGateway = {
      ...fixture.gateway,
      async getExact(pk, sk) {
        const item = await fixture.gateway.getExact(pk, sk);
        if (sk === "CURRENT" && ++currentReads > 8 && item)
          return {
            ...item,
            value: { ...item.value, snapshotId: "0".repeat(64) },
          };
        return item;
      },
    };
    await expect(
      new DynamoOpportunityEvidenceRepository(unstable).read(query),
    ).rejects.toBeInstanceOf(OpportunityEvidenceCorruptionError);
  });

  it("fences initially missing CURRENT rows and mutable availability", async () => {
    const fixture = gatewayFixture();
    let firstPartition: string | undefined;
    let firstReads = 0;
    const missingThenPresent: FixtureOddsDynamoGateway = {
      ...fixture.gateway,
      async getExact(pk, sk) {
        const item = await fixture.gateway.getExact(pk, sk);
        if (sk !== "CURRENT") return item;
        firstPartition ??= pk;
        if (pk === firstPartition && ++firstReads === 1) return null;
        return item;
      },
    };
    await expect(
      new DynamoOpportunityEvidenceRepository(missingThenPresent).read(query),
    ).rejects.toThrow("opportunity-current-changed-during-read");

    let availabilityReads = 0;
    const changingAvailability: FixtureOddsDynamoGateway = {
      ...fixture.gateway,
      async getAvailability(identity) {
        const value = await fixture.gateway.getAvailability!(identity);
        if (++availabilityReads === 4 && value)
          return { ...value, state: "suspended", evidenceId: "changed" };
        return value;
      },
    };
    await expect(
      new DynamoOpportunityEvidenceRepository(changingAvailability).read(query),
    ).rejects.toThrow("opportunity-availability-changed-during-read");
  });

  it("rejects future snapshot evidence before business classification", async () => {
    const future = gatewayFixture("2026-08-06T12:06:00.000Z");
    for (const [identity, value] of future.availability)
      future.availability.set(identity, {
        ...value,
        observedAt: query.asOf,
      });
    await expect(
      new DynamoOpportunityEvidenceRepository(future.gateway).read(query),
    ).rejects.toThrow("opportunity-evidence-time-invalid");
  });
});
