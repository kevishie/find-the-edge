import {
  defaultEvaluationPolicy,
  validateEvaluationPolicy,
  type EvaluationPolicy,
} from "@find-the-edge/config";
import {
  type EvaluationCandidate,
  type EvaluationCandidateRepository,
  type OpportunityCandidateRepository,
  type OpportunityEvidenceRepository,
  type OpportunityExactEvidenceBook,
  type OddsControlPlaneStore,
} from "@find-the-edge/database";
import type {
  FixtureOddsAvailabilityEvidence,
  NormalizedFixtureOddsSnapshot,
  OpportunityCandidate,
  OpportunitySnapshotEvidence,
} from "@find-the-edge/domain";
import {
  OPPORTUNITY_QUALIFICATION_VERSION,
  qualifyOpportunity,
} from "@find-the-edge/odds";
import {
  sportRegistry,
  strategyRegistry,
  validateStrategy,
  type SportModule,
  type StrategyDefinition,
} from "@find-the-edge/sports";

export interface OpportunityMarketVector {
  readonly marketKey: string;
  readonly selections: readonly {
    readonly selectionKey: string;
    readonly point: number | null;
  }[];
}
export interface OpportunityGenerationEvent extends EvaluationCandidate {
  readonly markets: readonly OpportunityMarketVector[];
}
export interface OpportunityGenerationCommand {
  readonly evaluatedAt: string;
  readonly events: readonly OpportunityGenerationEvent[];
  readonly evaluationPolicy?: EvaluationPolicy;
}
export interface OpportunityProviderHealthEvidence {
  readonly providerId: string;
  readonly sportsbookId: string;
  readonly healthy: boolean;
  readonly checkedAt: string;
  readonly healthKey: string;
  readonly evidenceId: string;
  readonly leagueKey: string;
  readonly capability: "odds";
  readonly recordVersion: number;
  readonly status: "healthy" | "degraded" | "unhealthy" | "missing" | "stale";
}
export interface OpportunityProviderHealthSource {
  read(input: {
    readonly sportKey: string;
    readonly leagueKey: string;
    readonly sportsbookId: string;
    readonly asOf: string;
  }): Promise<OpportunityProviderHealthEvidence>;
}
export interface OpportunityCandidateTelemetry {
  emit(event: {
    readonly outcome?: "success" | "failure";
    readonly failureClass?: "dependency" | "corruption" | "persistence";
    readonly sportKey: string;
    readonly candidateCount: number;
    readonly qualifiedCount: number;
    readonly disqualifiedCount: number;
    readonly reasonCounts: Readonly<Record<string, number>>;
    readonly calculationVersion: string;
  }): void;
}
export interface OpportunityCandidateLifecycleProjector {
  projectCandidate(
    candidate: OpportunityCandidate,
    occurredAt: string,
  ): Promise<unknown>;
}
export interface OpportunityGenerationResult {
  readonly candidates: readonly OpportunityCandidate[];
  readonly createdCount: number;
  readonly duplicateCount: number;
  readonly qualifiedCount: number;
  readonly disqualifiedCount: number;
  readonly reasonCounts: Readonly<Record<string, number>>;
}

const noTelemetry: OpportunityCandidateTelemetry = { emit() {} };
const compareText = (left: string, right: string) =>
  left < right ? -1 : left > right ? 1 : 0;

function canonicalMarketVector(
  market: OpportunityMarketVector,
): OpportunityMarketVector {
  return Object.freeze({
    marketKey: market.marketKey,
    selections: Object.freeze(
      market.selections
        .map(({ selectionKey, point }) => ({
          selectionKey,
          point: Object.is(point, -0) ? 0 : point,
        }))
        .sort(
          (left, right) =>
            compareText(left.selectionKey, right.selectionKey) ||
            (left.point ?? Number.NEGATIVE_INFINITY) -
              (right.point ?? Number.NEGATIVE_INFINITY),
        ),
    ),
  });
}

