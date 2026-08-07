import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const cognitoScopes = [
  "events/events:read",
  "events/scouting:read",
  "events/scouting:write",
];

test("Cognito provider refuses a non-exact configured scope set", async () => {
  const source = await readFile(
    new URL("../apps/web/public/cognito-token-provider.js", import.meta.url),
    "utf8",
  );
  for (const configuredScopes of [
    ["events/events:read"],
    ["events/events:read", "events/scouting:write", "events/scouting:read"],
    [...cognitoScopes, "events/extra"],
  ]) {
    const window = {
      __FTE_RUNTIME_CONFIG__: {
        tokenProviderKey: "cognitoSession",
        cognitoScopes: configuredScopes,
      },
    };
    vm.runInContext(source, vm.createContext({ window }));
    assert.equal(window.__FTE_TOKEN_PROVIDERS__, undefined);
  }
});

test("Cognito provider installs PKCE authorization-code login without fallback", async () => {
  const values = new Map();
  const assignments = [];
  const window = {
    __FTE_RUNTIME_CONFIG__: {
      schemaVersion: 1,
      apiBase: "https://api.example.com",
      tokenProviderKey: "cognitoSession",
      cognitoIssuer: "https://cognito-idp.us-east-1.amazonaws.com/pool",
      cognitoClientId: "client",
      cognitoDomain: "https://domain.auth.us-east-1.amazoncognito.com",
      cognitoScopes,
      callbackUrl: "https://app.example.com/auth/callback",
      logoutUrl: "https://app.example.com",
    },
  };
  const context = vm.createContext({
    window,
    crypto: webcrypto,
    AbortController,
    setTimeout,
    clearTimeout,
    TextEncoder,
    URL,
    URLSearchParams,
    btoa: (value) => Buffer.from(value, "binary").toString("base64"),
    atob: (value) => Buffer.from(value, "base64").toString("binary"),
    fetch: () => {
      throw new Error("unexpected token request");
    },
    sessionStorage: {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value),
      removeItem: (key) => values.delete(key),
    },
    location: {
      origin: "https://app.example.com",
      pathname: "/games",
      search: "",
      assign: (value) => {
        assignments.push(value);
      },
    },
    history: { replaceState() {} },
  });
  vm.runInContext(
    await readFile(
      new URL("../apps/web/public/cognito-token-provider.js", import.meta.url),
      "utf8",
    ),
    context,
  );
  assert.equal(
    typeof window.__FTE_TOKEN_PROVIDERS__.cognitoSession,
    "function",
  );
  assert.equal(typeof window.__FTE_LOGOUT__, "function");
  assert.equal(assignments.length, 0);
  const incompletePayload = Buffer.from(
    JSON.stringify({
      client_id: "client",
      iss: "https://cognito-idp.us-east-1.amazonaws.com/pool",
      token_use: "access",
      exp: Math.floor(Date.now() / 1000) + 300,
      scope: "events/events:read events/scouting:read",
    }),
  ).toString("base64url");
  values.set(
    "fte.oauth.session",
    JSON.stringify({ accessToken: `a.${incompletePayload}.b` }),
  );
  void window.__FTE_TOKEN_PROVIDERS__.cognitoSession();
  void window.__FTE_TOKEN_PROVIDERS__.cognitoSession();
  for (let index = 0; index < 10 && assignments.length === 0; index += 1)
    await new Promise((resolve) => setImmediate(resolve));
  assert.equal(assignments.length, 1);
  const authorize = new URL(assignments[0]);
  assert.equal(authorize.pathname, "/oauth2/authorize");
  assert.equal(authorize.searchParams.get("response_type"), "code");
  assert.equal(authorize.searchParams.get("code_challenge_method"), "S256");
  assert.match(
    authorize.searchParams.get("code_challenge"),
    /^[A-Za-z0-9_-]{43}$/,
  );
  assert.equal(values.has("fte.oauth.verifier"), true);
  assert.equal(values.get("fte.oauth.return-to"), "/games");
  assert.equal(
    authorize.searchParams.get("state"),
    values.get("fte.oauth.state"),
  );
  const verifier = values.get("fte.oauth.verifier");
  const digest = await webcrypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  const expectedChallenge = Buffer.from(digest).toString("base64url");
  assert.equal(authorize.searchParams.get("code_challenge"), expectedChallenge);
  assert.equal("localStorage" in context, false);
  assert.equal(authorize.searchParams.get("scope"), cognitoScopes.join(" "));
  const source = await readFile(
    new URL("../apps/web/public/cognito-token-provider.js", import.meta.url),
    "utf8",
  );
  assert.match(source, /token_use === "access"/);
  assert.match(source, /const cognitoScopes = Object\.freeze/);
  assert.match(source, /cognitoScopes\.every/);
  assert.match(source, /payload\?\.client_id === config\.cognitoClientId/);
  assert.match(source, /setTimeout\(\(\) => controller\.abort\(\), 10_000\)/);
  assert.match(source, /clearTimeout\(timeout\)/);
});

