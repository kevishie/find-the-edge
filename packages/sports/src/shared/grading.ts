import type {
  CompletedEventResultObservation,
  PaperGradingTerms,
} from "@find-the-edge/domain";
import {
  gradeMoneyline,
  gradeSpread,
  type DeterministicGrade,
} from "@find-the-edge/odds";

export interface SportPaperGradingAdapter {
  readonly sportKey: string;
  readonly version: string;
  grade(input: {
    eventId: string;
    terms: PaperGradingTerms;
    selectionKey: string;
    americanOdds: number;
    result: CompletedEventResultObservation;
  }): DeterministicGrade;
}
export const createTeamSportGradingAdapter = (
  sportKey: string,
  acceptedFullEventScopes: readonly string[],
): SportPaperGradingAdapter => ({
  sportKey,
  version: "paper-grading-v1",
  grade({ eventId, terms, selectionKey, americanOdds, result }) {
    if (result.sportKey !== sportKey)
      return {
        outcome: "unresolved",
        reason: "sport-mismatch",
        profit: 0,
        payout: 1,
        roi: 0,
      };
    if (result.canonicalEventId !== eventId)
      return {
        outcome: "unresolved",
        reason: "event-mismatch",
        profit: 0,
        payout: 1,
        roi: 0,
      };
    if (
      result.canonicalEventId !== undefined &&
      result.canonicalEventVersion !== terms.canonicalEventVersion
    )
      return {
        outcome: "unresolved",
        reason: "event-version-mismatch",
        profit: 0,
        payout: 1,
        roi: 0,
      };
    if (
      result.state === "final" &&
      ((terms.market.resultScope === "regulation" &&
        result.scoreScope !== "regulation") ||
        (terms.market.resultScope === "full-event" &&
          !acceptedFullEventScopes.includes(result.scoreScope)))
    )
      return {
        outcome: "unresolved",
        reason: "result-scope-mismatch",
        profit: 0,
        payout: 1,
        roi: 0,
      };
    const scores = result.scores;
    if (
      result.state === "final" &&
      (!scores ||
        scores.length !== 2 ||
        scores.some(
          (score) =>
            !Number.isSafeInteger(score.score) || Number(score.score) < 0,
        ) ||
        scores.some(
          (score) => !terms.participants.includes(score.participantId),
        ))
    )
      return {
        outcome: "unresolved",
        reason: "participant-mismatch",
        profit: 0,
        payout: 1,
        roi: 0,
      };
    const away = scores?.find(
      (score) => score.participantId === terms.participants[0],
    )?.score;
    const home = scores?.find(
      (score) => score.participantId === terms.participants[1],
    )?.score;
    const normalizedScores =
      away === undefined || home === undefined ? undefined : { away, home };
    if (terms.market.kind === "moneyline") {
      if (selectionKey === "draw" && terms.market.outcomeCount !== 3)
        return {
          outcome: "unresolved",
          reason: "selection-mismatch",
          profit: 0,
          payout: 1,
          roi: 0,
        };
      const selected =
        selectionKey === "draw"
          ? "draw"
          : selectionKey === terms.participants[0]
            ? "away"
            : selectionKey === terms.participants[1]
              ? "home"
              : undefined;
      if (!selected)
        return {
          outcome: "unresolved",
          reason: "selection-mismatch",
          profit: 0,
          payout: 1,
          roi: 0,
        };
      return gradeMoneyline({
        ...(normalizedScores ? { scores: normalizedScores } : {}),
        selected,
        outcomeCount: terms.market.outcomeCount,
        americanOdds,
        terminalState: result.state,
      });
    }
    const selected =
      terms.market.selectedParticipantId === terms.participants[0]
        ? "away"
        : terms.market.selectedParticipantId === terms.participants[1]
          ? "home"
          : undefined;
    if (!selected || selectionKey !== terms.market.selectedParticipantId)
      return {
        outcome: "unresolved",
        reason: "selection-mismatch",
        profit: 0,
        payout: 1,
        roi: 0,
      };
    return gradeSpread({
      ...(normalizedScores ? { scores: normalizedScores } : {}),
      selected,
      point: terms.market.point,
      americanOdds,
      terminalState: result.state,
    });
  },
});
export function gradingTermsForCandidate(input: {
  sportKey: string;
  eventVersion: number;
  participantIds: readonly [string, string];
  marketKey: "moneyline" | "spread";
  outcomeStructure: "two-way" | "three-way";
  selectedParticipantId?: string;
  point?: number;
}): PaperGradingTerms | null {
  if (!["mlb", "soccer"].includes(input.sportKey)) return null;
  const resultScope = input.sportKey === "soccer" ? "regulation" : "full-event";
  if (input.marketKey === "moneyline")
    return {
      schemaVersion: "1",
      canonicalEventVersion: input.eventVersion,
      participants: [...input.participantIds],
      market: {
        kind: "moneyline",
        outcomeCount: input.outcomeStructure === "three-way" ? 3 : 2,
        resultScope,
      },
    };
  if (
    !input.selectedParticipantId ||
    input.point === undefined ||
    !Number.isFinite(input.point)
  )
    return null;
  return {
    schemaVersion: "1",
    canonicalEventVersion: input.eventVersion,
    participants: [...input.participantIds],
    market: {
      kind: "spread",
      selectedParticipantId: input.selectedParticipantId,
      point: input.point,
      resultScope,
    },
  };
}
