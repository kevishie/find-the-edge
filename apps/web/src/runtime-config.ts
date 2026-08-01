const CONFIG_GLOBAL = "__FTE_RUNTIME_CONFIG__";
const PROVIDERS_GLOBAL = "__FTE_TOKEN_PROVIDERS__";
const PROVIDER_KEY = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
const MAX_TOKEN_LENGTH = 8192;
const DEFAULT_TOKEN_TIMEOUT_MS = 10_000;
const MAX_TOKEN_TIMEOUT_MS = 30_000;

export interface RuntimeConfig {
  schemaVersion: 1;
  apiBase: string;
  tokenProviderKey: string;
}

export type RuntimeConfigErrorCode =
  | "missing-config"
  | "invalid-config"
  | "invalid-api-base"
  | "invalid-provider-key"
  | "missing-provider";

export interface RuntimeConfigError {
  kind: "runtime-config-error";
  code: RuntimeConfigErrorCode;
  message: string;
}

export type TokenErrorCode =
  | "aborted"
  | "timeout"
  | "provider-rejected"
  | "empty-token"
  | "oversized-token";

export interface TokenError {
  kind: "token-error";
  code: TokenErrorCode;
  message: string;
}

export type Result<Value, Failure> =
  { ok: true; value: Value } | { ok: false; error: Failure };

export type AccessTokenProvider = () => unknown;

export interface RuntimeBootstrap {
  config: RuntimeConfig;
  acquireAccessToken: (
    options?: TokenAcquisitionOptions,
  ) => Promise<Result<string, TokenError>>;
}

export interface TokenAcquisitionOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface BootstrapOptions {
  mode?: "production" | "development" | "test";
  tokenTimeoutMs?: number;
}

function configError(
  code: RuntimeConfigErrorCode,
  message: string,
): Result<never, RuntimeConfigError> {
  return { ok: false, error: { kind: "runtime-config-error", code, message } };
}

function tokenError(
  code: TokenErrorCode,
  message: string,
): Result<never, TokenError> {
  return { ok: false, error: { kind: "token-error", code, message } };
}

