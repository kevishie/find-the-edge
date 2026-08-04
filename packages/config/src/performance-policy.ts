import type { CohortDefinition } from "@find-the-edge/domain";

export const PERFORMANCE_COHORT_POLICY_ID = "fte-paper-performance";
export const PERFORMANCE_COHORT_POLICY_VERSION = "1";

/** Server-owned rolling cohort. It always ends at the latest completed UTC day. */
export function scheduledPerformanceCohort(now: Date): {
  readonly policyId: typeof PERFORMANCE_COHORT_POLICY_ID;
  readonly policyVersion: typeof PERFORMANCE_COHORT_POLICY_VERSION;
  readonly cutoff: string;
  readonly definition: CohortDefinition;
} {
  if (!Number.isFinite(now.getTime()))
    throw new Error("performance-clock-invalid");
  const to = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  const from = new Date(to);
  from.setUTCDate(from.getUTCDate() - 30);
  const cutoff = now.toISOString();
  return {
    policyId: PERFORMANCE_COHORT_POLICY_ID,
    policyVersion: PERFORMANCE_COHORT_POLICY_VERSION,
    cutoff,
    definition: {
      window: { from: from.toISOString(), to: to.toISOString() },
      filters: {
        wagerMode: "paper",
        sports: ["baseball_mlb", "soccer_usa_mls"],
        markets: ["moneyline", "spread"],
      },
      policyVersions: {
        cohort: "cohort-v1",
        performance: "performance-v1",
        oddsBand: "odds-band-v1",
        calibration: "calibration-deciles-v1",
        clv: "clv-same-book-15m-v1",
      },
    },
  };
}
