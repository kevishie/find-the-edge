import {
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  type DynamoDBDocumentClient,
} from "@aws-sdk/lib-dynamodb";
import {
  approveStrategyExperiment,
  createStrategyActivation,
  stableCohortValue,
  type StrategyActivation,
  type StrategyArtifact,
  type StrategyExperiment,
  type StrategyPromotionDecision,
} from "@find-the-edge/domain";
import type { EventCursorCodec } from "./event-repository.js";
import {
  StrategyExperimentConflictError,
  StrategyExperimentNotFoundError,
  type StrategyExperimentRepository,
} from "./strategy-experiment-repository.js";

const conditional = (error: unknown) =>
  error instanceof Error &&
  ["ConditionalCheckFailedException", "TransactionCanceledException"].includes(
    error.name,
  );
export class DynamoDbStrategyExperimentRepository implements StrategyExperimentRepository {
  constructor(
    private readonly client: DynamoDBDocumentClient,
    private readonly tableName: string,
    private readonly cursors: EventCursorCodec,
  ) {}
  private async get(pk: string, sk: string) {
    const result = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { pk, sk },
        ConsistentRead: true,
      }),
    );
    return result.Item?.["value"] as unknown;
  }
  async putArtifact(value: StrategyArtifact) {
    try {
      await this.client.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Put: {
                TableName: this.tableName,
                Item: {
                  pk: `STRATEGY#${value.strategyId}`,
                  sk: `ARTIFACT#${value.version}`,
                  value,
                },
                ConditionExpression:
                  "attribute_not_exists(pk) AND attribute_not_exists(sk)",
              },
            },
          ],
        }),
      );
      return value;
    } catch (error) {
      if (!conditional(error)) throw error;
      const current = await this.getArtifact(value.strategyId, value.version);
      if (current && stableCohortValue(current) === stableCohortValue(value))
        return current;
      throw new StrategyExperimentConflictError("strategy-artifact-conflict");
    }
  }
  async getArtifact(strategyId: string, version: string) {
    return (await this.get(
      `STRATEGY#${strategyId}`,
      `ARTIFACT#${version}`,
    )) as StrategyArtifact | null;
  }
  async putExperiment(value: StrategyExperiment) {
    const evidence =
      value.state === "failed" ? [] : [value.tune.digest, value.holdout.digest];
    try {
      await this.client.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Put: {
                TableName: this.tableName,
                Item: {
                  pk: `EXPERIMENT#${value.experimentId}`,
                  sk: "RECORD",
                  value,
                },
                ConditionExpression: "attribute_not_exists(pk)",
              },
            },
            {
              Put: {
                TableName: this.tableName,
                Item: {
                  pk: "EXPERIMENTS",
                  sk: `${value.createdAt}#${value.experimentId}`,
                  value: {
                    experimentId: value.experimentId,
                    strategyId: value.challenger.strategyId,
                    state: value.state,
                  },
                },
                ConditionExpression:
                  "attribute_not_exists(pk) AND attribute_not_exists(sk)",
              },
            },
            ...evidence.map((digest) => ({
              Put: {
                TableName: this.tableName,
                Item: {
                  pk: `STRATEGY_EVIDENCE#${value.challenger.strategyId}`,
                  sk: digest,
                  value: { experimentId: value.experimentId },
                },
                ConditionExpression:
                  "attribute_not_exists(pk) AND attribute_not_exists(sk)",
              },
            })),
          ],
        }),
      );
      return value;
    } catch (error) {
      if (!conditional(error)) throw error;
      const current = await this.getExperiment(value.experimentId);
      if (current && stableCohortValue(current) === stableCohortValue(value))
        return current;
      throw new StrategyExperimentConflictError("strategy-experiment-conflict");
    }
  }
  async getExperiment(id: string) {
    return (await this.get(
      `EXPERIMENT#${id}`,
      "RECORD",
    )) as StrategyExperiment | null;
  }
  async listExperiments(input: {
    strategyId?: string;
    state?: StrategyExperiment["state"];
    limit: number;
    cursor?: string;
  }) {
    if (
      !Number.isSafeInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > 50
    )
      throw new Error("strategy-experiment-limit-invalid");
    const scope = JSON.stringify({
        strategyId: input.strategyId ?? null,
        state: input.state ?? null,
      }),
      start = input.cursor
        ? this.cursors.decode(input.cursor, `STRATEGY_EXPERIMENT#${scope}`)
            .lastSk
        : undefined;
    const result = await this.client.send(
      new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: "pk = :pk" + (start ? " AND sk > :after" : ""),
        ExpressionAttributeValues: {
          ":pk": "EXPERIMENTS",
          ...(start ? { ":after": start } : {}),
        },
        Limit: input.limit,
      }),
    );
    const refs = (result.Items ?? [])
      .map(
        (item) =>
          item["value"] as {
            experimentId: string;
            strategyId: string;
            state: StrategyExperiment["state"];
          },
      )
      .filter(
        (item) =>
          (!input.strategyId || item.strategyId === input.strategyId) &&
          (!input.state || item.state === input.state),
      );
    const items = (
      await Promise.all(refs.map((ref) => this.getExperiment(ref.experimentId)))
    ).filter((item): item is StrategyExperiment => !!item);
    const lastSk = result.LastEvaluatedKey?.["sk"] as string | undefined;
    return {
      items,
      ...(lastSk
        ? {
            nextCursor: this.cursors.encode(
              `STRATEGY_EXPERIMENT#${scope}`,
              lastSk,
              new Date().toISOString(),
              new Date(),
            ),
          }
        : {}),
    };
  }
  async approve(input: Parameters<StrategyExperimentRepository["approve"]>[0]) {
    const replay = (await this.get(
      "STRATEGY_DECISION",
      input.idempotencyKey,
    )) as {
      experiment: StrategyExperiment;
      decision: StrategyPromotionDecision;
    } | null;
    if (replay) {
      if (
        replay.decision.experimentId !== input.experimentId ||
        replay.decision.promoterId !== input.promoterId ||
        replay.decision.reason !== input.reason ||
        replay.decision.decidedAt !== input.decidedAt ||
        replay.decision.experimentDigest !== input.expectedDigest ||
        replay.decision.artifactDigest !== input.artifactDigest ||
        replay.decision.stateVersion !== input.expectedStateVersion + 1
      )
        throw new StrategyExperimentConflictError(
          "strategy-promotion-idempotency-conflict",
        );
      return replay;
    }
    const current = await this.getExperiment(input.experimentId);
    if (!current)
      throw new StrategyExperimentNotFoundError(
        "strategy-experiment-not-found",
      );
    let approved;
    try {
      approved = approveStrategyExperiment(current, input);
    } catch {
      throw new StrategyExperimentConflictError("strategy-promotion-conflict");
    }
    try {
      await this.client.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Put: {
                TableName: this.tableName,
                Item: {
                  pk: "EXPERIMENTS",
                  sk: `${current.createdAt}#${current.experimentId}`,
                  value: {
                    experimentId: current.experimentId,
                    strategyId: current.challenger.strategyId,
                    state: approved.experiment.state,
                  },
                },
                ConditionExpression: "#value.#state = :expectedState",
                ExpressionAttributeNames: {
                  "#value": "value",
                  "#state": "state",
                },
                ExpressionAttributeValues: {
                  ":expectedState": "awaiting-approval",
                },
              },
            },
            {
              Put: {
                TableName: this.tableName,
                Item: {
                  pk: `EXPERIMENT#${input.experimentId}`,
                  sk: "RECORD",
                  value: approved.experiment,
                },
                ConditionExpression: "#value.#stateVersion = :expected",
                ExpressionAttributeNames: {
                  "#value": "value",
                  "#stateVersion": "stateVersion",
                },
                ExpressionAttributeValues: {
                  ":expected": input.expectedStateVersion,
                },
              },
            },
            {
              Put: {
                TableName: this.tableName,
                Item: {
                  pk: "STRATEGY_DECISION",
                  sk: input.idempotencyKey,
                  value: approved,
                },
                ConditionExpression:
                  "attribute_not_exists(pk) AND attribute_not_exists(sk)",
              },
            },
            {
              Put: {
                TableName: this.tableName,
                Item: {
                  pk: `STRATEGY_APPROVAL#${current.challenger.strategyId}`,
                  sk: current.challenger.digest,
                  value: approved.decision,
                },
                ConditionExpression:
                  "attribute_not_exists(pk) AND attribute_not_exists(sk)",
              },
            },
            {
              Put: {
                TableName: this.tableName,
                Item: {
                  pk: `EXPERIMENT_AUDIT#${input.experimentId}`,
                  sk: `${input.decidedAt}#${approved.decision.decisionId}`,
                  value: approved.decision,
                },
                ConditionExpression:
                  "attribute_not_exists(pk) AND attribute_not_exists(sk)",
              },
            },
          ],
        }),
      );
      return approved;
    } catch (error) {
      if (conditional(error))
        throw new StrategyExperimentConflictError(
          "strategy-promotion-conflict",
        );
      throw error;
    }
  }
  async activate(
    input: Parameters<StrategyExperimentRepository["activate"]>[0],
  ) {
    const replay = (await this.get(
      "STRATEGY_ACTIVATION",
      input.idempotencyKey,
    )) as StrategyActivation | null;
    if (replay) {
      if (
        replay.experimentId !== input.experimentId ||
        replay.strategyId !== input.strategyId ||
        replay.artifactVersion !== input.artifactVersion ||
        replay.artifactDigest !== input.artifactDigest ||
        replay.kind !== input.kind ||
        replay.effectiveAt !== input.effectiveAt ||
        replay.actorId !== input.actorId ||
        replay.reason !== input.reason ||
        replay.predecessorActivationId !== input.expectedActivationId
      )
        throw new StrategyExperimentConflictError(
          "strategy-activation-idempotency-conflict",
        );
      return replay;
    }
    const artifact = await this.getArtifact(
        input.strategyId,
        input.artifactVersion,
      ),
      experiment = await this.getExperiment(input.experimentId),
      current = (await this.get(
        `STRATEGY_ACTIVE_HEAD#${input.strategyId}`,
        "HEAD",
      )) as StrategyActivation | null;
    if (!artifact || !experiment)
      throw new StrategyExperimentNotFoundError(
        "strategy-activation-target-not-found",
      );
    if ((current?.activationId ?? null) !== input.expectedActivationId)
      throw new StrategyExperimentConflictError("strategy-activation-stale");
    const approval = (await this.get(
        `STRATEGY_APPROVAL#${input.strategyId}`,
        input.artifactDigest,
      )) as StrategyPromotionDecision | null,
      approved = approval ? [approval.artifactDigest] : [];
    let activation;
    try {
      activation = createStrategyActivation({
        ...input,
        predecessorActivationId: current?.activationId ?? null,
        artifact,
        approvedArtifactDigests: approved,
      });
    } catch {
      throw new StrategyExperimentConflictError("strategy-activation-invalid");
    }
    try {
      await this.client.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Put: {
                TableName: this.tableName,
                Item: {
                  pk: `EXPERIMENT#${experiment.experimentId}`,
                  sk: "RECORD",
                  value: {
                    ...experiment,
                    state: "active",
                    stateVersion: experiment.stateVersion + 1,
                  },
                },
                ConditionExpression:
                  "#value.#stateVersion = :expected AND #value.#state = :approved",
                ExpressionAttributeNames: {
                  "#value": "value",
                  "#stateVersion": "stateVersion",
                  "#state": "state",
                },
                ExpressionAttributeValues: {
                  ":expected": experiment.stateVersion,
                  ":approved": "approved",
                },
              },
            },
            {
              Put: {
                TableName: this.tableName,
                Item: {
                  pk: `STRATEGY_ACTIVE_HEAD#${input.strategyId}`,
                  sk: "HEAD",
                  value: activation,
                },
                ...(input.expectedActivationId
                  ? {
                      ConditionExpression: "#value.#activationId = :expected",
                      ExpressionAttributeNames: {
                        "#value": "value",
                        "#activationId": "activationId",
                      },
                      ExpressionAttributeValues: {
                        ":expected": input.expectedActivationId,
                      },
                    }
                  : {
                      ConditionExpression:
                        "attribute_not_exists(pk) AND attribute_not_exists(sk)",
                    }),
              },
            },
            {
              Put: {
                TableName: this.tableName,
                Item: {
                  pk: `STRATEGY_ACTIVE#${input.strategyId}`,
                  sk: `${input.effectiveAt}#${activation.activationId}`,
                  value: activation,
                },
                ConditionExpression:
                  "attribute_not_exists(pk) AND attribute_not_exists(sk)",
              },
            },
            {
              Put: {
                TableName: this.tableName,
                Item: {
                  pk: "EXPERIMENTS",
                  sk: `${experiment.createdAt}#${experiment.experimentId}`,
                  value: {
                    experimentId: experiment.experimentId,
                    strategyId: experiment.challenger.strategyId,
                    state: "active",
                  },
                },
                ConditionExpression:
                  "attribute_exists(pk) AND attribute_exists(sk)",
              },
            },
            {
              Put: {
                TableName: this.tableName,
                Item: {
                  pk: "STRATEGY_ACTIVATION",
                  sk: input.idempotencyKey,
                  value: activation,
                },
                ConditionExpression:
                  "attribute_not_exists(pk) AND attribute_not_exists(sk)",
              },
            },
            {
              Put: {
                TableName: this.tableName,
                Item: {
                  pk: `EXPERIMENT_AUDIT#${input.experimentId}`,
                  sk: `${input.effectiveAt}#${activation.activationId}`,
                  value: activation,
                },
                ConditionExpression:
                  "attribute_not_exists(pk) AND attribute_not_exists(sk)",
              },
            },
          ],
        }),
      );
      return activation;
    } catch (error) {
      if (conditional(error))
        throw new StrategyExperimentConflictError(
          "strategy-activation-conflict",
        );
      throw error;
    }
  }
  async resolveActive(strategyId: string, scheduledAt: string) {
    const result = await this.client.send(
      new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: "pk = :pk AND sk <= :at",
        ExpressionAttributeValues: {
          ":pk": `STRATEGY_ACTIVE#${strategyId}`,
          ":at": `${scheduledAt}#~`,
        },
        ScanIndexForward: false,
        Limit: 1,
        ConsistentRead: true,
      }),
    );
    return (
      (result.Items?.[0]?.["value"] as StrategyActivation | undefined) ?? null
    );
  }
  async listAudit(experimentId: string) {
    const result = await this.client.send(
      new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: "pk = :pk",
        ExpressionAttributeValues: {
          ":pk": `EXPERIMENT_AUDIT#${experimentId}`,
        },
        Limit: 100,
        ConsistentRead: true,
      }),
    );
    return (result.Items ?? []).map(
      (item) => item["value"] as StrategyPromotionDecision | StrategyActivation,
    );
  }
  async hasConsumedEvidence(strategyId: string, digest: string) {
    return !!(await this.get(`STRATEGY_EVIDENCE#${strategyId}`, digest));
  }
}
