import type { NormalizedAnalysisRequest } from "./analysis-contract";

export interface StructuredAnalysisModelRequest {
  readonly request: NormalizedAnalysisRequest;
  readonly promptBundleId: string;
  readonly promptBundleVersion: string;
  readonly promptHash: string;
}
export interface StructuredAnalysisModelResult {
  readonly output: unknown;
  readonly model: {
    readonly id: string;
    readonly version: string;
    readonly deploymentId: string;
  };
  readonly usage: {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly latencyMs: number;
  };
}
export interface StructuredAnalysisModelAdapter {
  analyze(
    input: StructuredAnalysisModelRequest,
    options?: { readonly signal?: AbortSignal },
  ): Promise<StructuredAnalysisModelResult>;
}
export class ModelDisabledError extends Error {
  override readonly name = "ModelDisabledError";
  constructor() {
    super("model-disabled");
  }
}
export class DisabledStructuredAnalysisModelAdapter implements StructuredAnalysisModelAdapter {
  analyze(): Promise<StructuredAnalysisModelResult> {
    return Promise.reject(new ModelDisabledError());
  }
}
export class FakeStructuredAnalysisModelAdapter implements StructuredAnalysisModelAdapter {
  readonly calls: StructuredAnalysisModelRequest[] = [];
  constructor(
    private readonly result:
      | StructuredAnalysisModelResult
      | ((
          request: StructuredAnalysisModelRequest,
        ) => StructuredAnalysisModelResult),
  ) {}
  analyze(
    input: StructuredAnalysisModelRequest,
  ): Promise<StructuredAnalysisModelResult> {
    this.calls.push(structuredClone(input));
    return Promise.resolve(
      typeof this.result === "function"
        ? this.result(input)
        : structuredClone(this.result),
    );
  }
}
