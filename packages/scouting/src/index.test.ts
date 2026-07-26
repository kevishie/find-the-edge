import { describe, expect, it } from "vitest";

import { composePrompt, type PromptSection } from "./index";

const sections: PromptSection[] = [
  {
    id: "game",
    version: "1",
    kind: "analysis",
    content: "Analyze this event.",
  },
  { id: "fte", version: "2", kind: "strategy", content: "Apply strategy." },
  { id: "mlb", version: "1", kind: "sport", content: "Apply sport mechanics." },
  {
    id: "philosophy",
    version: "1",
    kind: "shared",
    content: "Use verified facts.",
  },
];

describe("prompt composition", () => {
  it("uses a deterministic shared-sport-strategy-analysis order", () => {
    const bundle = composePrompt("scout", "1.0.0", "model-1", sections);
    expect(bundle.sections.map((section) => section.kind)).toEqual([
      "shared",
      "sport",
      "strategy",
      "analysis",
    ]);
    expect(bundle.content).toMatchSnapshot();
  });

  it("rejects an incomplete bundle", () => {
    expect(() =>
      composePrompt(
        "scout",
        "1",
        "model",
        sections.filter((section) => section.kind !== "shared"),
      ),
    ).toThrow("Missing prompt section: shared");
  });
});
