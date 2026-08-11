import { beforeEach, describe, expect, it } from "vitest";
import type { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import {
  clearIdentitySecretsCache,
  loadIdentitySecrets,
  parseIdentitySecrets,
} from "./identity-secrets";

const valid = {
  currentKeyId: "session-2026-08",
  currentSecret: "a".repeat(48),
  otpPepper: "b".repeat(40),
  accountPepper: "c".repeat(40),
};

describe("identity secrets", () => {
  beforeEach(() => clearIdentitySecretsCache());

  it("reads a current key, an optional previous key, and both peppers", () => {
    expect(parseIdentitySecrets(JSON.stringify(valid))).toEqual({
      signingKeys: {
        current: { keyId: valid.currentKeyId, secret: valid.currentSecret },
      },
      otpPepper: valid.otpPepper,
      accountPepper: valid.accountPepper,
    });
    const rotating = parseIdentitySecrets(
      JSON.stringify({
        ...valid,
        previousKeyId: "session-2026-07",
        previousSecret: "d".repeat(48),
      }),
    );
    expect(rotating.signingKeys.previous).toEqual({
      keyId: "session-2026-07",
      secret: "d".repeat(48),
    });
  });

  it("refuses a secret it cannot trust rather than degrading", () => {
    for (const raw of [
      "not json",
      "[]",
      "null",
      JSON.stringify({ ...valid, extra: 1 }),
      JSON.stringify({ ...valid, currentSecret: "short" }),
      JSON.stringify({ ...valid, currentKeyId: "Not A Key" }),
      JSON.stringify({ ...valid, otpPepper: "tiny" }),
      JSON.stringify({ ...valid, accountPepper: 42 }),
      JSON.stringify({ ...valid, previousKeyId: "session-2026-07" }),
      JSON.stringify({
        ...valid,
        previousKeyId: valid.currentKeyId,
        previousSecret: "d".repeat(48),
      }),
    ])
      expect(() => parseIdentitySecrets(raw)).toThrow();
  });

  it("caches the parsed secret instead of reading it per request", async () => {
    let reads = 0;
    const client = {
      send: async () => {
        await Promise.resolve();
        reads += 1;
        return { SecretString: JSON.stringify(valid) };
      },
    } as unknown as SecretsManagerClient;
    await loadIdentitySecrets(client, "identity");
    await loadIdentitySecrets(client, "identity");
    expect(reads).toBe(1);
    // A zero lifetime re-reads every time, which is how a rotation reaches
    // a warm process.
    await loadIdentitySecrets(client, "identity-rotating", 0);
    await loadIdentitySecrets(client, "identity-rotating", 0);
    expect(reads).toBe(3);
  });

  it("fails when the secret has no value", async () => {
    const client = {
      send: async () => {
        await Promise.resolve();
        return {};
      },
    } as unknown as SecretsManagerClient;
    await expect(loadIdentitySecrets(client, "identity")).rejects.toThrow(
      "missing-identity-secret",
    );
  });
});