test("Cognito callback rejects malformed refresh tokens before storage", async () => {
  const source = await readFile(
    new URL("../apps/web/public/cognito-token-provider.js", import.meta.url),
    "utf8",
  );
  for (const refreshToken of ["", "   ", "x".repeat(8193), 42]) {
    const values = new Map([
      ["fte.oauth.state", "expected"],
      ["fte.oauth.verifier", "verifier"],
      ["fte.oauth.return-to", "/games/fixture?tab=odds"],
    ]);
    const payload = Buffer.from(
      JSON.stringify({
        client_id: "client",
        iss: "https://cognito-idp.us-east-1.amazonaws.com/pool",
        token_use: "access",
        exp: Math.floor(Date.now() / 1000) + 300,
        scope: cognitoScopes.join(" "),
      }),
    ).toString("base64url");
    const window = {
      __FTE_RUNTIME_CONFIG__: {
        tokenProviderKey: "cognitoSession",
        cognitoIssuer: "https://cognito-idp.us-east-1.amazonaws.com/pool",
        cognitoClientId: "client",
        cognitoDomain: "https://domain.auth.us-east-1.amazoncognito.com",
        cognitoScopes,
        callbackUrl: "https://app.example.com/auth/callback",
        logoutUrl: "https://app.example.com",
      },
    };
    vm.runInContext(
      source,
      vm.createContext({
        window,
        crypto: webcrypto,
        AbortController,
        setTimeout,
        clearTimeout,
        TextEncoder,
        URL,
        URLSearchParams,
        btoa: (value) => Buffer.from(value, "binary").toString("base64"),
        atob: (value) => Buffer.from(value, "base64").toString("binary"),
        fetch: async () => ({
          ok: true,
          json: async () => ({
            access_token: `a.${payload}.b`,
            refresh_token: refreshToken,
          }),
        }),
        sessionStorage: {
          getItem: (key) => values.get(key) ?? null,
          setItem: (key, value) => values.set(key, value),
          removeItem: (key) => values.delete(key),
        },
        location: {
          origin: "https://app.example.com",
          pathname: "/auth/callback",
          search: "?code=code&state=expected",
          assign() {},
        },
        history: {
          replaceState(_state, _title, path) {
            assert.equal(path, "/games/fixture?tab=odds");
          },
        },
      }),
    );
    await assert.rejects(
      window.__FTE_TOKEN_PROVIDERS__.cognitoSession(),
      /Authentication failed/,
    );
    assert.equal(values.has("fte.oauth.session"), false);
    assert.equal(values.has("fte.oauth.state"), false);
  }
});

