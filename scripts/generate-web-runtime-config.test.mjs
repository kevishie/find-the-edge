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

test("creates an exact, inert, non-secret artifact", () => {
  const artifact = createRuntimeConfigArtifact({
    apiBase: "https://api.example.com/",
    providerKey: "hostSession",
  });
  const context = vm.createContext({ window: {} });
  vm.runInContext(artifact, context, { timeout: 100 });
  assert.deepEqual(
    JSON.parse(JSON.stringify(context.window.__FTE_RUNTIME_CONFIG__)),
    {
      schemaVersion: 1,
      apiBase: "https://api.example.com",
      tokenProviderKey: "hostSession",
    },
  );
  assert.equal(Object.isFrozen(context.window.__FTE_RUNTIME_CONFIG__), true);
  assert.doesNotMatch(artifact, /token-value|bearer|local-e2e-token/i);
});

test("production HTML preloads the non-secret placeholder before the module", async () => {
  const html = await readFile(
    new URL("../apps/web/index.html", import.meta.url),
    "utf8",
  );
  const placeholder = await readFile(
    new URL("../apps/web/public/runtime-config.js", import.meta.url),
    "utf8",
  );
  assert.ok(
    html.indexOf('src="/runtime-config.js"') < html.indexOf('type="module"'),
  );
  assert.match(placeholder, /apiBase: ""/);
  assert.doesNotMatch(placeholder, /bearer|local-e2e-token|eyJ[a-zA-Z0-9_-]+/i);
});

test("rejects unsafe URLs, provider keys, and unexpected arguments", async () => {
  assert.throws(
    () =>
      createRuntimeConfigArtifact({
        apiBase: "http://api.example.com",
        providerKey: "valid",
      }),
    /HTTPS/,
  );
  assert.throws(
    () =>
      createRuntimeConfigArtifact({
        apiBase: "https://api.example.com",
        providerKey: "bad key",
      }),
    /Provider key/,
  );
  for (const unsafe of [
    "https://api.example.com/\tpath",
    "https://api.example.com/\u0000path",
    "https://api.example.com/\u007fpath",
  ]) {
    assert.throws(
      () =>
        createRuntimeConfigArtifact({
          apiBase: unsafe,
          providerKey: "hostSession",
        }),
      /HTTPS/,
    );
  }
  await assert.rejects(
    generateRuntimeConfig([
      "--api-base",
      "https://api.example.com",
      "--output",
      "ignored",
    ]),
    /Expected unique/,
  );
});

test("writes atomically and leaves an existing artifact intact on validation failure", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "fte-runtime-config-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const output = join(directory, "runtime-config.js");
  await writeFile(output, "existing\n", "utf8");

  await assert.rejects(
    generateRuntimeConfig([
      "--api-base",
      "not-a-url",
      "--provider-key",
      "hostSession",
      "--output",
      output,
    ]),
  );
  assert.equal(await readFile(output, "utf8"), "existing\n");

  await generateRuntimeConfig([
    "--api-base",
    "https://api.example.com",
    "--provider-key",
    "hostSession",
    "--output",
    output,
  ]);
  assert.match(await readFile(output, "utf8"), /https:\/\/api\.example\.com/);
  assert.equal((await stat(output)).mode & 0o777, 0o644);

  await writeFile(output, "replacement target\n", { mode: 0o600 });
  await generateRuntimeConfig([
    "--api-base",
    "https://api.example.com",
    "--provider-key",
    "hostSession",
    "--output",
    output,
  ]);
  assert.equal((await stat(output)).mode & 0o777, 0o644);
});
