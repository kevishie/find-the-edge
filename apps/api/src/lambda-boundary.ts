import type { EncodedApiResponse } from "./http-compression";

const INTERNAL_ERROR: EncodedApiResponse = Object.freeze({
  statusCode: 500,
  headers: {
    "content-type": "application/json",
    "cache-control": "no-store",
  },
  body: JSON.stringify({ error: "internal-error" }),
});

/**
 * The handler owns its operation-level error boundary, but request-time
 * adapter dependencies such as secret loading and authorization run before
 * that handler is called. Keep those failures on the same safe JSON contract
 * and never log an upstream message that could contain a token or account key.
 */
export async function withEventApiLambdaBoundary(
  operation: () => Promise<EncodedApiResponse>,
  log: (record: Readonly<Record<string, string>>) => void = console.error,
): Promise<EncodedApiResponse> {
  try {
    return await operation();
  } catch {
    try {
      log({
        event: "event-api-adapter-failure",
        errorName: "EventApiAdapterError",
        errorMessage: "request-adapter-operation-failed",
      });
    } catch {
      // Logging is diagnostic only. A broken sink must not replace the safe
      // response with the same unstructured integration failure this boundary
      // exists to prevent.
    }
    return INTERNAL_ERROR;
  }
}