test("Cognito callback failure rejects once, then allows explicit login recovery", async () => {
  const source = await readFile(
    new URL("../apps/web/public/cognito-token-provider.js", import.meta.url),
    "utf8",
  );
  for (const scenario of [
    "provider-denied",
    "state-mismatch",
    "exchange-failure",
  ]) {
    const values = new Map([
      ["fte.oauth.state", "expected"],
      ["fte.oauth.verifier", "verifier"],
    ]);
    const assignments = [];
    let fetches = 0;
    const window = {
      __FTE_RUNTIME_CONFIG__: {
        tokenProviderKey: "cognitoSession",
        cognitoIssuer: "https://cognito-idp.us-east-1.amazonaws.com/pool",
        cognitoClientId: "client",
        cognitoDomain: "https://domain.auth.us-east-1.amazoncognito.com",
        cognitoScopes,
        callbackUrl: "https://app.example.com/auth/callback",
        logoutUrl: "https://app.example.com",
      },
    };
    vm.runInContext(
      source,
      vm.createContext({
        window,
        crypto: webcrypto,
        AbortController,
        setTimeout,
        clearTimeout,
        TextEncoder,
        URL,
        URLSearchParams,
        btoa: (value) => Buffer.from(value, "binary").toString("base64"),
        atob: (value) => Buffer.from(value, "base64").toString("binary"),
        fetch: async () => {
          fetches += 1;
          return { ok: false, json: async () => ({}) };
        },
        sessionStorage: {
          getItem: (key) => values.get(key) ?? null,
          setItem: (key, value) => values.set(key, value),
          removeItem: (key) => values.delete(key),
        },
        location: {
          origin: "https://app.example.com",
          pathname: "/auth/callback",
          search:
            scenario === "provider-denied"
              ? "?error=access_denied&state=expected"
              : scenario === "state-mismatch"
                ? "?code=code&state=wrong"
                : "?code=code&state=expected",
          assign: (value) => assignments.push(value),
        },
        history: { replaceState() {} },
      }),
    );
    await assert.rejects(
      window.__FTE_TOKEN_PROVIDERS__.cognitoSession(),
      /Authentication failed/,
    );
    assert.equal(fetches, scenario === "exchange-failure" ? 1 : 0);
    assert.deepEqual(assignments, []);
    assert.equal(values.has("fte.oauth.session"), false);
    void window.__FTE_TOKEN_PROVIDERS__.cognitoSession();
    for (let index = 0; index < 10 && assignments.length === 0; index += 1)
      await new Promise((resolve) => setImmediate(resolve));
    assert.equal(assignments.length, 1);
    assert.match(assignments[0], /\/oauth2\/authorize\?/);
  }
});

test("401 invalidation clears the cached session without redirecting", async () => {
  const payload = Buffer.from(
    JSON.stringify({
      client_id: "client",
      iss: "https://cognito-idp.us-east-1.amazonaws.com/pool",
      token_use: "access",
      exp: Math.floor(Date.now() / 1000) + 300,
      scope: cognitoScopes.join(" "),
    }),
  ).toString("base64url");
  const token = `a.${payload}.b`;
  const values = new Map([
    ["fte.oauth.session", JSON.stringify({ accessToken: token })],
  ]);
  const assignments = [];
  const window = {
    __FTE_RUNTIME_CONFIG__: {
      tokenProviderKey: "cognitoSession",
      cognitoIssuer: "https://cognito-idp.us-east-1.amazonaws.com/pool",
      cognitoClientId: "client",
      cognitoDomain: "https://domain.auth.us-east-1.amazoncognito.com",
      cognitoScopes,
      callbackUrl: "https://app.example.com/auth/callback",
      logoutUrl: "https://app.example.com",
    },
  };
  vm.runInContext(
    await readFile(
      new URL("../apps/web/public/cognito-token-provider.js", import.meta.url),
      "utf8",
    ),
    vm.createContext({
      window,
      crypto: webcrypto,
      AbortController,
      setTimeout,
      clearTimeout,
      TextEncoder,
      URL,
      URLSearchParams,
      btoa: (value) => Buffer.from(value, "binary").toString("base64"),
      atob: (value) => Buffer.from(value, "base64").toString("binary"),
      fetch: () => {
        throw new Error("unexpected exchange");
      },
      sessionStorage: {
        getItem: (key) => values.get(key) ?? null,
        setItem: (key, value) => values.set(key, value),
        removeItem: (key) => values.delete(key),
      },
      location: {
        origin: "https://app.example.com",
        pathname: "/games",
        search: "",
        assign: (value) => assignments.push(value),
      },
      history: { replaceState() {} },
    }),
  );
  assert.equal(await window.__FTE_TOKEN_PROVIDERS__.cognitoSession(), token);
  assert.equal(
    typeof window.__FTE_TOKEN_INVALIDATORS__.cognitoSession,
    "function",
  );
  assert.equal(Object.isFrozen(window.__FTE_TOKEN_INVALIDATORS__), true);
  window.__FTE_TOKEN_INVALIDATORS__.cognitoSession();
  assert.equal(values.has("fte.oauth.session"), false);
  assert.deepEqual(assignments, []);
  void window.__FTE_TOKEN_PROVIDERS__.cognitoSession();
  for (let index = 0; index < 10 && assignments.length === 0; index += 1)
    await new Promise((resolve) => setImmediate(resolve));
  assert.equal(assignments.length, 1);
  assert.match(assignments[0], /\/oauth2\/authorize\?/);
});

