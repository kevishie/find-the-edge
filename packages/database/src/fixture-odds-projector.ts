import type { NormalizedFixtureOddsSnapshot } from "@find-the-edge/domain";

import {
  FixtureOddsTransactionCanceledError,
  type FixtureOddsDynamoGateway,
  type FixtureOddsItem,
  validateFixtureOddsSnapshotItem,
} from "./fixture-odds-adapter.js";

export type FixtureOddsProjectionDecision = "advanced" | "retained";

const conditionalLoss = (error: unknown) =>
  error instanceof FixtureOddsTransactionCanceledError &&
  error.reasons.length === 1 &&
  error.reasons[0]?.code === "ConditionalCheckFailed";

/** Applies one already-committed immutable snapshot to the replay-safe CURRENT view. */
export class FixtureOddsCurrentProjector {
  constructor(private readonly gateway: FixtureOddsDynamoGateway) {}

  async project(item: FixtureOddsItem): Promise<{
    decision: FixtureOddsProjectionDecision;
    snapshot: NormalizedFixtureOddsSnapshot;
  }> {
    const snapshot = validateFixtureOddsSnapshotItem(item, item.pk, item.sk);
    if (!snapshot) throw new Error("fixture-odds-snapshot-missing");
    try {
      await this.gateway.putCurrent({
        item: { pk: snapshot.partitionKey, sk: "CURRENT", value: snapshot },
        advanceAfter: {
          observedAt: snapshot.observedAt,
          snapshotId: snapshot.snapshotId,
        },
      });
      return { decision: "advanced", snapshot };
    } catch (error) {
      if (conditionalLoss(error)) return { decision: "retained", snapshot };
      throw error;
    }
  }
}
