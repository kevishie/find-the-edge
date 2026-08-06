import { impliedProbability } from "./index";

export const LINE_MOVEMENT_CALCULATION_VERSION = "line-movement-v1" as const;

export type MovementObservationState = "active" | "suspended" | "unavailable";

export interface MovementObservation {
  readonly observationId: string;
  readonly state: MovementObservationState;
  readonly americanOdds: number;
  readonly point?: number;
  readonly observedAt: string;
  readonly retrievedAt: string;
}

export interface LineMovementInput {
  readonly observations: readonly MovementObservation[];
  readonly significantProbabilityChange: number;
  readonly maximumGapMinutes: number;
}

export type MovementDirection = "shortened" | "lengthened" | "unchanged";

export type MovementIssue =
  | "current-observation-inactive"
  | "history-gap-exceeded"
  | "insufficient-active-observations"
  | "invalid-observation"
  | "line-changed";

export interface PointMovement {
  readonly opening: number | null;
  readonly latest: number | null;
  readonly delta: number | null;
  readonly changed: boolean;
}

export interface PriceMovement {
  readonly openingAmericanOdds: number;
  readonly latestAmericanOdds: number;
  readonly americanOddsDelta: number;
  readonly openingImpliedProbability: number;
  readonly latestImpliedProbability: number;
  readonly impliedProbabilityDelta: number;
  readonly direction: MovementDirection;
  readonly significant: boolean;
}

export interface MovementGap {
  readonly maximumMinutes: number;
  readonly thresholdMinutes: number;
  readonly exceedsThreshold: boolean;
}

export interface LineMovementResult {
  readonly calculationVersion: typeof LINE_MOVEMENT_CALCULATION_VERSION;
  readonly status: "available" | "unavailable" | "invalid";
  readonly issues: readonly MovementIssue[];
  readonly currentState: MovementObservationState | null;
  readonly activeObservationCount: number;
  readonly openingObservationId: string | null;
  readonly latestObservationId: string | null;
  readonly pointMovement: Readonly<PointMovement> | null;
  readonly priceMovement: Readonly<PriceMovement> | null;
  readonly gap: Readonly<MovementGap> | null;
}

interface OrderedObservation {
  readonly observation: MovementObservation;
  readonly observedAt: number;
  readonly retrievedAt: number;
}

function assertProbabilityThreshold(value: number): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new RangeError(
      "Movement probability threshold must be finite and in [0, 1]",
    );
  }
}

