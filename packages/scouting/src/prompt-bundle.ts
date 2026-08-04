import { createHash } from "node:crypto";

import {
  assertAcyclic,
  canonicalAnalysisJson,
  type NormalizedAnalysisRequest,
} from "./analysis-contract";

export type PromptSectionKind = "shared" | "sport" | "strategy" | "analysis";

export interface PromptSection {
  id: string;
  version: string;
  kind: PromptSectionKind;
  content: string;
}

export interface PromptBundle {
  id: string;
  version: string;
  modelId: string;
  modelVersion: string;
  sections: PromptSection[];
  content: string;
  promptTextHash: string;
  bundleHash: string;
  /** Compatibility alias for bundleHash. */
  sha256Hash: string;
}

export interface AnalysisPromptBundle extends PromptBundle {
  trustedPromptHash: string;
  evidenceHash: string;
  candidateHash: string;
  requestHash: string;
  analysisPromptHash: string;
  untrustedEvidenceFrame: string;
  trustedInstructions: string;
  requestFrame: string;
  messages: readonly Readonly<{
    role: "system" | "user";
    content: string;
    trust: "trusted-instructions" | "trusted-request" | "untrusted-evidence";
  }>[];
  /** Deterministic diagnostic serialization; invoke models with messages instead. */
  analysisPrompt: string;
}

const sectionOrder: readonly PromptSectionKind[] = [
  "shared",
  "sport",
  "strategy",
  "analysis",
];

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalizedText(value: string, field: string, maximum: number): string {
  if (typeof value !== "string") throw new Error(`${field} must be text`);
  const result = value.replaceAll("\r\n", "\n").trim();
  if (
    !result ||
    result.length > maximum ||
    [...result].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return (
        (code < 32 && code !== 9 && code !== 10 && code !== 13) || code === 127
      );
    })
  ) {
    throw new Error(`${field} must be bounded printable text`);
  }
  return result;
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`)
    .join(",")}}`;
}

export function composePrompt(
  id: string,
  version: string,
  model: string | { readonly id: string; readonly version: string },
  sections: PromptSection[],
): PromptBundle {
  const normalizedId = normalizedText(id, "Prompt bundle id", 128);
  const normalizedVersion = normalizedText(
    version,
    "Prompt bundle version",
    64,
  );
  assertAcyclic(sections);
  const normalizedModelId = normalizedText(
    typeof model === "string" ? model : model.id,
    "Model id",
    128,
  );
  const normalizedModelVersion = normalizedText(
    typeof model === "string" ? model : model.version,
    "Model version",
    128,
  );
  if (!Array.isArray(sections))
    throw new Error("Prompt sections must be an array");
  const normalized = sections.map((section, index) => ({
    id: normalizedText(section.id, `Prompt section ${index} id`, 128),
    version: normalizedText(
      section.version,
      `Prompt section ${index} version`,
      64,
    ),
    kind: section.kind,
    content: normalizedText(
      section.content,
      `Prompt section ${index} content`,
      64_000,
    ),
  }));
  for (const required of sectionOrder) {
    const matches = normalized.filter((section) => section.kind === required);
    if (matches.length === 0)
      throw new Error(`Missing prompt section: ${required}`);
    if (matches.length > 1)
      throw new Error(`Duplicate prompt section: ${required}`);
  }
  if (normalized.some((section) => !sectionOrder.includes(section.kind))) {
    throw new Error("Unknown prompt section kind");
  }
  const sorted = [...normalized].sort(
    (left, right) =>
      sectionOrder.indexOf(left.kind) - sectionOrder.indexOf(right.kind),
  );
  const content = sorted
    .map(
      (section) =>
        `<!-- ${section.kind}:${section.id}@${section.version} -->\n${section.content}`,
    )
    .join("\n\n");
  const promptTextHash = sha256(content);
  const bundleHash = sha256(
    canonical({
      id: normalizedId,
      version: normalizedVersion,
      modelId: normalizedModelId,
      modelVersion: normalizedModelVersion,
      sections: sorted,
      content,
    }),
  );
  return {
    id: normalizedId,
    version: normalizedVersion,
    modelId: normalizedModelId,
    modelVersion: normalizedModelVersion,
    sections: sorted,
    content,
    promptTextHash,
    bundleHash,
    sha256Hash: bundleHash,
  };
}

