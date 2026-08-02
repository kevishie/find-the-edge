import { describe, expect, it, vi } from "vitest";

import { bootstrapRuntime } from "./runtime-config";

const validConfig = {
  schemaVersion: 1,
  apiBase: "https://api.example.com/",
};

describe("anonymous runtime bootstrap", () => {
  it("accepts the minimal public API configuration", () => {
    expect(bootstrapRuntime({ __FTE_RUNTIME_CONFIG__: validConfig })).toEqual({
      ok: true,
      value: {
        config: {
          schemaVersion: 1,
          apiBase: "https://api.example.com",
        },
      },
    });
  });

  it.each([
    ["missing", {}],
    ["null", { __FTE_RUNTIME_CONFIG__: null }],
    [
      "wrong schema",
      { __FTE_RUNTIME_CONFIG__: { ...validConfig, schemaVersion: 2 } },
    ],
    [
      "unknown field",
      { __FTE_RUNTIME_CONFIG__: { ...validConfig, secret: "x" } },
    ],
    [
      "credentials",
      {
        __FTE_RUNTIME_CONFIG__: {
          ...validConfig,
          apiBase: "https://u:p@api.example.com",
        },
      },
    ],
    [
      "query",
      {
        __FTE_RUNTIME_CONFIG__: {
          ...validConfig,
          apiBase: "https://api.example.com?q=1",
        },
      },
    ],
  ])("rejects %s configuration", (_label, host) => {
    expect(bootstrapRuntime(host)).toMatchObject({ ok: false });
  });

  it("allows local HTTP only outside production", () => {
    const host = {
      __FTE_RUNTIME_CONFIG__: {
        ...validConfig,
        apiBase: "http://127.0.0.1:3000",
      },
    };
    expect(bootstrapRuntime(host)).toMatchObject({ ok: false });
    expect(bootstrapRuntime(host, { mode: "development" })).toMatchObject({
      ok: true,
    });
  });

  it("does not execute a configuration accessor", () => {
    const getter = vi.fn(() => validConfig);
    const host = {};
    Object.defineProperty(host, "__FTE_RUNTIME_CONFIG__", { get: getter });
    expect(bootstrapRuntime(host)).toMatchObject({ ok: false });
    expect(getter).not.toHaveBeenCalled();
  });

  it("redacts hostile proxy failures", () => {
    const hostile = new Proxy(
      {},
      {
        getOwnPropertyDescriptor() {
          throw new Error("secret-detail");
        },
      },
    );
    const result = bootstrapRuntime(hostile);
    expect(result).toMatchObject({
      ok: false,
      error: { code: "invalid-config" },
    });
    expect(JSON.stringify(result)).not.toContain("secret-detail");
  });
});
