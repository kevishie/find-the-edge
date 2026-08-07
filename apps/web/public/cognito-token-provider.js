(function installCognitoProvider() {
  "use strict";
  const config = window.__FTE_RUNTIME_CONFIG__;
  const cognitoScopes = Object.freeze([
    "events/events:read",
    "events/scouting:read",
    "events/scouting:write",
  ]);
  if (
    !config ||
    config.tokenProviderKey !== "cognitoSession" ||
    !Array.isArray(config.cognitoScopes) ||
    config.cognitoScopes.length !== cognitoScopes.length ||
    !cognitoScopes.every(
      (scope, index) => config.cognitoScopes[index] === scope,
    )
  )
    return;
  const keys = Object.freeze({
    verifier: "fte.oauth.verifier",
    state: "fte.oauth.state",
    session: "fte.oauth.session",
    returnTo: "fte.oauth.return-to",
  });
  const encoder = new TextEncoder();
  const base64url = (bytes) =>
    btoa(String.fromCharCode(...bytes))
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replace(/=+$/, "");
  const random = () => {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    return base64url(bytes);
  };
  const safeJson = (value) => {
    try {
      return JSON.parse(value);
    } catch {
      return undefined;
    }
  };
  const decodePayload = (token) => {
    try {
      const parts = token.split(".");
      if (parts.length !== 3 || !/^[A-Za-z0-9_-]+$/.test(parts[1]))
        return undefined;
      return safeJson(
        atob(
          parts[1]
            .replaceAll("-", "+")
            .replaceAll("_", "/")
            .padEnd(Math.ceil(parts[1].length / 4) * 4, "="),
        ),
      );
    } catch {
      return undefined;
    }
  };
  const validAccessToken = (token) => {
    if (typeof token !== "string" || token.length === 0 || token.length > 8192)
      return false;
    const payload = decodePayload(token);
    const scopes =
      typeof payload?.scope === "string" ? payload.scope.split(" ") : [];
    return (
      payload?.client_id === config.cognitoClientId &&
      payload?.iss === config.cognitoIssuer &&
      payload?.token_use === "access" &&
      Number(payload?.exp) > Date.now() / 1000 + 30 &&
      cognitoScopes.every((scope) => scopes.includes(scope))
    );
  };
  const tokenEndpoint = `${config.cognitoDomain.replace(/\/$/, "")}/oauth2/token`;
  let sessionEpoch = 0;
  let logoutPending = false;
  let callbackFailurePending = false;
  let refreshPromise;
  const activeExchanges = new Set();
  async function exchange(parameters) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    activeExchanges.add(controller);
    try {
      const response = await fetch(tokenEndpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(parameters),
        credentials: "omit",
        cache: "no-store",
        signal: controller.signal,
      });
      if (!response.ok) throw new Error("Authentication failed.");
      const result = await response.json();
      if (!validAccessToken(result.access_token))
        throw new Error("Authentication failed.");
      return result;
    } catch {
      throw new Error("Authentication failed.");
    } finally {
      clearTimeout(timeout);
      activeExchanges.delete(controller);
    }
  }
  function saveSession(result, priorRefreshToken, expectedEpoch) {
    if (expectedEpoch !== sessionEpoch)
      throw new Error("Authentication failed.");
    const suppliedRefreshToken = result.refresh_token;
    if (
      suppliedRefreshToken !== undefined &&
      (typeof suppliedRefreshToken !== "string" ||
        suppliedRefreshToken.trim().length === 0 ||
        suppliedRefreshToken.length > 8192)
    )
      throw new Error("Authentication failed.");
    const refreshToken = suppliedRefreshToken ?? priorRefreshToken;
    if (
      refreshToken !== undefined &&
      (typeof refreshToken !== "string" ||
        refreshToken.trim().length === 0 ||
        refreshToken.length > 8192)
    )
      throw new Error("Authentication failed.");
    sessionStorage.setItem(
      keys.session,
      JSON.stringify({
        accessToken: result.access_token,
        idToken:
          typeof result.id_token === "string" && result.id_token.length <= 8192
            ? result.id_token
            : undefined,
        ...(refreshToken ? { refreshToken } : {}),
      }),
    );
  }
  async function beginLogin() {
    const expectedEpoch = sessionEpoch;
    const verifier = random();
    const state = random();
    const challenge = base64url(
      new Uint8Array(
        await crypto.subtle.digest("SHA-256", encoder.encode(verifier)),
      ),
    );
    if (expectedEpoch !== sessionEpoch)
      throw new Error("Authentication failed.");
    sessionStorage.setItem(keys.verifier, verifier);
    sessionStorage.setItem(keys.state, state);
    const authorize = new URL(
      `${config.cognitoDomain.replace(/\/$/, "")}/oauth2/authorize`,
    );
    authorize.search = new URLSearchParams({
      response_type: "code",
      client_id: config.cognitoClientId,
      redirect_uri: config.callbackUrl,
      scope: cognitoScopes.join(" "),
      state,
      code_challenge_method: "S256",
      code_challenge: challenge,
    }).toString();
    if (expectedEpoch !== sessionEpoch) {
      sessionStorage.removeItem(keys.verifier);
      sessionStorage.removeItem(keys.state);
      throw new Error("Authentication failed.");
    }
    const returnTo = `${location.pathname}${typeof location.search === "string" ? location.search : ""}${typeof location.hash === "string" ? location.hash : ""}`;
    if (
      returnTo.startsWith("/") &&
      !returnTo.startsWith("//") &&
      !returnTo.startsWith("/auth/callback") &&
      returnTo.length <= 2_048
    )
      sessionStorage.setItem(keys.returnTo, returnTo);
    location.assign(authorize.toString());
    return new Promise(() => {});
  }
  let loginPromise;
  function beginLoginSingleFlight() {
    if (logoutPending)
      return Promise.reject(new Error("Authentication failed."));
    if (!loginPromise)
      loginPromise = beginLogin().catch((error) => {
        void error;
        loginPromise = undefined;
        throw new Error("Authentication failed.");
      });
    return loginPromise;
  }
  async function handleCallback() {
    if (location.origin + location.pathname !== config.callbackUrl) return;
    const query = new URLSearchParams(location.search);
    const code = query.get("code");
    const state = query.get("state");
    const expectedState = sessionStorage.getItem(keys.state);
    const verifier = sessionStorage.getItem(keys.verifier);
    const returnTo = sessionStorage.getItem(keys.returnTo);
    sessionStorage.removeItem(keys.state);
    sessionStorage.removeItem(keys.verifier);
    sessionStorage.removeItem(keys.returnTo);
    history.replaceState(
      null,
      "",
      returnTo &&
        returnTo.startsWith("/") &&
        !returnTo.startsWith("//") &&
        !returnTo.startsWith("/auth/callback") &&
        returnTo.length <= 2_048
        ? returnTo
        : "/games",
    );
    if (!code || !state || state !== expectedState || !verifier)
      throw new Error("Authentication failed.");
    const expectedEpoch = sessionEpoch;
    const result = await exchange({
      grant_type: "authorization_code",
      client_id: config.cognitoClientId,
      code,
      code_verifier: verifier,
      redirect_uri: config.callbackUrl,
    });
    saveSession(result, undefined, expectedEpoch);
  }
  function refreshSession(session) {
    if (refreshPromise) return refreshPromise;
    const expectedEpoch = sessionEpoch;
    const attempt = exchange({
      grant_type: "refresh_token",
      client_id: config.cognitoClientId,
      refresh_token: session.refreshToken,
    }).then((result) => {
      saveSession(result, session.refreshToken, expectedEpoch);
      return result.access_token;
    });
    const tracked = attempt.finally(() => {
      if (refreshPromise === tracked) refreshPromise = undefined;
    });
    refreshPromise = tracked;
    return refreshPromise;
  }
  async function acquire() {
    await callbackPromise;
    if (logoutPending) throw new Error("Authentication failed.");
    if (callbackFailurePending) {
      callbackFailurePending = false;
      throw new Error("Authentication failed.");
    }
    const session = safeJson(sessionStorage.getItem(keys.session));
    if (validAccessToken(session?.accessToken)) return session.accessToken;
    if (
      typeof session?.refreshToken === "string" &&
      session.refreshToken.length <= 8192
    ) {
      const expectedEpoch = sessionEpoch;
      try {
        return await refreshSession(session);
      } catch {
        sessionStorage.removeItem(keys.session);
        if (expectedEpoch !== sessionEpoch)
          throw new Error("Authentication failed.");
      }
    }
    return beginLoginSingleFlight();
  }
  function invalidate() {
    sessionEpoch += 1;
    for (const controller of activeExchanges) controller.abort();
    refreshPromise = undefined;
    loginPromise = undefined;
    sessionStorage.removeItem(keys.session);
  }
  function logout() {
    logoutPending = true;
    invalidate();
    sessionStorage.removeItem(keys.state);
    sessionStorage.removeItem(keys.verifier);
    const target = new URL(`${config.cognitoDomain.replace(/\/$/, "")}/logout`);
    target.search = new URLSearchParams({
      client_id: config.cognitoClientId,
      logout_uri: config.logoutUrl,
    }).toString();
    location.assign(target.toString());
  }
  const callbackPromise = handleCallback().catch(() => {
    sessionStorage.removeItem(keys.session);
    callbackFailurePending = true;
  });
  const registry = Object.freeze({
    ...(window.__FTE_TOKEN_PROVIDERS__ || {}),
    [config.tokenProviderKey]: acquire,
  });
  Object.defineProperty(window, "__FTE_TOKEN_PROVIDERS__", {
    value: registry,
    configurable: false,
    writable: false,
  });
  const invalidators = Object.freeze({
    ...(window.__FTE_TOKEN_INVALIDATORS__ || {}),
    [config.tokenProviderKey]: invalidate,
  });
  Object.defineProperty(window, "__FTE_TOKEN_INVALIDATORS__", {
    value: invalidators,
    configurable: false,
    writable: false,
  });
  Object.defineProperty(window, "__FTE_LOGOUT__", {
    value: logout,
    configurable: false,
    writable: false,
  });
})();
