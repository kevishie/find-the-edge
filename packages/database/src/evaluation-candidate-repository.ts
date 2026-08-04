import type { EventRepository } from "./event-repository";

export interface EvaluationCandidate {
  readonly eventId: string;
  readonly eventVersion: number;
  readonly sportKey: string;
  readonly leagueKey: string;
  readonly participantIds: readonly string[];
  readonly startsAt: string;
  readonly status: "scheduled";
}
export interface EvaluationCandidateQuery {
  readonly sportKey: string;
  readonly leagueKey: string;
  readonly from: string;
  readonly until: string;
  readonly limit: number;
}
export interface EvaluationCandidateRepository {
  listEligible(
    query: EvaluationCandidateQuery,
  ): Promise<readonly EvaluationCandidate[]>;
  rereadEligible(
    candidate: EvaluationCandidate,
    asOf: string,
  ): Promise<EvaluationCandidate | null>;
}
export class EventEvaluationCandidateRepository implements EvaluationCandidateRepository {
  constructor(private readonly events: EventRepository) {}
  async listEligible(query: EvaluationCandidateQuery) {
    if (
      !Number.isSafeInteger(query.limit) ||
      query.limit < 1 ||
      query.limit > 100 ||
      Date.parse(query.from) >= Date.parse(query.until)
    )
      throw new Error("evaluation-candidate-query-invalid");
    const days = new Set<string>();
    for (
      let cursor = new Date(query.from);
      cursor <= new Date(query.until);
      cursor = new Date(cursor.getTime() + 86_400_000)
    )
      days.add(cursor.toISOString().slice(0, 10));
    days.add(query.until.slice(0, 10));
    const candidates: EvaluationCandidate[] = [];
    for (const day of days) {
      let token: string | undefined;
      do {
        const page = await this.events.list(
          {
            sportKey: query.sportKey,
            leagueKey: query.leagueKey,
            status: "scheduled",
            day,
          },
          Math.min(50, query.limit - candidates.length),
          token,
        );
        for (const item of page.items)
          if (
            item.status === "scheduled" &&
            item.startsAt >= query.from &&
            item.startsAt < query.until
          )
            candidates.push(
              Object.freeze({
                eventId: item.id,
                eventVersion: item.version,
                sportKey: item.sportKey,
                leagueKey: item.leagueKey,
                participantIds: item.participants.map(({ id }) => id),
                startsAt: item.startsAt,
                status: "scheduled",
              }),
            );
        token = page.nextCursor ?? undefined;
      } while (token && candidates.length < query.limit);
      if (candidates.length >= query.limit) break;
    }
    return Object.freeze(
      candidates
        .sort(
          (a, b) =>
            a.startsAt.localeCompare(b.startsAt) ||
            a.eventId.localeCompare(b.eventId),
        )
        .slice(0, query.limit),
    );
  }
  async rereadEligible(candidate: EvaluationCandidate, asOf: string) {
    const detail = await this.events.detail(candidate.eventId);
    const item = detail.item;
    if (
      !item ||
      item.status !== "scheduled" ||
      item.version !== candidate.eventVersion ||
      item.startsAt !== candidate.startsAt ||
      item.startsAt <= asOf ||
      item.sportKey !== candidate.sportKey ||
      item.leagueKey !== candidate.leagueKey ||
      item.participants.length !== candidate.participantIds.length ||
      item.participants.some(
        ({ id }, index) => id !== candidate.participantIds[index],
      )
    )
      return null;
    return candidate;
  }
}
export class MemoryEvaluationCandidateRepository implements EvaluationCandidateRepository {
  constructor(private readonly candidates: readonly EvaluationCandidate[]) {}
  listEligible(query: EvaluationCandidateQuery) {
    return Promise.resolve(
      this.candidates
        .filter(
          (candidate) =>
            candidate.sportKey === query.sportKey &&
            candidate.leagueKey === query.leagueKey &&
            candidate.startsAt >= query.from &&
            candidate.startsAt < query.until,
        )
        .slice(0, query.limit),
    );
  }
  rereadEligible(candidate: EvaluationCandidate, asOf: string) {
    const current = this.candidates.find(
      (item) =>
        item.eventId === candidate.eventId &&
        item.eventVersion === candidate.eventVersion &&
        item.startsAt === candidate.startsAt &&
        item.sportKey === candidate.sportKey &&
        item.leagueKey === candidate.leagueKey &&
        item.participantIds.length === candidate.participantIds.length &&
        item.participantIds.every(
          (id, index) => id === candidate.participantIds[index],
        ),
    );
    return Promise.resolve(
      current?.status === "scheduled" && current.startsAt > asOf
        ? current
        : null,
    );
  }
}
