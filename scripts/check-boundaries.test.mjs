import assert from "node:assert/strict";
import test from "node:test";

import { validatePackageGraph } from "./check-boundaries.mjs";

test("rejects frontend infrastructure and domain provider dependencies", () => {
  assert.deepEqual(
    validatePackageGraph([
      { name: "ui", dependencies: ["database"] },
      { name: "domain", dependencies: ["providers"] },
    ]),
    ["ui must not depend on database", "domain must not depend on providers"],
  );
});

test("accepts architecture-aligned dependencies", () => {
  assert.deepEqual(
    validatePackageGraph([
      { name: "odds", dependencies: ["domain"] },
      { name: "sports", dependencies: ["domain"] },
    ]),
    [],
  );
});
