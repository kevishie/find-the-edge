import { describe, expect, it } from "vitest";
import {
  ALGORITHM_VERSIONS,
  CONSENSUS_CALCULATION_VERSION,
  DISPLAY_PRECISION_POLICY_VERSION,
} from "./versions";

describe("algorithm version registry", () => {
  it("identifies the hardened consensus as v2 and is deeply immutable", () => {
    expect(CONSENSUS_CALCULATION_VERSION).toBe("weighted-consensus-v2");
    expect(ALGORITHM_VERSIONS.consensus.version).toBe("weighted-consensus-v2");
    expect(ALGORITHM_VERSIONS.precision.version).toBe(
      DISPLAY_PRECISION_POLICY_VERSION,
    );
    expect(Object.isFrozen(ALGORITHM_VERSIONS)).toBe(true);
    expect(Object.isFrozen(ALGORITHM_VERSIONS.consensus)).toBe(true);
  });
});
