import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import vm from "node:vm";

import {
  createRuntimeConfigArtifact,
  generateRuntimeConfig,
} from "./generate-web-runtime-config.mjs";

test("creates an exact anonymous non-secret artifact", () => {
  const artifact = createRuntimeConfigArtifact({
    apiBase: "https://api.example.com/",
  });
  const context = vm.createContext({ window: {} });
  vm.runInContext(artifact, context, { timeout: 100 });
  assert.deepEqual(
    JSON.parse(JSON.stringify(context.window.__FTE_RUNTIME_CONFIG__)),
    { schemaVersion: 1, apiBase: "https://api.example.com" },
  );
  assert.equal(Object.isFrozen(context.window.__FTE_RUNTIME_CONFIG__), true);
  assert.doesNotMatch(artifact, /token|cognito|password|bearer/i);
});

test("production HTML loads only runtime configuration before the module", async () => {
  const html = await readFile(
    new URL("../apps/web/index.html", import.meta.url),
    "utf8",
  );
  assert.ok(
    html.indexOf('src="/runtime-config.js"') < html.indexOf('type="module"'),
  );
  assert.doesNotMatch(html, /cognito|token-provider/i);
});

test("rejects unsafe URLs and unexpected arguments", async () => {
  assert.throws(
    () => createRuntimeConfigArtifact({ apiBase: "http://api.example.com" }),
    /HTTPS/,
  );
  for (const unsafe of [
    "https://api.example.com/\tpath",
    "https://api.example.com/\u0000path",
    "https://api.example.com/\u007fpath",
  ])
    assert.throws(
      () => createRuntimeConfigArtifact({ apiBase: unsafe }),
      /HTTPS/,
    );
  await assert.rejects(
    generateRuntimeConfig(["--api-base", "https://api.example.com"]),
    /Expected unique/,
  );
});

test("allows HTTP localhost only in explicit local mode", () => {
  assert.match(
    createRuntimeConfigArtifact({
      apiBase: "http://127.0.0.1:3000",
      localMode: true,
    }),
    /http:\/\/127\.0\.0\.1:3000/,
  );
  assert.throws(() =>
    createRuntimeConfigArtifact({
      apiBase: "http://api.example.com",
      localMode: true,
    }),
  );
});

test("writes atomically and preserves an existing artifact on failure", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "fte-runtime-config-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const output = join(directory, "runtime-config.js");
  await writeFile(output, "existing\n", "utf8");

  await assert.rejects(
    generateRuntimeConfig(["--api-base", "not-a-url", "--output", output]),
  );
  assert.equal(await readFile(output, "utf8"), "existing\n");

  await generateRuntimeConfig([
    "--api-base",
    "https://api.example.com",
    "--output",
    output,
  ]);
  assert.match(await readFile(output, "utf8"), /https:\/\/api\.example\.com/);
  assert.equal((await stat(output)).mode & 0o777, 0o644);
});
