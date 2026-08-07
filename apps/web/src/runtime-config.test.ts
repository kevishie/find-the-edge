import { describe, expect, it, vi } from "vitest";

import { bootstrapRuntime } from "./runtime-config";

const validConfig = {
  schemaVersion: 1,
  apiBase: "https://api.example.com/",
};

const validLaunchConfig = {
  ...validConfig,
  tokenProviderKey: "cognitoSession",
  cognitoIssuer: "https://cognito-idp.us-east-1.amazonaws.com/pool",
  cognitoClientId: "client",
  cognitoDomain: "https://domain.auth.us-east-1.amazoncognito.com",
  cognitoScopes: [
    "events/events:read",
    "events/scouting:read",
    "events/scouting:write",
  ],
  callbackUrl: "https://app.example.com/auth/callback",
  logoutUrl: "https://app.example.com",
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

  it("accepts only the exact ordered scouting scope set", () => {
    expect(
      bootstrapRuntime({ __FTE_RUNTIME_CONFIG__: validLaunchConfig }),
    ).toEqual({
      ok: true,
      value: {
        config: {
          ...validLaunchConfig,
          apiBase: "https://api.example.com",
          cognitoScopes: [
            "events/events:read",
            "events/scouting:read",
            "events/scouting:write",
          ],
        },
      },
    });

    for (const cognitoScopes of [
      ["events/events:read"],
      ["events/events:read", "events/scouting:write", "events/scouting:read"],
      [
        "events/events:read",
        "events/scouting:read",
        "events/scouting:write",
        "events/extra",
      ],
      "events/events:read events/scouting:read events/scouting:write",
    ])
      expect(
        bootstrapRuntime({
          __FTE_RUNTIME_CONFIG__: { ...validLaunchConfig, cognitoScopes },
        }),
      ).toMatchObject({ ok: false, error: { code: "invalid-config" } });
  });

  it("rejects accessor-backed scope entries without invoking them", () => {
    const getter = vi.fn(() => "events/events:read");
    const scopes = [
      "events/events:read",
      "events/scouting:read",
      "events/scouting:write",
    ];
    Object.defineProperty(scopes, "0", { get: getter });
    expect(
      bootstrapRuntime({
        __FTE_RUNTIME_CONFIG__: {
          ...validLaunchConfig,
          cognitoScopes: scopes,
        },
      }),
    ).toMatchObject({ ok: false, error: { code: "invalid-config" } });
    expect(getter).not.toHaveBeenCalled();
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
