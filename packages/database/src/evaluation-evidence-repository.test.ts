import { describe, expect, it, vi } from "vitest";
import { normalizeFixtureOddsObservation } from "@find-the-edge/domain";
import { DynamoEvaluationEvidenceRepository } from "./evaluation-evidence-repository";
import type {
  FixtureOddsDynamoGateway,
  FixtureOddsItem,
} from "./fixture-odds-adapter";

const make = (book: string, selection: string, odds: number) =>
  normalizeFixtureOddsObservation({
    canonicalEventId: "event",
    canonicalEventVersion: 1,
    sportKey: "mlb",
    marketKey: "moneyline",
    selectionKey: selection,
    sportsbookId: book,
    americanOdds: odds,
    observedAt: "2026-08-03T23:58:00.000Z",
    retrievedAt: "2026-08-03T23:59:00.000Z",
  });
const snapshots = [
  make("target", "away", -120),
  make("target", "home", 110),
  make("other", "away", -115),
  make("other", "home", 105),
];
const items = new Map<string, FixtureOddsItem>();
for (const value of snapshots) {
  items.set(`${value.partitionKey}|CURRENT`, {
    pk: value.partitionKey,
    sk: "CURRENT",
    value,
  });
  items.set(`${value.partitionKey}|${value.sortKey}`, {
    pk: value.partitionKey,
    sk: value.sortKey,
    value,
  });
}
const getExact = (pk: string, sk: string) =>
  Promise.resolve(items.get(`${pk}|${sk}`) ?? null);
const getExactMock = vi.fn(getExact);
const gateway = {
  getExact: getExactMock,
} as unknown as FixtureOddsDynamoGateway;
const query = {
  eventId: "event",
  eventVersion: 1,
  sportKey: "mlb",
  marketKey: "moneyline",
  selections: [{ selectionKey: "away" }, { selectionKey: "home" }],
  targetSportsbookId: "target",
  comparisonSportsbookIds: ["other"],
  asOf: "2026-08-04T00:00:00.000Z",
  maximumAgeMinutes: 15,
  minimumComparisonBooks: 1,
} as const;

describe("exact evaluation evidence reader", () => {
  it("strongly resolves CURRENT and rereads immutable snapshots while excluding target from consensus", async () => {
    const result = await new DynamoEvaluationEvidenceRepository(gateway).read(
      query,
    );
    expect(result.status).toBe("ready");
    expect(result.offered?.sportsbookId).toBe("target");
    expect(result.comparisons.map(({ sportsbookId }) => sportsbookId)).toEqual([
      "other",
    ]);
    expect(getExactMock).toHaveBeenCalledTimes(8);
  });
  it("fails closed on a sparse or incomplete vector", async () => {
    const missing = {
      ...gateway,
      getExact: vi.fn((pk: string, sk: string) =>
        pk.includes('"home","other"')
          ? Promise.resolve(null)
          : getExact(pk, sk),
      ),
    } as FixtureOddsDynamoGateway;
    const result = await new DynamoEvaluationEvidenceRepository(missing).read(
      query,
    );
    expect(result.status).toBe("invalid");
    expect(result.reasonCodes).toEqual(
      expect.arrayContaining(["comparison-incomplete", "comparison-sparse"]),
    );
  });
  it("rejects duplicate books, duplicate selections, and future evidence", async () => {
    const repository = new DynamoEvaluationEvidenceRepository(gateway);
    await expect(
      repository.read({
        ...query,
        comparisonSportsbookIds: ["other", "other"],
      }),
    ).rejects.toThrow("evidence-comparison-books-invalid");
    await expect(
      repository.read({
        ...query,
        selections: [{ selectionKey: "home" }, { selectionKey: "home" }],
      }),
    ).rejects.toThrow("evidence-selection-vector-invalid");
    const future = await repository.read({
      ...query,
      asOf: "2026-08-03T23:57:00.000Z",
    });
    expect(future.status).toBe("invalid");
    expect(future.reasonCodes).toContain("evidence-from-future");
  });
});
