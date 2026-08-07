export const opportunityRankComponentOrder = Object.freeze([
  "freshness",
  "coverage",
  "agreement",
] as const);
export type OpportunityRankComponent =
  (typeof opportunityRankComponentOrder)[number];

export const opportunityRankOrder = Object.freeze([
  "expected-value-desc",
  "confidence-desc",
  "freshness-desc",
  "sportsbook-coverage-desc",
  "logical-opportunity-id-asc",
] as const);

export interface OpportunityRankingPolicy {
  readonly id: string;
  readonly version: string;
  readonly confidence: {
    readonly scale: { readonly minimum: 0; readonly maximum: 100 };
    readonly aggregation: "minimum-component";
    readonly componentOrder: readonly OpportunityRankComponent[];
    readonly buckets: readonly [
      { readonly key: "low"; readonly minimum: 0; readonly maximum: 59 },
      { readonly key: "medium"; readonly minimum: 60; readonly maximum: 79 },
      { readonly key: "high"; readonly minimum: 80; readonly maximum: 100 },
    ];
  };
  readonly order: typeof opportunityRankOrder;
  readonly maximumFilterAgeMinutes: number;
  readonly maximumPhysicalRows: 200;
  readonly cursorTtlMs: number;
}

export const defaultOpportunityRankingPolicy: OpportunityRankingPolicy =
  Object.freeze({
    id: "find-the-edge-opportunity-ranking",
    version: "1.0.0",
    confidence: Object.freeze({
      scale: Object.freeze({ minimum: 0 as const, maximum: 100 as const }),
      aggregation: "minimum-component" as const,
      componentOrder: opportunityRankComponentOrder,
      buckets: Object.freeze([
        Object.freeze({ key: "low", minimum: 0, maximum: 59 }),
        Object.freeze({ key: "medium", minimum: 60, maximum: 79 }),
        Object.freeze({ key: "high", minimum: 80, maximum: 100 }),
      ] as const),
    }),
    order: opportunityRankOrder,
    maximumFilterAgeMinutes: 15,
    maximumPhysicalRows: 200 as const,
    cursorTtlMs: 5 * 60_000,
  });

const equal = (left: unknown, right: unknown) =>
  JSON.stringify(left) === JSON.stringify(right);
const deepFreeze = <T>(value: T): Readonly<T> => {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>))
      deepFreeze(child);
  }
  return value;
};

export function validateOpportunityRankingPolicy(
  policy: OpportunityRankingPolicy,
): OpportunityRankingPolicy {
  if (
    !policy ||
    typeof policy !== "object" ||
    !/^[a-z0-9][a-z0-9-]{0,63}$/.test(policy.id) ||
    !/^\d+\.\d+\.\d+$/.test(policy.version) ||
    !equal(policy.confidence?.scale, { minimum: 0, maximum: 100 }) ||
    policy.confidence?.aggregation !== "minimum-component" ||
    !equal(policy.confidence?.componentOrder, opportunityRankComponentOrder) ||
    !equal(policy.confidence?.buckets, [
      { key: "low", minimum: 0, maximum: 59 },
      { key: "medium", minimum: 60, maximum: 79 },
      { key: "high", minimum: 80, maximum: 100 },
    ]) ||
    !equal(policy.order, opportunityRankOrder) ||
    !Number.isFinite(policy.maximumFilterAgeMinutes) ||
    policy.maximumFilterAgeMinutes < 0 ||
    policy.maximumFilterAgeMinutes > 24 * 60 ||
    policy.maximumPhysicalRows !== 200 ||
    !Number.isSafeInteger(policy.cursorTtlMs) ||
    policy.cursorTtlMs < 60_000 ||
    policy.cursorTtlMs > 15 * 60_000
  )
    throw new Error("opportunity-ranking-policy-invalid");
  return deepFreeze(structuredClone(policy));
}
