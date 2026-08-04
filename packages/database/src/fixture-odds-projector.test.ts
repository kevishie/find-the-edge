import { normalizeFixtureOddsObservation } from "@find-the-edge/domain";
import { describe, expect, it, vi } from "vitest";

import {
  FixtureOddsTransactionCanceledError,
  type FixtureOddsDynamoGateway,
} from "./fixture-odds-adapter.js";
import { FixtureOddsCurrentProjector } from "./fixture-odds-projector.js";

const snapshot = normalizeFixtureOddsObservation({
  canonicalEventId: "event-1",
  canonicalEventVersion: 1,
  sportKey: "baseball",
  marketKey: "moneyline",
  selectionKey: "team-1",
  sportsbookId: "draftkings",
  americanOdds: -110,
  observedAt: "2026-08-04T12:00:00.000Z",
  retrievedAt: "2026-08-04T12:00:01.000Z",
});

const gateway = (putCurrent = vi.fn().mockResolvedValue(undefined)) =>
  ({
    getExact: vi.fn(),
    transactSnapshot: vi.fn(),
    putCurrent,
  }) satisfies FixtureOddsDynamoGateway;

describe("FixtureOddsCurrentProjector", () => {
  it("advances a strictly validated immutable snapshot", async () => {
    const store = gateway();
    await expect(
      new FixtureOddsCurrentProjector(store).project({
        pk: snapshot.partitionKey,
        sk: snapshot.sortKey,
        value: snapshot,
      }),
    ).resolves.toMatchObject({ decision: "advanced", snapshot });
    expect(store.putCurrent).toHaveBeenCalledWith({
      item: { pk: snapshot.partitionKey, sk: "CURRENT", value: snapshot },
      advanceAfter: {
        observedAt: snapshot.observedAt,
        snapshotId: snapshot.snapshotId,
      },
    });
  });

  it("treats duplicate and older conditional losses as retained", async () => {
    const store = gateway(
      vi
        .fn()
        .mockRejectedValue(
          new FixtureOddsTransactionCanceledError([
            { code: "ConditionalCheckFailed" },
          ]),
        ),
    );
    await expect(
      new FixtureOddsCurrentProjector(store).project({
        pk: snapshot.partitionKey,
        sk: snapshot.sortKey,
        value: snapshot,
      }),
    ).resolves.toMatchObject({ decision: "retained" });
  });

  it("rejects forged snapshot rows", async () => {
    await expect(
      new FixtureOddsCurrentProjector(gateway()).project({
        pk: snapshot.partitionKey,
        sk: snapshot.sortKey,
        value: { ...snapshot, americanOdds: 999 },
      }),
    ).rejects.toThrow(/forged/);
  });
});
