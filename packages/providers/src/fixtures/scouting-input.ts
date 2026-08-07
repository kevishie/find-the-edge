import type { ScoutingInputCollectionRequest } from "../scouting-input-ports";

type Capability =
  | "fixture"
  | "venue"
  | "team-roster-profile"
  | "lineup"
  | "injury-suspension"
  | "statistics";

export interface ScoutingInputFixtureFragment {
  readonly coverage: readonly unknown[];
  readonly observations: readonly unknown[];
  readonly facts: readonly unknown[];
}

function observation(
  request: ScoutingInputCollectionRequest,
  capabilityKey: Capability,
  offset: number,
  subjectId?: string,
  timestamp = request.evaluatedAt,
) {
  const suffix = subjectId ?? "event";
  const id = `${capabilityKey}.${suffix}.${request.collectorSequence + offset}`;
  return {
    id,
    capabilityKey,
    ...(subjectId === undefined ? {} : { subjectId }),
    providerId: "scouting-development-fixture",
    providerEntityType: capabilityKey,
    providerEntityId: `${request.canonicalEventId}.${suffix}`,
    providerTimestamp: timestamp,
    collectedAt: timestamp,
    evidenceReference: {
      kind: "synthetic-fixture",
      reference: `synthetic://scouting/${request.canonicalEventId}/${id}`,
    },
    revision: { collectorSequence: request.collectorSequence + offset },
  };
}

function coverage(
  capabilityKey: Capability,
  observationId: string,
  subjectId?: string,
) {
  return {
    capabilityKey,
    ...(subjectId === undefined ? {} : { subjectId }),
    status: "available",
    observationIds: [observationId],
  };
}

function fact(
  request: ScoutingInputCollectionRequest,
  capabilityKey: Capability,
  schemaKey: string,
  value: unknown,
  observationId: string,
  subjectId?: string,
  schemaVariant?: string,
  overrides: Record<string, unknown> = {},
) {
  return Object.fromEntries(
    Object.entries({
      id: `${capabilityKey}.${schemaKey}.${schemaVariant ?? "default"}.${subjectId ?? "event"}`,
      capabilityKey,
      schemaKey,
      ...(schemaVariant === undefined ? {} : { schemaVariant }),
      ...(subjectId === undefined ? {} : { subjectId }),
      state: "verified",
      value,
      observationIds: [observationId],
      observedAt: request.evaluatedAt,
      confidence: 1,
      ...overrides,
    }).filter(([, entry]) => entry !== undefined),
  );
}

function shifted(timestamp: string, milliseconds: number): string {
  const value = Date.parse(timestamp) + milliseconds;
  if (!Number.isFinite(value))
    throw new Error("fixture timestamp out of range");
  return new Date(value).toISOString();
}

export function fixtureFragment(
  request: ScoutingInputCollectionRequest,
): ScoutingInputFixtureFragment {
  const fixture = observation(request, "fixture", 0);
  const venue = observation(request, "venue", 1);
  return {
    coverage: [coverage("fixture", fixture.id), coverage("venue", venue.id)],
    observations: [fixture, venue],
    facts: [
      fact(
        request,
        "fixture",
        "competition-context",
        { competitionKey: request.leagueKey },
        fixture.id,
      ),
      fact(
        request,
        "venue",
        "venue-profile",
        { name: "Development Ground" },
        venue.id,
        undefined,
        undefined,
        {
          state: "inferred",
          basisFactIds: ["fixture.competition-context.default.event"],
          confidence: 0.8,
        },
      ),
    ],
  };
}

