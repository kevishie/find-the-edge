import { DISPLAY_PRECISION_POLICY_VERSION } from "./versions";

export { DISPLAY_PRECISION_POLICY_VERSION };

export const DISPLAY_SCALES = Object.freeze({
  decimalOdds: 3,
  americanOdds: 0,
  percentage: 2,
  money: 2,
  edgeLabPercentage: 1,
} as const);

export interface DisplayValue {
  readonly value: number;
  readonly text: string;
}

function assertScale(scale: number): void {
  if (!Number.isSafeInteger(scale) || scale < 0 || scale > 12) {
    throw new RangeError("Display scale must be an integer in [0, 12]");
  }
}

export function roundDisplay(value: number, scale: number): number {
  if (!Number.isFinite(value)) {
    throw new RangeError("Display value must be finite");
  }
  assertScale(scale);
  const absoluteText = Math.abs(value).toString();
  const [coefficient = "0", exponentText] = absoluteText.split("e");
  const decimalPoint = coefficient.indexOf(".");
  const fractionalDigits =
    decimalPoint === -1 ? 0 : coefficient.length - decimalPoint - 1;
  const digitsText = coefficient.replace(".", "").replace(/^0+/, "") || "0";
  const decimalExponent = Number(exponentText ?? 0) - fractionalDigits;
  const shift = decimalExponent + scale;
  let rounded: number;
  if (shift >= 0) {
    rounded = value;
  } else {
    const divisor = 10n ** BigInt(-shift);
    const digits = BigInt(digitsText);
    const quotient = digits / divisor;
    const remainder = digits % divisor;
    const magnitude = remainder * 2n >= divisor ? quotient + 1n : quotient;
    rounded = (Math.sign(value) * Number(magnitude)) / 10 ** scale;
  }
  if (!Number.isFinite(rounded)) {
    throw new RangeError("Display value exceeds numeric precision");
  }
  return Object.is(rounded, -0) ? 0 : rounded;
}

export function formatFixedDisplay(value: number, scale: number): string {
  const rounded = roundDisplay(value, scale);
  const negative = rounded < 0;
  const absolute = Math.abs(rounded);
  const [coefficient = "0", exponentText = "0"] = absolute
    .toString()
    .split("e");
  const digits = coefficient.replace(".", "");
  const coefficientIntegerDigits = coefficient.includes(".")
    ? coefficient.indexOf(".")
    : coefficient.length;
  const decimalPosition = coefficientIntegerDigits + Number(exponentText);
  const expanded =
    decimalPosition <= 0
      ? `0.${"0".repeat(-decimalPosition)}${digits}`
      : decimalPosition >= digits.length
        ? `${digits}${"0".repeat(decimalPosition - digits.length)}`
        : `${digits.slice(0, decimalPosition)}.${digits.slice(decimalPosition)}`;
  const [integerPart = "0", fractionalPart = ""] = expanded.split(".");
  const fixed =
    scale === 0
      ? integerPart
      : `${integerPart}.${fractionalPart.padEnd(scale, "0").slice(0, scale)}`;
  return negative && absolute !== 0 ? `-${fixed}` : fixed;
}

function display(value: number, scale: number, suffix = ""): DisplayValue {
  const rounded = roundDisplay(value, scale);
  return Object.freeze({
    value: rounded,
    text: `${formatFixedDisplay(rounded, scale)}${suffix}`,
  });
}

export const displayDecimalOdds = (value: number): DisplayValue =>
  display(value, DISPLAY_SCALES.decimalOdds);

export function displayAmericanOdds(value: number): DisplayValue {
  const projected = display(value, DISPLAY_SCALES.americanOdds);
  return Object.freeze({
    value: projected.value,
    text: projected.value > 0 ? `+${projected.text}` : projected.text,
  });
}

export const displayPercentage = (
  probability: number,
  scale: number = DISPLAY_SCALES.percentage,
): DisplayValue => display(probability * 100, scale, "%");

export const displayMoney = (value: number): DisplayValue =>
  display(value, DISPLAY_SCALES.money);
