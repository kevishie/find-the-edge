import {
  GetSecretValueCommand,
  type SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import {
  loadCursorSecretRingCached,
  type CursorSecretRing,
} from "@find-the-edge/database";
const exact = (value: object, keys: readonly string[]) =>
  Object.keys(value).sort().join("|") === [...keys].sort().join("|");
const CURSOR_MAX_TTL_MS = 900_000;
const CURSOR_CLOCK_SKEW_MS = 5_000;
const parseCanonicalInstant = (value: string): number => {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value)
    throw new Error("invalid-cursor-secret-ring");
  return parsed;
};
const decode = (value: unknown): Uint8Array => {
  if (typeof value !== "string" || !/^(?:[A-Za-z0-9+/]{43}=)$/.test(value))
    throw new Error("invalid-cursor-secret");
  const bytes = Buffer.from(value, "base64");
  if (bytes.length !== 32 || bytes.toString("base64") !== value)
    throw new Error("invalid-cursor-secret");
  return bytes;
};
export const parseCursorSecretRing = (raw: string): CursorSecretRing => {
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("invalid-cursor-secret-ring");
  const item = value as Readonly<Record<string, unknown>>;
  const hasPrevious = [
    "previousId",
    "previousSecret",
    "previousAcceptUntil",
  ].some((key) => key in item);
  const keys = [
    "currentId",
    "currentSecret",
    "currentCreatedAt",
    ...(hasPrevious
      ? ["previousId", "previousSecret", "previousAcceptUntil"]
      : []),
  ];
  if (
    !exact(item, keys) ||
    typeof item["currentId"] !== "string" ||
    typeof item["currentCreatedAt"] !== "string"
  )
    throw new Error("invalid-cursor-secret-ring");
  const currentCreatedAt = parseCanonicalInstant(item["currentCreatedAt"]);
  const current = {
    id: item["currentId"],
    secret: decode(item["currentSecret"]),
  };
  if (!hasPrevious) return { current };
  if (
    typeof item["previousId"] !== "string" ||
    typeof item["previousAcceptUntil"] !== "string"
  )
    throw new Error("invalid-cursor-secret-ring");
  const previousAcceptUntil = parseCanonicalInstant(
    item["previousAcceptUntil"],
  );
  if (
    previousAcceptUntil <
    currentCreatedAt + CURSOR_MAX_TTL_MS + CURSOR_CLOCK_SKEW_MS
  )
    throw new Error("invalid-cursor-secret-ring");
  return {
    current,
    previous: {
      id: item["previousId"],
      secret: decode(item["previousSecret"]),
      acceptUntil: item["previousAcceptUntil"],
    },
  };
};
export const loadSecretRing = (
  client: SecretsManagerClient,
  arn: string,
): Promise<CursorSecretRing> =>
  loadCursorSecretRingCached(`${arn}:v1`, async () => {
    const output = await client.send(
      new GetSecretValueCommand({ SecretId: arn }),
    );
    if (!output.SecretString) throw new Error("missing-cursor-secret");
    return parseCursorSecretRing(output.SecretString);
  });