export function teamRosterFragment(
  request: ScoutingInputCollectionRequest,
): ScoutingInputFixtureFragment {
  const staleTimestamp = shifted(request.evaluatedAt, -7_200_000);
  const observations = request.participantIds.map((participantId, index) =>
    observation(
      request,
      "team-roster-profile",
      10 + index,
      participantId,
      index === 0 ? staleTimestamp : request.evaluatedAt,
    ),
  );
  return {
    coverage: observations.map((item) =>
      coverage("team-roster-profile", item.id, item.subjectId),
    ),
    observations,
    facts: observations.map((item, index) =>
      fact(
        request,
        "team-roster-profile",
        "active-members",
        {
          memberIds: Array.from(
            { length: 12 },
            (_, memberIndex) =>
              `${request.participantIds[index]}.player-${memberIndex + 1}`,
          ),
        },
        item.id,
        item.subjectId,
        undefined,
        index === 0
          ? { state: "stale", observedAt: staleTimestamp, confidence: 0.7 }
          : {},
      ),
    ),
  };
}

export function lineupFragment(
  request: ScoutingInputCollectionRequest,
): ScoutingInputFixtureFragment {
  const primary = request.participantIds.map((participantId, index) =>
    observation(request, "lineup", 20 + index, participantId),
  );
  const disputedSubject = request.participantIds[0];
  const disputed = {
    ...observation(request, "lineup", 29, disputedSubject),
    providerEntityId: `${request.canonicalEventId}.${disputedSubject}.alternate-source`,
  };
  const observations = [...primary, disputed];
  return {
    coverage: primary.map((item, index) =>
      index === 0
        ? {
            capabilityKey: "lineup",
            subjectId: item.subjectId,
            status: "partial",
            observationIds: [item.id, disputed.id],
          }
        : coverage("lineup", item.id, item.subjectId),
    ),
    observations,
    facts: primary.flatMap((item, index) => {
      const value = {
        memberIds: Array.from(
          { length: 11 },
          (_, memberIndex) =>
            `${request.participantIds[index]}.player-${memberIndex + 1}`,
        ),
      };
      const predicted =
        index === 0
          ? fact(
              request,
              "lineup",
              "starting-lineup",
              value,
              item.id,
              item.subjectId,
              "predicted",
              {
                state: "conflicting",
                value: undefined,
                observedAt: undefined,
                confidence: 0,
                observationIds: [item.id, disputed.id],
                conflict: {
                  alternatives: [
                    { value, observationIds: [item.id] },
                    {
                      value: {
                        memberIds: Array.from(
                          { length: 11 },
                          (_, memberIndex) =>
                            `${request.participantIds[index]}.player-${memberIndex + 2}`,
                        ),
                      },
                      observationIds: [disputed.id],
                    },
                  ],
                },
              },
            )
          : fact(
              request,
              "lineup",
              "starting-lineup",
              value,
              item.id,
              item.subjectId,
              "predicted",
            );
      return [
        predicted,
        fact(
          request,
          "lineup",
          "starting-lineup",
          value,
          item.id,
          item.subjectId,
          "confirmed",
        ),
      ];
    }),
  };
}

export function injurySuspensionFragment(
  request: ScoutingInputCollectionRequest,
): ScoutingInputFixtureFragment {
  const item = observation(request, "injury-suspension", 30);
  return {
    coverage: [
      {
        capabilityKey: "injury-suspension",
        status: "unavailable",
        unavailableReason: "development-fixture-unavailable",
        observationIds: [item.id],
      },
    ],
    observations: [item],
    facts: [
      fact(
        request,
        "injury-suspension",
        "feed-status",
        { covered: true, reportedCount: 0 },
        item.id,
        undefined,
        undefined,
        {
          state: "unavailable",
          value: undefined,
          observedAt: undefined,
          unavailableReason: "development-fixture-unavailable",
          confidence: 0,
        },
      ),
    ],
  };
}

export function statisticsFragment(
  request: ScoutingInputCollectionRequest,
): ScoutingInputFixtureFragment {
  const observations = request.participantIds.map((participantId, index) =>
    observation(request, "statistics", 40 + index, participantId),
  );
  return {
    coverage: observations.map((item) =>
      coverage("statistics", item.id, item.subjectId),
    ),
    observations,
    facts: observations.map((item) =>
      fact(
        request,
        "statistics",
        "team-form-summary",
        { matches: 5, points: 10 },
        item.id,
        item.subjectId,
      ),
    ),
  };
}
