export const CALCULATION_VERSION = "edge-calculation-v1" as const;
export const CONSENSUS_CALCULATION_VERSION = "weighted-consensus-v2" as const;
export const FAIR_VALUE_CALCULATION_VERSION = "fair-value-v1" as const;
export const QUALIFICATION_VERSION = "deterministic-qualification-v1" as const;
export const LINE_MOVEMENT_CALCULATION_VERSION = "line-movement-v1" as const;
export const MARKET_OUTLIER_CALCULATION_VERSION = "market-outlier-v1" as const;
export const MARKET_DISAGREEMENT_CALCULATION_VERSION =
  "market-disagreement-v1" as const;
export const CLOSING_LINE_VALUE_CALCULATION_VERSION =
  "closing-line-value-v1" as const;
export const CLOSING_CONSENSUS_CLV_CALCULATION_VERSION =
  "closing-consensus-clv-v1" as const;
export const DISPLAY_PRECISION_POLICY_VERSION = "display-precision-v1" as const;
export const FAIR_VALUE_DISPLAY_VERSION = DISPLAY_PRECISION_POLICY_VERSION;

const ref = <Id extends string, Version extends string>(
  id: Id,
  version: Version,
) => Object.freeze({ id, version });

export const ALGORITHM_VERSIONS = Object.freeze({
  edge: ref("edge", CALCULATION_VERSION),
  consensus: ref("weighted-consensus", CONSENSUS_CALCULATION_VERSION),
  fairValue: ref("fair-value", FAIR_VALUE_CALCULATION_VERSION),
  qualification: ref("qualification", QUALIFICATION_VERSION),
  movement: ref("line-movement", LINE_MOVEMENT_CALCULATION_VERSION),
  marketOutlier: ref("market-outlier", MARKET_OUTLIER_CALCULATION_VERSION),
  marketDisagreement: ref(
    "market-disagreement",
    MARKET_DISAGREEMENT_CALCULATION_VERSION,
  ),
  closingLineValue: ref(
    "closing-line-value",
    CLOSING_LINE_VALUE_CALCULATION_VERSION,
  ),
  closingConsensusClv: ref(
    "closing-consensus-clv",
    CLOSING_CONSENSUS_CLV_CALCULATION_VERSION,
  ),
  precision: ref("display-precision", DISPLAY_PRECISION_POLICY_VERSION),
} as const);

export type AlgorithmVersionKey = keyof typeof ALGORITHM_VERSIONS;
