const CONFIG_GLOBAL = "__FTE_RUNTIME_CONFIG__";
const PROVIDER_KEY = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;

export interface RuntimeConfig {
  schemaVersion: 1;
  apiBase: string;
  tokenProviderKey?: string;
  cognitoIssuer?: string;
  cognitoClientId?: string;
  cognitoDomain?: string;
  cognitoScope?: string;
  callbackUrl?: string;
  logoutUrl?: string;
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

export type Result<Value, Failure> =
  { ok: true; value: Value } | { ok: false; error: Failure };

export interface RuntimeBootstrap {
  config: RuntimeConfig;
}

export interface BootstrapOptions {
  mode?: "production" | "development" | "test";
}

function configError(
  code: RuntimeConfigErrorCode,
  message: string,
): Result<never, RuntimeConfigError> {
  return { ok: false, error: { kind: "runtime-config-error", code, message } };
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
  const legacy = ["apiBase", "schemaVersion", "tokenProviderKey"];
  const anonymous = ["apiBase", "schemaVersion"];
  const launch = [
    "apiBase",
    "callbackUrl",
    "cognitoClientId",
    "cognitoDomain",
    "cognitoIssuer",
    "cognitoScope",
    "logoutUrl",
    "schemaVersion",
    "tokenProviderKey",
  ];
  const actual = Object.keys(descriptors).sort();
  if (
    Reflect.ownKeys(descriptors).some((key) => typeof key !== "string") ||
    (actual.join("|") !== anonymous.join("|") &&
      actual.join("|") !== legacy.join("|") &&
      actual.join("|") !== launch.join("|")) ||
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
    tokenProviderKey !== undefined &&
    (typeof tokenProviderKey !== "string" ||
      !PROVIDER_KEY.test(tokenProviderKey))
  )
    return configError(
      "invalid-provider-key",
      "The session provider is not configured.",
    );
  const launchConfig =
    actual.length === launch.length
      ? Object.fromEntries(
          launch
            .filter((key) => !legacy.includes(key))
            .map((key) => [key, ownDataValue(value, key).value]),
        )
      : {};
  if (actual.length === launch.length) {
    for (const [key, item] of Object.entries(launchConfig)) {
      if (
        typeof item !== "string" ||
        item.length === 0 ||
        Array.from(item).some((character) => {
          const code = character.charCodeAt(0);
          return code <= 0x20 || code === 0x7f;
        })
      )
        return configError(
          "invalid-config",
          `Launch configuration ${key} is invalid.`,
        );
    }
    try {
      for (const key of [
        "cognitoIssuer",
        "cognitoDomain",
        "callbackUrl",
        "logoutUrl",
      ]) {
        const url = new URL(launchConfig[key] as string);
        if (url.protocol !== "https:" || url.username || url.password)
          throw new Error();
      }
      const domain = new URL(launchConfig["cognitoDomain"] as string);
      const callback = new URL(launchConfig["callbackUrl"] as string);
      const logout = new URL(launchConfig["logoutUrl"] as string);
      if (
        launchConfig["cognitoScope"] !== "events/events:read" ||
        domain.origin !== launchConfig["cognitoDomain"] ||
        domain.pathname !== "/" ||
        domain.search ||
        domain.hash ||
        logout.origin !== launchConfig["logoutUrl"] ||
        logout.pathname !== "/" ||
        logout.search ||
        logout.hash ||
        launchConfig["callbackUrl"] !==
          `${launchConfig["logoutUrl"]}/auth/callback` ||
        callback.origin !== logout.origin
      )
        throw new Error();
    } catch {
      return configError("invalid-config", "Launch configuration is invalid.");
    }
  }
  return {
    ok: true,
    value: {
      schemaVersion: 1,
      apiBase,
      ...(typeof tokenProviderKey === "string" ? { tokenProviderKey } : {}),
      ...launchConfig,
    },
  };
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
    return {
      ok: true,
      value: {
        config: config.value,
      },
    };
  } catch {
    return configError("invalid-config", "Runtime configuration is invalid.");
  }
}
