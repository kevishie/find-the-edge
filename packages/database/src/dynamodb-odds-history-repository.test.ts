import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it, vi } from "vitest";
import { normalizeFixtureOddsObservation } from "@find-the-edge/domain";
import { impliedProbability } from "@find-the-edge/odds";
import { DynamoOddsHistoryRepository } from "./dynamodb-odds-history-repository";
import { EventCursorCodec } from "./event-repository";
import { oddsHistoryPartition } from "./odds-history-repository";

describe("Dynamo odds history repository", () => {
  it("allows an eventual page to omit immutable history before convergence", async () => {
    const observation = (input: {
      readonly point: number;
      readonly americanOdds: number;
      readonly observedAt: string;
      readonly retrievedAt: string;
    }) =>
      normalizeFixtureOddsObservation({
        canonicalEventId: "event:mlb:history",
        canonicalEventVersion: 3,
        sportKey: "mlb",
        marketKey: "total",
        selectionKey: "over",
        selectionLabel: "Over",
        sportsbookId: "pinnacle",
        sportsbookLabel: "Pinnacle",
        ...input,
        provenance: {
          providerId: "sharpapi",
          policyVersion: "v1",
          bookRole: "comparison",
          sourceState: "active",
        },
      });
    const value = observation({
      point: 8.5,
      americanOdds: -105,
      observedAt: "2026-08-05T12:00:00.000Z",
      retrievedAt: "2026-08-05T12:00:01.000Z",
    });
    const newest = observation({
      point: 9,
      americanOdds: -110,
      observedAt: "2026-08-05T12:30:00.000Z",
      retrievedAt: "2026-08-05T12:30:01.000Z",
    });
    const row = (stored: typeof value) => ({
      pk: oddsHistoryPartition(stored.canonicalEventId),
      sk: stored.sortKey,
      value: stored,
    });
    const send = vi
      .fn()
      .mockResolvedValueOnce({ Items: [row(value)] })
      .mockResolvedValueOnce({ Items: [row(value), row(newest)] });
    const repository = new DynamoOddsHistoryRepository(
      { send } as unknown as DynamoDBDocumentClient,
      "events",
      new EventCursorCodec({
        current: { id: "test", secret: new Uint8Array(32).fill(8) },
      }),
      { pinnacle: "Pinnacle" },
      impliedProbability,
      () => new Date("2026-08-05T13:00:00.000Z"),
    );
    const input = {
      eventId: value.canonicalEventId,
      canonicalEventVersion: value.canonicalEventVersion,
      from: "2026-08-05T11:00:00.000Z",
      to: "2026-08-05T13:00:00.000Z",
      limit: 25,
    };
    await expect(repository.list(input)).resolves.toMatchObject({
      series: [{ sportsbookId: "pinnacle", points: [{ point: 8.5 }] }],
    });
    await expect(repository.list(input)).resolves.toMatchObject({
      series: [
        {
          sportsbookId: "pinnacle",
          points: [{ point: 8.5 }, { point: 9 }],
        },
      ],
    });
    const command = send.mock.calls[0]?.[0] as {
      input: Record<string, unknown>;
    };
    expect(command.input).toMatchObject({
      TableName: "events",
      ConsistentRead: false,
      ScanIndexForward: true,
      Limit: 26,
      KeyConditionExpression: "pk = :pk AND sk BETWEEN :from AND :to",
      ExpressionAttributeValues: {
        ":pk": `ODDS_HISTORY#${value.canonicalEventId}`,
      },
    });
    expect(
      (
        send.mock.calls as unknown as readonly [
          { readonly constructor: { readonly name: string } },
        ][]
      ).map(([command]) => command.constructor.name),
    ).toEqual(["QueryCommand", "QueryCommand"]);
    expect(
      (send.mock.calls[1]?.[0] as { input: Record<string, unknown> }).input,
    ).toMatchObject({ ConsistentRead: false });
  });
});
