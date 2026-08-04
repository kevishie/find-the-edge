import { createHmac, timingSafeEqual } from "node:crypto";
import {
  approveStrategyExperiment,
  createStrategyActivation,
  stableCohortValue,
  type StrategyActivation,
  type StrategyArtifact,
  type StrategyExperiment,
  type StrategyPromotionDecision,
} from "@find-the-edge/domain";

export class StrategyExperimentConflictError extends Error {
  override readonly name = "StrategyExperimentConflictError";
}
export class StrategyExperimentNotFoundError extends Error {
  override readonly name = "StrategyExperimentNotFoundError";
}
export interface StrategyExperimentPage {
  readonly items: readonly StrategyExperiment[];
  readonly nextCursor?: string;
}
export interface StrategyExperimentRepository {
  putArtifact(value: StrategyArtifact): Promise<StrategyArtifact>;
  getArtifact(
    strategyId: string,
    version: string,
  ): Promise<StrategyArtifact | null>;
  putExperiment(value: StrategyExperiment): Promise<StrategyExperiment>;
  getExperiment(id: string): Promise<StrategyExperiment | null>;
  listExperiments(input: {
    strategyId?: string;
    state?: StrategyExperiment["state"];
    limit: number;
    cursor?: string;
  }): Promise<StrategyExperimentPage>;
  approve(input: {
    experimentId: string;
    promoterId: string;
    reason: string;
    decidedAt: string;
    idempotencyKey: string;
    expectedStateVersion: number;
    expectedDigest: string;
    artifactDigest: string;
  }): Promise<{
    experiment: StrategyExperiment;
    decision: StrategyPromotionDecision;
  }>;
  activate(input: {
    experimentId: string;
    strategyId: string;
    artifactVersion: string;
    artifactDigest: string;
    kind: "promotion" | "rollback";
    effectiveAt: string;
    actorId: string;
    reason: string;
    idempotencyKey: string;
    expectedActivationId: string | null;
  }): Promise<StrategyActivation>;
  resolveActive(
    strategyId: string,
    scheduledAt: string,
  ): Promise<StrategyActivation | null>;
  listAudit(
    experimentId: string,
  ): Promise<readonly (StrategyPromotionDecision | StrategyActivation)[]>;
  hasConsumedEvidence(strategyId: string, digest: string): Promise<boolean>;
}

const cursorCodec = (secret: string) => ({
  encode(payload: object) {
    const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const signature = createHmac("sha256", secret)
      .update(body)
      .digest("base64url");
    return `${body}.${signature}`;
  },
  decode(value: string) {
    try {
      const [body, signature, extra] = value.split(".");
      if (!body || !signature || extra) throw new Error();
      const expected = createHmac("sha256", secret).update(body).digest();
      const actual = Buffer.from(signature, "base64url");
      if (
        actual.length !== expected.length ||
        !timingSafeEqual(actual, expected)
      )
        throw new Error();
      return JSON.parse(Buffer.from(body, "base64url").toString()) as Record<
        string,
        unknown
      >;
    } catch {
      throw new Error("strategy-experiment-cursor-invalid");
    }
  },
});

