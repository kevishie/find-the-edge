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
  modelVersion: string;
  sections: PromptSection[];
  content: string;
}

const order: PromptSectionKind[] = ["shared", "sport", "strategy", "analysis"];

export function composePrompt(
  id: string,
  version: string,
  modelVersion: string,
  sections: PromptSection[],
): PromptBundle {
  if (!id.trim() || !version.trim() || !modelVersion.trim()) {
    throw new Error(
      "Prompt bundle id, version, and model version are required",
    );
  }
  for (const required of order) {
    if (!sections.some((section) => section.kind === required)) {
      throw new Error(`Missing prompt section: ${required}`);
    }
  }
  const sorted = [...sections].sort(
    (left, right) => order.indexOf(left.kind) - order.indexOf(right.kind),
  );
  const content = sorted
    .map(
      (section) =>
        `<!-- ${section.kind}:${section.id}@${section.version} -->\n${section.content.trim()}`,
    )
    .join("\n\n");
  return { id, version, modelVersion, sections: sorted, content };
}
