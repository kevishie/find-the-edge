import {
  validateEvaluationPolicy,
  type EvaluationPolicy,
} from "@find-the-edge/config";
import {
  EvaluationEvidenceInputError,
  MemoryEvaluationTerminalRepository,
  type EvaluationTerminalRepository,
  type EvaluationAttemptRepository,
  type EvaluationEvidenceRepository,
  type EvaluationEvidenceResult,
  type PaperEvaluationRepository,
} from "@find-the-edge/database";
import {
  createEvaluationAttempt,
  createPaperEvaluation,
  sha256Hex,
  type PaperEvaluationInput,
  type PaperEvaluationPair,
  type NormalizedFixtureOddsSnapshot,
} from "@find-the-edge/domain";
import { qualifyEvaluation } from "@find-the-edge/odds";
import {
  AnalysisContractError,
  ModelDisabledError,
  validateAnalysisOutput,
  type AnalysisPolicyLike,
  type AnalysisStrategyLike,
  type NormalizedAnalysisRequest,
  type StructuredAnalysisModelAdapter,
} from "@find-the-edge/scouting";

export interface PickEvaluationInput {
  readonly request: NormalizedAnalysisRequest;
  readonly analysisPolicy: AnalysisPolicyLike;
  readonly strategy: AnalysisStrategyLike;
  readonly evaluationPolicy: EvaluationPolicy;
  readonly eventVersion: number;
  readonly selectionKeys: readonly string[];
  readonly comparisonSportsbookIds: readonly string[];
  readonly promptHash: string;
  readonly timeoutMs?: number;
  readonly execution?: {
    readonly mode: "shadow" | "paper";
    readonly runId: string;
    readonly itemId: string;
    readonly policyId: string;
    readonly policyVersion: string;
    readonly scheduledFor: string;
  };
}
export type PickEvaluationResult =
  | {
      readonly terminal: "evaluation";
      readonly outcome: "created" | "duplicate";
      readonly pair: PaperEvaluationPair;
    }
  | {
      readonly terminal: "attempt";
      readonly outcome: "created" | "duplicate";
      readonly reasonCode: string;
      readonly reasonCodes: readonly string[];
      readonly attemptId: string;
    };
export interface SafeEvaluationTelemetry {
  emit(event: {
    readonly terminal: string;
    readonly reasonCode?: string;
    readonly sportKey: string;
    readonly leagueKey: string;
    readonly strategyVersion: string;
    readonly modelVersion?: string;
    readonly inputTokens?: number;
    readonly outputTokens?: number;
    readonly latencyMs?: number;
  }): void;
}
interface ResolvedEvidenceBook {
  readonly sportsbookId: string;
  readonly snapshots: readonly NormalizedFixtureOddsSnapshot[];
}
const noTelemetry: SafeEvaluationTelemetry = { emit() {} };

export class PickEvaluationService {
  constructor(
    private readonly dependencies: {
      readonly evidence: EvaluationEvidenceRepository;
      readonly model: StructuredAnalysisModelAdapter;
      readonly attempts: EvaluationAttemptRepository;
      readonly evaluations: PaperEvaluationRepository;
      readonly terminalClaims?: EvaluationTerminalRepository;
      readonly telemetry?: SafeEvaluationTelemetry;
    },
  ) {}

  private readonly fallbackTerminalClaims =
    new MemoryEvaluationTerminalRepository();

  private safeEmit(
    event: Parameters<SafeEvaluationTelemetry["emit"]>[0],
  ): void {
    try {
      (this.dependencies.telemetry ?? noTelemetry).emit(event);
    } catch {
      // Telemetry is deliberately isolated from the authoritative terminal write.
    }
  }

