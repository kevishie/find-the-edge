import {
  cp,
  lstat,
  mkdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { createRuntimeConfigArtifact } from "./generate-web-runtime-config.mjs";
import {
  checksums,
  projectRoot,
  run,
  safeDevConfig,
  validateSafeDevConfig,
} from "./phase1-support.mjs";

export async function assertSafeBundleOutput(root, output) {
  const expected = resolve(root, "dist/phase1-web");
  if (resolve(output) !== expected)
    throw new Error(
      "Bundle output must be exactly the generated dist/phase1-web subtree",
    );
  const rootReal = await realpath(root);
  const parent = dirname(expected);
  try {
    const parentInfo = await lstat(parent);
    if (parentInfo.isSymbolicLink() || !parentInfo.isDirectory())
      throw new Error("Bundle parent must be a real directory");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    await mkdir(parent, { recursive: false });
  }
  const parentReal = await realpath(parent);
  if (!parentReal.startsWith(`${rootReal}${sep}`))
    throw new Error("Bundle parent escapes the project root");
  try {
    const outputInfo = await lstat(expected);
    if (outputInfo.isSymbolicLink() || !outputInfo.isDirectory())
      throw new Error("Existing bundle output must be a real directory");
    const outputReal = await realpath(expected);
    if (outputReal !== resolve(parentReal, "phase1-web"))
      throw new Error("Existing bundle output escapes its generated subtree");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return expected;
}

export async function buildPhase1Web(environment = process.env) {
  const config = safeDevConfig(environment);
  validateSafeDevConfig(config);
  const output = resolve(projectRoot, "dist/phase1-web");
  const build = resolve(projectRoot, "apps/web/dist");
  await assertSafeBundleOutput(projectRoot, output);
  run("pnpm", ["--filter", "@find-the-edge/web", "build"]);
  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });
  await cp(build, output, { recursive: true });
  await writeFile(
    resolve(output, "runtime-config.js"),
    createRuntimeConfigArtifact({
      apiBase: config.apiBase,
      localMode: config.localMode,
    }),
    { encoding: "utf8", mode: 0o644 },
  );
  const html = await readFile(resolve(output, "index.html"), "utf8");
  if (
    html.indexOf('src="/runtime-config.js"') < 0 ||
    html.indexOf('src="/runtime-config.js"') > html.indexOf('type="module"') ||
    html.includes('src="/cognito-token-provider.js"')
  )
    throw new Error(
      "runtime config must load before the application module without an authentication provider",
    );
  const digestMap = await checksums(output, new Set(["phase1-manifest.json"]));
  const manifest = {
    schemaVersion: 1,
    stage: "dev",
    apiBase: config.apiBase,
    algorithm: "sha256",
    files: digestMap,
  };
  const serialized = `${JSON.stringify(manifest, null, 2)}\n`;
  if (/bearer\s|eyJ[A-Za-z0-9_-]+\.|access[_-]?token/i.test(serialized))
    throw new Error("Bundle manifest appears to contain a token");
  await writeFile(resolve(output, "phase1-manifest.json"), serialized, "utf8");
  return { output, manifest };
}

if (
  process.argv[1] &&
  import.meta.url === new URL(process.argv[1], "file:").href
) {
  buildPhase1Web()
    .then(({ output }) => {
      process.stdout.write(`Phase1 static bundle ready: ${output}\n`);
    })
    .catch((error) => {
      process.stderr.write(
        `Phase1 bundle failed: ${error instanceof Error ? error.message : "unknown error"}\n`,
      );
      process.exitCode = 1;
    });
}
