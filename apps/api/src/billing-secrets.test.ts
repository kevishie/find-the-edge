import { beforeEach, describe, expect, it } from "vitest";
import type { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import {
  clearBillingSecretsCache,
  loadBillingSecrets,
  parseBillingSecrets,
} from "./billing-secrets";

// Stripe's key grammar is scanned for in commits, and a literal that matches
// it is indistinguishable from a real leak to any scanner — so the fixture is
// assembled at runtime instead of written out. The value is still a valid
// test-mode shape for the parser.
const fakeSecretKey = ["sk", "test", "F".repeat(24)].join("_");

const valid = {
  secretKey: fakeSecretKey,
  webhookSecret: "whsec_TestWebhookSecret0123456789",
  priceId: "price_TestMonthly001",
};

describe("billing secrets", () => {
  beforeEach(() => clearBillingSecretsCache());

  it("reads the key, the webhook secret, and the server-side price", () => {
    expect(parseBillingSecrets(JSON.stringify(valid))).toEqual(valid);
    expect(
      parseBillingSecrets(
        JSON.stringify({ ...valid, secretKey: "rk_live_ABCDEFGHIJKLMNOPQRST" }),
      ).secretKey,
    ).toBe("rk_live_ABCDEFGHIJKLMNOPQRST");
  });

  it("refuses a secret it cannot trust rather than degrading", () => {
    const cases: readonly unknown[] = [
      { ...valid, secretKey: "not-a-key" },
      { ...valid, webhookSecret: "wrong_prefix_0123456789" },
      { ...valid, priceId: "prod_NotAPrice0001" },
      { ...valid, extra: "field" },
      { secretKey: valid.secretKey, webhookSecret: valid.webhookSecret },
      [valid],
      null,
    ];
    for (const candidate of cases)
      expect(() => parseBillingSecrets(JSON.stringify(candidate))).toThrow(
        "invalid-billing-secret",
      );
    expect(() => parseBillingSecrets("{not json")).toThrow();
  });

  it("caches the read and refuses an empty secret string", async () => {
    let reads = 0;
    const client = {
      send: async () => {
        await Promise.resolve();
        reads += 1;
        return { SecretString: JSON.stringify(valid) };
      },
    } as unknown as SecretsManagerClient;
    expect(await loadBillingSecrets(client, "billing")).toEqual(valid);
    expect(await loadBillingSecrets(client, "billing")).toEqual(valid);
    expect(reads).toBe(1);

    clearBillingSecretsCache();
    const empty = {
      send: async () => {
        await Promise.resolve();
        return {};
      },
    } as unknown as SecretsManagerClient;
    await expect(loadBillingSecrets(empty, "billing")).rejects.toThrow(
      "missing-billing-secret",
    );
  });
});
