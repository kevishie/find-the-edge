import { open, rename, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";

const PROVIDER_KEY = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;

function parseArguments(arguments_) {
  const values = new Map();
  for (let index = 0; index < arguments_.length; index += 2) {
    const key = arguments_[index];
    const value = arguments_[index + 1];
    if (!key?.startsWith("--") || value === undefined || values.has(key))
      throw new Error(
        "Expected unique --api-base, --provider-key, and --output arguments.",
      );
    values.set(key, value);
  }
  const expected = ["--api-base", "--provider-key", "--output"];
  if (
    values.size !== expected.length ||
    expected.some((key) => !values.has(key))
  )
    throw new Error(
      "Expected unique --api-base, --provider-key, and --output arguments.",
    );
  return {
    apiBase: values.get("--api-base"),
    providerKey: values.get("--provider-key"),
    output: values.get("--output"),
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

export function createRuntimeConfigArtifact({
  apiBase,
  providerKey,
  localMode = false,
  launch,
}) {
  const normalizedApiBase = validateApiBase(apiBase, localMode);
  if (!PROVIDER_KEY.test(providerKey ?? ""))
    throw new Error(
      "Provider key must match the runtime provider-key contract.",
    );
  const launchConfig = launch ? validateLaunchConfig(launch) : {};
  const data = JSON.stringify({
    schemaVersion: 1,
    apiBase: normalizedApiBase,
    tokenProviderKey: providerKey,
    ...launchConfig,
  }).replaceAll("<", "\\u003c");
  return `window.__FTE_RUNTIME_CONFIG__ = Object.freeze(${data});\n`;
}

function validateLaunchConfig(value) {
  const required = [
    "cognitoIssuer",
    "cognitoClientId",
    "cognitoDomain",
    "cognitoScope",
    "callbackUrl",
    "logoutUrl",
  ];
  if (
    !value ||
    required.some(
      (key) =>
        typeof value[key] !== "string" ||
        !value[key] ||
        /[\u0000-\u0020\u007f]/.test(value[key]),
    )
  )
    throw new Error(
      "Complete secret-free Cognito launch configuration is required.",
    );
  for (const key of [
    "cognitoIssuer",
    "cognitoDomain",
    "callbackUrl",
    "logoutUrl",
  ]) {
    const url = new URL(value[key]);
    if (url.protocol !== "https:" || url.username || url.password)
      throw new Error("Cognito launch URLs must be safe HTTPS URLs.");
  }
  const domain = new URL(value.cognitoDomain);
  const callback = new URL(value.callbackUrl);
  const logout = new URL(value.logoutUrl);
  if (
    domain.origin !== value.cognitoDomain ||
    domain.pathname !== "/" ||
    domain.search ||
    domain.hash
  )
    throw new Error("Cognito domain must be an exact HTTPS origin.");
  if (
    logout.origin !== value.logoutUrl ||
    logout.pathname !== "/" ||
    logout.search ||
    logout.hash ||
    value.callbackUrl !== `${value.logoutUrl}/auth/callback` ||
    callback.origin !== logout.origin
  )
    throw new Error(
      "Callback and logout URLs must exactly match the web origin.",
    );
  if (value.cognitoScope !== "events/events:read")
    throw new Error("Cognito scope must be events/events:read.");
  return Object.fromEntries(required.map((key) => [key, value[key]]));
}

export async function generateRuntimeConfig(arguments_) {
  const { apiBase, providerKey, output } = parseArguments(arguments_);
  const artifact = createRuntimeConfigArtifact({ apiBase, providerKey });
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