export function frameUntrustedEvidence(request: NormalizedAnalysisRequest): {
  frame: string;
  evidenceHash: string;
  candidateHash: string;
} {
  const evidence = [...request.evidence].sort((left, right) =>
    left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
  );
  const evidenceJson = canonical(evidence);
  const candidateJson = canonical(request.candidate);
  const byteLength = new TextEncoder().encode(evidenceJson).byteLength;
  return {
    frame: `UNTRUSTED_EVIDENCE_UTF8_LENGTH:${byteLength}\n${evidenceJson}`,
    evidenceHash: sha256(evidenceJson),
    candidateHash: sha256(candidateJson),
  };
}

export function composeAnalysisPrompt(
  bundle: PromptBundle,
  request: NormalizedAnalysisRequest,
): AnalysisPromptBundle {
  assertAcyclic(bundle);
  const expectedContent = bundle.sections
    .map(
      (section) =>
        `<!-- ${section.kind}:${section.id}@${section.version} -->\n${section.content}`,
    )
    .join("\n\n");
  const expectedPromptHash = sha256(expectedContent);
  const expectedBundleHash = sha256(
    canonical({
      id: bundle.id,
      version: bundle.version,
      modelId: bundle.modelId,
      modelVersion: bundle.modelVersion,
      sections: bundle.sections,
      content: expectedContent,
    }),
  );
  if (
    bundle.content !== expectedContent ||
    bundle.promptTextHash !== expectedPromptHash ||
    bundle.bundleHash !== expectedBundleHash ||
    bundle.sha256Hash !== expectedBundleHash
  ) {
    throw new Error("Prompt bundle integrity check failed");
  }
  const expected = request.versions;
  if (
    bundle.id !== expected.promptBundleId ||
    bundle.version !== expected.promptBundleVersion ||
    bundle.modelId !== expected.modelId ||
    bundle.modelVersion !== expected.modelVersion ||
    bundle.sections.some((section) => {
      const reference = expected.promptSections[section.kind];
      return (
        section.id !== reference.id || section.version !== reference.version
      );
    })
  ) {
    throw new Error("Prompt bundle does not match analysis contract");
  }
  const { frame, evidenceHash, candidateHash } =
    frameUntrustedEvidence(request);
  const requestEnvelope = canonical({
    sportKey: request.sportKey,
    leagueKey: request.leagueKey,
    eventId: request.eventId,
    participantIds: request.participantIds,
    startsAt: request.startsAt,
    asOf: request.asOf,
    candidate: request.candidate,
    candidateHash,
    evidenceHash,
    derivedStatus: request.derivedStatus,
    missingEvidenceCodes: request.missingEvidenceCodes,
    derivedReasonCodes: request.derivedReasonCodes,
    strategy: request.strategy ?? null,
    versions: request.versions,
    inputHash: request.inputHash,
  });
  const requestHash = sha256(requestEnvelope);
  const requestFrame = `ANALYSIS_REQUEST_CANONICAL_JSON_UTF8_LENGTH:${new TextEncoder().encode(requestEnvelope).byteLength}\n${requestEnvelope}`;
  const messages = [
    {
      role: "system" as const,
      content: bundle.content,
      trust: "trusted-instructions" as const,
    },
    {
      role: "user" as const,
      content: requestFrame,
      trust: "trusted-request" as const,
    },
    {
      role: "user" as const,
      content: frame,
      trust: "untrusted-evidence" as const,
    },
  ];
  const analysisPrompt = canonicalAnalysisJson(messages);
  return {
    ...bundle,
    trustedPromptHash: bundle.promptTextHash,
    evidenceHash,
    candidateHash,
    requestHash,
    analysisPromptHash: sha256(analysisPrompt),
    untrustedEvidenceFrame: frame,
    trustedInstructions: bundle.content,
    requestFrame,
    messages,
    analysisPrompt,
  };
}
