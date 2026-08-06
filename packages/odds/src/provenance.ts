import {
  createCalculationProvenance,
  type CalculationProvenance,
} from "@find-the-edge/domain";
import {
  ALGORITHM_VERSIONS,
  DISPLAY_PRECISION_POLICY_VERSION,
  type AlgorithmVersionKey,
} from "./versions";

export interface OddsComponentInput {
  readonly algorithmKey: AlgorithmVersionKey;
  readonly input: unknown;
}

export function calculationProvenance(
  algorithmKey: AlgorithmVersionKey,
  input: unknown,
  components: readonly OddsComponentInput[] = [],
  componentEvidence: readonly Readonly<CalculationProvenance>[] = [],
): Readonly<CalculationProvenance> {
  return createCalculationProvenance({
    algorithm: ALGORITHM_VERSIONS[algorithmKey],
    input,
    precisionPolicyVersion: DISPLAY_PRECISION_POLICY_VERSION,
    components: components.map((component) => ({
      algorithm: ALGORITHM_VERSIONS[component.algorithmKey],
      input: component.input,
    })),
    componentEvidence: componentEvidence.flatMap((evidence) => [
      evidence.root,
      ...evidence.components,
    ]),
  });
}

export function safeCalculationProvenance(
  algorithmKey: AlgorithmVersionKey,
  input: unknown,
  components: readonly OddsComponentInput[] = [],
  componentEvidence: readonly Readonly<CalculationProvenance>[] = [],
): Readonly<CalculationProvenance> | null {
  try {
    return calculationProvenance(
      algorithmKey,
      input,
      components,
      componentEvidence,
    );
  } catch {
    return null;
  }
}
