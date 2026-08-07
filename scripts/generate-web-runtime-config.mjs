import { open, rename, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";

export const COGNITO_SCOPES = Object.freeze([
  "events/events:read",
  "events/scouting:read",
  "events/scouting:write",
]);

const PROVIDER_KEY = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;

function parseArguments(arguments_) {
  const values = new Map();
  for (let index = 0; index < arguments_.length; index += 2) {
    const key = arguments_[index];
    const value = arguments_[index + 1];
    if (!key?.startsWith("--") || value === undefined || values.has(key))
      throw new Error("Expected unique runtime configuration arguments.");
    values.set(key, value);
  }
  const expected = [
    "--api-base",
    "--callback-url",
    "--cognito-client-id",
    "--cognito-domain",
    "--cognito-issuer",
    "--logout-url",
    "--output",
    "--provider-key",
  ];
  if (
    values.size !== expected.length ||
    expected.some((key) => !values.has(key))
  )
    throw new Error("Expected unique runtime configuration arguments.");
  return {
    apiBase: values.get("--api-base"),
    callbackUrl: values.get("--callback-url"),
    cognitoClientId: values.get("--cognito-client-id"),
    cognitoDomain: values.get("--cognito-domain"),
    cognitoIssuer: values.get("--cognito-issuer"),
    logoutUrl: values.get("--logout-url"),
    output: values.get("--output"),
    tokenProviderKey: values.get("--provider-key"),
  };
}

function validateApiBase(value, localMode = false) {
  if (!value || /[\u0000-\u0020\u007f]/.test(value))
    throw new Error("API base must be an absolute HTTPS URL.");
  const url = new URL(value);
  const allowedLocalHttp =
    localMode &&
    url.protocol === "http:" &&
    ["localhost", "127.0.0.1"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !allowedLocalHttp) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error(
      "API base must be an absolute HTTPS URL without credentials, query, or fragment.",
    );
  return url.toString().replace(/\/$/, "");
}

function validateHttpsUrl(value, label) {
  if (!value || /[\u0000-\u0020\u007f]/.test(value))
    throw new Error(`${label} must be a safe HTTPS URL.`);
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error(`${label} must be a safe HTTPS URL.`);
  return url;
}

export function createRuntimeConfigArtifact({
  apiBase,
  callbackUrl,
  cognitoClientId,
  cognitoDomain,
  cognitoIssuer,
  logoutUrl,
  tokenProviderKey,
  localMode = false,
}) {
  const normalizedApiBase = validateApiBase(apiBase, localMode);
  if (!PROVIDER_KEY.test(tokenProviderKey ?? ""))
    throw new Error("Token provider key is invalid.");
  if (
    !cognitoClientId ||
    /[\u0000-\u0020\u007f]/.test(cognitoClientId) ||
    cognitoClientId.length > 128
  )
    throw new Error("Cognito client ID is invalid.");
  const issuer = validateHttpsUrl(cognitoIssuer, "Cognito issuer");
  const domain = validateHttpsUrl(cognitoDomain, "Cognito domain");
  const callback = validateHttpsUrl(callbackUrl, "Cognito callback");
  const logout = validateHttpsUrl(logoutUrl, "Cognito logout");
  if (
    domain.origin !== cognitoDomain ||
    domain.pathname !== "/" ||
    callback.origin !== logout.origin ||
    callbackUrl !== `${logout.origin}/auth/callback` ||
    logout.origin !== logoutUrl ||
    logout.pathname !== "/"
  )
    throw new Error("Cognito browser URLs are not exactly bound.");
  const data = JSON.stringify({
    schemaVersion: 1,
    apiBase: normalizedApiBase,
    tokenProviderKey,
    cognitoIssuer: issuer.toString().replace(/\/$/, ""),
    cognitoClientId,
    cognitoDomain: domain.origin,
    callbackUrl,
    logoutUrl,
  }).replaceAll("<", "\\u003c");
  const scopes = JSON.stringify(COGNITO_SCOPES);
  return `window.__FTE_RUNTIME_CONFIG__ = Object.freeze({...${data},cognitoScopes:Object.freeze(${scopes})});\n`;
}

export async function generateRuntimeConfig(arguments_) {
  const { output, ...config } = parseArguments(arguments_);
  const artifact = createRuntimeConfigArtifact(config);
  const outputPath = resolve(output);
  const temporaryPath = resolve(
    dirname(outputPath),
    `.${randomUUID()}.runtime-config.tmp`,
  );
  let handle;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(artifact, "utf8");
    await handle.chmod(0o644);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, outputPath);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

if (
  process.argv[1] &&
  import.meta.url === new URL(process.argv[1], "file:").href
) {
  generateRuntimeConfig(process.argv.slice(2)).catch((error) => {
    process.stderr.write(
      `Runtime config generation failed: ${error instanceof Error ? error.message : "unknown error"}\n`,
    );
    process.exitCode = 1;
  });
}
