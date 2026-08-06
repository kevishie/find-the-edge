import { describe, expect, it } from "vitest";
import { calculationProvenance } from "./provenance";

describe("odds provenance", () => {
  it("binds normalized inputs and canonical component sets", () => {
    const first = calculationProvenance("fairValue", { z: -0, a: 1 }, [
      { algorithmKey: "consensus", input: { books: ["a", "b"] } },
    ]);
    const second = calculationProvenance("fairValue", { a: 1, z: 0 }, [
      { algorithmKey: "consensus", input: { books: ["a", "b"] } },
    ]);
    expect(first).toEqual(second);
    expect(first.root.algorithm).toEqual({
      id: "fair-value",
      version: "fair-value-v1",
    });
  });
});
