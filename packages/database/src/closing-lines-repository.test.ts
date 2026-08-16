import {
  CLOSING_BOOK_SCHEMA_VERSION,
  createClosingLinesRecord,
  type ClosingBookRecord,
} from "@find-the-edge/domain";
import { describe, expect, it } from "vitest";
import {
  DynamoClosingLinesRepository,
  MemoryClosingLinesRepository,
  projectFinalizedClosingSelections,
} from "./closing-lines-repository";

const record = (
  sportsbookId: string,
  odds: readonly [number, number] = [120, -135],
): ClosingBookRecord => ({
  schemaVersion: CLOSING_BOOK_SCHEMA_VERSION,
  canonicalEventId: "event-1",
  canonicalEventVersion: 2,
  providerId: "sharpapi",
  providerEventId: "provider-event-1",
  sportKey: "mlb",
  leagueKey: "mlb",
  startsAt: "2026-08-10T23:10:00.000Z",
  sportsbookId,
  providerSportsbookId: sportsbookId,
  capturedAt: "2026-08-10T23:10:00.000Z",
  retrievedAt: "2026-08-10T23:20:00.000Z",
  captureTrigger: "kickoff",
  isFinal: true,
  selections: [
    {
      marketKey: "moneyline",
      selectionKey: "participant:away",
      sportsbookId,
      americanOdds: odds[0],
      observedAt: "2026-08-10T23:09:00.000Z",
      retrievedAt: "2026-08-10T23:20:00.000Z",
    },
    {
      marketKey: "moneyline",
      selectionKey: "participant:home",
      sportsbookId,
      americanOdds: odds[1],
      observedAt: "2026-08-10T23:09:00.000Z",
      retrievedAt: "2026-08-10T23:20:00.000Z",
    },
  ],
});

describe("closing lines repository", () => {
  it("retains the newest exact provider binding", async () => {
    const repository = new MemoryClosingLinesRepository();
    const base = {
      canonicalEventId: "event-1",
      canonicalEventVersion: 2,
      providerId: "sharpapi" as const,
      providerEventId: "new-id",
      sportKey: "mlb",
      leagueKey: "mlb",
      startsAt: "2026-08-10T23:10:00.000Z",
      observedAt: "2026-08-10T22:00:00.000Z",
    };
    expect(await repository.bind(base)).toBe("updated");
    expect(
      await repository.bind({
        ...base,
        providerEventId: "stale-id",
        observedAt: "2026-08-10T21:00:00.000Z",
      }),
    ).toBe("retained");
    expect((await repository.getBinding("event-1"))?.providerEventId).toBe(
      "new-id",
    );
    expect(
      (await repository.listBindings("event-1")).map(
        ({ providerEventId }) => providerEventId,
      ),
    ).toEqual(["new-id", "stale-id"]);
  });

  it("bounds retained provider binding history", async () => {
    const repository = new MemoryClosingLinesRepository();
    for (let index = 0; index < 12; index += 1)
      await repository.bind({
        canonicalEventId: "event-1",
        canonicalEventVersion: index + 1,
        providerId: "sharpapi",
        providerEventId: `provider-${index}`,
        sportKey: "mlb",
        leagueKey: "mlb",
        startsAt: "2026-08-10T23:10:00.000Z",
        observedAt: `2026-08-10T22:${String(index).padStart(2, "0")}:00.000Z`,
      });
    expect(await repository.listBindings("event-1")).toHaveLength(8);
  });

  it("never overwrites a finalized book", async () => {
    const repository = new MemoryClosingLinesRepository();
    expect(await repository.finalizeBook(record("hardrock"))).toBe("created");
    expect(await repository.finalizeBook(record("hardrock"))).toBe("exists");
    await expect(
      repository.finalizeBook(record("hardrock", [125, -140])),
    ).rejects.toThrow("closing-book-finalization-conflict");
  });

  it("treats reordered immutable selections as an idempotent replay", async () => {
    const repository = new MemoryClosingLinesRepository();
    const original = record("hardrock");
    const reordered = {
      ...original,
      selections: [...original.selections].reverse(),
    };
    expect(await repository.finalizeBook(original)).toBe("created");
    expect(await repository.finalizeBook(reordered)).toBe("exists");
  });

  it("reads the exact Dynamo book key when resolving a replay", async () => {
    const exact = record("hardrock");
    const client = {
      send: (command: { input?: { ConditionExpression?: string } }) => {
        if (command.input?.ConditionExpression) {
          const error = new Error("conditional");
          error.name = "ConditionalCheckFailedException";
          return Promise.reject(error);
        }
        return Promise.resolve({ Item: { value: exact } });
      },
    };
    const repository = new DynamoClosingLinesRepository(
      client as never,
      "table",
    );
    await expect(repository.finalizeBook(exact)).resolves.toBe("exists");
  });

  it("rejects malformed canonical market pairs", async () => {
    const repository = new MemoryClosingLinesRepository();
    const original = record("hardrock");
    await expect(
      repository.finalizeBook({
        ...original,
        selections: original.selections.map((selection, index) => ({
          ...selection,
          marketKey: "spread",
          point: index === 0 ? 1.5 : -2.5,
        })),
      }),
    ).rejects.toThrow("closing-book-market-invalid");
  });

  it("allows finalized backfill captures throughout provider retention", () => {
    expect(() =>
      createClosingLinesRecord({
        canonicalEventId: "event-1",
        canonicalEventVersion: 2,
        sportKey: "mlb",
        leagueKey: "mlb",
        startsAt: "2026-08-10T23:10:00.000Z",
        capturedAt: "2026-08-11T23:10:00.000Z",
        selections: record("hardrock").selections,
      }),
    ).not.toThrow();
  });

  it("projects the display close and only an exact complete sharp anchor", () => {
    const projected = projectFinalizedClosingSelections(
      [record("hardrock"), record("pinnacle", [118, -124])],
      ["hardrock", "pinnacle"],
    );
    expect(projected).toMatchObject([
      { sportsbookId: "hardrock", americanOdds: 120, sharpAmericanOdds: 118 },
      { sportsbookId: "hardrock", americanOdds: -135, sharpAmericanOdds: -124 },
    ]);
  });

  it("never mixes display and anchor books from different provider events", () => {
    const display = record("hardrock");
    const anchor = {
      ...record("pinnacle", [118, -124]),
      providerEventId: "provider-event-2",
      retrievedAt: "2026-08-10T23:21:00.000Z",
    };
    expect(
      projectFinalizedClosingSelections(
        [display, anchor],
        ["hardrock", "pinnacle"],
      ),
    ).toMatchObject([
      { sportsbookId: "hardrock", americanOdds: 120 },
      { sportsbookId: "hardrock", americanOdds: -135 },
    ]);
    expect(
      projectFinalizedClosingSelections(
        [display, anchor],
        ["hardrock", "pinnacle"],
      )?.some(({ sharpAmericanOdds }) => sharpAmericanOdds !== undefined),
    ).toBe(false);
  });
});
