import type { NormalizedFixtureOddsSnapshot } from "@find-the-edge/domain";
import { fixtureOddsPartition } from "@find-the-edge/domain";
import {
  validateFixtureOddsCurrentItem,
  validateFixtureOddsSnapshotItem,
  type FixtureOddsDynamoGateway,
} from "./fixture-odds-adapter";

export type EvidenceReadCode =
  | "offered-missing"
  | "offered-stale"
  | "comparison-sparse"
  | "comparison-incomplete"
  | "comparison-stale"
  | "evidence-from-future";
export class EvaluationEvidenceInputError extends Error {
  override readonly name = "EvaluationEvidenceInputError";
}
export interface EvidenceSelection {
  readonly selectionKey: string;
  readonly point?: number;
}
export interface EvaluationEvidenceQuery {
  readonly eventId: string;
  readonly eventVersion: number;
  readonly sportKey: string;
  readonly marketKey: string;
  readonly selections: readonly EvidenceSelection[];
  readonly targetSportsbookId: string;
  readonly comparisonSportsbookIds: readonly string[];
  readonly asOf: string;
  readonly maximumAgeMinutes: number;
  readonly minimumComparisonBooks: number;
}
export interface ExactEvidenceBook {
  readonly sportsbookId: string;
  readonly snapshots: readonly NormalizedFixtureOddsSnapshot[];
}
export interface EvaluationEvidenceResult {
  readonly status: "ready" | "invalid";
  readonly reasonCodes: readonly EvidenceReadCode[];
  readonly offered: ExactEvidenceBook | null;
  readonly comparisons: readonly ExactEvidenceBook[];
}
export interface EvaluationEvidenceRepository {
  read(query: EvaluationEvidenceQuery): Promise<EvaluationEvidenceResult>;
}

export class DynamoEvaluationEvidenceRepository implements EvaluationEvidenceRepository {
  constructor(private readonly gateway: FixtureOddsDynamoGateway) {}

  async read(
    query: EvaluationEvidenceQuery,
  ): Promise<EvaluationEvidenceResult> {
    if (
      (query.selections.length !== 2 && query.selections.length !== 3) ||
      new Set(
        query.selections.map(
          ({ selectionKey, point }) => `${selectionKey}\u0000${point ?? ""}`,
        ),
      ).size !== query.selections.length
    )
      throw new EvaluationEvidenceInputError(
        "evidence-selection-vector-invalid",
      );
    if (
      query.comparisonSportsbookIds.includes(query.targetSportsbookId) ||
      new Set(query.comparisonSportsbookIds).size !==
        query.comparisonSportsbookIds.length
    )
      throw new EvaluationEvidenceInputError(
        "evidence-comparison-books-invalid",
      );
    if (!Number.isFinite(Date.parse(query.asOf)))
      throw new EvaluationEvidenceInputError("evidence-as-of-invalid");
    const books = [query.targetSportsbookId, ...query.comparisonSportsbookIds];
    const exactBooks: ExactEvidenceBook[] = [];
    let evidenceFromFuture = false;
    for (const sportsbookId of books) {
      const snapshots: NormalizedFixtureOddsSnapshot[] = [];
      for (const selection of query.selections) {
        const partitionKey = fixtureOddsPartition({
          canonicalEventId: query.eventId,
          canonicalEventVersion: query.eventVersion,
          sportKey: query.sportKey,
          marketKey: query.marketKey,
          selectionKey: selection.selectionKey,
          sportsbookId,
        }).key;
        const currentItem = await this.gateway.getExact(
          partitionKey,
          "CURRENT",
        );
        const current = validateFixtureOddsCurrentItem(
          currentItem,
          partitionKey,
        );
        if (!current) continue;
        const exactItem = await this.gateway.getExact(
          partitionKey,
          current.sortKey,
        );
        const exact = validateFixtureOddsSnapshotItem(
          exactItem,
          partitionKey,
          current.sortKey,
        );
        if (!exact || exact.snapshotId !== current.snapshotId)
          throw new Error("evidence-exact-reread-mismatch");
        if (
          Date.parse(exact.observedAt) > Date.parse(query.asOf) ||
          Date.parse(exact.retrievedAt) > Date.parse(query.asOf)
        )
          evidenceFromFuture = true;
        if (selection.point !== undefined && exact.point !== selection.point)
          continue;
        snapshots.push(exact);
      }
      if (snapshots.length === query.selections.length)
        exactBooks.push({ sportsbookId, snapshots });
    }
    const offered =
      exactBooks.find(
        (book) => book.sportsbookId === query.targetSportsbookId,
      ) ?? null;
    const comparisons = exactBooks.filter(
      (book) => book.sportsbookId !== query.targetSportsbookId,
    );
    const reasons = new Set<EvidenceReadCode>();
    if (evidenceFromFuture) reasons.add("evidence-from-future");
    if (!offered) reasons.add("offered-missing");
    if (
      offered?.snapshots.some(
        (snapshot) =>
          (Date.parse(query.asOf) - Date.parse(snapshot.observedAt)) / 60_000 >
          query.maximumAgeMinutes,
      )
    )
      reasons.add("offered-stale");
    if (comparisons.length < query.minimumComparisonBooks)
      reasons.add("comparison-sparse");
    if (
      comparisons.some((book) =>
        book.snapshots.some(
          (snapshot) =>
            (Date.parse(query.asOf) - Date.parse(snapshot.observedAt)) /
              60_000 >
            query.maximumAgeMinutes,
        ),
      )
    )
      reasons.add("comparison-stale");
    const requestedComparisonCount = query.comparisonSportsbookIds.length;
    if (comparisons.length < requestedComparisonCount)
      reasons.add("comparison-incomplete");
    return Object.freeze({
      status: reasons.size ? "invalid" : "ready",
      reasonCodes: Object.freeze([...reasons].sort()),
      offered,
      comparisons: Object.freeze(comparisons),
    });
  }
}

export class MemoryEvaluationEvidenceRepository implements EvaluationEvidenceRepository {
  constructor(private readonly result: EvaluationEvidenceResult) {}
  read(): Promise<EvaluationEvidenceResult> {
    return Promise.resolve(structuredClone(this.result));
  }
}