function assertGapValue(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${label} must be finite and nonnegative`);
  }
}

function parseCanonicalTimestamp(value: string): number | null {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return null;
  try {
    return new Date(parsed).toISOString() === value ? parsed : null;
  } catch {
    return null;
  }
}

function compareCanonicalText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function isSignificantProbabilityMovement(
  probabilityDelta: number,
  threshold: number,
): boolean {
  if (!Number.isFinite(probabilityDelta)) {
    throw new RangeError("Movement probability delta must be finite");
  }
  assertProbabilityThreshold(threshold);
  return Math.abs(probabilityDelta) >= threshold;
}

export function exceedsMovementGap(
  maximumGapMinutes: number,
  thresholdMinutes: number,
): boolean {
  assertGapValue(maximumGapMinutes, "Movement maximum gap");
  assertGapValue(thresholdMinutes, "Movement gap threshold");
  return maximumGapMinutes > thresholdMinutes;
}

function freezeMovementResult(
  result: Omit<LineMovementResult, "calculationVersion">,
): LineMovementResult {
  return Object.freeze({
    calculationVersion: LINE_MOVEMENT_CALCULATION_VERSION,
    ...result,
    issues: Object.freeze([...result.issues]),
    pointMovement:
      result.pointMovement === null
        ? null
        : Object.freeze({ ...result.pointMovement }),
    priceMovement:
      result.priceMovement === null
        ? null
        : Object.freeze({ ...result.priceMovement }),
    gap: result.gap === null ? null : Object.freeze({ ...result.gap }),
  });
}

function invalidMovementResult(): LineMovementResult {
  return freezeMovementResult({
    status: "invalid",
    issues: ["invalid-observation"],
    currentState: null,
    activeObservationCount: 0,
    openingObservationId: null,
    latestObservationId: null,
    pointMovement: null,
    priceMovement: null,
    gap: null,
  });
}

function orderObservations(
  observations: readonly MovementObservation[],
): readonly OrderedObservation[] | null {
  const ids = new Set<string>();
  const ordered: OrderedObservation[] = [];
  for (const observation of observations) {
    const observedAt = parseCanonicalTimestamp(observation.observedAt);
    const retrievedAt = parseCanonicalTimestamp(observation.retrievedAt);
    if (
      !observation.observationId.trim() ||
      ids.has(observation.observationId) ||
      (observation.state !== "active" &&
        observation.state !== "suspended" &&
        observation.state !== "unavailable") ||
      observedAt === null ||
      retrievedAt === null ||
      (observation.point !== undefined && !Number.isFinite(observation.point))
    ) {
      return null;
    }
    try {
      const probability = impliedProbability(observation.americanOdds);
      if (probability <= 0 || probability >= 1) return null;
    } catch {
      return null;
    }
    ids.add(observation.observationId);
    ordered.push({ observation, observedAt, retrievedAt });
  }
  return ordered.sort(
    (left, right) =>
      left.observedAt - right.observedAt ||
      left.retrievedAt - right.retrievedAt ||
      compareCanonicalText(
        left.observation.observationId,
        right.observation.observationId,
      ),
  );
}

function movementDirection(probabilityDelta: number): MovementDirection {
  if (probabilityDelta > 0) return "shortened";
  if (probabilityDelta < 0) return "lengthened";
  return "unchanged";
}

export function calculateLineMovement(
  input: LineMovementInput,
): LineMovementResult {
  assertProbabilityThreshold(input.significantProbabilityChange);
  assertGapValue(input.maximumGapMinutes, "Movement gap threshold");

  const ordered = orderObservations(input.observations);
  if (ordered === null) return invalidMovementResult();

  const current = ordered.at(-1)?.observation ?? null;
  const active = ordered.filter(
    ({ observation }) => observation.state === "active",
  );
  const opening = active[0] ?? null;
  const latest = active.at(-1) ?? null;
  const issues: MovementIssue[] = [];
  if (current !== null && current.state !== "active") {
    issues.push("current-observation-inactive");
  }
  if (active.length < 2) issues.push("insufficient-active-observations");

  const inactiveCurrent =
    current !== null && current.state !== "active" ? true : false;
  if (
    active.length < 2 ||
    inactiveCurrent ||
    opening === null ||
    latest === null
  ) {
    return freezeMovementResult({
      status: "unavailable",
      issues,
      currentState: current?.state ?? null,
      activeObservationCount: active.length,
      openingObservationId: opening?.observation.observationId ?? null,
      latestObservationId: latest?.observation.observationId ?? null,
      pointMovement: null,
      priceMovement: null,
      gap: null,
    });
  }

  let maximumGapMinutes = 0;
  for (let index = 1; index < active.length; index += 1) {
    const previous = active[index - 1]!;
    const next = active[index]!;
    maximumGapMinutes = Math.max(
      maximumGapMinutes,
      (next.observedAt - previous.observedAt) / 60_000,
    );
  }
  const gapExceeded = exceedsMovementGap(
    maximumGapMinutes,
    input.maximumGapMinutes,
  );
  if (gapExceeded) issues.push("history-gap-exceeded");
  const gap = {
    maximumMinutes: maximumGapMinutes,
    thresholdMinutes: input.maximumGapMinutes,
    exceedsThreshold: gapExceeded,
  } satisfies MovementGap;

  const openingPoint = opening.observation.point ?? null;
  const latestPoint = latest.observation.point ?? null;
  const pointChanged = active.some(
    ({ observation }) => (observation.point ?? null) !== openingPoint,
  );
  const pointDelta =
    openingPoint === null || latestPoint === null
      ? null
      : latestPoint - openingPoint;
  if (pointDelta !== null && !Number.isFinite(pointDelta)) {
    return invalidMovementResult();
  }
  const pointMovement = {
    opening: openingPoint,
    latest: latestPoint,
    delta: pointDelta,
    changed: pointChanged,
  } satisfies PointMovement;
  if (pointChanged) {
    issues.unshift("line-changed");
    return freezeMovementResult({
      status: "unavailable",
      issues,
      currentState: current?.state ?? null,
      activeObservationCount: active.length,
      openingObservationId: opening.observation.observationId,
      latestObservationId: latest.observation.observationId,
      pointMovement,
      priceMovement: null,
      gap,
    });
  }

  const openingImpliedProbability = impliedProbability(
    opening.observation.americanOdds,
  );
  const latestImpliedProbability = impliedProbability(
    latest.observation.americanOdds,
  );
  const impliedProbabilityDelta =
    latestImpliedProbability - openingImpliedProbability;
  const americanOddsDelta =
    latest.observation.americanOdds - opening.observation.americanOdds;
  if (
    !Number.isFinite(americanOddsDelta) ||
    !Number.isFinite(openingImpliedProbability) ||
    !Number.isFinite(latestImpliedProbability) ||
    !Number.isFinite(impliedProbabilityDelta)
  ) {
    return invalidMovementResult();
  }
  const priceMovement = {
    openingAmericanOdds: opening.observation.americanOdds,
    latestAmericanOdds: latest.observation.americanOdds,
    americanOddsDelta,
    openingImpliedProbability,
    latestImpliedProbability,
    impliedProbabilityDelta,
    direction: movementDirection(impliedProbabilityDelta),
    significant: isSignificantProbabilityMovement(
      impliedProbabilityDelta,
      input.significantProbabilityChange,
    ),
  } satisfies PriceMovement;

  return freezeMovementResult({
    status: "available",
    issues,
    currentState: current?.state ?? null,
    activeObservationCount: active.length,
    openingObservationId: opening.observation.observationId,
    latestObservationId: latest.observation.observationId,
    pointMovement,
    priceMovement,
    gap,
  });
}