test("refresh is single-flight and logout blocks late credential writes", async () => {
  const config = {
    tokenProviderKey: "cognitoSession",
    cognitoIssuer: "https://cognito-idp.us-east-1.amazonaws.com/pool",
    cognitoClientId: "client",
    cognitoDomain: "https://domain.auth.us-east-1.amazoncognito.com",
    cognitoScopes,
    callbackUrl: "https://app.example.com/auth/callback",
    logoutUrl: "https://app.example.com",
  };
  const token = (exp) => {
    const payload = Buffer.from(
      JSON.stringify({
        client_id: config.cognitoClientId,
        iss: config.cognitoIssuer,
        token_use: "access",
        exp,
        scope: config.cognitoScopes.join(" "),
      }),
    ).toString("base64url");
    return `a.${payload}.b`;
  };
  const expired = token(1);
  const fresh = token(Math.floor(Date.now() / 1000) + 300);
  const values = new Map([
    [
      "fte.oauth.session",
      JSON.stringify({ accessToken: expired, refreshToken: "real-refresh" }),
    ],
  ]);
  const pending = [];
  let fetches = 0;
  let sessionWrites = 0;
  let assigned;
  const window = { __FTE_RUNTIME_CONFIG__: config };
  vm.runInContext(
    await readFile(
      new URL("../apps/web/public/cognito-token-provider.js", import.meta.url),
      "utf8",
    ),
    vm.createContext({
      window,
      crypto: webcrypto,
      AbortController,
      setTimeout,
      clearTimeout,
      TextEncoder,
      URL,
      URLSearchParams,
      btoa: (value) => Buffer.from(value, "binary").toString("base64"),
      atob: (value) => Buffer.from(value, "base64").toString("binary"),
      fetch: () => {
        fetches += 1;
        return new Promise((resolve) => pending.push(resolve));
      },
      sessionStorage: {
        getItem: (key) => values.get(key) ?? null,
        setItem: (key, value) => {
          if (key === "fte.oauth.session") sessionWrites += 1;
          values.set(key, value);
        },
        removeItem: (key) => values.delete(key),
      },
      location: {
        origin: "https://app.example.com",
        pathname: "/games",
        search: "",
        assign: (value) => {
          assigned = value;
        },
      },
      history: { replaceState() {} },
    }),
  );
  const first = window.__FTE_TOKEN_PROVIDERS__.cognitoSession();
  const second = window.__FTE_TOKEN_PROVIDERS__.cognitoSession();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fetches, 1);
  pending.shift()({ ok: true, json: async () => ({ access_token: fresh }) });
  assert.deepEqual(await Promise.all([first, second]), [fresh, fresh]);
  assert.equal(sessionWrites, 1);

  values.set(
    "fte.oauth.session",
    JSON.stringify({ accessToken: expired, refreshToken: "real-refresh" }),
  );
  const late = window.__FTE_TOKEN_PROVIDERS__.cognitoSession();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fetches, 2);
  window.__FTE_LOGOUT__();
  pending.shift()({ ok: true, json: async () => ({ access_token: fresh }) });
  await assert.rejects(late, /Authentication failed/);
  await assert.rejects(
    window.__FTE_TOKEN_PROVIDERS__.cognitoSession(),
    /Authentication failed/,
  );
  assert.equal(values.has("fte.oauth.session"), false);
  assert.equal(sessionWrites, 1);
  assert.match(assigned, /\/logout\?/);
});

