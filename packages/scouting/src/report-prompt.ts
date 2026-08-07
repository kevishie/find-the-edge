import { canonicalCalculationJson, sha256Hex } from "@find-the-edge/domain";
import {
  validateReportCalculationReference,
  type ReportCalculationReference,
} from "@find-the-edge/odds";
import type { NormalizedScoutingInput } from "./scouting-input";
import type { ReportModelRequest } from "./report-model-port";
import { validTrustedInstructions } from "./trusted-instructions";

export interface BuildReportPromptRequestInput {
  readonly schema: Readonly<{ id: string; version: string }>;
  readonly sportKey: string;
  readonly moduleVersion: string;
  readonly strategy: Readonly<{ id: string; version: string }>;
  readonly promptBundle: Readonly<{
    id: string;
    version: string;
    trustedInstructions: readonly string[];
  }>;
  readonly scoutingInput: NormalizedScoutingInput;
  readonly calculationReferences: readonly ReportCalculationReference[];
}

const HASH = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;

export class ReportPromptError extends Error {
  override readonly name = "ReportPromptError";
}

function fail(code: string): never {
  throw new ReportPromptError(`report-prompt-${code}`);
}

function frame(name: string, value: string): string {
  return `${name}:${new TextEncoder().encode(value).length}\n${value}\n`;
}

function canonical(value: unknown): string {
  try {
    return canonicalCalculationJson(value);
  } catch {
    return fail("material-invalid");
  }
}

function isRuntimeArray(value: unknown): boolean {
  return Array.isArray(value);
}

export function buildReportPromptRequest(
  input: BuildReportPromptRequestInput,
): Readonly<ReportModelRequest> {
  const identifiers = [
    input.schema.id,
    input.schema.version,
    input.sportKey,
    input.moduleVersion,
    input.strategy.id,
    input.strategy.version,
    input.promptBundle.id,
    input.promptBundle.version,
  ];
  if (
    identifiers.some((value) => typeof value !== "string" || !ID.test(value)) ||
    !HASH.test(input.scoutingInput.inputHash) ||
    !isRuntimeArray(input.scoutingInput.facts) ||
    !validTrustedInstructions(input.promptBundle.trustedInstructions) ||
    !isRuntimeArray(input.calculationReferences) ||
    input.calculationReferences.length > 256
  ) {
    return fail("input-invalid");
  }
  const facts = [...input.scoutingInput.facts]
    .sort((left, right) =>
      left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
    )
    .map((fact) => ({
      id: fact.id,
      capabilityKey: fact.capabilityKey,
      schemaKey: fact.schemaKey,
      ...(fact.schemaVariant === undefined
        ? {}
        : { schemaVariant: fact.schemaVariant }),
      ...(fact.subjectId === undefined ? {} : { subjectId: fact.subjectId }),
      state: fact.state,
      ...(Object.hasOwn(fact, "value") ? { value: fact.value } : {}),
      ...(fact.unavailableReason === undefined
        ? {}
        : { unavailableReason: fact.unavailableReason }),
      confidence: fact.confidence,
      freshness: fact.freshness,
      evidenceIds: fact.provenance.map((item) => item.id).sort(),
    }));
  let validatedReferences: readonly ReportCalculationReference[];
  try {
    validatedReferences = input.calculationReferences.map((reference) =>
      validateReportCalculationReference(reference),
    );
  } catch {
    return fail("calculation-reference-invalid");
  }
  const calculations = [...validatedReferences]
    .sort((left, right) =>
      left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
    )
    .map((reference) => ({
      id: reference.id,
      kind: reference.kind,
      marketKey: reference.marketKey,
      selectionKey: reference.selectionKey,
      calculationVersion: reference.calculationVersion,
      status: reference.status,
      referenceHash: reference.referenceHash,
    }));
  if (new Set(calculations.map(({ id }) => id)).size !== calculations.length) {
    return fail("calculation-reference-duplicate");
  }
  const calculationManifestHash = sha256Hex(canonical(calculations));
  const identities = {
    schema: input.schema,
    sportKey: input.sportKey,
    moduleVersion: input.moduleVersion,
    strategy: { id: input.strategy.id, version: input.strategy.version },
    sourceSchema: input.scoutingInput.moduleSchema,
    sourceManifestHash: input.scoutingInput.manifestHash,
    sourceInputHash: input.scoutingInput.inputHash,
    instructionBundle: {
      id: input.promptBundle.id,
      version: input.promptBundle.version,
    },
    calculationManifestHash,
  };
  const framedContent =
    "FTE-REPORT-REQUEST/1\n" +
    frame(
      "TRUSTED_INSTRUCTIONS",
      canonical([...input.promptBundle.trustedInstructions]),
    ) +
    frame("TRUSTED_IDENTITIES", canonical(identities)) +
    frame("UNTRUSTED_FACTS", canonical(facts)) +
    frame("DETERMINISTIC_REFERENCES", canonical(calculations));
  const requestHash = sha256Hex(framedContent);
  return Object.freeze({
    schema: Object.freeze({ ...input.schema }),
    identities: Object.freeze({
      sportKey: input.sportKey,
      moduleVersion: input.moduleVersion,
      strategyId: input.strategy.id,
      strategyVersion: input.strategy.version,
      scoutingInputHash: input.scoutingInput.inputHash,
      calculationManifestHash,
      promptBundleId: input.promptBundle.id,
      promptBundleVersion: input.promptBundle.version,
    }),
    requestHash,
    framedContent,
  });
}

export const buildScoutingReportPrompt = buildReportPromptRequest;
