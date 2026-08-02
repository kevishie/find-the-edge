import { open, rename, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";

function parseArguments(arguments_) {
  const values = new Map();
  for (let index = 0; index < arguments_.length; index += 2) {
    const key = arguments_[index];
    const value = arguments_[index + 1];
    if (!key?.startsWith("--") || value === undefined || values.has(key))
      throw new Error("Expected unique --api-base and --output arguments.");
    values.set(key, value);
  }
  const expected = ["--api-base", "--output"];
  if (
    values.size !== expected.length ||
    expected.some((key) => !values.has(key))
  )
    throw new Error("Expected unique --api-base and --output arguments.");
  return {
    apiBase: values.get("--api-base"),
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

export function createRuntimeConfigArtifact({ apiBase, localMode = false }) {
  const normalizedApiBase = validateApiBase(apiBase, localMode);
  const data = JSON.stringify({
    schemaVersion: 1,
    apiBase: normalizedApiBase,
  }).replaceAll("<", "\\u003c");
  return `window.__FTE_RUNTIME_CONFIG__ = Object.freeze(${data});\n`;
}

export async function generateRuntimeConfig(arguments_) {
  const { apiBase, output } = parseArguments(arguments_);
  const artifact = createRuntimeConfigArtifact({ apiBase });
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