function availabilityRef(value: FixtureOddsAvailabilityEvidence | null) {
  return value
    ? {
        identity: value.identity,
        evidenceId: value.evidenceId,
        state: value.state,
        observedAt: value.observedAt,
      }
    : null;
}

function snapshotEvidence(
  snapshot: NormalizedFixtureOddsSnapshot,
  book: OpportunityExactEvidenceBook,
): OpportunitySnapshotEvidence {
  const selectionAvailability =
    book.selectionAvailability.find(
      (candidate) => candidate?.identity === snapshot.partitionKey,
    ) ?? null;
  return {
    canonicalEventId: snapshot.canonicalEventId,
    canonicalEventVersion: snapshot.canonicalEventVersion,
    sportKey: snapshot.sportKey,
    marketKey: snapshot.marketKey,
    selectionKey: snapshot.selectionKey,
    sportsbookId: snapshot.sportsbookId,
    point: snapshot.point ?? null,
    americanOdds: snapshot.americanOdds,
    observedAt: snapshot.observedAt,
    retrievedAt: snapshot.retrievedAt,
    partitionKey: snapshot.partitionKey,
    sortKey: snapshot.sortKey,
    snapshotId: snapshot.snapshotId,
    selectionAvailability: availabilityRef(selectionAvailability),
    groupAvailability: availabilityRef(book.groupAvailability),
  };
}

function orderedOdds(
  book: OpportunityExactEvidenceBook,
  selections: OpportunityMarketVector["selections"],
): readonly number[] {
  if (book.snapshots.length !== selections.length) return [];
  const bySelection = new Map(
    book.snapshots.map((snapshot) => [snapshot.selectionKey, snapshot]),
  );
  if (bySelection.size !== selections.length) return [];
  const ordered = selections.map(
    ({ selectionKey }) => bySelection.get(selectionKey)?.americanOdds,
  );
  return ordered.some((value) => value === undefined)
    ? []
    : (ordered as readonly number[]);
}

function safeEmit(
  telemetry: OpportunityCandidateTelemetry,
  event: Parameters<OpportunityCandidateTelemetry["emit"]>[0],
): void {
  try {
    telemetry.emit(event);
  } catch {
    // Metrics cannot change the authoritative persistence result.
  }
}

export class OpportunityCandidateService {
  constructor(
    private readonly dependencies: {
      readonly eligibleEvents: EvaluationCandidateRepository;
      readonly evidence: OpportunityEvidenceRepository;
      readonly candidates: OpportunityCandidateRepository;
      readonly providerHealth: OpportunityProviderHealthSource;
      readonly lifecycle: OpportunityCandidateLifecycleProjector;
      readonly telemetry?: OpportunityCandidateTelemetry;
      readonly resolveSportModule?: (sportKey: string) => SportModule;
      readonly resolveStrategy?: (
        sportKey: string,
      ) => StrategyDefinition | undefined;
    },
  ) {}

