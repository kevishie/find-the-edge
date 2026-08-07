import {
  fixtureOddsGroupAvailabilityIdentity,
  fixtureOddsPartition,
  isOpportunityPointVectorCoherent,
  type FixtureOddsAvailabilityEvidence,
  type NormalizedFixtureOddsSnapshot,
} from "@find-the-edge/domain";
import {
  validateFixtureOddsCurrentItem,
  validateFixtureOddsSnapshotItem,
  type FixtureOddsDynamoGateway,
} from "./fixture-odds-adapter";

export type OpportunityEvidenceBookState =
  | "active"
  | "missing"
  | "stale"
  | "suspended"
  | "closed"
  | "incomplete"
  | "incoherent"
  | "unavailable";

export class OpportunityEvidenceInputError extends Error {
  override readonly name = "OpportunityEvidenceInputError";
}
export class OpportunityEvidenceCorruptionError extends Error {
  override readonly name = "OpportunityEvidenceCorruptionError";
}

export interface OpportunityEvidenceSelection {
  readonly selectionKey: string;
  readonly point: number | null;
}
export interface OpportunityEvidenceQuery {
  readonly canonicalEventId: string;
  readonly canonicalEventVersion: number;
  readonly sportKey: string;
  readonly marketKey: string;
  readonly selections: readonly OpportunityEvidenceSelection[];
  readonly targetSportsbookId: string;
  readonly comparisonSportsbookIds: readonly string[];
  readonly asOf: string;
  readonly maximumAgeMinutes: number;
}
export interface OpportunityExactEvidenceBook {
  readonly sportsbookId: string;
  readonly state: OpportunityEvidenceBookState;
  readonly snapshots: readonly NormalizedFixtureOddsSnapshot[];
  readonly selectionAvailability: readonly (FixtureOddsAvailabilityEvidence | null)[];
  readonly groupAvailability: FixtureOddsAvailabilityEvidence | null;
  readonly ageMinutes: number | null;
}
export interface OpportunityEvidenceResult {
  readonly target: OpportunityExactEvidenceBook;
  readonly comparisons: readonly OpportunityExactEvidenceBook[];
}
export interface OpportunityEvidenceRepository {
  read(query: OpportunityEvidenceQuery): Promise<OpportunityEvidenceResult>;
}

const compareText = (left: string, right: string) =>
  left < right ? -1 : left > right ? 1 : 0;

function validateQuery(query: OpportunityEvidenceQuery): void {
  if (
    (query.selections.length !== 2 && query.selections.length !== 3) ||
    new Set(query.selections.map(({ selectionKey }) => selectionKey)).size !==
      query.selections.length ||
    query.selections.some(
      ({ selectionKey, point }) =>
        !selectionKey ||
        (point !== null &&
          (typeof point !== "number" || !Number.isFinite(point))),
    ) ||
    query.comparisonSportsbookIds.includes(query.targetSportsbookId) ||
    new Set(query.comparisonSportsbookIds).size !==
      query.comparisonSportsbookIds.length ||
    !Number.isSafeInteger(query.canonicalEventVersion) ||
    query.canonicalEventVersion < 1 ||
    !Number.isFinite(Date.parse(query.asOf)) ||
    !Number.isFinite(query.maximumAgeMinutes) ||
    query.maximumAgeMinutes < 0
  )
    throw new OpportunityEvidenceInputError(
      "opportunity-evidence-query-invalid",
    );
}

function availabilityState(
  value: FixtureOddsAvailabilityEvidence | null,
): OpportunityEvidenceBookState | null {
  if (value === null) return "unavailable";
  if (value.state === "active") return null;
  if (value.state === "stale") return "stale";
  if (value.state === "suspended") return "suspended";
  if (value.state === "closed") return "closed";
  if (value.state === "incomplete" || value.state === "malformed")
    return "incomplete";
  if (value.state === "missing") return "missing";
  return "unavailable";
}

