import { describe, expect, it } from "vitest";
import {
  CALCULATION_HASH_STRATEGY_VERSION,
  calculationInputHash,
  canonicalCalculationJson,
  createCalculationProvenance,
  normalizeCalculationProvenance,
} from "./calculation-provenance";

describe("calculation provenance", () => {
  it("canonicalizes UTF-8 object keys and negative zero while preserving array order", () => {
    const left = { z: -0, é: 2, a: [1, 2] };
    const right = { a: [1, 2], é: 2, z: 0 };
    expect(canonicalCalculationJson(left)).toBe(
      canonicalCalculationJson(right),
    );
    expect(calculationInputHash("fixture-v1", left)).toBe(
      calculationInputHash("fixture-v1", right),
    );
    expect(calculationInputHash("fixture-v1", { a: [1, 2] })).not.toBe(
      calculationInputHash("fixture-v1", { a: [2, 1] }),
    );
    expect(calculationInputHash("fixture-v1", left)).toMatch(/^[a-f0-9]{64}$/);
  });

  it("binds algorithm and component versions and treats component order as a set", () => {
    const componentA = {
      algorithm: { id: "consensus", version: "weighted-consensus-v2" },
      input: { books: ["a", "b"] },
    } as const;
    const componentB = {
      algorithm: { id: "quality", version: "market-outlier-v1" },
      input: { threshold: 0.08 },
    } as const;
    const first = createCalculationProvenance({
      algorithm: { id: "qualification", version: "qualification-v1" },
      input: { offered: 120 },
      precisionPolicyVersion: "display-precision-v1",
      components: [componentA, componentB],
    });
    const reordered = createCalculationProvenance({
      algorithm: { id: "qualification", version: "qualification-v1" },
      input: { offered: 120 },
      precisionPolicyVersion: "display-precision-v1",
      components: [componentB, componentA],
    });
    const changed = createCalculationProvenance({
      algorithm: { id: "qualification", version: "qualification-v2" },
      input: { offered: 120 },
      precisionPolicyVersion: "display-precision-v1",
      components: [componentA, componentB],
    });
    expect(first).toEqual(reordered);
    expect(first.root.inputHash).not.toBe(changed.root.inputHash);
    expect(first.hashStrategyVersion).toBe(CALCULATION_HASH_STRATEGY_VERSION);
    expect(Object.isFrozen(first.components)).toBe(true);
    expect(normalizeCalculationProvenance(first)).toEqual(first);
  });

  it("keeps display policy outside authoritative hashes and binds structured algorithm identity", () => {
    const first = createCalculationProvenance({
      algorithm: { id: "edge@candidate", version: "v1" },
      input: { offered: 120 },
      precisionPolicyVersion: "display-precision-v1",
    });
    const displayPolicyChanged = createCalculationProvenance({
      algorithm: { id: "edge@candidate", version: "v1" },
      input: { offered: 120 },
      precisionPolicyVersion: "display-precision-v2",
    });
    const formerlyAmbiguous = createCalculationProvenance({
      algorithm: { id: "edge", version: "candidate@v1" },
      input: { offered: 120 },
      precisionPolicyVersion: "display-precision-v1",
    });

    expect(first.root.inputHash).toBe(displayPolicyChanged.root.inputHash);
    expect(first.precisionPolicyVersion).not.toBe(
      displayPolicyChanged.precisionPolicyVersion,
    );
    expect(first.root.inputHash).not.toBe(formerlyAmbiguous.root.inputHash);
  });

  it.each([
    { unsafe: { apiKey: "secret" }, message: "unsafe" },
    { unsafe: { prompt: "model text" }, message: "unsafe" },
    { unsafe: { value: Number.NaN }, message: "finite" },
    { unsafe: { value: undefined }, message: "unsupported" },
    { unsafe: Array(2), message: "sparse" },
  ])("rejects unsafe canonical material: $message", ({ unsafe, message }) => {
    expect(() => calculationInputHash("fixture-v1", unsafe)).toThrow(message);
  });

  it.each([
    { unsafe: { value: "\ud800" }, message: "Unicode" },
    { unsafe: { ["bad\udc00"]: "value" }, message: "unsafe" },
    { unsafe: { token: "opaque" }, message: "unsafe" },
    { unsafe: { sessionToken: "opaque" }, message: "unsafe" },
    { unsafe: { providerPayload: {} }, message: "unsafe" },
    { unsafe: { provider_response: {} }, message: "unsafe" },
    { unsafe: { providerBody: {} }, message: "unsafe" },
    { unsafe: { value: "Bearer abc.def" }, message: "unsafe" },
    { unsafe: { value: "access_token=opaque" }, message: "unsafe" },
    { unsafe: { value: '"access_token":"opaque"' }, message: "unsafe" },
    { unsafe: { value: "sk-proj-opaque" }, message: "unsafe" },
    { unsafe: { value: "sk-live-opaque" }, message: "unsafe" },
    { unsafe: { value: "sk-test-opaque" }, message: "unsafe" },
    { unsafe: { value: "sk_live_opaque" }, message: "unsafe" },
  ])(
    "rejects unsafe secret material without echoing it",
    ({ unsafe, message }) => {
      expect(() => calculationInputHash("fixture-v1", unsafe)).toThrow(message);
    },
  );

  it.each([
    "password",
    "passphrase",
    "privateKey",
    "client_secret",
    "signingKey",
    "token",
    "payload",
    "response",
    "body",
    "email",
    "phone",
    "address",
    "ssn",
    "socialSecurityNumber",
    "dateOfBirth",
    "myApiKey",
    "aws_api_key",
    "aws-api-key",
    "userPrivateKey",
    "requestAuthorization",
  ])("rejects secret and PII field name %s", (key) => {
    expect(() =>
      calculationInputHash("fixture-v1", { [key]: "opaque" }),
    ).toThrow("unsafe");
  });

  it.each([
    "Basic QWxhZGRpbjpvcGVuIHNlc2FtZQ==",
    "Bearer opaque.value",
    "ghp_0123456789abcdef",
    "github_pat_0123456789_abcdef",
    "AKIA1234567890ABCDEF",
    "ASIA1234567890ABCDEF",
    "sk-arbitraryCredentialForm",
    "-----BEGIN RSA PRIVATE KEY-----",
    "password=opaque",
    "api_key:opaque",
    "person@example.com",
    "123-45-6789",
    "212-555-0123",
    "+1 (212) 555-0123",
  ])(
    "rejects obvious credential or PII values without echoing them",
    (value) => {
      let error: unknown;
      try {
        calculationInputHash("fixture-v1", { value });
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe(
        "calculation input contains an unsafe value",
      );
      expect((error as Error).message).not.toContain(value);
    },
  );

  it("accepts valid surrogate pairs and safe tokenization identifiers", () => {
    expect(() =>
      calculationInputHash("fixture-v1", {
        emoji: "\ud83d\ude00",
        value: "tokenization:model-v1",
      }),
    ).not.toThrow();
  });

  it.each([
    "+120",
    "-110",
    "2026-08-06T12:00:00.000Z",
    "edge-calculation-v1",
    "a".repeat(64),
    "fixture-1234567890",
  ])("does not mistake ordinary calculation value %s for PII", (value) => {
    expect(() => calculationInputHash("fixture-v1", { value })).not.toThrow();
  });

  it("rejects oversized, cyclic, accessor, duplicate-component, and forged evidence", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => calculationInputHash("fixture-v1", cyclic)).toThrow("cyclic");
    expect(() =>
      calculationInputHash("fixture-v1", { text: "x".repeat(70_000) }),
    ).toThrow("size");
    const accessor = Object.defineProperty({}, "value", {
      enumerable: true,
      get: () => 1,
    });
    expect(() => calculationInputHash("fixture-v1", accessor)).toThrow(
      "data properties",
    );
    const accessorArray = [1];
    Object.defineProperty(accessorArray, "0", {
      enumerable: true,
      get: () => 1,
    });
    expect(() => calculationInputHash("fixture-v1", accessorArray)).toThrow(
      "data properties",
    );
    const unsafeArray = [1] as number[] & { apiKey?: string };
    unsafeArray.apiKey = "hidden";
    expect(() => calculationInputHash("fixture-v1", unsafeArray)).toThrow(
      "unsafe",
    );
    expect(() =>
      createCalculationProvenance({
        algorithm: { id: "root", version: "1" },
        input: {},
        precisionPolicyVersion: "display-precision-v1",
        components: [
          { algorithm: { id: "same", version: "1" }, input: {} },
          { algorithm: { id: "same", version: "1" }, input: {} },
        ],
      }),
    ).toThrow("duplicate");
    const valid = createCalculationProvenance({
      algorithm: { id: "root", version: "1" },
      input: {},
      precisionPolicyVersion: "display-precision-v1",
    });
    expect(() =>
      normalizeCalculationProvenance({
        ...valid,
        root: { ...valid.root, inputHash: "g".repeat(64) },
      }),
    ).toThrow("hash");
  });

  it("bounds object keys and the combined component graph before child processing", () => {
    const oversizedRecord = Object.fromEntries(
      Array.from({ length: 257 }, (_, index) => [`field${index}`, index]),
    );
    expect(() => calculationInputHash("fixture-v1", oversizedRecord)).toThrow(
      "size",
    );

    const evidence = createCalculationProvenance({
      algorithm: { id: "evidence", version: "1" },
      input: {},
      precisionPolicyVersion: "display-precision-v1",
    }).root;
    expect(() =>
      createCalculationProvenance({
        algorithm: { id: "root", version: "1" },
        input: {},
        precisionPolicyVersion: "display-precision-v1",
        components: Array.from({ length: 128 }, (_, index) => ({
          algorithm: { id: `component-${index}`, version: "1" },
          input: {},
        })),
        componentEvidence: Array.from({ length: 129 }, () => evidence),
      }),
    ).toThrow("size");
  });
});