test("logout blocks a late authorization-code exchange from saving credentials", async () => {
  const values = new Map([
    ["fte.oauth.state", "expected"],
    ["fte.oauth.verifier", "verifier"],
  ]);
  let complete;
  let sessionWrites = 0;
  const config = {
    tokenProviderKey: "cognitoSession",
    cognitoIssuer: "https://cognito-idp.us-east-1.amazonaws.com/pool",
    cognitoClientId: "client",
    cognitoDomain: "https://domain.auth.us-east-1.amazoncognito.com",
    cognitoScopes,
    callbackUrl: "https://app.example.com/auth/callback",
    logoutUrl: "https://app.example.com",
  };
  const payload = Buffer.from(
    JSON.stringify({
      client_id: config.cognitoClientId,
      iss: config.cognitoIssuer,
      token_use: "access",
      exp: Math.floor(Date.now() / 1000) + 300,
      scope: config.cognitoScopes.join(" "),
    }),
  ).toString("base64url");
  const window = { __FTE_RUNTIME_CONFIG__: config };
  vm.runInContext(
    await readFile(
      new URL("../apps/web/public/cognito-token-provider.js", import.meta.url),
      "utf8",
    ),
    vm.createContext({
      window,
      crypto: webcrypto,
      AbortController,
      setTimeout,
      clearTimeout,
      TextEncoder,
      URL,
      URLSearchParams,
      btoa: (value) => Buffer.from(value, "binary").toString("base64"),
      atob: (value) => Buffer.from(value, "base64").toString("binary"),
      fetch: () => new Promise((resolve) => (complete = resolve)),
      sessionStorage: {
        getItem: (key) => values.get(key) ?? null,
        setItem: (key, value) => {
          if (key === "fte.oauth.session") sessionWrites += 1;
          values.set(key, value);
        },
        removeItem: (key) => values.delete(key),
      },
      location: {
        origin: "https://app.example.com",
        pathname: "/auth/callback",
        search: "?code=code&state=expected",
        assign() {},
      },
      history: { replaceState() {} },
    }),
  );
  await new Promise((resolve) => setImmediate(resolve));
  window.__FTE_LOGOUT__();
  complete({
    ok: true,
    json: async () => ({
      access_token: `a.${payload}.b`,
      refresh_token: "refresh",
    }),
  });
  await assert.rejects(
    window.__FTE_TOKEN_PROVIDERS__.cognitoSession(),
    /Authentication failed/,
  );
  assert.equal(sessionWrites, 0);
  assert.equal(values.has("fte.oauth.session"), false);
});