function ownDataValue(
  source: object,
  key: PropertyKey,
): { found: boolean; value?: unknown } {
  const descriptor = Object.getOwnPropertyDescriptor(source, key);
  if (!descriptor || !("value" in descriptor)) return { found: false };
  return { found: true, value: descriptor.value };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const prototype: unknown = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function validateApiBase(
  value: unknown,
  mode: NonNullable<BootstrapOptions["mode"]>,
): string | undefined {
  const hasUnsafeWhitespace =
    typeof value === "string" &&
    Array.from(value).some((character) => {
      const code = character.charCodeAt(0);
      return code <= 0x20 || code === 0x7f;
    });
  if (typeof value !== "string" || value.length === 0 || hasUnsafeWhitespace)
    return undefined;
  try {
    const url = new URL(value);
    if (url.username || url.password || url.search || url.hash)
      return undefined;
    const localHttp =
      mode !== "production" &&
      url.protocol === "http:" &&
      (url.hostname === "localhost" || url.hostname === "127.0.0.1");
    if (url.protocol !== "https:" && !localHttp) return undefined;
    return url.toString().replace(/\/$/, "");
  } catch {
    return undefined;
  }
}

function parseConfig(
  value: unknown,
  mode: NonNullable<BootstrapOptions["mode"]>,
): Result<RuntimeConfig, RuntimeConfigError> {
  if (!isPlainRecord(value))
    return configError("invalid-config", "Runtime configuration is invalid.");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const expected = ["apiBase", "schemaVersion", "tokenProviderKey"];
  if (
    Reflect.ownKeys(descriptors).some((key) => typeof key !== "string") ||
    Object.keys(descriptors).sort().join("|") !== expected.join("|") ||
    Object.values(descriptors).some((descriptor) => !("value" in descriptor))
  )
    return configError("invalid-config", "Runtime configuration is invalid.");

  const schemaVersion = ownDataValue(value, "schemaVersion").value;
  if (schemaVersion !== 1)
    return configError("invalid-config", "Runtime configuration is invalid.");
  const apiBase = validateApiBase(ownDataValue(value, "apiBase").value, mode);
  if (!apiBase)
    return configError(
      "invalid-api-base",
      "The API address is not configured.",
    );
  const tokenProviderKey = ownDataValue(value, "tokenProviderKey").value;
  if (
    typeof tokenProviderKey !== "string" ||
    !PROVIDER_KEY.test(tokenProviderKey)
  )
    return configError(
      "invalid-provider-key",
      "The session provider is not configured.",
    );
  return {
    ok: true,
    value: { schemaVersion: 1, apiBase, tokenProviderKey },
  };
}

function resolveProvider(
  host: object,
  key: string,
): Result<AccessTokenProvider, RuntimeConfigError> {
  const registryValue = ownDataValue(host, PROVIDERS_GLOBAL);
  if (!registryValue.found || !isPlainRecord(registryValue.value))
    return configError(
      "missing-provider",
      "The session provider is unavailable.",
    );
  const provider = ownDataValue(registryValue.value, key);
  if (!provider.found || typeof provider.value !== "function")
    return configError(
      "missing-provider",
      "The session provider is unavailable.",
    );
  return { ok: true, value: provider.value as AccessTokenProvider };
}

async function acquireToken(
  provider: AccessTokenProvider,
  options: TokenAcquisitionOptions,
  defaultTimeoutMs: number,
): Promise<Result<string, TokenError>> {
  const timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > MAX_TOKEN_TIMEOUT_MS
  )
    return tokenError("timeout", "Session acquisition timed out.");
  if (options.signal?.aborted)
    return tokenError("aborted", "Session acquisition was cancelled.");

  let timer: ReturnType<typeof setTimeout> | undefined;
  let abortListener: (() => void) | undefined;
  const timeout = new Promise<Result<string, TokenError>>((resolve) => {
    timer = setTimeout(
      () => resolve(tokenError("timeout", "Session acquisition timed out.")),
      timeoutMs,
    );
  });
  const aborted = new Promise<Result<string, TokenError>>((resolve) => {
    if (!options.signal) return;
    abortListener = () =>
      resolve(tokenError("aborted", "Session acquisition was cancelled."));
    options.signal.addEventListener("abort", abortListener, { once: true });
  });
  const provided = Promise.resolve()
    .then(provider)
    .then((value): Result<string, TokenError> => {
      if (typeof value !== "string")
        return tokenError("provider-rejected", "Session acquisition failed.");
      const token = value.trim();
      if (token.length === 0)
        return tokenError("empty-token", "Session acquisition failed.");
      if (token.length > MAX_TOKEN_LENGTH)
        return tokenError("oversized-token", "Session acquisition failed.");
      return { ok: true, value: token };
    })
    .catch(() =>
      tokenError("provider-rejected", "Session acquisition failed."),
    );

  try {
    return await Promise.race([provided, timeout, aborted]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (abortListener && options.signal)
      options.signal.removeEventListener("abort", abortListener);
  }
}

export function bootstrapRuntime(
  host: object = window,
  options: BootstrapOptions = {},
): Result<RuntimeBootstrap, RuntimeConfigError> {
  try {
    const rawConfig = ownDataValue(host, CONFIG_GLOBAL);
    if (!rawConfig.found)
      return configError(
        "missing-config",
        "Runtime configuration has not been installed.",
      );
    const config = parseConfig(rawConfig.value, options.mode ?? "production");
    if (!config.ok) return config;
    const provider = resolveProvider(host, config.value.tokenProviderKey);
    if (!provider.ok) return provider;
    const defaultTimeoutMs = options.tokenTimeoutMs ?? DEFAULT_TOKEN_TIMEOUT_MS;
    return {
      ok: true,
      value: {
        config: config.value,
        acquireAccessToken: (tokenOptions = {}) =>
          acquireToken(provider.value, tokenOptions, defaultTimeoutMs),
      },
    };
  } catch {
    return configError("invalid-config", "Runtime configuration is invalid.");
  }
}