  async evaluate(input: PickEvaluationInput): Promise<PickEvaluationResult> {
    let policyInvalid = false;
    try {
      validateEvaluationPolicy(input.evaluationPolicy);
    } catch {
      policyInvalid = true;
    }
    const canonicalSelections = [...input.selectionKeys].sort();
    const policyIdentity = {
      ...input.evaluationPolicy,
      comparisonWeights: Object.fromEntries(
        Object.entries(input.evaluationPolicy.comparisonWeights).sort(
          ([left], [right]) => left.localeCompare(right),
        ),
      ),
    };
    const baseSemanticInput = {
      request: input.request.inputHash,
      evaluationPolicy: policyIdentity,
      eventVersion: input.eventVersion,
      selections: canonicalSelections,
      comparisonBooks: [...input.comparisonSportsbookIds].sort(),
      promptHash: input.promptHash,
      ...(input.execution ? { execution: input.execution } : {}),
    };
    let semanticInputHash = sha256Hex(
      JSON.stringify({
        ...baseSemanticInput,
        evidenceSnapshotIds: [],
      }),
    );
    const attempt = async (
      status: "abstained" | "invalid" | "failed",
      reasonCodes: readonly string[],
    ) => {
      const normalizedReasons = [...new Set(reasonCodes)].sort();
      const attemptInput = {
        semanticInputHash,
        status,
        reasonCodes: normalizedReasons,
        sportKey: input.request.sportKey,
        leagueKey: input.request.leagueKey,
        eventId: input.request.eventId,
        strategy: { id: input.strategy.id, version: input.strategy.version },
        model: {
          id: input.analysisPolicy.versions.modelId,
          version: input.analysisPolicy.versions.modelVersion,
        },
        createdAt: input.request.asOf,
        ...(input.execution ? { execution: input.execution } : {}),
      } as const;
      const intended = createEvaluationAttempt(attemptInput);
      await (
        this.dependencies.terminalClaims ?? this.fallbackTerminalClaims
      ).claim({
        semanticInputHash,
        terminalKind: "attempt",
        terminalId: intended.attemptId,
      });
      const stored = await this.dependencies.attempts.persist(attemptInput);
      this.safeEmit({
        terminal: "attempt",
        reasonCode: normalizedReasons[0]!,
        sportKey: input.request.sportKey,
        leagueKey: input.request.leagueKey,
        strategyVersion: input.strategy.version,
      });
      return {
        terminal: "attempt" as const,
        outcome: stored.outcome,
        reasonCode: normalizedReasons[0]!,
        reasonCodes: normalizedReasons,
        attemptId: stored.attempt.attemptId,
      };
    };
    if (!/^[a-f0-9]{64}$/.test(input.promptHash))
      return attempt("invalid", ["prompt-hash-invalid"]);
    if (policyInvalid) return attempt("invalid", ["evaluation-policy-invalid"]);
    if (
      (canonicalSelections.length !== 2 && canonicalSelections.length !== 3) ||
      new Set(canonicalSelections).size !== canonicalSelections.length
    )
      return attempt("invalid", ["selection-vector-invalid"]);
    if (
      input.comparisonSportsbookIds.includes(
        input.evaluationPolicy.targetSportsbookId,
      ) ||
      new Set(input.comparisonSportsbookIds).size !==
        input.comparisonSportsbookIds.length
    )
      return attempt("invalid", ["comparison-books-invalid"]);
    if (input.request.derivedStatus === "abstain")
      return attempt(
        "abstained",
        input.request.derivedReasonCodes.length
          ? input.request.derivedReasonCodes
          : ["evidence-abstain"],
      );
    if (
      input.comparisonSportsbookIds.some(
        (book) =>
          book !== input.evaluationPolicy.targetSportsbookId &&
          input.evaluationPolicy.comparisonWeights[book] === undefined,
      )
    )
      return attempt("abstained", ["comparison-weight-unconfigured"]);
    let evidence: EvaluationEvidenceResult;
    let offeredEvidence: ResolvedEvidenceBook | null = null;
    let comparisonEvidence: readonly ResolvedEvidenceBook[] = [];
    try {
      evidence = await this.dependencies.evidence.read({
        eventId: input.request.eventId,
        eventVersion: input.eventVersion,
        sportKey: input.request.sportKey,
        marketKey: input.request.candidate.marketKey,
        selections: canonicalSelections.map((selectionKey) => ({
          selectionKey,
          ...(input.request.candidate.point === undefined
            ? {}
            : { point: input.request.candidate.point }),
        })),
        targetSportsbookId: input.evaluationPolicy.targetSportsbookId,
        comparisonSportsbookIds: input.comparisonSportsbookIds,
        asOf: input.request.asOf,
        maximumAgeMinutes: input.evaluationPolicy.maximumPriceAgeMinutes,
        minimumComparisonBooks: input.evaluationPolicy.minimumComparisonBooks,
      });
      if (
        !evidence ||
        !["ready", "invalid"].includes(evidence.status) ||
        !Array.isArray(evidence.reasonCodes) ||
        !Array.isArray(evidence.comparisons)
      )
        return attempt("invalid", ["evidence-envelope-invalid"]);
      offeredEvidence = evidence.offered;
      comparisonEvidence =
        evidence.comparisons as readonly ResolvedEvidenceBook[];
      const snapshotIds = [
        ...(offeredEvidence?.snapshots ?? []),
        ...comparisonEvidence.flatMap(({ snapshots }) => snapshots),
      ]
        .map(({ snapshotId }) => snapshotId)
        .sort();
      semanticInputHash = sha256Hex(
        JSON.stringify({
          ...baseSemanticInput,
          evidenceSnapshotIds: snapshotIds,
        }),
      );
    } catch (error) {
      return attempt(
        error instanceof EvaluationEvidenceInputError ? "invalid" : "failed",
        [
          error instanceof EvaluationEvidenceInputError
            ? error.message
            : "evidence-read-failed",
        ],
      );
    }
    if (evidence.status !== "ready" || !offeredEvidence)
      return attempt(
        "abstained",
        evidence.reasonCodes.length
          ? evidence.reasonCodes
          : ["evidence-invalid"],
      );
    const timeoutMs = input.timeoutMs ?? 10_000;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let modelResult;
    try {
      modelResult = await Promise.race([
        this.dependencies.model.analyze(
          {
            request: input.request,
            promptBundleId: input.analysisPolicy.versions.promptBundleId,
            promptBundleVersion:
              input.analysisPolicy.versions.promptBundleVersion,
            promptHash: input.promptHash,
          },
          { signal: controller.signal },
        ),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new Error("model-timeout"));
          }, timeoutMs);
        }),
      ]);
    } catch (error) {
      if (error instanceof ModelDisabledError)
        return attempt("failed", ["model-disabled"]);
      return attempt("failed", [
        error instanceof Error && error.message === "model-timeout"
          ? "model-timeout"
          : "model-failed",
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
    let analysis;
    try {
      if (
        modelResult.model.id !== input.analysisPolicy.versions.modelId ||
        modelResult.model.version !== input.analysisPolicy.versions.modelVersion
      )
        return attempt("invalid", ["model-identity-mismatch"]);
      if (
        !/^[\x21-\x7e]{1,256}$/.test(modelResult.model.deploymentId) ||
        !Number.isSafeInteger(modelResult.usage.inputTokens) ||
        modelResult.usage.inputTokens < 0 ||
        !Number.isSafeInteger(modelResult.usage.outputTokens) ||
        modelResult.usage.outputTokens < 0 ||
        !Number.isFinite(modelResult.usage.latencyMs) ||
        modelResult.usage.latencyMs < 0
      )
        return attempt("invalid", ["model-metadata-invalid"]);
    } catch {
      return attempt("invalid", ["model-envelope-invalid"]);
    }
    try {
      analysis = validateAnalysisOutput(
        modelResult.output,
        input.request,
        input.analysisPolicy,
      );
    } catch (error) {
      return attempt("invalid", [
        error instanceof AnalysisContractError
          ? `model-invalid:${error.code.toLowerCase()}`
          : "model-invalid",
      ]);
    }
    if (analysis.status === "abstain")
      return attempt(
        "abstained",
        analysis.abstentionCodes.length
          ? analysis.abstentionCodes
          : ["model-abstained"],
      );
    const candidateSelectionKey =
      analysis.candidate.selection.kind === "draw"
        ? "draw"
        : analysis.candidate.selection.participantId!;
    const candidateIndex = canonicalSelections.indexOf(candidateSelectionKey);
    if (candidateIndex < 0)
      return attempt("invalid", ["candidate-selection-missing"]);
    const offeredSnapshot = offeredEvidence.snapshots[candidateIndex]!;
    const qualification = qualifyEvaluation({
      offeredAmerican: offeredSnapshot.americanOdds,
      offeredAgeMinutes:
        (Date.parse(input.request.asOf) -
          Date.parse(offeredSnapshot.observedAt)) /
        60_000,
      candidateIndex,
      modelProbability: analysis.probability,
      books: comparisonEvidence.map((book) => ({
        sportsbookId: book.sportsbookId,
        weight: input.evaluationPolicy.comparisonWeights[book.sportsbookId]!,
        ageMinutes: Math.max(
          ...book.snapshots.map(
            (snapshot: NormalizedFixtureOddsSnapshot) =>
              (Date.parse(input.request.asOf) -
                Date.parse(snapshot.observedAt)) /
              60_000,
          ),
        ),
        americanOdds: book.snapshots.map(
          (snapshot: NormalizedFixtureOddsSnapshot) => snapshot.americanOdds,
        ),
      })),
      outcomeCount: canonicalSelections.length,
      analysisMaturity: analysis.status === "reduced" ? "reduced" : "complete",
      policy: input.evaluationPolicy,
    });
    const evaluationInput: PaperEvaluationInput = {
      manifest: {
        mode: "decision-time",
        ...(input.execution ? { execution: input.execution } : {}),
        sportKey: input.request.sportKey,
        leagueKey: input.request.leagueKey,
        eventId: input.request.eventId,
        marketKey: input.request.candidate.marketKey,
        selectionKey: candidateSelectionKey,
        offeredOdds: {
          partitionKey: offeredSnapshot.partitionKey,
          sortKey: offeredSnapshot.sortKey,
          snapshotId: offeredSnapshot.snapshotId,
        },
        comparisonEvidence: comparisonEvidence
          .map((book) => book.snapshots[candidateIndex]!)
          .map((snapshot) => ({
            partitionKey: snapshot.partitionKey,
            sortKey: snapshot.sortKey,
            snapshotId: snapshot.snapshotId,
          })),
        comparisonOutcomeEvidence: comparisonEvidence
          .flatMap(({ snapshots }) => snapshots)
          .map((snapshot) => ({
            partitionKey: snapshot.partitionKey,
            sortKey: snapshot.sortKey,
            snapshotId: snapshot.snapshotId,
          })),
        consensusProvenance: {
          includedSportsbookIds: qualification.includedSportsbookIds,
          comparisonWeights: Object.fromEntries(
            comparisonEvidence.map(({ sportsbookId }) => [
              sportsbookId,
              input.evaluationPolicy.comparisonWeights[sportsbookId]!,
            ]),
          ),
          outlierThreshold: input.evaluationPolicy.outlierThreshold,
          conservativeProbability:
            input.evaluationPolicy.conservativeProbability,
        },
        probability: {
          minimum: analysis.probability.low,
          maximum: analysis.probability.high,
        },
        uncertainty: analysis.probability.uncertainty,
        noVigProbability: qualification.noVigProbability,
        expectedValue: qualification.expectedValue,
        thresholds: {
          minimumExpectedValue: input.evaluationPolicy.minimumExpectedValue,
          minimumComparisonBooks: input.evaluationPolicy.minimumComparisonBooks,
          maximumPriceAgeMinutes: input.evaluationPolicy.maximumPriceAgeMinutes,
          maximumUncertainty: input.evaluationPolicy.maximumUncertainty,
          minimumEdge: input.evaluationPolicy.minimumEdge,
          outlierThreshold: input.evaluationPolicy.outlierThreshold,
          conservativeProbability:
            input.evaluationPolicy.conservativeProbability,
        },
        evidenceCompleteness:
          input.request.derivedStatus === "complete" ? "complete" : "partial",
        versions: {
          sportModule: {
            id: input.request.sportKey,
            version: input.analysisPolicy.versions.contractVersion,
          },
          strategy: { id: input.strategy.id, version: input.strategy.version },
          model: {
            id: modelResult.model.id,
            version: modelResult.model.version,
          },
          promptBundle: {
            id: input.analysisPolicy.versions.promptBundleId,
            version: input.analysisPolicy.versions.promptBundleVersion,
          },
          calculation: {
            id: "qualification",
            version: qualification.calculationVersion,
          },
          inputSchema: {
            id: input.analysisPolicy.versions.inputSchemaId,
            version: input.analysisPolicy.versions.inputSchemaVersion,
          },
          manifestSchema: { id: "paper-evaluation", version: "2" },
        },
        provenanceReferences: [
          `evaluation-policy:${input.evaluationPolicy.id}@${input.evaluationPolicy.version}`,
          `model-deployment:${modelResult.model.deploymentId}`,
          `prompt-hash:${input.promptHash}`,
        ],
      },
      decision: qualification.decision,
      reasonCodes: qualification.reasons,
      createdAt: input.request.asOf,
    };
    const intended = createPaperEvaluation(evaluationInput);
    await (
      this.dependencies.terminalClaims ?? this.fallbackTerminalClaims
    ).claim({
      semanticInputHash,
      terminalKind: "evaluation",
      terminalId: intended.evaluation.evaluationId,
    });
    const persisted =
      await this.dependencies.evaluations.persist(evaluationInput);
    this.safeEmit({
      terminal: qualification.decision,
      sportKey: input.request.sportKey,
      leagueKey: input.request.leagueKey,
      strategyVersion: input.strategy.version,
      modelVersion: modelResult.model.version,
      inputTokens: modelResult.usage.inputTokens,
      outputTokens: modelResult.usage.outputTokens,
      latencyMs: modelResult.usage.latencyMs,
    });
    return {
      terminal: "evaluation",
      outcome: persisted.outcome,
      pair: persisted.pair,
    };
  }
}