  async generate(
    command: OpportunityGenerationCommand,
  ): Promise<OpportunityGenerationResult> {
    const normalizedEvents = command.events.map((event) => ({
      ...event,
      markets: event.markets.map(canonicalMarketVector),
    }));
    if (
      new Date(command.evaluatedAt).toISOString() !== command.evaluatedAt ||
      normalizedEvents.length > 100 ||
      new Set(
        normalizedEvents.map(
          ({ eventId, eventVersion }) => `${eventId}\0${eventVersion}`,
        ),
      ).size !== command.events.length ||
      normalizedEvents.some(
        ({ markets }) =>
          markets.length === 0 ||
          markets.length > 64 ||
          markets.some(
            ({ marketKey, selections }) =>
              !marketKey.trim() ||
              (selections.length !== 2 && selections.length !== 3) ||
              selections.some(
                ({ selectionKey, point }) =>
                  !selectionKey.trim() ||
                  (point !== null && !Number.isFinite(point)),
              ) ||
              new Set(selections.map(({ selectionKey }) => selectionKey))
                .size !== selections.length,
          ) ||
          new Set(
            markets.map(({ marketKey, selections }) =>
              JSON.stringify([marketKey, selections]),
            ),
          ).size !== markets.length,
      )
    )
      throw new Error("opportunity-generation-command-invalid");
    let activeSportKey = "unknown";
    let failureClass: "dependency" | "corruption" | "persistence" =
      "dependency";
    const candidates: OpportunityCandidate[] = [];
    let createdCount = 0;
    let duplicateCount = 0;
    const reasonCounts = new Map<string, number>();
    try {
      const policy = validateEvaluationPolicy(
        command.evaluationPolicy ?? defaultEvaluationPolicy,
      );
      const events = [...normalizedEvents].sort(
        (left, right) =>
          compareText(left.startsAt, right.startsAt) ||
          compareText(left.eventId, right.eventId),
      );
      for (const event of events) {
        activeSportKey = event.sportKey;
        failureClass = "dependency";
        const module = (
          this.dependencies.resolveSportModule ??
          ((sportKey: string) => sportRegistry.get(sportKey))
        )(event.sportKey);
        const strategy = (
          this.dependencies.resolveStrategy ??
          ((sportKey: string) => strategyRegistry.find(sportKey))
        )(event.sportKey);
        if (!strategy || !validateStrategy(strategy, module).valid)
          throw new Error("opportunity-strategy-invalid");
        const maximumEvidenceAgeMinutes = Math.min(
          policy.maximumPriceAgeMinutes,
          strategy.maximumPriceAgeMinutes,
        );
        const minimumComparisonBooks = Math.max(
          3,
          policy.minimumComparisonBooks,
          strategy.minimumComparisonBooks,
        );
        const minimumExpectedValue = Math.max(
          policy.minimumExpectedValue,
          strategy.minimumEv,
        );
        const current = await this.dependencies.eligibleEvents.rereadEligible(
          event,
          command.evaluatedAt,
        );
        const eventStatus = current ? "scheduled" : "not-scheduled";
        const books = [
          policy.targetSportsbookId,
          ...Object.keys(policy.comparisonWeights).sort(compareText),
        ];
        const rawHealth = await Promise.all(
          books.map((sportsbookId) =>
            this.dependencies.providerHealth.read({
              sportKey: event.sportKey,
              leagueKey: event.leagueKey,
              sportsbookId,
              asOf: command.evaluatedAt,
            }),
          ),
        );
        if (
          rawHealth.some(
            (item, index) =>
              item.sportsbookId !== books[index] ||
              !item.providerId ||
              !item.healthKey ||
              !item.evidenceId ||
              item.leagueKey !== event.leagueKey ||
              item.capability !== "odds" ||
              !Number.isSafeInteger(item.recordVersion) ||
              item.recordVersion < 0 ||
              item.healthy !== (item.status === "healthy") ||
              new Date(item.checkedAt).toISOString() !== item.checkedAt ||
              item.checkedAt > command.evaluatedAt,
          )
        )
          throw new Error("opportunity-provider-health-invalid");
        const healthEvidenceByKey = new Map<string, string>();
        for (const item of rawHealth) {
          const signature = JSON.stringify({
            providerId: item.providerId,
            healthy: item.healthy,
            checkedAt: item.checkedAt,
            evidenceId: item.evidenceId,
            leagueKey: item.leagueKey,
            capability: item.capability,
            recordVersion: item.recordVersion,
            status: item.status,
          });
          const existing = healthEvidenceByKey.get(item.healthKey);
          if (existing !== undefined && existing !== signature)
            throw new Error("opportunity-provider-health-inconsistent");
          healthEvidenceByKey.set(item.healthKey, signature);
        }
        const health = rawHealth.map((item) => {
          const ageMinutes =
            (Date.parse(command.evaluatedAt) - Date.parse(item.checkedAt)) /
            60_000;
          return ageMinutes > maximumEvidenceAgeMinutes
            ? Object.freeze({
                ...item,
                healthy: false,
                status: "stale" as const,
              })
            : item;
        });
        const comparisonHealth = Object.fromEntries(
          health.slice(1).map((item) => [item.sportsbookId, item.healthy]),
        );
        for (const market of [...event.markets].sort((left, right) =>
          compareText(left.marketKey, right.marketKey),
        )) {
          if (
            (market.selections.length !== 2 &&
              market.selections.length !== 3) ||
            new Set(market.selections.map(({ selectionKey }) => selectionKey))
              .size !== market.selections.length
          )
            throw new Error("opportunity-market-vector-invalid");
          failureClass = "corruption";
          const evidence = await this.dependencies.evidence.read({
            canonicalEventId: event.eventId,
            canonicalEventVersion: event.eventVersion,
            sportKey: event.sportKey,
            marketKey: market.marketKey,
            selections: market.selections,
            targetSportsbookId: policy.targetSportsbookId,
            comparisonSportsbookIds: Object.keys(policy.comparisonWeights).sort(
              compareText,
            ),
            asOf: command.evaluatedAt,
            maximumAgeMinutes: maximumEvidenceAgeMinutes,
          });
          for (const [
            candidateIndex,
            selection,
          ] of market.selections.entries()) {
            failureClass = "corruption";
            const qualification = qualifyOpportunity({
              eventStatus,
              marketApproved:
                strategy.approvedMarketKeys.includes(market.marketKey) &&
                !strategy.prohibitedMarketKeys.includes(market.marketKey),
              targetSportsbookId: policy.targetSportsbookId,
              targetProviderHealthy: health[0]!.healthy,
              comparisonProviderHealth: comparisonHealth,
              selectionKeys: market.selections.map(
                ({ selectionKey }) => selectionKey,
              ),
              candidateIndex,
              target: {
                sportsbookId: evidence.target.sportsbookId,
                state: evidence.target.state,
                ageMinutes: evidence.target.ageMinutes,
                americanOdds: orderedOdds(evidence.target, market.selections),
              },
              comparisons: evidence.comparisons.map((book) => ({
                sportsbookId: book.sportsbookId,
                state: book.state,
                ageMinutes: book.ageMinutes,
                americanOdds: orderedOdds(book, market.selections),
              })),
              policy: {
                comparisonWeights: policy.comparisonWeights,
                minimumComparisonBooks,
                maximumPriceAgeMinutes: maximumEvidenceAgeMinutes,
                outlierThreshold: policy.outlierThreshold,
                disagreementWarningThreshold:
                  policy.disagreementWarningThreshold,
                disagreementBlockThreshold: policy.disagreementBlockThreshold,
                minimumExpectedValue,
              },
            });
            if (!qualification.provenance)
              throw new Error("opportunity-calculation-provenance-unavailable");
            failureClass = "persistence";
            const persisted = await this.dependencies.candidates.persist({
              logicalIdentity: {
                canonicalEventId: event.eventId,
                canonicalEventVersion: event.eventVersion,
                sportKey: event.sportKey,
                marketKey: market.marketKey,
                selectionKey: selection.selectionKey,
                point: selection.point,
                targetSportsbookId: policy.targetSportsbookId,
                strategyId: strategy.id,
                strategyVersion: strategy.version,
              },
              evaluatedAt: command.evaluatedAt,
              qualificationGates: {
                eventStatus,
                marketApproved:
                  strategy.approvedMarketKeys.includes(market.marketKey) &&
                  !strategy.prohibitedMarketKeys.includes(market.marketKey),
                minimumComparisonBooks,
                maximumPriceAgeMinutes: maximumEvidenceAgeMinutes,
                minimumExpectedValue,
                disagreementWarningThreshold:
                  policy.disagreementWarningThreshold,
                disagreementBlockThreshold: policy.disagreementBlockThreshold,
              },
              status: qualification.status,
              reasonCodes: qualification.reasonCodes,
              warningCodes: qualification.warningCodes,
              values: qualification.values,
              targetEvidence: evidence.target.snapshots.map((snapshot) =>
                snapshotEvidence(snapshot, evidence.target),
              ),
              comparisonEvidence: evidence.comparisons.flatMap((book) =>
                book.snapshots.map((snapshot) =>
                  snapshotEvidence(snapshot, book),
                ),
              ),
              includedComparisonSportsbookIds:
                qualification.includedComparisonSportsbookIds,
              excludedComparisonBooks:
                qualification.excludedComparisonBooks.map((excluded) => {
                  const book = evidence.comparisons.find(
                    ({ sportsbookId }) =>
                      sportsbookId === excluded.sportsbookId,
                  );
                  return {
                    sportsbookId: excluded.sportsbookId,
                    reasonCodes: excluded.reasonCodes,
                    snapshots: (book?.snapshots ?? []).map((snapshot) =>
                      snapshotEvidence(snapshot, book!),
                    ),
                  };
                }),
              providerHealth: health,
              versions: {
                sportModule: {
                  id: event.sportKey,
                  version: module.metadata.version,
                },
                strategy: { id: strategy.id, version: strategy.version },
                evaluationPolicy: { id: policy.id, version: policy.version },
                calculation: qualification.provenance,
              },
            });
            if (persisted.outcome === "created") createdCount += 1;
            else duplicateCount += 1;
            candidates.push(persisted.candidate);
            for (const reason of persisted.candidate.reasonCodes)
              reasonCounts.set(reason, (reasonCounts.get(reason) ?? 0) + 1);
            await this.dependencies.lifecycle.projectCandidate(
              persisted.candidate,
              command.evaluatedAt,
            );
          }
        }
      }
      const qualifiedCount = candidates.filter(
        ({ status }) => status === "qualified",
      ).length;
      const reasonDistribution = Object.freeze(
        Object.fromEntries(
          [...reasonCounts].sort(([left], [right]) => compareText(left, right)),
        ),
      );
      for (const sportKey of new Set(
        candidates.map(({ logicalIdentity }) => logicalIdentity.sportKey),
      )) {
        const sportCandidates = candidates.filter(
          ({ logicalIdentity }) => logicalIdentity.sportKey === sportKey,
        );
        const sportReasonCounts = new Map<string, number>();
        for (const candidate of sportCandidates)
          for (const reason of candidate.reasonCodes)
            sportReasonCounts.set(
              reason,
              (sportReasonCounts.get(reason) ?? 0) + 1,
            );
        safeEmit(this.dependencies.telemetry ?? noTelemetry, {
          outcome: "success",
          sportKey,
          candidateCount: sportCandidates.length,
          qualifiedCount: sportCandidates.filter(
            ({ status }) => status === "qualified",
          ).length,
          disqualifiedCount: sportCandidates.filter(
            ({ status }) => status === "disqualified",
          ).length,
          reasonCounts: Object.freeze(
            Object.fromEntries(
              [...sportReasonCounts].sort(([left], [right]) =>
                compareText(left, right),
              ),
            ),
          ),
          calculationVersion: [
            ...new Set(
              sportCandidates.map(
                ({ versions }) => versions.calculation.root.algorithm.version,
              ),
            ),
          ]
            .sort(compareText)
            .join(","),
        });
      }
      if (events.length === 0)
        safeEmit(this.dependencies.telemetry ?? noTelemetry, {
          outcome: "success",
          sportKey: "none",
          candidateCount: 0,
          qualifiedCount: 0,
          disqualifiedCount: 0,
          reasonCounts: Object.freeze({}),
          calculationVersion: OPPORTUNITY_QUALIFICATION_VERSION,
        });
      return Object.freeze({
        candidates: Object.freeze(candidates),
        createdCount,
        duplicateCount,
        qualifiedCount,
        disqualifiedCount: candidates.length - qualifiedCount,
        reasonCounts: reasonDistribution,
      });
    } catch (error) {
      const failureSports = new Set([
        ...candidates.map(({ logicalIdentity }) => logicalIdentity.sportKey),
        activeSportKey,
      ]);
      for (const sportKey of failureSports) {
        const sportCandidates = candidates.filter(
          ({ logicalIdentity }) => logicalIdentity.sportKey === sportKey,
        );
        const sportReasonCounts = new Map<string, number>();
        for (const candidate of sportCandidates)
          for (const reason of candidate.reasonCodes)
            sportReasonCounts.set(
              reason,
              (sportReasonCounts.get(reason) ?? 0) + 1,
            );
        safeEmit(this.dependencies.telemetry ?? noTelemetry, {
          outcome: "failure",
          failureClass,
          sportKey,
          candidateCount: sportCandidates.length,
          qualifiedCount: sportCandidates.filter(
            ({ status }) => status === "qualified",
          ).length,
          disqualifiedCount: sportCandidates.filter(
            ({ status }) => status === "disqualified",
          ).length,
          reasonCounts: Object.freeze(
            Object.fromEntries(
              [...sportReasonCounts].sort(([left], [right]) =>
                compareText(left, right),
              ),
            ),
          ),
          calculationVersion: OPPORTUNITY_QUALIFICATION_VERSION,
        });
      }
      throw error;
    }
  }
}