export class MemoryStrategyExperimentRepository implements StrategyExperimentRepository {
  private readonly artifacts = new Map<string, StrategyArtifact>();
  private readonly experiments = new Map<string, StrategyExperiment>();
  private readonly decisions = new Map<string, StrategyPromotionDecision>();
  private readonly activations = new Map<string, StrategyActivation>();
  private readonly evidenceLedger = new Set<string>();
  private readonly codec;
  constructor(cursorSecret = "memory-strategy-experiment-secret-at-least-32") {
    if (cursorSecret.length < 32)
      throw new Error("strategy-experiment-cursor-secret-invalid");
    this.codec = cursorCodec(cursorSecret);
  }
  async putArtifact(value: StrategyArtifact) {
    await Promise.resolve();
    const key = `${value.strategyId}\0${value.version}`,
      current = this.artifacts.get(key);
    if (current && stableCohortValue(current) !== stableCohortValue(value))
      throw new StrategyExperimentConflictError("strategy-artifact-conflict");
    this.artifacts.set(key, structuredClone(value));
    return structuredClone(value);
  }
  async getArtifact(strategyId: string, version: string) {
    await Promise.resolve();
    const item = this.artifacts.get(`${strategyId}\0${version}`);
    return item ? structuredClone(item) : null;
  }
  async putExperiment(value: StrategyExperiment) {
    await Promise.resolve();
    const current = this.experiments.get(value.experimentId);
    if (current && stableCohortValue(current) !== stableCohortValue(value))
      throw new StrategyExperimentConflictError("strategy-experiment-conflict");
    const evidenceKeys = (
      value.state === "failed" ? [] : [value.tune.digest, value.holdout.digest]
    ).map((digest) => `${value.challenger.strategyId}\0${digest}`);
    if (!current && evidenceKeys.some((key) => this.evidenceLedger.has(key)))
      throw new StrategyExperimentConflictError(
        "strategy-experiment-evidence-reused",
      );
    this.experiments.set(value.experimentId, structuredClone(value));
    evidenceKeys.forEach((key) => this.evidenceLedger.add(key));
    return structuredClone(value);
  }
  async getExperiment(id: string) {
    await Promise.resolve();
    const item = this.experiments.get(id);
    return item ? structuredClone(item) : null;
  }
  async listExperiments(input: {
    strategyId?: string;
    state?: StrategyExperiment["state"];
    limit: number;
    cursor?: string;
  }) {
    await Promise.resolve();
    if (
      !Number.isSafeInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > 50
    )
      throw new Error("strategy-experiment-limit-invalid");
    const scope = JSON.stringify({
      strategyId: input.strategyId ?? null,
      state: input.state ?? null,
    });
    let after = "";
    if (input.cursor) {
      const decoded = this.codec.decode(input.cursor);
      if (decoded["scope"] !== scope || typeof decoded["after"] !== "string")
        throw new Error("strategy-experiment-cursor-invalid");
      after = decoded["after"];
    }
    const items = [...this.experiments.values()]
      .filter(
        (item) =>
          (!input.strategyId ||
            item.challenger.strategyId === input.strategyId) &&
          (!input.state || item.state === input.state) &&
          item.experimentId > after,
      )
      .sort((a, b) => a.experimentId.localeCompare(b.experimentId));
    const page = items.slice(0, input.limit),
      hasMore = items.length > page.length;
    return {
      items: structuredClone(page),
      ...(hasMore
        ? {
            nextCursor: this.codec.encode({
              scope,
              after: page.at(-1)!.experimentId,
            }),
          }
        : {}),
    };
  }
  async approve(input: Parameters<StrategyExperimentRepository["approve"]>[0]) {
    await Promise.resolve();
    const replay = this.decisions.get(input.idempotencyKey);
    if (replay) {
      const experiment = this.experiments.get(replay.experimentId);
      if (
        !experiment ||
        replay.experimentId !== input.experimentId ||
        replay.promoterId !== input.promoterId ||
        replay.reason !== input.reason ||
        replay.experimentDigest !== input.expectedDigest ||
        replay.artifactDigest !== input.artifactDigest
      )
        throw new StrategyExperimentConflictError(
          "strategy-promotion-idempotency-conflict",
        );
      return {
        experiment: structuredClone(experiment),
        decision: structuredClone(replay),
      };
    }
    const current = this.experiments.get(input.experimentId);
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
    this.experiments.set(
      input.experimentId,
      structuredClone(approved.experiment),
    );
    this.decisions.set(
      input.idempotencyKey,
      structuredClone(approved.decision),
    );
    return structuredClone(approved);
  }
  async activate(
    input: Parameters<StrategyExperimentRepository["activate"]>[0],
  ) {
    await Promise.resolve();
    const replay = this.activations.get(input.idempotencyKey);
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
      return structuredClone(replay);
    }
    const experiment = this.experiments.get(input.experimentId),
      artifact = this.artifacts.get(
        `${input.strategyId}\0${input.artifactVersion}`,
      );
    if (!experiment || !artifact)
      throw new StrategyExperimentNotFoundError(
        "strategy-activation-target-not-found",
      );
    const approvedDigests = [...this.decisions.values()].map(
        (decision) => decision.artifactDigest,
      ),
      current =
        [...this.activations.values()]
          .filter((item) => item.strategyId === input.strategyId)
          .sort((a, b) => b.effectiveAt.localeCompare(a.effectiveAt))[0] ??
        null;
    if ((current?.activationId ?? null) !== input.expectedActivationId)
      throw new StrategyExperimentConflictError("strategy-activation-stale");
    let activation;
    try {
      activation = createStrategyActivation({
        ...input,
        predecessorActivationId: current?.activationId ?? null,
        artifact,
        approvedArtifactDigests: approvedDigests,
      });
    } catch {
      throw new StrategyExperimentConflictError("strategy-activation-invalid");
    }
    this.activations.set(input.idempotencyKey, structuredClone(activation));
    this.experiments.set(input.experimentId, {
      ...experiment,
      state: "active",
      stateVersion: experiment.stateVersion + 1,
    });
    return structuredClone(activation);
  }
  async resolveActive(strategyId: string, scheduledAt: string) {
    await Promise.resolve();
    const matches = [...this.activations.values()]
      .filter(
        (item) =>
          item.strategyId === strategyId && item.effectiveAt <= scheduledAt,
      )
      .sort(
        (a, b) =>
          b.effectiveAt.localeCompare(a.effectiveAt) ||
          b.activationId.localeCompare(a.activationId),
      );
    return matches[0] ? structuredClone(matches[0]) : null;
  }
  async listAudit(experimentId: string) {
    await Promise.resolve();
    return structuredClone(
      [...this.decisions.values(), ...this.activations.values()]
        .filter((item) => item.experimentId === experimentId)
        .sort((a, b) =>
          ("decidedAt" in a ? a.decidedAt : a.effectiveAt).localeCompare(
            "decidedAt" in b ? b.decidedAt : b.effectiveAt,
          ),
        ),
    );
  }
  async hasConsumedEvidence(strategyId: string, digest: string) {
    await Promise.resolve();
    return this.evidenceLedger.has(`${strategyId}\0${digest}`);
  }
}
