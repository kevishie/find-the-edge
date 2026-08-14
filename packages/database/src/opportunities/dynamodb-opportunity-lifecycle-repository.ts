import {
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  type DynamoDBDocumentClient,
} from "@aws-sdk/lib-dynamodb";
import {
  createRankedOpportunityProjection,
  isOpportunityLifecycleHeadActive,
  normalizeOpportunityLifecycleHead,
  normalizeOpportunityLifecycleTransition,
  reduceOpportunityLifecycle,
  type OpportunityLifecycleCommand,
  type OpportunityLifecycleHead,
  type OpportunityLifecycleTransition,
  type OpportunityRankingPolicyContract,
} from "@find-the-edge/domain";
import {
  OpportunityLifecycleConflictError,
  type OpportunityLifecycleApplyResult,
  type OpportunityLifecycleDiscoveryPage,
  type OpportunityLifecycleEventFence,
  type OpportunityLifecycleRepository,
  type OpportunityLifecycleSweepMode,
} from "./opportunity-lifecycle-repository";

export const OPPORTUNITY_ACTIVE_INDEX = "opportunity-active-v1";
const partition = (id: string) => `OPPORTUNITY_LIFECYCLE#${id}`;
const rankPartition = (id: string) => `OPPORTUNITY_RANK#${id}`;
const padded = (version: number) => String(version).padStart(16, "0");