export class ControlPlaneOpportunityProviderHealthSource implements OpportunityProviderHealthSource {
  constructor(
    private readonly store: OddsControlPlaneStore,
    private readonly providerId: string,
  ) {}

  async read(input: {
    readonly sportKey: string;
    readonly leagueKey: string;
    readonly sportsbookId: string;
    readonly asOf: string;
  }): Promise<OpportunityProviderHealthEvidence> {
    const healthKey = `${this.providerId}:${input.leagueKey}:odds`;
    const record = await this.store.getHealth(healthKey);
    const recordVersion = record?.version ?? 0;
    const stale = record?.failureReason === "stale";
    const status = !record
      ? "missing"
      : stale
        ? "stale"
        : record.status === "degraded" || record.degraded
          ? "degraded"
          : record.status === "healthy" && record.healthy
            ? "healthy"
            : "unhealthy";
    const checkedAt = record?.updatedAt ?? input.asOf;
    return Object.freeze({
      providerId: record?.providerId ?? this.providerId,
      sportsbookId: input.sportsbookId,
      healthy: status === "healthy",
      checkedAt,
      healthKey: record?.healthKey ?? healthKey,
      evidenceId: `${record?.healthKey ?? healthKey}@${recordVersion}@${checkedAt}`,
      leagueKey: input.leagueKey,
      capability: "odds",
      recordVersion,
      status,
    });
  }
}

/** Deterministic test fixture only; production uses the control-plane adapter. */
export class StaticOpportunityProviderHealthSource implements OpportunityProviderHealthSource {
  constructor(
    private readonly providerId: string,
    private readonly healthy = true,
  ) {}
  read(input: {
    readonly sportKey: string;
    readonly leagueKey: string;
    readonly sportsbookId: string;
    readonly asOf: string;
  }): Promise<OpportunityProviderHealthEvidence> {
    return Promise.resolve({
      providerId: this.providerId,
      sportsbookId: input.sportsbookId,
      healthy: this.healthy,
      checkedAt: input.asOf,
      healthKey: `${this.providerId}:${input.leagueKey}:odds`,
      evidenceId: `${this.providerId}:${input.leagueKey}:odds@test@${input.asOf}`,
      leagueKey: input.leagueKey,
      capability: "odds",
      recordVersion: 0,
      status: this.healthy ? "healthy" : "unhealthy",
    });
  }
}
