import { createHash } from "node:crypto";
import type {
  CohortDefinition,
  CohortMember,
  PaperBetRecord,
  PaperEvaluationRecord,
} from "@find-the-edge/domain";
import type { PaperEvaluationRepository } from "@find-the-edge/database";
import { oddsBand } from "@find-the-edge/odds";
import type { CohortMemberSource } from "./cohort-builder.js";

export interface CohortMemberMaterializer {
  resolve(input: {
    readonly paperBet: PaperBetRecord;
    readonly evaluation: PaperEvaluationRecord;
    readonly cutoff: string;
  }): Promise<{
    readonly member: CohortMember;
    readonly americanOdds: number;
  } | null>;
}

type Cursor = {
  readonly day: string;
  readonly dayCursor?: string;
  readonly binding: string;
};
const day = (value: Date) => value.toISOString().slice(0, 10);
const addDay = (value: string, amount: number) => {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + amount);
  return day(date);
};
const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const decode = (value: string, binding: string): Cursor => {
  try {
    const parsed = JSON.parse(
      Buffer.from(value, "base64url").toString(),
    ) as Cursor;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(parsed.day) || parsed.binding !== binding)
      throw new Error();
    return parsed;
  } catch {
    throw new Error("cohort-member-cursor-invalid");
  }
};
const encode = (value: Cursor) =>
  Buffer.from(JSON.stringify(value)).toString("base64url");

/** Production source: only the decision-day GSI is traversed; table scans are forbidden. */
export class DayIndexedCohortMemberSource implements CohortMemberSource {
  constructor(
    private readonly evaluations: PaperEvaluationRepository,
    private readonly materializer: CohortMemberMaterializer,
  ) {}

  async list(input: {
    readonly definition: CohortDefinition;
    readonly cutoff: string;
    readonly limit: number;
    readonly cursor?: string;
  }) {
    if (
      !Number.isSafeInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > 100
    )
      throw new Error("cohort-member-page-invalid");
    const binding = digest({
      definition: input.definition,
      cutoff: input.cutoff,
    });
    const finalDay = day(new Date(Date.parse(input.definition.window.to) - 1));
    let state: Cursor = input.cursor
      ? decode(input.cursor, binding)
      : { day: day(new Date(input.definition.window.from)), binding };
    const items: CohortMember[] = [];
    while (state.day <= finalDay && items.length < input.limit) {
      const page = await this.evaluations.listPaperBetsByDecisionDay({
        day: state.day,
        limit: Math.min(100, input.limit - items.length),
        ...(state.dayCursor ? { cursor: state.dayCursor } : {}),
      });
      for (const paperBet of page.items) {
        if (
          paperBet.createdAt < input.definition.window.from ||
          paperBet.createdAt >= input.definition.window.to ||
          paperBet.createdAt > input.cutoff
        )
          continue;
        const evaluation = await this.evaluations.getEvaluation(
          paperBet.evaluationId,
        );
        if (
          !evaluation ||
          evaluation.createdAt > input.cutoff ||
          !this.matches(evaluation, input.definition)
        )
          continue;
        const resolved = await this.materializer.resolve({
          paperBet,
          evaluation,
          cutoff: input.cutoff,
        });
        if (
          !resolved ||
          (input.definition.filters.oddsBands &&
            !input.definition.filters.oddsBands.includes(
              oddsBand(resolved.americanOdds),
            ))
        )
          continue;
        items.push(resolved.member);
      }
      state = page.nextCursor
        ? { ...state, dayCursor: page.nextCursor }
        : { day: addDay(state.day, 1), binding };
    }
    return {
      items,
      ...(state.day <= finalDay ? { nextCursor: encode(state) } : {}),
    };
  }

  private matches(
    evaluation: PaperEvaluationRecord,
    definition: CohortDefinition,
  ) {
    const { filters } = definition,
      manifest = evaluation.manifest;
    return (
      (manifest.wagerMode ?? "paper") === "paper" &&
      (!filters.sports || filters.sports.includes(manifest.sportKey)) &&
      (!filters.leagues || filters.leagues.includes(manifest.leagueKey)) &&
      (!filters.markets ||
        filters.markets.includes(
          manifest.marketKey as "moneyline" | "spread",
        )) &&
      (!filters.strategyVersions ||
        filters.strategyVersions.includes(
          manifest.versions.strategy.version,
        )) &&
      (!filters.modelVersions ||
        filters.modelVersions.includes(manifest.versions.model.version))
    );
  }
}
