import { describe, expect, it } from "vitest";

import { fixedClock } from "./index";

describe("fixedClock", () => {
  it("returns a deterministic instant", () => {
    expect(fixedClock("2026-07-29T12:00:00.000Z")().toISOString()).toBe(
      "2026-07-29T12:00:00.000Z",
    );
  });
});
