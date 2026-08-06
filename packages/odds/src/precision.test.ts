import { describe, expect, it } from "vitest";
import {
  DISPLAY_PRECISION_POLICY_VERSION,
  displayAmericanOdds,
  displayDecimalOdds,
  displayMoney,
  displayPercentage,
  formatFixedDisplay,
  roundDisplay,
} from "./precision";

describe("display precision policy", () => {
  it.each([
    [1.005, 2, 1.01, "1.01"],
    [-1.005, 2, -1.01, "-1.01"],
    [2.5e-7, 7, 3e-7, "0.0000003"],
    [-0.004, 2, 0, "0.00"],
  ])(
    "rounds %s at scale %s half away from zero",
    (value, scale, number, text) => {
      expect(roundDisplay(value, scale)).toBe(number);
      expect(formatFixedDisplay(value, scale)).toBe(text);
    },
  );

  it("exposes the established fair-value scales", () => {
    expect(DISPLAY_PRECISION_POLICY_VERSION).toBe("display-precision-v1");
    expect(displayDecimalOdds(2.34567)).toEqual({
      value: 2.346,
      text: "2.346",
    });
    expect(displayAmericanOdds(120.5)).toEqual({ value: 121, text: "+121" });
    expect(displayPercentage(0.123456)).toEqual({
      value: 12.35,
      text: "12.35%",
    });
    expect(displayMoney(-12.345)).toEqual({ value: -12.35, text: "-12.35" });
  });

  it("keeps fixed scale for exponent-form magnitudes", () => {
    expect(formatFixedDisplay(1e21, 2)).toBe("1000000000000000000000.00");
    expect(formatFixedDisplay(-1e-7, 8)).toBe("-0.00000010");
  });

  it.each([Number.NaN, Infinity, -Infinity])(
    "rejects non-finite %s",
    (value) => {
      expect(() => roundDisplay(value, 2)).toThrow("finite");
    },
  );
  it.each([-1, 13, 1.5])("rejects invalid scale %s", (scale) => {
    expect(() => roundDisplay(1, scale)).toThrow("scale");
  });
});
