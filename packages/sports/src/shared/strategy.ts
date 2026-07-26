import type {
  SportModule,
  StrategyDefinition,
  ValidationResult,
} from "./contracts";

export function validateStrategy(
  strategy: StrategyDefinition,
  module: SportModule,
): ValidationResult<StrategyDefinition> {
  const errors: string[] = [];
  const possibleMarkets = new Set(module.markets.map((market) => market.key));

  if (strategy.sportKey !== module.key)
    errors.push("Strategy sport does not match module");
  if (!strategy.id.trim()) errors.push("Strategy id is required");
  if (!strategy.version.trim()) errors.push("Strategy version is required");
  if (strategy.minimumEv < 0 || strategy.minimumEv >= 1) {
    errors.push("Minimum EV must be between 0 and 1");
  }
  if (strategy.minimumComparisonBooks < 1) {
    errors.push("At least one comparison book is required");
  }
  for (const marketKey of strategy.approvedMarketKeys) {
    if (!possibleMarkets.has(marketKey)) {
      errors.push(`Approved market is not defined by module: ${marketKey}`);
    }
    if (strategy.prohibitedMarketKeys.includes(marketKey)) {
      errors.push(
        `Market cannot be both approved and prohibited: ${marketKey}`,
      );
    }
  }

  return errors.length
    ? { valid: false, errors }
    : { valid: true, value: strategy, errors: [] };
}
