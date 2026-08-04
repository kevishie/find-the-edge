import {
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
} from "@aws-sdk/lib-dynamodb";
import {
  createPaperPickItemId,
  createPaperPickGenerationId,
  createPaperPickRunId,
  normalizePaperPickCandidateManifest,
  type PaperPickItemTerminal,
  type PaperPickRunIdentityInput,
  type PaperPickRunItem,
  type PaperPickRunRecord,
} from "@find-the-edge/domain";
import type {
  PaperPickBudgetAmount,
  PaperPickBudgetLimits,
  PaperPickRunRepository,
} from "./paper-pick-run-repository";
const conditional = (error: unknown) =>
  error instanceof Error && error.name === "ConditionalCheckFailedException";
const itemAddress = (itemId: string) => {
  const match = itemId.match(/^paper-pick-item:([a-f0-9]{64}):[a-f0-9]{64}$/);
  if (!match) throw new Error("paper-pick-item-identity-invalid");
  return {
    pk: `PAPER_PICK_RUN#paper-pick-run:${match[1]}`,
    sk: `ITEM#${itemId}`,
  };
};
export class DynamoPaperPickRunRepository implements PaperPickRunRepository {
  constructor(
    private readonly client: DynamoDBDocumentClient,
    private readonly tableName: string,
  ) {}
  async createGeneration(
    policyId: string,
    policyVersion: string,
    scheduledFor: string,
    limits: PaperPickBudgetLimits,
  ) {
    const generationId = createPaperPickGenerationId(
      policyId,
      policyVersion,
      scheduledFor,
    );
    try {
      await this.client.send(
        new PutCommand({
          TableName: this.tableName,
          Item: {
            pk: `PAPER_PICK_GENERATION#${generationId}`,
            sk: "META",
            limits,
            budget: {
              modelCalls: 0,
              inputTokens: 0,
              outputTokens: 0,
              costMicros: 0,
              concurrency: 0,
            },
            admittedEvents: 0,
          },
          ConditionExpression: "attribute_not_exists(pk)",
        }),
      );
    } catch (error) {
      if (!conditional(error)) throw error;
      const existing = await this.client.send(
        new GetCommand({
          TableName: this.tableName,
          Key: { pk: `PAPER_PICK_GENERATION#${generationId}`, sk: "META" },
          ConsistentRead: true,
        }),
      );
      if (JSON.stringify(existing.Item?.["limits"]) !== JSON.stringify(limits))
        throw new Error("paper-pick-generation-replay-conflict");
    }
    return generationId;
  }
  async createRun(
    identity: PaperPickRunIdentityInput,
    createdAt: string,
    candidates: readonly {
      readonly eventId: string;
      readonly eventVersion: number;
      readonly sportKey: string;
      readonly leagueKey: string;
      readonly participantIds: readonly string[];
      readonly startsAt: string;
    }[],
    generationId: string,
  ) {
    const runId = createPaperPickRunId(identity);
    const run: PaperPickRunRecord = {
      ...identity,
      runId,
      generationId,
      createdAt,
      state: "ready",
      counters: {
        discovered: 0,
        terminal: 0,
        evaluations: 0,
        attempts: 0,
        skipped: 0,
        limits: 0,
        failures: 0,
      },
      candidateManifest: normalizePaperPickCandidateManifest(
        identity,
        candidates,
      ),
    };
    try {
      await this.client.send(
        new PutCommand({
          TableName: this.tableName,
          Item: {
            pk: `PAPER_PICK_RUN#${runId}`,
            sk: "META",
            value: run,
          },
          ConditionExpression: "attribute_not_exists(pk)",
        }),
      );
      return { outcome: "created" as const, run };
    } catch (error) {
      if (!conditional(error)) throw error;
      const existing = await this.getRun(runId);
      if (!existing || existing.runId !== run.runId)
        throw new Error("paper-pick-run-replay-conflict");
      return { outcome: "duplicate" as const, run: existing };
    }
  }
  async admitEvent(
    generationId: string,
    eventId: string,
    eventVersion: number,
    maximumEvents: number,
  ) {
    if (
      !eventId ||
      !Number.isSafeInteger(eventVersion) ||
      eventVersion < 1 ||
      !Number.isSafeInteger(maximumEvents) ||
      maximumEvents < 1
    )
      throw new Error("paper-pick-event-admission-invalid");
    const generationKey = {
      pk: `PAPER_PICK_GENERATION#${generationId}`,
      sk: "META",
    };
    const admissionKey = {
      pk: `PAPER_PICK_GENERATION#${generationId}`,
      sk: `EVENT#${eventId}`,
    };
    try {
      await this.client.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Put: {
                TableName: this.tableName,
                Item: { ...admissionKey, eventId, eventVersion },
                ConditionExpression:
                  "attribute_not_exists(pk) AND attribute_not_exists(sk)",
              },
            },
            {
              Update: {
                TableName: this.tableName,
                Key: generationKey,
                UpdateExpression: "SET admittedEvents=admittedEvents+:one",
                ConditionExpression:
                  "limits.events=:maximum AND admittedEvents < :maximum",
                ExpressionAttributeValues: {
                  ":one": 1,
                  ":maximum": maximumEvents,
                },
              },
            },
          ],
        }),
      );
      return "admitted" as const;
    } catch (error) {
      if (
        !(error instanceof Error) ||
        error.name !== "TransactionCanceledException"
      )
        throw error;
      const reasons = (
        error as Error & {
          CancellationReasons?: readonly { Code?: string }[];
        }
      ).CancellationReasons;
      if (
        reasons?.some(
          ({ Code }) => Code !== "None" && Code !== "ConditionalCheckFailed",
        )
      )
        throw error;
      const [admission, generation] = await Promise.all([
        this.client.send(
          new GetCommand({
            TableName: this.tableName,
            Key: admissionKey,
            ConsistentRead: true,
          }),
        ),
        this.client.send(
          new GetCommand({
            TableName: this.tableName,
            Key: generationKey,
            ConsistentRead: true,
          }),
        ),
      ]);
      if (admission.Item) return "existing" as const;
      if (!generation.Item) throw new Error("paper-pick-generation-missing");
      const storedLimits = generation.Item["limits"] as
        { readonly events?: unknown } | undefined;
      if (storedLimits?.events !== maximumEvents)
        throw new Error("paper-pick-event-admission-invalid");
      return "event-limit" as const;
    }
  }
  async createItem(
    runId: string,
    candidate: {
      readonly eventId: string;
      readonly eventVersion: number;
      readonly sportKey: string;
      readonly leagueKey: string;
      readonly participantIds: readonly string[];
      readonly startsAt: string;
    },
    mode: "shadow" | "paper",
  ) {
    const itemId = createPaperPickItemId(
      runId,
      candidate.eventId,
      candidate.eventVersion,
    );
    const item: PaperPickRunItem = {
      itemId,
      runId,
      ...structuredClone(candidate),
      mode,
      state: "ready",
    };
    try {
      await this.client.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              ConditionCheck: {
                TableName: this.tableName,
                Key: { pk: `PAPER_PICK_RUN#${runId}`, sk: "META" },
                ConditionExpression: "attribute_exists(pk)",
              },
            },
            {
              Put: {
                TableName: this.tableName,
                Item: {
                  pk: `PAPER_PICK_RUN#${runId}`,
                  sk: `ITEM#${itemId}`,
                  value: item,
                },
                ConditionExpression:
                  "attribute_not_exists(pk) AND attribute_not_exists(sk)",
              },
            },
          ],
        }),
      );
      return item;
    } catch (error) {
      if (
        !conditional(error) &&
        (!(error instanceof Error) ||
          error.name !== "TransactionCanceledException")
      )
        throw error;
      const existing = await this.getItem(itemId);
      if (!existing || JSON.stringify(existing) !== JSON.stringify(item))
        throw new Error("paper-pick-item-replay-conflict");
      return existing;
    }
  }
  private async rawItem(itemId: string) {
    const result = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: itemAddress(itemId),
        ConsistentRead: true,
      }),
    );
    return result.Item;
  }
  async claimItem(itemId: string, owner: string, now: string, leaseMs: number) {
    const raw = await this.rawItem(itemId);
    if (!raw) return null;
    const item = raw["value"] as PaperPickRunItem;
    if (item.state === "terminal") return null;
    const token = `${owner}:${crypto.randomUUID()}`,
      leaseExpiresAt = new Date(Date.parse(now) + leaseMs).toISOString();
    const priorToken = raw["claimToken"] as string | undefined;
    const priorLease = raw["leaseExpiresAt"] as string | undefined;
    const priorConcurrencyHeld = raw["concurrencyHeld"] === true;
    if (priorLease && priorLease > now) return null;
    try {
      if (priorConcurrencyHeld) {
        const run = await this.getRun(item.runId);
        if (!run) throw new Error("paper-pick-run-missing");
        await this.client.send(
          new TransactWriteCommand({
            TransactItems: [
              {
                Update: {
                  TableName: this.tableName,
                  Key: {
                    pk: `PAPER_PICK_GENERATION#${run.generationId}`,
                    sk: "META",
                  },
                  UpdateExpression:
                    "SET budget.concurrency=budget.concurrency-:one",
                  ConditionExpression: "budget.concurrency >= :one",
                  ExpressionAttributeValues: { ":one": 1 },
                },
              },
              {
                Update: {
                  TableName: this.tableName,
                  Key: itemAddress(itemId),
                  UpdateExpression:
                    "SET #value.#state=:claimed, claimToken=:token, leaseExpiresAt=:lease, concurrencyHeld=:false",
                  ConditionExpression:
                    "#value.#state=:claimed AND claimToken=:priorToken AND leaseExpiresAt=:priorLease AND leaseExpiresAt <= :now AND concurrencyHeld=:true",
                  ExpressionAttributeNames: {
                    "#value": "value",
                    "#state": "state",
                  },
                  ExpressionAttributeValues: {
                    ":claimed": "claimed",
                    ":priorToken": priorToken,
                    ":priorLease": priorLease,
                    ":token": token,
                    ":lease": leaseExpiresAt,
                    ":now": now,
                    ":false": false,
                    ":true": true,
                  },
                },
              },
            ],
          }),
        );
      } else {
        await this.client.send(
          new UpdateCommand({
            TableName: this.tableName,
            Key: itemAddress(itemId),
            UpdateExpression:
              "SET #value.#state=:claimed, claimToken=:token, leaseExpiresAt=:lease, concurrencyHeld=:false",
            ConditionExpression:
              "#value.#state=:ready OR (#value.#state=:claimed AND leaseExpiresAt <= :now AND concurrencyHeld=:false)",
            ExpressionAttributeNames: { "#value": "value", "#state": "state" },
            ExpressionAttributeValues: {
              ":ready": "ready",
              ":claimed": "claimed",
              ":token": token,
              ":lease": leaseExpiresAt,
              ":now": now,
              ":false": false,
            },
          }),
        );
      }
      return {
        item: { ...item, state: "claimed" as const },
        token,
        leaseExpiresAt,
      };
    } catch (error) {
      if (
        conditional(error) ||
        (error instanceof Error &&
          error.name === "TransactionCanceledException")
      )
        return null;
      throw error;
    }
  }
  async renewItem(itemId: string, token: string, now: string, leaseMs: number) {
    const raw = await this.rawItem(itemId);
    if (!raw) throw new Error("paper-pick-item-missing");
    const leaseExpiresAt = new Date(Date.parse(now) + leaseMs).toISOString();
    try {
      const result = await this.client.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: itemAddress(itemId),
          UpdateExpression: "SET leaseExpiresAt=:lease",
          ConditionExpression:
            "claimToken=:token AND leaseExpiresAt > :now AND #value.#state=:claimed",
          ExpressionAttributeNames: { "#value": "value", "#state": "state" },
          ExpressionAttributeValues: {
            ":lease": leaseExpiresAt,
            ":token": token,
            ":now": now,
            ":claimed": "claimed",
          },
          ReturnValues: "ALL_NEW",
        }),
      );
      return {
        item: result.Attributes?.["value"] as PaperPickRunItem,
        token,
        leaseExpiresAt,
      };
    } catch (error) {
      if (conditional(error)) throw new Error("paper-pick-lease-lost");
      throw error;
    }
  }
  async reserve(
    itemId: string,
    token: string,
    requested: PaperPickBudgetAmount,
    limits: PaperPickBudgetLimits,
  ) {
    const claim = await this.rawItem(itemId);
    if (!claim) throw new Error("paper-pick-lease-lost");
    const runId = (claim["value"] as PaperPickRunItem).runId;
    const run = await this.getRun(runId);
    if (!run) throw new Error("paper-pick-run-missing");
    const budgetKey = {
      pk: `PAPER_PICK_GENERATION#${run.generationId}`,
      sk: "META",
    };
    try {
      await this.client.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              ConditionCheck: {
                TableName: this.tableName,
                Key: itemAddress(itemId),
                ConditionExpression:
                  "claimToken=:token AND concurrencyHeld=:false AND leaseExpiresAt > :now AND #value.#state=:claimed",
                ExpressionAttributeNames: {
                  "#value": "value",
                  "#state": "state",
                },
                ExpressionAttributeValues: {
                  ":token": token,
                  ":false": false,
                  ":now": new Date().toISOString(),
                  ":claimed": "claimed",
                },
              },
            },
            {
              Update: {
                TableName: this.tableName,
                Key: budgetKey,
                UpdateExpression:
                  "SET budget.modelCalls=budget.modelCalls+:mc, budget.inputTokens=budget.inputTokens+:it, budget.outputTokens=budget.outputTokens+:ot, budget.costMicros=budget.costMicros+:cost, budget.concurrency=budget.concurrency+:conc",
                ConditionExpression:
                  "limits=:limits AND budget.modelCalls <= :allowedMc AND budget.inputTokens <= :allowedIt AND budget.outputTokens <= :allowedOt AND budget.costMicros <= :allowedCost AND budget.concurrency <= :allowedConc",
                ExpressionAttributeValues: {
                  ":limits": limits,
                  ":mc": requested.modelCalls,
                  ":it": requested.inputTokens,
                  ":ot": requested.outputTokens,
                  ":cost": requested.costMicros,
                  ":conc": requested.concurrency,
                  ":allowedMc": limits.modelCalls - requested.modelCalls,
                  ":allowedIt": limits.inputTokens - requested.inputTokens,
                  ":allowedOt": limits.outputTokens - requested.outputTokens,
                  ":allowedCost": limits.costMicros - requested.costMicros,
                  ":allowedConc": limits.concurrency - requested.concurrency,
                },
              },
            },
            {
              Update: {
                TableName: this.tableName,
                Key: itemAddress(itemId),
                UpdateExpression:
                  "SET concurrencyHeld=:true, reservation=:reservation",
                ConditionExpression: "claimToken=:token",
                ExpressionAttributeValues: {
                  ":true": true,
                  ":token": token,
                  ":reservation": {
                    modelCalls: requested.modelCalls,
                    inputTokens: requested.inputTokens,
                    outputTokens: requested.outputTokens,
                    costMicros: requested.costMicros,
                  },
                },
              },
            },
          ],
        }),
      );
      return "reserved";
    } catch (error) {
      if (
        error instanceof Error &&
        error.name === "TransactionCanceledException"
      ) {
        const reasons = (
          error as Error & {
            CancellationReasons?: readonly { Code?: string }[];
          }
        ).CancellationReasons;
        if (reasons?.[1]?.Code !== "ConditionalCheckFailed")
          throw new Error("paper-pick-lease-lost");
        const meta = await this.client.send(
          new GetCommand({
            TableName: this.tableName,
            Key: budgetKey,
            ConsistentRead: true,
          }),
        );
        const budget = meta.Item?.["budget"] as
          PaperPickBudgetAmount | undefined;
        if (!budget) throw new Error("paper-pick-budget-missing");
        if (JSON.stringify(meta.Item?.["limits"]) !== JSON.stringify(limits))
          throw new Error("paper-pick-budget-policy-conflict");
        if (budget.concurrency + requested.concurrency > limits.concurrency)
          return "concurrency-limit";
        if (budget.modelCalls + requested.modelCalls > limits.modelCalls)
          return "model-call-limit";
        if (
          budget.inputTokens + requested.inputTokens > limits.inputTokens ||
          budget.outputTokens + requested.outputTokens > limits.outputTokens
        )
          return "token-limit";
        return "cost-limit";
      }
      if (conditional(error)) throw new Error("paper-pick-lease-lost");
      throw error;
    }
  }
  async reconcile(
    itemId: string,
    token: string,
    actual: Omit<PaperPickBudgetAmount, "concurrency">,
  ) {
    const claim = await this.rawItem(itemId);
    const runId = (claim?.["value"] as PaperPickRunItem | undefined)?.runId;
    const run = runId ? await this.getRun(runId) : null;
    if (!run) throw new Error("paper-pick-lease-lost");
    const reserved = claim?.["reservation"] as
      Omit<PaperPickBudgetAmount, "concurrency"> | undefined;
    if (!claim || !reserved) throw new Error("paper-pick-lease-lost");
    for (const key of [
      "modelCalls",
      "inputTokens",
      "outputTokens",
      "costMicros",
    ] as const)
      if (actual[key] > reserved[key])
        throw new Error("paper-pick-usage-exceeds-reservation");
    await this.client.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: this.tableName,
              Key: {
                pk: `PAPER_PICK_GENERATION#${run.generationId}`,
                sk: "META",
              },
              UpdateExpression:
                "SET budget.modelCalls=budget.modelCalls-:mc, budget.inputTokens=budget.inputTokens-:it, budget.outputTokens=budget.outputTokens-:ot, budget.costMicros=budget.costMicros-:cost",
              ExpressionAttributeValues: {
                ":mc": reserved.modelCalls - actual.modelCalls,
                ":it": reserved.inputTokens - actual.inputTokens,
                ":ot": reserved.outputTokens - actual.outputTokens,
                ":cost": reserved.costMicros - actual.costMicros,
              },
            },
          },
          {
            Update: {
              TableName: this.tableName,
              Key: itemAddress(itemId),
              UpdateExpression: "REMOVE reservation",
              ConditionExpression: "claimToken=:token",
              ExpressionAttributeValues: { ":token": token },
            },
          },
        ],
      }),
    );
  }
  async releaseConcurrency(itemId: string, token: string) {
    const claim = await this.rawItem(itemId);
    if (!claim) throw new Error("paper-pick-lease-lost");
    const runId = (claim["value"] as PaperPickRunItem).runId;
    const run = await this.getRun(runId);
    if (!run) throw new Error("paper-pick-lease-lost");
    if (claim["concurrencyHeld"] !== true) return;
    try {
      await this.client.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Update: {
                TableName: this.tableName,
                Key: {
                  pk: `PAPER_PICK_GENERATION#${run.generationId}`,
                  sk: "META",
                },
                UpdateExpression:
                  "SET budget.concurrency=budget.concurrency-:one",
                ConditionExpression: "budget.concurrency >= :one",
                ExpressionAttributeValues: { ":one": 1 },
              },
            },
            {
              Update: {
                TableName: this.tableName,
                Key: itemAddress(itemId),
                UpdateExpression: "SET concurrencyHeld=:false",
                ConditionExpression:
                  "claimToken=:token AND concurrencyHeld=:true",
                ExpressionAttributeValues: {
                  ":false": false,
                  ":true": true,
                  ":token": token,
                },
              },
            },
          ],
        }),
      );
    } catch (error) {
      if (
        error instanceof Error &&
        error.name === "TransactionCanceledException"
      )
        throw new Error("paper-pick-lease-lost");
      throw error;
    }
  }
  async finishItem(
    itemId: string,
    token: string,
    terminal: PaperPickItemTerminal,
    reasonCode: string,
    now: string,
    terminalId?: string,
  ) {
    const raw = await this.rawItem(itemId);
    if (!raw) throw new Error("paper-pick-item-missing");
    try {
      const result = await this.client.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: itemAddress(itemId),
          UpdateExpression:
            "SET #value.#state=:terminalState, #value.#terminal=:terminal, #value.reasonCode=:reason" +
            (terminalId ? ", #value.terminalId=:terminalId" : ""),
          ConditionExpression:
            "claimToken=:token AND leaseExpiresAt > :now AND #value.#state=:claimed",
          ExpressionAttributeNames: {
            "#value": "value",
            "#state": "state",
            "#terminal": "terminal",
          },
          ExpressionAttributeValues: {
            ":token": token,
            ":claimed": "claimed",
            ":now": now,
            ":terminalState": "terminal",
            ":terminal": terminal,
            ":reason": reasonCode,
            ...(terminalId ? { ":terminalId": terminalId } : {}),
          },
          ReturnValues: "ALL_NEW",
        }),
      );
      return result.Attributes?.["value"] as PaperPickRunItem;
    } catch (error) {
      if (!conditional(error)) throw error;
      const existing = await this.getItem(itemId);
      if (
        existing?.state === "terminal" &&
        existing.terminal === terminal &&
        existing.reasonCode === reasonCode
      )
        return existing;
      throw new Error("paper-pick-lease-lost");
    }
  }
  async getRun(runId: string) {
    const result = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { pk: `PAPER_PICK_RUN#${runId}`, sk: "META" },
        ConsistentRead: true,
      }),
    );
    return (result.Item?.["value"] as PaperPickRunRecord | undefined) ?? null;
  }
  async checkpointRun(runId: string) {
    const run = await this.getRun(runId);
    if (!run) throw new Error("paper-pick-run-missing");
    if (run.state === "complete" || run.state === "stopped") return run;
    const items = await this.listItems(runId);
    const terminals = items.filter((item) => item.state === "terminal");
    const count = (kind: PaperPickItemTerminal) =>
      terminals.filter((item) => item.terminal === kind).length;
    const next: PaperPickRunRecord = {
      ...run,
      state:
        terminals.length === items.length
          ? "complete"
          : terminals.length
            ? "partial"
            : items.length
              ? "running"
              : "complete",
      counters: {
        discovered: items.length,
        terminal: terminals.length,
        evaluations: count("evaluation"),
        attempts: count("attempt"),
        skipped: count("skipped"),
        limits: count("limit"),
        failures: count("failed"),
      },
    };
    try {
      await this.client.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { pk: `PAPER_PICK_RUN#${runId}`, sk: "META" },
          UpdateExpression: "SET #value=:next",
          ConditionExpression:
            "#value.#state=:ready OR #value.#state=:running OR #value.#state=:partial",
          ExpressionAttributeNames: { "#value": "value", "#state": "state" },
          ExpressionAttributeValues: {
            ":next": next,
            ":ready": "ready",
            ":running": "running",
            ":partial": "partial",
          },
        }),
      );
      return next;
    } catch (error) {
      if (!conditional(error)) throw error;
      const existing = await this.getRun(runId);
      if (!existing) throw new Error("paper-pick-run-missing");
      return existing;
    }
  }
  async getItem(itemId: string) {
    const raw = await this.rawItem(itemId);
    return (raw?.["value"] as PaperPickRunItem | undefined) ?? null;
  }
  async listItems(runId: string) {
    const items: Record<string, unknown>[] = [];
    let ExclusiveStartKey: Record<string, unknown> | undefined;
    do {
      const result = await this.client.send(
        new QueryCommand({
          TableName: this.tableName,
          KeyConditionExpression: "pk = :pk AND begins_with(sk, :item)",
          ExpressionAttributeValues: {
            ":pk": `PAPER_PICK_RUN#${runId}`,
            ":item": "ITEM#",
          },
          ConsistentRead: true,
          ExclusiveStartKey,
        }),
      );
      items.push(...(result.Items ?? []));
      ExclusiveStartKey = result.LastEvaluatedKey;
    } while (ExclusiveStartKey);
    return items.map((item) => item["value"] as PaperPickRunItem);
  }
}
