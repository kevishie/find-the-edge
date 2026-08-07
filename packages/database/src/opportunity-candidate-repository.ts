import {
  createOpportunityCandidate,
  normalizeOpportunityCandidate,
  type OpportunityCandidate,
  type OpportunityCandidateInput,
} from "@find-the-edge/domain";

export interface OpportunityCandidatePersistResult {
  readonly outcome: "created" | "duplicate";
  readonly candidate: OpportunityCandidate;
}
export interface OpportunityCandidateRepository {
  persist(
    input: OpportunityCandidateInput,
  ): Promise<OpportunityCandidatePersistResult>;
  get(occurrenceId: string): Promise<OpportunityCandidate | null>;
}

const identical = (left: OpportunityCandidate, right: OpportunityCandidate) =>
  JSON.stringify(left) === JSON.stringify(right);

export class MemoryOpportunityCandidateRepository implements OpportunityCandidateRepository {
  private readonly records = new Map<string, OpportunityCandidate>();

  persist(input: OpportunityCandidateInput) {
    const candidate = createOpportunityCandidate(input);
    const existing = this.records.get(candidate.occurrenceId);
    if (existing) {
      if (!identical(existing, candidate))
        return Promise.reject(
          new Error("opportunity-candidate-replay-conflict"),
        );
      return Promise.resolve({
        outcome: "duplicate" as const,
        candidate: structuredClone(existing),
      });
    }
    this.records.set(candidate.occurrenceId, structuredClone(candidate));
    return Promise.resolve({
      outcome: "created" as const,
      candidate: structuredClone(candidate),
    });
  }

  get(occurrenceId: string) {
    const candidate = this.records.get(occurrenceId);
    return Promise.resolve(
      candidate
        ? normalizeOpportunityCandidate(structuredClone(candidate))
        : null,
    );
  }
}

export const opportunityCandidatesEqual = identical;
