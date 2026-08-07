export interface ReportModelRequest {
  readonly schema: Readonly<{ id: string; version: string }>;
  readonly identities: Readonly<{
    sportKey: string;
    moduleVersion: string;
    strategyId: string;
    strategyVersion: string;
    scoutingInputHash: string;
    calculationManifestHash: string;
    promptBundleId: string;
    promptBundleVersion: string;
  }>;
  readonly requestHash: string;
  readonly framedContent: string;
}

export interface ReportModelUsage {
  readonly inputUnits: number;
  readonly outputUnits: number;
  readonly totalUnits: number;
}

export interface ReportModelResult {
  /** Untrusted provider output. It must not be read before consumer validation. */
  readonly output: unknown;
  readonly metadata: Readonly<{
    providerId: string;
    modelId: string;
    modelVersion: string;
    deploymentId: string;
    usage: Readonly<ReportModelUsage>;
    latencyMilliseconds: number;
  }>;
}

export interface ReportModelPort {
  generate(
    request: ReportModelRequest,
    options?: Readonly<{ signal?: AbortSignal }>,
  ): Promise<ReportModelResult>;
}

export type ReportModelProviderErrorCode =
  "DISABLED" | "ABORTED" | "FAILED" | "INVALID_RESULT";

export class ReportModelProviderError extends Error {
  override readonly name = "ReportModelProviderError";

  constructor(
    readonly code: ReportModelProviderErrorCode,
    readonly retryable: boolean,
  ) {
    super(`Report model provider ${code.toLowerCase()}`);
  }
}

function aborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new ReportModelProviderError("ABORTED", false);
}

async function awaitWithAbort<T>(
  value: PromiseLike<T> | T,
  signal: AbortSignal | undefined,
): Promise<T> {
  aborted(signal);
  if (signal === undefined) return await value;
  let removeListener = (): void => undefined;
  const abort = new Promise<never>((_resolve, reject) => {
    const onAbort = (): void =>
      reject(new ReportModelProviderError("ABORTED", false));
    signal.addEventListener("abort", onAbort, { once: true });
    removeListener = () => signal.removeEventListener("abort", onAbort);
  });
  try {
    return await Promise.race([Promise.resolve(value), abort]);
  } finally {
    removeListener();
  }
}

export function createDisabledReportModelAdapter(): ReportModelPort {
  return Object.freeze({
    async generate(
      _request: ReportModelRequest,
      options?: Readonly<{ signal?: AbortSignal }>,
    ): Promise<ReportModelResult> {
      await Promise.resolve();
      aborted(options?.signal);
      throw new ReportModelProviderError("DISABLED", false);
    },
  });
}

export type FakeReportModelAdapterOptions = Readonly<
  | {
      output: unknown;
      outputFactory?: never;
      metadata?: Partial<ReportModelResult["metadata"]>;
    }
  | {
      output?: never;
      outputFactory: (request: ReportModelRequest) => unknown;
      metadata?: Partial<ReportModelResult["metadata"]>;
    }
>;

export function createFakeReportModelAdapter(
  options: FakeReportModelAdapterOptions,
): ReportModelPort {
  const suppliedUsage = options.metadata?.usage;
  const metadata = Object.freeze({
    providerId: options.metadata?.providerId ?? "deterministic-fake",
    modelId: options.metadata?.modelId ?? "report-model-fake",
    modelVersion: options.metadata?.modelVersion ?? "1",
    deploymentId: options.metadata?.deploymentId ?? "local-test",
    usage: Object.freeze({
      inputUnits: suppliedUsage?.inputUnits ?? 0,
      outputUnits: suppliedUsage?.outputUnits ?? 0,
      totalUnits: suppliedUsage?.totalUnits ?? 0,
    }),
    latencyMilliseconds: options.metadata?.latencyMilliseconds ?? 0,
  });
  return Object.freeze({
    async generate(
      request: ReportModelRequest,
      generateOptions?: Readonly<{ signal?: AbortSignal }>,
    ): Promise<ReportModelResult> {
      aborted(generateOptions?.signal);
      try {
        const value = await awaitWithAbort(
          options.outputFactory
            ? options.outputFactory(request)
            : options.output,
          generateOptions?.signal,
        );
        aborted(generateOptions?.signal);
        return Object.freeze({ output: value, metadata });
      } catch (error) {
        if (error instanceof ReportModelProviderError) throw error;
        throw new ReportModelProviderError("FAILED", true);
      }
    },
  });
}

export const disabledReportModelAdapter = createDisabledReportModelAdapter();
