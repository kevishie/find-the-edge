import { describe, expect, it } from "vitest";
import type { IsoTimestamp, SportKey } from "@find-the-edge/domain";
import {
  MemoryBettingSplitRepository,
  normalizeBettingSplitObservation,
} from "./betting-split-repository";

const split = (overrides: Record<string, unknown> = {}) =>
  ({
    providerId: "sharpapi",
    providerEventId: "provider-event-1",
    canonicalEventId: "event-1",
    canonicalEventVersion: 2,
    sportKey: "mlb" as SportKey,
    leagueKey: "mlb",
    marketKey: "moneyline",
    selectionKey: "team:away",
    betPercent: 62,
    moneyPercent: 55,
    providerTimestamp: "2026-08-03T12:00:00.000Z" as IsoTimestamp,
    retrievedAt: "2026-08-03T12:00:01.000Z" as IsoTimestamp,
    ...overrides,
  }) as Parameters<typeof normalizeBettingSplitObservation>[0];

describe("betting split evidence", () => {
  it("keeps missing percentages missing and validates provided percentages", () => {
    expect(
      normalizeBettingSplitObservation(split({ moneyPercent: undefined }))
        .moneyPercent,
    ).toBeUndefined();
    expect(() =>
      normalizeBettingSplitObservation(split({ betPercent: 101 })),
    ).toThrow("betting-split-percentage-invalid");
  });
  it("deduplicates replay and never regresses current", async () => {
    const repository = new MemoryBettingSplitRepository();
    expect((await repository.persist(split())).history).toBe("inserted");
    expect((await repository.persist(split())).history).toBe("duplicate");
    expect(
      (
        await repository.persist(
          split({
            betPercent: 40,
            providerTimestamp: "2026-08-03T11:00:00.000Z",
          }),
        )
      ).current,
    ).toBe("retained");
    const current = await repository.current({
      providerId: "sharpapi",
      canonicalEventId: "event-1",
      canonicalEventVersion: 2,
      marketKey: "moneyline",
      selectionKey: "team:away",
    });
    expect(current?.betPercent).toBe(62);
  });
  it("keeps provider provenance in deterministic identity", () => {
    expect(normalizeBettingSplitObservation(split()).id).not.toBe(
      normalizeBettingSplitObservation(split({ providerId: "other" })).id,
    );
  });
  it("preserves valid moneyline odds and binds them into immutable identity", () => {
    const priced = normalizeBettingSplitObservation(
      split({ americanOdds: 145 }),
    );
    expect(priced.americanOdds).toBe(145);
    expect(priced.id).not.toBe(
      normalizeBettingSplitObservation(split({ americanOdds: 150 })).id,
    );
    expect(() =>
      normalizeBettingSplitObservation(split({ americanOdds: 99 })),
    ).toThrow("betting-split-odds-invalid");
  });
  it("reads valid pre-moneyline split identities without rewriting them", () => {
    const legacyId =
      "split:e48f5b87895177d7217cf5210ccc09f057fc6a68e97c99b04ca87d5cc4924a4f";
    expect(normalizeBettingSplitObservation(split({ id: legacyId })).id).toBe(
      legacyId,
    );
    expect(() =>
      normalizeBettingSplitObservation(
        split({ id: legacyId, americanOdds: 145 }),
      ),
    ).toThrow("betting-split-id-invalid");
  });
  it("returns the freshest logical splits across harmless event version bumps", async () => {
    const repository = new MemoryBettingSplitRepository();
    await repository.persist(split({ canonicalEventVersion: 8 }));
    await repository.persist(
      split({
        canonicalEventVersion: 9,
        betPercent: 64,
        providerTimestamp: "2026-08-03T12:10:00.000Z",
        retrievedAt: "2026-08-03T12:10:01.000Z",
      }),
    );
    expect(await repository.listCurrent("event-1")).toMatchObject([
      { canonicalEventVersion: 9, betPercent: 64 },
    ]);
    expect(await repository.listCurrent("event-1", 8)).toMatchObject([
      { canonicalEventVersion: 8, betPercent: 62 },
    ]);
  });
});
