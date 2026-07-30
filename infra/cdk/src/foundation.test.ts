import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";

import { createFoundationApp } from "./foundation";

describe("foundation CDK app", () => {
  it("synthesizes a deterministic environment-aware empty foundation", () => {
    const { stack } = createFoundationApp({ stage: "test" });
    const template = Template.fromStack(stack).toJSON();

    expect(stack.stackName).toBe("FindTheEdge-test-Foundation");
    expect(template["Resources"] ?? {}).toEqual({});
  });

  it("rejects unsafe stage names", () => {
    expect(() => createFoundationApp({ stage: "Production!" })).toThrow(
      "FTE_AWS_STAGE",
    );
  });
});
