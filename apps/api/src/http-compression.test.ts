import { gunzipSync } from "node:zlib";
import { expect, it } from "vitest";
import { encodeApiResponse } from "./http-compression";

const response = (body: string) => ({
  statusCode: 200,
  headers: { "content-type": "application/json", "cache-control": "no-store" },
  body,
});

const largeBody = JSON.stringify({ items: "x".repeat(4_000) });

it("gzips a large body for a client that offers gzip", () => {
  const encoded = encodeApiResponse(response(largeBody), "gzip, deflate, br");
  expect(encoded.isBase64Encoded).toBe(true);
  expect(encoded.headers).toMatchObject({
    "content-encoding": "gzip",
    vary: "accept-encoding",
    "content-type": "application/json",
  });
  expect(gunzipSync(Buffer.from(encoded.body, "base64")).toString()).toBe(
    largeBody,
  );
});

it("honours quality parameters when matching the encoding", () => {
  const encoded = encodeApiResponse(
    response(largeBody),
    "br;q=1.0, gzip;q=0.8",
  );
  expect(encoded.isBase64Encoded).toBe(true);
});

it("passes small bodies through untouched", () => {
  const small = response(JSON.stringify({ ok: true }));
  expect(encodeApiResponse(small, "gzip")).toBe(small);
});

it("never compresses for a client that did not offer gzip", () => {
  for (const acceptEncoding of [
    undefined,
    "",
    "br",
    "identity",
    "gzippy",
    "gzip;q=0",
  ]) {
    const passed = encodeApiResponse(response(largeBody), acceptEncoding);
    expect(passed.isBase64Encoded).toBeUndefined();
    expect(passed.body).toBe(largeBody);
  }
});
