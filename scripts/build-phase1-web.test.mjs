import assert from "node:assert/strict";
import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { mkdtemp } from "node:fs/promises";
import { assertSafeBundleOutput } from "./build-phase1-web.mjs";

test("allows only the dedicated real generated bundle subtree", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "fte-bundle-root-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const output = join(root, "dist/phase1-web");
  assert.equal(await assertSafeBundleOutput(root, output), output);
  await assert.rejects(assertSafeBundleOutput(root, root), /exactly/);
  await assert.rejects(
    assertSafeBundleOutput(root, join(root, "apps/web/dist")),
    /exactly/,
  );
});

test("rejects symlinked parents and output before recursive deletion", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "fte-bundle-link-"));
  const outside = await mkdtemp(join(tmpdir(), "fte-bundle-outside-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await symlink(outside, join(root, "dist"));
  await assert.rejects(
    assertSafeBundleOutput(root, join(root, "dist/phase1-web")),
    /real directory/,
  );
  await rm(join(root, "dist"));
  await mkdir(join(root, "dist"));
  await writeFile(join(outside, "protected"), "keep");
  await symlink(outside, join(root, "dist/phase1-web"));
  await assert.rejects(
    assertSafeBundleOutput(root, join(root, "dist/phase1-web")),
    /real directory/,
  );
  assert.equal(
    await import("node:fs/promises").then(({ readFile }) =>
      readFile(join(outside, "protected"), "utf8"),
    ),
    "keep",
  );
});
