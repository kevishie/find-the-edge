import { describe, expect, it, vi } from "vitest";
import { DynamoCohortRepository } from "./dynamodb-cohort-repository.js";
const definition = {
  window: { from: "2026-07-01T00:00:00.000Z", to: "2026-08-01T00:00:00.000Z" },
  filters: { wagerMode: "paper" as const },
  policyVersions: {
    cohort: "cohort-v1" as const,
    performance: "performance-v1" as const,
    oddsBand: "odds-band-v1" as const,
    calibration: "calibration-deciles-v1" as const,
    clv: "clv-same-book-15m-v1" as const,
  },
};
const member = (id: string) => ({
  paperBetId: `paper-bet:${id.repeat(64)}`,
  evaluationId: `evaluation:${id.repeat(64)}`,
  gradeId: `paper-grade:${id.repeat(64)}`,
  resultObservationId: `result:${id.repeat(64)}`,
  openingSnapshotId: id.repeat(64),
  closingSnapshotId: null,
});
describe("Dynamo cohort repository", () =>
  it("finalizes only after paginating every immutable member", async () => {
    const rows = new Map<string, unknown>();
    let queryPage = 0;
    const send = vi.fn(async (command: { input: Record<string, unknown> }) => {
      await Promise.resolve();
      const input = command.input;
      if ("Item" in input) {
        const item = input["Item"] as {
          pk: string;
          sk: string;
          value: unknown;
        };
        const key = `${item.pk}|${item.sk}`;
        if (rows.has(key)) {
          const error = new Error("conditional");
          error.name = "ConditionalCheckFailedException";
          throw error;
        }
        rows.set(key, item.value);
        return {};
      }
      if (
        "KeyConditionExpression" in input &&
        String(input["KeyConditionExpression"]).includes("begins_with")
      ) {
        const values = [...rows.entries()]
          .filter(([key]) => key.includes("|MEMBER#"))
          .map(([, value]) => ({ value }));
        if (queryPage++ === 0)
          return {
            Items: values.slice(0, 1),
            LastEvaluatedKey: { pk: "p", sk: "one" },
          };
        return { Items: values.slice(1) };
      }
      if ("Key" in input) {
        const key = input["Key"] as { pk: string; sk: string };
        return { Item: { value: rows.get(`${key.pk}|${key.sk}`) } };
      }
      return { Items: [] };
    });
    const repo = new DynamoCohortRepository({ send } as never, "table"),
      result = await repo.putCohort({
        definition,
        cutoff: "2026-08-02T00:00:00.000Z",
        members: [member("a"), member("b")],
      });
    expect(result.members).toHaveLength(2);
    expect(
      [...rows.keys()].filter((key) => key.includes("|MEMBER#")),
    ).toHaveLength(2);
    expect(queryPage).toBe(2);
  }));