function validateAvailability(
  value: FixtureOddsAvailabilityEvidence | null,
  expectedIdentity: string,
  asOf: string,
): void {
  if (value === null) return;
  if (
    value.identity !== expectedIdentity ||
    !value.evidenceId ||
    !value.reason ||
    !Number.isFinite(Date.parse(value.observedAt))
  )
    throw new OpportunityEvidenceCorruptionError(
      "opportunity-availability-invalid",
    );
  if (Date.parse(value.observedAt) > Date.parse(asOf))
    throw new OpportunityEvidenceCorruptionError(
      "opportunity-availability-from-future",
    );
}

function pointsCoherent(
  marketKey: string,
  selections: readonly OpportunityEvidenceSelection[],
  snapshots: readonly NormalizedFixtureOddsSnapshot[],
): boolean {
  if (snapshots.length !== selections.length) return false;
  const expected = new Map(
    selections.map((item) => [item.selectionKey, item.point]),
  );
  return (
    snapshots.every(
      (snapshot) =>
        expected.get(snapshot.selectionKey) === (snapshot.point ?? null),
    ) &&
    isOpportunityPointVectorCoherent(
      marketKey,
      snapshots.map(({ selectionKey, point }) => ({
        selectionKey,
        point: point ?? null,
      })),
    )
  );
}

const sameMutableEvidence = (left: unknown, right: unknown) =>
  JSON.stringify(left) === JSON.stringify(right);

export class DynamoOpportunityEvidenceRepository implements OpportunityEvidenceRepository {
  constructor(private readonly gateway: FixtureOddsDynamoGateway) {}

