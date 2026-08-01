import { describe, expect, it, vi } from "vitest";

import { bootstrapRuntime } from "./runtime-config";

function hostWith(
  config: unknown,
  provider: unknown = () => Promise.resolve(" token-value "),
): Record<string, unknown> {
  return {
    __FTE_RUNTIME_CONFIG__: config,
    __FTE_TOKEN_PROVIDERS__: { hostSession: provider },
  };
}

const validConfig = {
  schemaVersion: 1,
  apiBase: "https://api.example.com/",
  tokenProviderKey: "hostSession",
};

describe("runtime bootstrap", () => {
  it("resolves exact configuration and a trimmed async token", async () => {
    const result = bootstrapRuntime(hostWith(validConfig));
    expect(result).toMatchObject({
      ok: true,
      value: { config: { apiBase: "https://api.example.com" } },
    });
    if (!result.ok) throw new Error("expected bootstrap success");
    await expect(result.value.acquireAccessToken()).resolves.toEqual({
      ok: true,
      value: "token-value",
    });
  });

  it.each([
    ["empty", {}, "invalid-config"],
    ["extra key", { ...validConfig, extra: true }, "invalid-config"],
    ["wrong schema", { ...validConfig, schemaVersion: 2 }, "invalid-config"],
    ["inherited", Object.create(validConfig), "invalid-config"],
    [
      "unsafe URL",
      { ...validConfig, apiBase: "javascript:alert(1)" },
      "invalid-api-base",
    ],
    [
      "credential URL",
      { ...validConfig, apiBase: "https://u:p@api.example.com" },
      "invalid-api-base",
    ],
    [
      "query URL",
      { ...validConfig, apiBase: "https://api.example.com/?key=x" },
      "invalid-api-base",
    ],
    [
      "embedded URL tab",
      { ...validConfig, apiBase: "https://api.example.com/\tpath" },
      "invalid-api-base",
    ],
    [
      "embedded URL DEL",
      { ...validConfig, apiBase: "https://api.example.com/\u007fpath" },
      "invalid-api-base",
    ],
    [
      "unsafe key",
      { ...validConfig, tokenProviderKey: "__proto__" },
      "invalid-provider-key",
    ],
  ])("rejects %s configuration", (_label, config, code) => {
    expect(bootstrapRuntime(hostWith(config))).toMatchObject({
      ok: false,
      error: { code },
    });
  });

  it("allows localhost HTTP only when explicitly non-production", () => {
    const config = { ...validConfig, apiBase: "http://localhost:3000" };
    expect(bootstrapRuntime(hostWith(config))).toMatchObject({ ok: false });
    expect(
      bootstrapRuntime(hostWith(config), { mode: "development" }),
    ).toMatchObject({ ok: true });
  });

  it("does not execute configuration or provider accessors", () => {
    const configGetter = vi.fn(() => validConfig);
    const host = {};
    Object.defineProperty(host, "__FTE_RUNTIME_CONFIG__", {
      get: configGetter,
    });
    expect(bootstrapRuntime(host)).toMatchObject({
      ok: false,
      error: { code: "missing-config" },
    });
    expect(configGetter).not.toHaveBeenCalled();

    const providerGetter = vi.fn(() => () => Promise.resolve("token"));
    const registry = {};
    Object.defineProperty(registry, "hostSession", { get: providerGetter });
    expect(
      bootstrapRuntime({
        __FTE_RUNTIME_CONFIG__: validConfig,
        __FTE_TOKEN_PROVIDERS__: registry,
      }),
    ).toMatchObject({ ok: false, error: { code: "missing-provider" } });
    expect(providerGetter).not.toHaveBeenCalled();
  });

  it("redacts hostile proxy failures instead of throwing before render", () => {
    const hostile = new Proxy(
      {},
      {
        getOwnPropertyDescriptor() {
          throw new Error("secret-detail");
        },
      },
    );
    expect(() => bootstrapRuntime(hostile)).not.toThrow();
    expect(bootstrapRuntime(hostile)).toEqual({
      ok: false,
      error: {
        kind: "runtime-config-error",
        code: "invalid-config",
        message: "Runtime configuration is invalid.",
      },
    });
  });

  it.each([
    ["missing", null],
    ["not a function", "token"],
  ])("rejects a %s provider", (_label, provider) => {
    expect(bootstrapRuntime(hostWith(validConfig, provider))).toMatchObject({
      ok: false,
      error: { code: "missing-provider" },
    });
  });
});

describe("token acquisition", () => {
  async function acquire(provider: unknown, timeoutMs = 50) {
    const result = bootstrapRuntime(hostWith(validConfig, provider), {
      tokenTimeoutMs: timeoutMs,
    });
    if (!result.ok) throw new Error("expected bootstrap success");
    return result.value.acquireAccessToken();
  }

  it.each([
    [
      "provider rejection",
      () => Promise.reject(new Error("secret-detail")),
      "provider-rejected",
    ],
    [
      "provider throw",
      () => {
        throw new Error("secret-detail");
      },
      "provider-rejected",
    ],
    [
      "non-string",
      () => Promise.resolve({ token: "secret-detail" }),
      "provider-rejected",
    ],
    ["empty", () => Promise.resolve("   "), "empty-token"],
    ["oversized", () => Promise.resolve("x".repeat(8193)), "oversized-token"],
  ])("redacts %s", async (_label, provider, code) => {
    const result = await acquire(provider);
    expect(result).toMatchObject({ ok: false, error: { code } });
    expect(JSON.stringify(result)).not.toContain("secret-detail");
  });

  it("times out a provider that never settles", async () => {
    await expect(
      acquire(() => new Promise(() => undefined), 5),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "timeout" },
    });
  });

  it("rejects invalid or unbounded timeout overrides", async () => {
    const result = bootstrapRuntime(
      hostWith(validConfig, () => new Promise(() => undefined)),
    );
    if (!result.ok) throw new Error("expected bootstrap success");
    await expect(
      result.value.acquireAccessToken({ timeoutMs: 30_001 }),
    ).resolves.toMatchObject({ ok: false, error: { code: "timeout" } });
  });

  it("honors both pre-abort and an abort while waiting", async () => {
    const controller = new AbortController();
    controller.abort();
    const bootstrap = bootstrapRuntime(hostWith(validConfig));
    if (!bootstrap.ok) throw new Error("expected bootstrap success");
    await expect(
      bootstrap.value.acquireAccessToken({ signal: controller.signal }),
    ).resolves.toMatchObject({ ok: false, error: { code: "aborted" } });

    const waiting = new AbortController();
    const pending = bootstrapRuntime(
      hostWith(validConfig, () => new Promise(() => undefined)),
    );
    if (!pending.ok) throw new Error("expected bootstrap success");
    const acquisition = pending.value.acquireAccessToken({
      signal: waiting.signal,
      timeoutMs: 100,
    });
    waiting.abort();
    await expect(acquisition).resolves.toMatchObject({
      ok: false,
      error: { code: "aborted" },
    });
  });
});