test("logout during PKCE digest prevents state storage and authorization redirect", async () => {
  const values = new Map();
  const assignments = [];
  let finishDigest;
  const crypto = {
    getRandomValues: (bytes) => webcrypto.getRandomValues(bytes),
    subtle: {
      digest: () => new Promise((resolve) => (finishDigest = resolve)),
    },
  };
  const window = {
    __FTE_RUNTIME_CONFIG__: {
      tokenProviderKey: "cognitoSession",
      cognitoIssuer: "https://cognito-idp.us-east-1.amazonaws.com/pool",
      cognitoClientId: "client",
      cognitoDomain: "https://domain.auth.us-east-1.amazoncognito.com",
      cognitoScopes,
      callbackUrl: "https://app.example.com/auth/callback",
      logoutUrl: "https://app.example.com",
    },
  };
  vm.runInContext(
    await readFile(
      new URL("../apps/web/public/cognito-token-provider.js", import.meta.url),
      "utf8",
    ),
    vm.createContext({
      window,
      crypto,
      AbortController,
      setTimeout,
      clearTimeout,
      TextEncoder,
      URL,
      URLSearchParams,
      btoa: (value) => Buffer.from(value, "binary").toString("base64"),
      atob: (value) => Buffer.from(value, "base64").toString("binary"),
      fetch: () => {
        throw new Error("unexpected exchange");
      },
      sessionStorage: {
        getItem: (key) => values.get(key) ?? null,
        setItem: (key, value) => values.set(key, value),
        removeItem: (key) => values.delete(key),
      },
      location: {
        origin: "https://app.example.com",
        pathname: "/games",
        search: "",
        assign: (value) => assignments.push(value),
      },
      history: { replaceState() {} },
    }),
  );
  const acquisition = window.__FTE_TOKEN_PROVIDERS__.cognitoSession();
  await new Promise((resolve) => setImmediate(resolve));
  window.__FTE_LOGOUT__();
  finishDigest(new Uint8Array(32).buffer);
  await assert.rejects(acquisition, /Authentication failed/);
  assert.equal(values.has("fte.oauth.state"), false);
  assert.equal(values.has("fte.oauth.verifier"), false);
  assert.equal(assignments.length, 1);
  assert.match(assignments[0], /\/logout\?/);
});

test("failed login initiation clears single-flight state for a fresh retry", async () => {
  const values = new Map();
  const assignments = [];
  let digests = 0;
  const window = {
    __FTE_RUNTIME_CONFIG__: {
      tokenProviderKey: "cognitoSession",
      cognitoIssuer: "https://issuer.example.com",
      cognitoClientId: "client",
      cognitoDomain: "https://domain.auth.us-east-1.amazoncognito.com",
      cognitoScopes,
      callbackUrl: "https://app.example.com/auth/callback",
      logoutUrl: "https://app.example.com",
    },
  };
  vm.runInContext(
    await readFile(
      new URL("../apps/web/public/cognito-token-provider.js", import.meta.url),
      "utf8",
    ),
    vm.createContext({
      window,
      crypto: {
        getRandomValues: (bytes) => webcrypto.getRandomValues(bytes),
        subtle: {
          digest: async () => {
            digests += 1;
            if (digests === 1) throw new Error("raw digest failure");
            return new Uint8Array(32).buffer;
          },
        },
      },
      AbortController,
      setTimeout,
      clearTimeout,
      TextEncoder,
      URL,
      URLSearchParams,
      btoa: (value) => Buffer.from(value, "binary").toString("base64"),
      atob: (value) => Buffer.from(value, "base64").toString("binary"),
      fetch: () => {
        throw new Error("unexpected exchange");
      },
      sessionStorage: {
        getItem: (key) => values.get(key) ?? null,
        setItem: (key, value) => values.set(key, value),
        removeItem: (key) => values.delete(key),
      },
      location: {
        origin: "https://app.example.com",
        pathname: "/games",
        search: "",
        assign: (value) => assignments.push(value),
      },
      history: { replaceState() {} },
    }),
  );
  await assert.rejects(
    window.__FTE_TOKEN_PROVIDERS__.cognitoSession(),
    /Authentication failed/,
  );
  void window.__FTE_TOKEN_PROVIDERS__.cognitoSession();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(digests, 2);
  assert.equal(assignments.length, 1);
  assert.match(assignments[0], /\/oauth2\/authorize\?/);
});
