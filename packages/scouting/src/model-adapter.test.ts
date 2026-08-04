import { describe, expect, it } from "vitest";
import {
  DisabledStructuredAnalysisModelAdapter,
  FakeStructuredAnalysisModelAdapter,
  ModelDisabledError,
} from "./model-adapter";

describe("structured model adapter", () => {
  it("fails closed without making a paid call", async () => {
    await expect(
      new DisabledStructuredAnalysisModelAdapter().analyze(),
    ).rejects.toBeInstanceOf(ModelDisabledError);
  });
  it("keeps logical model identity separate from deployment identity", async () => {
    const adapter = new FakeStructuredAnalysisModelAdapter({
      output: {},
      model: { id: "logical", version: "1", deploymentId: "deploy-a" },
      usage: { inputTokens: 1, outputTokens: 2, latencyMs: 3 },
    });
    const result = await adapter.analyze({
      request: {} as never,
      promptBundleId: "p",
      promptBundleVersion: "1",
      promptHash: "a".repeat(64),
    });
    expect(result.model).toEqual({
      id: "logical",
      version: "1",
      deploymentId: "deploy-a",
    });
    expect(adapter.calls).toHaveLength(1);
  });
});