  async read(
    query: OpportunityEvidenceQuery,
  ): Promise<OpportunityEvidenceResult> {
    validateQuery(query);
    if (!this.gateway.getAvailability)
      throw new OpportunityEvidenceCorruptionError(
        "opportunity-availability-store-unavailable",
      );
    const books = [query.targetSportsbookId, ...query.comparisonSportsbookIds];
    const results: OpportunityExactEvidenceBook[] = [];
    for (const sportsbookId of books) {
      const snapshots: NormalizedFixtureOddsSnapshot[] = [];
      const availability: (FixtureOddsAvailabilityEvidence | null)[] = [];
      const currentRefs: {
        readonly partitionKey: string;
        readonly current: ReturnType<typeof validateFixtureOddsCurrentItem>;
        readonly availability: FixtureOddsAvailabilityEvidence | null;
      }[] = [];
      for (const selection of query.selections) {
        const partitionKey = fixtureOddsPartition({
          canonicalEventId: query.canonicalEventId,
          canonicalEventVersion: query.canonicalEventVersion,
          sportKey: query.sportKey,
          marketKey: query.marketKey,
          selectionKey: selection.selectionKey,
          sportsbookId,
        }).key;
        let current;
        try {
          current = validateFixtureOddsCurrentItem(
            await this.gateway.getExact(partitionKey, "CURRENT"),
            partitionKey,
          );
        } catch (error) {
          throw new OpportunityEvidenceCorruptionError(
            error instanceof Error
              ? `opportunity-current-invalid:${error.message}`
              : "opportunity-current-invalid",
          );
        }
        const selectionAvailability =
          await this.gateway.getAvailability(partitionKey);
        validateAvailability(selectionAvailability, partitionKey, query.asOf);
        availability.push(selectionAvailability);
        currentRefs.push({
          partitionKey,
          current,
          availability: selectionAvailability,
        });
        if (!current) continue;
        const exact = validateFixtureOddsSnapshotItem(
          await this.gateway.getExact(partitionKey, current.sortKey),
          partitionKey,
          current.sortKey,
        );
        if (!exact || exact.snapshotId !== current.snapshotId)
          throw new OpportunityEvidenceCorruptionError(
            "opportunity-exact-reread-mismatch",
          );
        snapshots.push(exact);
      }
      const groupIdentity = fixtureOddsGroupAvailabilityIdentity({
        canonicalEventId: query.canonicalEventId,
        canonicalEventVersion: query.canonicalEventVersion,
        sportKey: query.sportKey,
        marketKey: query.marketKey,
        sportsbookId,
      });
      const groupAvailability =
        await this.gateway.getAvailability(groupIdentity);
      validateAvailability(groupAvailability, groupIdentity, query.asOf);
      for (const reference of currentRefs) {
        const stable = validateFixtureOddsCurrentItem(
          await this.gateway.getExact(reference.partitionKey, "CURRENT"),
          reference.partitionKey,
        );
        if (!sameMutableEvidence(stable, reference.current))
          throw new OpportunityEvidenceCorruptionError(
            "opportunity-current-changed-during-read",
          );
        const stableAvailability = await this.gateway.getAvailability(
          reference.partitionKey,
        );
        validateAvailability(
          stableAvailability,
          reference.partitionKey,
          query.asOf,
        );
        if (!sameMutableEvidence(stableAvailability, reference.availability))
          throw new OpportunityEvidenceCorruptionError(
            "opportunity-availability-changed-during-read",
          );
      }
      const stableGroupAvailability =
        await this.gateway.getAvailability(groupIdentity);
      validateAvailability(stableGroupAvailability, groupIdentity, query.asOf);
      if (!sameMutableEvidence(stableGroupAvailability, groupAvailability))
        throw new OpportunityEvidenceCorruptionError(
          "opportunity-availability-changed-during-read",
        );
      if (
        snapshots.some(
          ({ observedAt, retrievedAt }) =>
            Date.parse(retrievedAt) < Date.parse(observedAt) ||
            Date.parse(observedAt) > Date.parse(query.asOf) ||
            Date.parse(retrievedAt) > Date.parse(query.asOf),
        )
      )
        throw new OpportunityEvidenceCorruptionError(
          "opportunity-evidence-time-invalid",
        );
      const ageMinutes = snapshots.length
        ? Math.max(
            ...snapshots.map(
              (snapshot) =>
                (Date.parse(query.asOf) - Date.parse(snapshot.observedAt)) /
                60_000,
            ),
          )
        : null;
      let state: OpportunityEvidenceBookState = "active";
      if (!snapshots.length) state = "missing";
      else if (snapshots.length !== query.selections.length)
        state = "incomplete";
      else if (!pointsCoherent(query.marketKey, query.selections, snapshots))
        state = "incoherent";
      else if (ageMinutes! > query.maximumAgeMinutes) state = "stale";
      else {
        const states = [
          ...availability.map((value, index) => {
            const snapshot = snapshots.find(
              ({ selectionKey }) =>
                selectionKey === query.selections[index]?.selectionKey,
            );
            return value?.state === "active" &&
              snapshot &&
              Date.parse(value.observedAt) < Date.parse(snapshot.observedAt)
              ? ("unavailable" as const)
              : availabilityState(value);
          }),
          groupAvailability?.state === "active" &&
          Date.parse(groupAvailability.observedAt) <
            Math.max(
              ...snapshots.map(({ observedAt }) => Date.parse(observedAt)),
            )
            ? ("unavailable" as const)
            : availabilityState(groupAvailability),
        ].filter((item): item is OpportunityEvidenceBookState => item !== null);
        state = states.sort(compareText)[0] ?? "active";
      }
      results.push(
        Object.freeze({
          sportsbookId,
          state,
          snapshots: Object.freeze([...snapshots]),
          selectionAvailability: Object.freeze([...availability]),
          groupAvailability,
          ageMinutes,
        }),
      );
    }
    return Object.freeze({
      target: results[0]!,
      comparisons: Object.freeze(results.slice(1)),
    });
  }
}

export class MemoryOpportunityEvidenceRepository implements OpportunityEvidenceRepository {
  constructor(
    private readonly result:
      | OpportunityEvidenceResult
      | (() => OpportunityEvidenceResult | Promise<OpportunityEvidenceResult>),
  ) {}
  async read(): Promise<OpportunityEvidenceResult> {
    const value =
      typeof this.result === "function" ? await this.result() : this.result;
    return structuredClone(value);
  }
}
