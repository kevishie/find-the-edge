export type ClvUnavailableReason =
  | "legacy-scheduled-start-missing"
  | "closing-price-missing"
  | "closing-price-stale"
  | "closing-price-post-start"
  | "closing-line-changed"
  | "closing-book-mismatch";
export interface ClosingCandidate {
  readonly partitionKey?: string;
  readonly snapshotId: string;
  readonly eventId: string;
  readonly eventVersion: number;
  readonly sportKey: string;
  readonly marketKey: string;
  readonly selectionKey: string;
  readonly sportsbookId: string;
  readonly point?: number;
  readonly americanOdds: number;
  readonly observedAt: string;
  readonly state: "active" | "suspended";
}
export function selectClosingOdds(input: {
  readonly scheduledStart?: string;
  readonly opening: ClosingCandidate;
  readonly candidates: readonly ClosingCandidate[];
}): {
  readonly snapshot: ClosingCandidate | null;
  readonly unavailableReason: ClvUnavailableReason | null;
} {
  const validIso = (value: string) =>
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value;
  if (
    (input.scheduledStart && !validIso(input.scheduledStart)) ||
    !validIso(input.opening.observedAt) ||
    input.candidates.some((candidate) => !validIso(candidate.observedAt))
  )
    throw new Error("closing-timestamp-invalid");
  if (!input.scheduledStart)
    return {
      snapshot: null,
      unavailableReason: "legacy-scheduled-start-missing",
    };
  const start = Date.parse(input.scheduledStart),
    earliest = start - 900000,
    same = input.candidates
      .filter(
        (c) =>
          c.eventId === input.opening.eventId &&
          c.eventVersion === input.opening.eventVersion &&
          c.sportKey === input.opening.sportKey &&
          c.marketKey === input.opening.marketKey &&
          c.selectionKey === input.opening.selectionKey &&
          c.sportsbookId === input.opening.sportsbookId &&
          c.point === input.opening.point &&
          c.state === "active",
      )
      .sort((a, b) => b.observedAt.localeCompare(a.observedAt)),
    valid = same.find(
      (c) =>
        Date.parse(c.observedAt) <= start &&
        Date.parse(c.observedAt) >= earliest,
    );
  if (valid) return { snapshot: valid, unavailableReason: null };
  if (same.some((c) => Date.parse(c.observedAt) > start))
    return { snapshot: null, unavailableReason: "closing-price-post-start" };
  if (same.length)
    return { snapshot: null, unavailableReason: "closing-price-stale" };
  const related = input.candidates.filter(
    (c) =>
      c.eventId === input.opening.eventId &&
      c.eventVersion === input.opening.eventVersion &&
      c.sportKey === input.opening.sportKey &&
      c.marketKey === input.opening.marketKey &&
      c.selectionKey === input.opening.selectionKey,
  );
  if (
    related.some(
      (c) =>
        c.sportsbookId === input.opening.sportsbookId &&
        c.point !== input.opening.point,
    )
  )
    return { snapshot: null, unavailableReason: "closing-line-changed" };
  if (related.some((c) => c.sportsbookId !== input.opening.sportsbookId))
    return { snapshot: null, unavailableReason: "closing-book-mismatch" };
  return { snapshot: null, unavailableReason: "closing-price-missing" };
}
