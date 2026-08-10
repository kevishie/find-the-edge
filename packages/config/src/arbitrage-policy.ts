import { approvedSportsbookCollection } from "./sportsbooks";

export interface ArbitragePolicy {
  readonly id: string;
  readonly version: string;
  /** Books whose collected quotes participate in best-price selection. */
  readonly sportsbookIds: readonly string[];
  /** Sum of best-price inverse decimals below 1 is an arbitrage; at or
   * above 1 but below this threshold is a low-hold market. */
  readonly lowHoldThreshold: number;
  readonly maximumPriceAgeMinutes: number;
}

export const defaultArbitragePolicy: ArbitragePolicy = Object.freeze({
  id: "find-the-edge-arbitrage",
  version: "1.0.0",
  sportsbookIds: Object.freeze(
    Object.keys(approvedSportsbookCollection).sort(),
  ),
  lowHoldThreshold: 1.01,
  maximumPriceAgeMinutes: 15,
});

export function validateArbitragePolicy(
  policy: ArbitragePolicy,
): ArbitragePolicy {
  if (
    !policy ||
    typeof policy !== "object" ||
    !policy.id ||
    !policy.version ||
    !Array.isArray(policy.sportsbookIds) ||
    policy.sportsbookIds.length < 2 ||
    new Set(policy.sportsbookIds).size !== policy.sportsbookIds.length ||
    policy.sportsbookIds.some(
      (book: string) => !book || book !== book.trim().toLowerCase(),
    ) ||
    !Number.isFinite(policy.lowHoldThreshold) ||
    policy.lowHoldThreshold <= 1 ||
    policy.lowHoldThreshold > 1.1 ||
    !Number.isFinite(policy.maximumPriceAgeMinutes) ||
    policy.maximumPriceAgeMinutes <= 0
  )
    throw new Error("arbitrage-policy-invalid");
  return policy;
}