export class DynamoOpportunityLifecycleRepository implements OpportunityLifecycleRepository {
  constructor(
    private readonly client: DynamoDBDocumentClient,
    private readonly tableName: string,
  ) {}
  async get(logicalOpportunityId: string) {
    const result = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { pk: partition(logicalOpportunityId), sk: "HEAD" },
        // State-version transitions and stale-index filtering require the head winner.
        ConsistentRead: true,
      }),
    );
    if (result.Item?.["value"] === undefined) return null;
    const head = normalizeOpportunityLifecycleHead(
      result.Item["value"] as OpportunityLifecycleHead,
    );
    if (head.logicalOpportunityId !== logicalOpportunityId)
      throw new Error("opportunity-lifecycle-key-mismatch");
    return head;
  }
  async apply(
    command: OpportunityLifecycleCommand,
    fence: OpportunityLifecycleEventFence,
    rankingPolicy?: OpportunityRankingPolicyContract,
  ): Promise<OpportunityLifecycleApplyResult> {
    const existing = await this.get(command.candidate.logicalOpportunityId);
    const decision = reduceOpportunityLifecycle(existing, command);
    if (decision.outcome !== "applied")
      return { outcome: decision.outcome, head: decision.head };
    const rankProjection =
      decision.head.state === "active"
        ? rankingPolicy
          ? createRankedOpportunityProjection(
              command.candidate,
              decision.head,
              rankingPolicy,
            )
          : null
        : null;
    if (decision.head.state === "active" && !rankProjection)
      throw new Error("opportunity-ranking-policy-required");
    try {
      await this.client.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              ConditionCheck: {
                TableName: this.tableName,
                Key: { pk: fence.pk, sk: fence.sk },
                ConditionExpression:
                  fence.expectedMaterialVersion === null
                    ? "attribute_not_exists(pk)"
                    : "#value.#materialVersion = :eventVersion",
                ...(fence.expectedMaterialVersion === null
                  ? {}
                  : {
                      ExpressionAttributeNames: {
                        "#value": "value",
                        "#materialVersion": "materialVersion",
                      },
                      ExpressionAttributeValues: {
                        ":eventVersion": fence.expectedMaterialVersion,
                      },
                    }),
              },
            },
            {
              Put: {
                TableName: this.tableName,
                Item: {
                  pk: partition(decision.head.logicalOpportunityId),
                  sk: "HEAD",
                  value: decision.head,
                  ...(decision.head.state === "active"
                    ? {
                        activePk: decision.head.activePk,
                        activeSk: decision.head.activeSk,
                      }
                    : {}),
                },
                ConditionExpression: existing
                  ? "#value.#stateVersion = :expected"
                  : "attribute_not_exists(pk)",
                ...(existing
                  ? {
                      ExpressionAttributeNames: {
                        "#value": "value",
                        "#stateVersion": "stateVersion",
                      },
                      ExpressionAttributeValues: {
                        ":expected": existing.stateVersion,
                      },
                    }
                  : {}),
              },
            },
            {
              Put: {
                TableName: this.tableName,
                Item: {
                  pk: partition(decision.head.logicalOpportunityId),
                  sk: `TRANSITION#${padded(decision.transition.stateVersion)}#${decision.transition.transitionId}`,
                  value: decision.transition,
                },
                ConditionExpression: "attribute_not_exists(pk)",
              },
            },
            rankProjection
              ? {
                  Put: {
                    TableName: this.tableName,
                    Item: {
                      pk: rankPartition(decision.head.logicalOpportunityId),
                      sk: "CURRENT",
                      rankPk: rankProjection.rankPartition,
                      rankSk: rankProjection.rankKey,
                      value: rankProjection,
                    },
                  },
                }
              : {
                  Delete: {
                    TableName: this.tableName,
                    Key: {
                      pk: rankPartition(decision.head.logicalOpportunityId),
                      sk: "CURRENT",
                    },
                  },
                },
          ],
        }),
      );
      return {
        outcome: "applied",
        head: decision.head,
        transition: decision.transition,
      };
    } catch (error) {
      if (
        !(error instanceof Error) ||
        ![
          "TransactionCanceledException",
          "ConditionalCheckFailedException",
        ].includes(error.name)
      )
        throw error;
      const winner = await this.get(command.candidate.logicalOpportunityId);
      if (winner?.lastCommandId === command.commandId)
        return { outcome: "duplicate", head: winner };
      throw new OpportunityLifecycleConflictError(
        "opportunity-lifecycle-transition-conflict",
      );
    }
  }
  async history(logicalOpportunityId: string) {
    const transitions: OpportunityLifecycleTransition[] = [];
    let cursor: Record<string, unknown> | undefined;
    do {
      const result = await this.client.send(
        new QueryCommand({
          TableName: this.tableName,
          KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
          ExpressionAttributeValues: {
            ":pk": partition(logicalOpportunityId),
            ":prefix": "TRANSITION#",
          },
          // Transition history is immutable diagnostic data; lifecycle head
          // transitions, ranking, and sweep checkpoints remain strong.
          ConsistentRead: false,
          ...(cursor ? { ExclusiveStartKey: cursor } : {}),
        }),
      );
      transitions.push(
        ...(result.Items ?? []).map((item) =>
          normalizeOpportunityLifecycleTransition(
            item["value"] as OpportunityLifecycleTransition,
          ),
        ),
      );
      cursor = result.LastEvaluatedKey as Record<string, unknown> | undefined;
    } while (cursor);
    return Object.freeze(transitions);
  }
  async discoverActive(input: {
    readonly sportKey: string;
    readonly asOf: string;
    readonly through?: string;
    readonly limit: number;
    readonly cursor?: string;
  }): Promise<OpportunityLifecycleDiscoveryPage> {
    if (
      !Number.isSafeInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > 100 ||
      new Date(input.asOf).toISOString() !== input.asOf ||
      (input.through !== undefined &&
        new Date(input.through).toISOString() !== input.through)
    )
      throw new Error("opportunity-lifecycle-limit-invalid");
    const result = await this.client.send(
      new QueryCommand({
        TableName: this.tableName,
        IndexName: OPPORTUNITY_ACTIVE_INDEX,
        KeyConditionExpression: input.through
          ? "activePk = :pk AND activeSk <= :through"
          : "activePk = :pk",
        ExpressionAttributeValues: {
          ":pk": `ACTIVE_OPPORTUNITY#${input.sportKey}`,
          ...(input.through ? { ":through": `${input.through}#~` } : {}),
        },
        Limit: input.limit,
        ...(input.cursor
          ? {
              ExclusiveStartKey: JSON.parse(
                Buffer.from(input.cursor, "base64url").toString("utf8"),
              ) as Record<string, unknown>,
            }
          : {}),
      }),
    );
    const items: OpportunityLifecycleHead[] = [];
    const staleActiveKeys: string[] = [];
    const discoveryFailureKeys: string[] = [];
    for (const rawRow of result.Items ?? []) {
      const row = rawRow as Record<string, unknown>;
      const rowPk: unknown = row["pk"];
      if (
        typeof rowPk !== "string" ||
        !rowPk.startsWith("OPPORTUNITY_LIFECYCLE#")
      ) {
        const key = JSON.stringify(row);
        staleActiveKeys.push(key);
        discoveryFailureKeys.push(key);
        continue;
      }
      let head: OpportunityLifecycleHead | null;
      try {
        head = await this.get(rowPk.slice("OPPORTUNITY_LIFECYCLE#".length));
      } catch {
        const key = JSON.stringify({
          pk: row["pk"],
          sk: row["sk"],
          activePk: row["activePk"],
          activeSk: row["activeSk"],
        });
        staleActiveKeys.push(key);
        discoveryFailureKeys.push(key);
        continue;
      }
      if (!head) {
        const key = JSON.stringify({
          pk: row["pk"],
          sk: row["sk"],
          activePk: row["activePk"],
          activeSk: row["activeSk"],
        });
        staleActiveKeys.push(key);
        discoveryFailureKeys.push(key);
        continue;
      }
      if (
        head.state !== "active" ||
        (!input.through && !isOpportunityLifecycleHeadActive(head, input.asOf))
      ) {
        staleActiveKeys.push(
          JSON.stringify({
            pk: row["pk"],
            sk: row["sk"],
            activePk: row["activePk"],
            activeSk: row["activeSk"],
          }),
        );
        continue;
      }
      items.push(head);
    }
    return {
      items: Object.freeze(items),
      nextCursor: result.LastEvaluatedKey
        ? Buffer.from(JSON.stringify(result.LastEvaluatedKey)).toString(
            "base64url",
          )
        : null,
      staleActiveCount: staleActiveKeys.length,
      staleActiveKeys: Object.freeze(staleActiveKeys),
      discoveryFailureCount: discoveryFailureKeys.length,
      discoveryFailureKeys: Object.freeze(discoveryFailureKeys),
    };
  }
  async getSweepCursor(sportKey: string, mode: OpportunityLifecycleSweepMode) {
    const result = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: {
          pk: `OPPORTUNITY_LIFECYCLE_SWEEP#${sportKey}`,
          sk: `CHECKPOINT#${mode}`,
        },
        // Sweep continuation must not replay from an older checkpoint.
        ConsistentRead: true,
      }),
    );
    const cursor: unknown = result.Item?.["cursor"];
    if (cursor === undefined || cursor === null) return null;
    if (typeof cursor !== "string" || cursor.length === 0)
      throw new Error("opportunity-sweep-checkpoint-invalid");
    return cursor;
  }
  async setSweepCursor(input: {
    readonly sportKey: string;
    readonly mode: OpportunityLifecycleSweepMode;
    readonly cursor: string | null;
    readonly updatedAt: string;
  }) {
    if (new Date(input.updatedAt).toISOString() !== input.updatedAt)
      throw new Error("opportunity-sweep-checkpoint-invalid");
    await this.client.send(
      new PutCommand({
        TableName: this.tableName,
        Item: {
          pk: `OPPORTUNITY_LIFECYCLE_SWEEP#${input.sportKey}`,
          sk: `CHECKPOINT#${input.mode}`,
          cursor: input.cursor,
          updatedAt: input.updatedAt,
        },
      }),
    );
  }
  async reconcileRankProjection(input: {
    readonly head: OpportunityLifecycleHead;
    readonly candidate: import("@find-the-edge/domain").OpportunityCandidate;
    readonly fence: OpportunityLifecycleEventFence;
    readonly rankingPolicy: OpportunityRankingPolicyContract;
  }): Promise<"projected" | "inactive" | "conflict"> {
    if (input.head.state !== "active") {
      if (
        input.candidate.logicalOpportunityId !==
          input.head.logicalOpportunityId ||
        input.candidate.occurrenceId !== input.head.latestCandidateOccurrenceId
      )
        return "conflict";
      try {
        await this.client.send(
          new TransactWriteCommand({
            TransactItems: [
              {
                ConditionCheck: {
                  TableName: this.tableName,
                  Key: {
                    pk: partition(input.head.logicalOpportunityId),
                    sk: "HEAD",
                  },
                  ConditionExpression:
                    "#value.#state = :state AND #value.#stateVersion = :version AND #value.#latest = :occurrence",
                  ExpressionAttributeNames: {
                    "#value": "value",
                    "#state": "state",
                    "#stateVersion": "stateVersion",
                    "#latest": "latestCandidateOccurrenceId",
                  },
                  ExpressionAttributeValues: {
                    ":state": input.head.state,
                    ":version": input.head.stateVersion,
                    ":occurrence": input.candidate.occurrenceId,
                  },
                },
              },
              {
                Delete: {
                  TableName: this.tableName,
                  Key: {
                    pk: rankPartition(input.head.logicalOpportunityId),
                    sk: "CURRENT",
                  },
                },
              },
            ],
          }),
        );
        return "inactive";
      } catch (error) {
        if (
          error instanceof Error &&
          [
            "TransactionCanceledException",
            "ConditionalCheckFailedException",
          ].includes(error.name)
        )
          return "conflict";
        throw error;
      }
    }
    const projection = createRankedOpportunityProjection(
      input.candidate,
      input.head,
      input.rankingPolicy,
    );
    try {
      await this.client.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              ConditionCheck: {
                TableName: this.tableName,
                Key: { pk: input.fence.pk, sk: input.fence.sk },
                ConditionExpression:
                  input.fence.expectedMaterialVersion === null
                    ? "attribute_not_exists(pk)"
                    : "#value.#materialVersion = :eventVersion",
                ...(input.fence.expectedMaterialVersion === null
                  ? {}
                  : {
                      ExpressionAttributeNames: {
                        "#value": "value",
                        "#materialVersion": "materialVersion",
                      },
                      ExpressionAttributeValues: {
                        ":eventVersion": input.fence.expectedMaterialVersion,
                      },
                    }),
              },
            },
            {
              ConditionCheck: {
                TableName: this.tableName,
                Key: {
                  pk: partition(input.head.logicalOpportunityId),
                  sk: "HEAD",
                },
                ConditionExpression:
                  "#value.#state = :active AND #value.#stateVersion = :version AND #value.#latest = :occurrence",
                ExpressionAttributeNames: {
                  "#value": "value",
                  "#state": "state",
                  "#stateVersion": "stateVersion",
                  "#latest": "latestCandidateOccurrenceId",
                },
                ExpressionAttributeValues: {
                  ":active": "active",
                  ":version": input.head.stateVersion,
                  ":occurrence": input.candidate.occurrenceId,
                },
              },
            },
            {
              Put: {
                TableName: this.tableName,
                Item: {
                  pk: rankPartition(input.head.logicalOpportunityId),
                  sk: "CURRENT",
                  rankPk: projection.rankPartition,
                  rankSk: projection.rankKey,
                  value: projection,
                },
              },
            },
          ],
        }),
      );
      return "projected";
    } catch (error) {
      if (
        error instanceof Error &&
        [
          "TransactionCanceledException",
          "ConditionalCheckFailedException",
        ].includes(error.name)
      )
        return "conflict";
      throw error;
    }
  }
}
