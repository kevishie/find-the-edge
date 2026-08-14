import { describe, expect, it, vi } from "vitest";
import { withEventApiLambdaBoundary } from "./lambda-boundary";

describe("event API Lambda boundary", () => {
  it("passes successful responses through unchanged", async () => {
    const response = {
      statusCode: 204,
      headers: { "cache-control": "no-store" },
      body: "",
    };
    await expect(
      withEventApiLambdaBoundary(() => Promise.resolve(response)),
    ).resolves.toBe(response);
  });

  it("turns adapter dependency failures into a redacted JSON 500", async () => {
    const log = vi.fn();
    const sensitive = new Error(
      `storage failed for account:${"a".repeat(64)} fte1.secret.signature`,
    );
    await expect(
      withEventApiLambdaBoundary(() => Promise.reject(sensitive), log),
    ).resolves.toEqual({
      statusCode: 500,
      headers: {
        "content-type": "application/json",
        "cache-control": "no-store",
      },
      body: JSON.stringify({ error: "internal-error" }),
    });
    expect(log).toHaveBeenCalledWith({
      event: "event-api-adapter-failure",
      errorName: "EventApiAdapterError",
      errorMessage: "request-adapter-operation-failed",
    });
    expect(JSON.stringify(log.mock.calls)).not.toContain("account:");
    expect(JSON.stringify(log.mock.calls)).not.toContain("fte1.");
  });

  it("still returns the safe response when the diagnostic sink throws", async () => {
    await expect(
      withEventApiLambdaBoundary(
        () => Promise.reject(new Error("dependency-failed")),
        () => {
          throw new Error("logging-failed");
        },
      ),
    ).resolves.toMatchObject({
      statusCode: 500,
      body: JSON.stringify({ error: "internal-error" }),
    });
  });
});
