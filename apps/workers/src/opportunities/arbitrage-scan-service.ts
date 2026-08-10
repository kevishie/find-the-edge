import {
  defaultArbitragePolicy,
  validateArbitragePolicy,
  type ArbitragePolicy,
} from "@find-the-edge/config";
import type {
  ArbitrageBoardRepository,
  OpportunityEvidenceRepository,
  OpportunityExactEvidenceBook,
} from "@find-the-edge/database";
import {
  computeMarketArbitrage,
  createArbitrageFinding,
  type ArbitrageFinding,
  type OpportunityComparisonExclusionReasonCode,
  type OpportunitySnapshotEvidence,
} from "@find-the-edge/domain";
import {
  snapshotEvidence,
  type OpportunityGenerationEvent,
} from "../opportunity-candidate-service";

export interface ArbitrageScanSummary {
  readonly arbitrageCount: number;
  readonly lowHoldCount: number;
  readonly failedMarkets: number;
}

const exclusionReason = (
  state: OpportunityExactEvidenceBook["state"],
): OpportunityComparisonExclusionReasonCode => {
  switch (state) {
    case "closed":
      return "closed";
    case "incoherent":
      return "incoherent";
    case "incomplete":
      return "incomplete";
    case "stale":
      return "stale";
    case "suspended":
      return "suspended";
    default:
      return "unavailable";
  }
};

/** Scans a slate's markets for cross-book arbitrage and low-hold sets, all
 * evidence snapshot-pinned by the same reader the +EV pipeline trusts; the
 * latest scan per sport replaces that sport's board wholesale. */
export class ArbitrageScanService {
  private readonly policy: ArbitragePolicy;
  constructor(
    private readonly dependencies: {
      readonly evidence: OpportunityEvidenceRepository;
      readonly board: ArbitrageBoardRepository;
      readonly policy?: ArbitragePolicy;
    },
  ) {
    this.policy = validateArbitragePolicy(
      dependencies.policy ?? defaultArbitragePolicy,
    );
  }

  async scanEvents(
    events: readonly OpportunityGenerationEvent[],
    asOf: string,
  ): Promise<ArbitrageScanSummary> {
    const findingsBySport = new Map<string, ArbitrageFinding[]>();
    let arbitrageCount = 0;
    let lowHoldCount = 0;
    let failedMarkets = 0;
    for (const event of events) {
      for (const market of event.markets) {
        try {
          const finding = await this.scanMarket(event, market, asOf);
          if (!finding) continue;
          const bucket = findingsBySport.get(event.sportKey) ?? [];
          bucket.push(finding);
          findingsBySport.set(event.sportKey, bucket);
          if (finding.classification === "arbitrage") arbitrageCount += 1;
          else lowHoldCount += 1;
        } catch (error) {
          // The evidence reader fails closed on torn reads mid-write; a
          // skipped market this tick rescans on the next.
          failedMarkets += 1;
          console.log(
            JSON.stringify({
              event: "arbitrage-market-scan-failed",
              eventId: event.eventId,
              marketKey: market.marketKey,
              errorName: error instanceof Error ? error.name : "unknown",
              errorMessage:
                error instanceof Error
                  ? error.message.slice(0, 300)
                  : "unknown",
            }),
          );
        }
      }
    }
    for (const sportKey of new Set(events.map(({ sportKey }) => sportKey)))
      await this.dependencies.board.putBoard(
        sportKey,
        findingsBySport.get(sportKey) ?? [],
        asOf,
      );
    return { arbitrageCount, lowHoldCount, failedMarkets };
  }

  private async scanMarket(
    event: OpportunityGenerationEvent,
    market: OpportunityGenerationEvent["markets"][number],
    asOf: string,
  ): Promise<ArbitrageFinding | null> {
    const [nominalTarget, ...rest] = this.policy.sportsbookIds;
    const evidence = await this.dependencies.evidence.read({
      canonicalEventId: event.eventId,
      canonicalEventVersion: event.eventVersion,
      sportKey: event.sportKey,
      marketKey: market.marketKey,
      selections: market.selections,
      targetSportsbookId: nominalTarget!,
      comparisonSportsbookIds: rest,
      asOf,
      maximumAgeMinutes: this.policy.maximumPriceAgeMinutes,
    });
    const books = [evidence.target, ...evidence.comparisons];
    const active = books.filter((book) => book.state === "active");
    if (active.length < 2) return null;
    const excludedBooks = books
      .filter((book) => book.state !== "active")
      .map((book) => ({
        sportsbookId: book.sportsbookId,
        reasonCodes: [exclusionReason(book.state)],
      }));
    const quotesPerOutcome = market.selections.map(({ selectionKey }) =>
      active.flatMap((book) => {
        const snapshot = book.snapshots.find(
          (candidate) => candidate.selectionKey === selectionKey,
        );
        return snapshot ? [snapshotEvidence(snapshot, book)] : [];
      }),
    );
    const computation = computeMarketArbitrage(
      quotesPerOutcome,
      this.policy.lowHoldThreshold,
    );
    if (!computation || computation.classification === null) return null;
    const legs = market.selections.map((selection, index) => {
      const best = computation.bestPerOutcome[index]!;
      const competing = quotesPerOutcome[index]!.filter(
        (quote): quote is OpportunitySnapshotEvidence =>
          quote.sportsbookId !== best.sportsbookId,
      );
      return {
        selectionKey: selection.selectionKey,
        point: selection.point,
        best,
        competing,
      };
    });
    return createArbitrageFinding({
      canonicalEventId: event.eventId,
      canonicalEventVersion: event.eventVersion,
      sportKey: event.sportKey,
      leagueKey: event.leagueKey,
      marketKey: market.marketKey,
      startsAt: event.startsAt,
      evaluatedAt: asOf,
      legs,
      excludedBooks,
      policy: {
        id: this.policy.id,
        version: this.policy.version,
        lowHoldThreshold: this.policy.lowHoldThreshold,
        maximumPriceAgeMinutes: this.policy.maximumPriceAgeMinutes,
      },
    });
  }
}
