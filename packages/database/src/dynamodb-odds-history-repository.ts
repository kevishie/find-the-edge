import {
  QueryCommand,
  type DynamoDBDocumentClient,
} from "@aws-sdk/lib-dynamodb";
import {
  JoinedOddsHistoryRepository,
  type OddsHistoryProbabilityProjector,
  type OddsHistoryStoredRow,
} from "./odds-history-repository";
import type { EventCursorCodec } from "./event-repository";

export class DynamoOddsHistoryRepository extends JoinedOddsHistoryRepository {
  constructor(
    client: DynamoDBDocumentClient,
    tableName: string,
    cursor: EventCursorCodec,
    approvedSportsbooks: Readonly<Record<string, string>>,
    projectImpliedProbability: OddsHistoryProbabilityProjector,
    now: () => Date = () => new Date(),
  ) {
    super(
      {
        query: async (input) => {
          const result = await client.send(
            new QueryCommand({
              TableName: tableName,
              KeyConditionExpression: "pk = :pk AND sk BETWEEN :from AND :to",
              ExpressionAttributeValues: {
                ":pk": input.pk,
                ":from": input.fromSk,
                ":to": input.toSk,
              },
              // History rows are immutable and timestamped; a stale replica
              // may omit a recent chart point but cannot change evidence.
              ConsistentRead: false,
              ScanIndexForward: true,
              Limit: input.limit,
              ...(input.startSk
                ? {
                    ExclusiveStartKey: {
                      pk: input.pk,
                      sk: input.startSk,
                    },
                  }
                : {}),
            }),
          );
          return {
            items: (result.Items as OddsHistoryStoredRow[] | undefined) ?? [],
            hasMore: result.LastEvaluatedKey !== undefined,
          };
        },
      },
      cursor,
      approvedSportsbooks,
      projectImpliedProbability,
      now,
    );
  }
}
