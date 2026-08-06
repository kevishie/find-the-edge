import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it, vi } from "vitest";
import { normalizeFixtureOddsObservation } from "@find-the-edge/domain";
import { DynamoOddsHistoryRepository } from "./dynamodb-odds-history-repository";
import { EventCursorCodec } from "./event-repository";
import { oddsHistoryPartition } from "./odds-history-repository";

describe("Dynamo odds history repository", () => {
  it("uses a bounded, strongly consistent event-history query", async () => {
    const value = normalizeFixtureOddsObservation({
      canonicalEventId: "event:mlb:history",
      canonicalEventVersion: 3,
      sportKey: "mlb",
      marketKey: "total",
      selectionKey: "over",
      selectionLabel: "Over",
      sportsbookId: "pinnacle",
      sportsbookLabel: "Pinnacle",
      point: 8.5,
      americanOdds: -105,
      observedAt: "2026-08-05T12:00:00.000Z",
      retrievedAt: "2026-08-05T12:00:01.000Z",
    });
    const send = vi.fn().mockResolvedValue({
      Items: [
        {
          pk: oddsHistoryPartition(value.canonicalEventId),
          sk: value.sortKey,
          value,
        },
      ],
    });
    const repository = new DynamoOddsHistoryRepository(
      { send } as unknown as DynamoDBDocumentClient,
      "events",
      new EventCursorCodec({
        current: { id: "test", secret: new Uint8Array(32).fill(8) },
      }),
      { pinnacle: "Pinnacle" },
      () => new Date("2026-08-05T13:00:00.000Z"),
    );
    await expect(
      repository.list({
        eventId: value.canonicalEventId,
        canonicalEventVersion: value.canonicalEventVersion,
        from: "2026-08-05T11:00:00.000Z",
        to: "2026-08-05T13:00:00.000Z",
        limit: 25,
      }),
    ).resolves.toMatchObject({
      series: [{ sportsbookId: "pinnacle", points: [{ point: 8.5 }] }],
    });
    const command = send.mock.calls[0]?.[0] as {
      input: Record<string, unknown>;
    };
    expect(command.input).toMatchObject({
      TableName: "events",
      ConsistentRead: true,
      ScanIndexForward: true,
      Limit: 26,
      KeyConditionExpression: "pk = :pk AND sk BETWEEN :from AND :to",
      ExpressionAttributeValues: {
        ":pk": `ODDS_HISTORY#${value.canonicalEventId}`,
      },
    });
  });
});
