import { gzipSync } from "node:zlib";
import type { ApiResponse } from "./handler";

/**
 * The HTTP API gateway does not compress payloads, so the six-figure board
 * bodies otherwise ship uncompressed. Compressing in the function costs a few
 * milliseconds at the current CPU allocation and cuts the wire size roughly
 * ninefold.
 */
const MINIMUM_COMPRESSIBLE_BYTES = 1_024;

export interface EncodedApiResponse extends ApiResponse {
  readonly isBase64Encoded?: boolean;
}

const acceptsGzip = (acceptEncoding: string | undefined) =>
  typeof acceptEncoding === "string" &&
  acceptEncoding.split(",").some((entry) => {
    const [name, ...parameters] = entry.split(";");
    if (name!.trim().toLowerCase() !== "gzip") return false;
    // "gzip;q=0" declines the encoding rather than offering it.
    return !parameters.some(
      (parameter) =>
        parameter.trim().toLowerCase().replace(/\s+/g, "") === "q=0",
    );
  });

export const encodeApiResponse = (
  response: ApiResponse,
  acceptEncoding: string | undefined,
): EncodedApiResponse => {
  if (
    !acceptsGzip(acceptEncoding) ||
    Buffer.byteLength(response.body) < MINIMUM_COMPRESSIBLE_BYTES
  )
    return response;
  return {
    statusCode: response.statusCode,
    headers: {
      ...response.headers,
      "content-encoding": "gzip",
      // Caches between the function and the browser must not serve a gzip
      // body to a client that did not offer gzip.
      vary: "accept-encoding",
    },
    body: gzipSync(Buffer.from(response.body)).toString("base64"),
    isBase64Encoded: true,
  };
};
