import type { SportKey } from "@find-the-edge/domain";
import {
  createDevelopmentScoutingInputPorts,
  developmentScoutingInputSource,
} from "@find-the-edge/providers";
import { validateScoutingInput } from "@find-the-edge/scouting";
import {
  defineSportScoutingInputContract,
  scoutingCapabilityInstances,
  soccerModule,
  SportRegistry,
} from "@find-the-edge/sports";
import { describe, expect, it } from "vitest";

const event = {
  canonicalEventId: "event-mls-1",
  canonicalEventVersion: "v1",
  sportKey: "soccer" as SportKey,
  leagueKey: "mls",
  startsAt: "2026-08-07T23:00:00.000Z",
  participantIds: ["club-a", "club-b"],
};

describe("provider to sport-owned scouting input contract", () => {
  it("validates the actual development ports through the real soccer module", async () => {
    const ports = createDevelopmentScoutingInputPorts("test");
    const request = {
      correlationId: "correlation-1",
      ...event,
      evaluatedAt: "2026-08-07T20:00:00.000Z",
      collectorSequence: 100,
    };
    const fragments = (await Promise.all([
      ports.fixture.collectFixture(request),
      ports.teamRoster.collectTeamRoster(request),
      ports.lineup.collectLineup(request),
      ports.injurySuspension.collectInjurySuspension(request),
      ports.statistics.collectStatistics(request),
    ])) as { coverage: unknown[]; observations: unknown[]; facts: unknown[] }[];
    const raw = {
      schemaId: "find-the-edge.scouting-input",
      schemaVersion: "1.0.0",
      moduleSchema: {
        id: soccerModule.scoutingInputContract.schemaId,
        version: soccerModule.scoutingInputContract.schemaVersion,
      },
      event,
      coverage: fragments.flatMap((fragment) => fragment.coverage),
      observations: fragments.flatMap((fragment) => fragment.observations),
      facts: fragments.flatMap((fragment) => fragment.facts),
    };
    const expectedCoverage = scoutingCapabilityInstances(
      soccerModule.scoutingInputContract,
      event.participantIds,
    );
    expect(
      raw.coverage
        .map((item) => {
          const coverage = item as {
            capabilityKey: string;
            subjectId?: string;
          };
          return `${coverage.capabilityKey}:${coverage.subjectId ?? "event"}`;
        })
        .sort(),
    ).toEqual(
      expectedCoverage
        .map((item) => `${item.capabilityKey}:${item.subjectId ?? "event"}`)
        .sort(),
    );
    const normalized = validateScoutingInput(raw, {
      canonicalEvent: event,
      evaluatedAt: request.evaluatedAt,
      environment: "test",
      module: soccerModule,
      sourceAuthorization: developmentScoutingInputSource,
    });
    expect(normalized.coverage).toHaveLength(expectedCoverage.length);
    expect(new Set(normalized.facts.map((fact) => fact.state))).toEqual(
      new Set(["verified", "inferred", "stale", "conflicting", "unavailable"]),
    );
    const inferredVenue = normalized.facts.find(
      (fact) => fact.capabilityKey === "venue",
    );
    expect(inferredVenue?.provenance.map((item) => item.capabilityKey)).toEqual(
      ["fixture", "venue"],
    );
    expect(normalized.inputHash).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.isFrozen(normalized)).toBe(true);
  });

  it("supports an unrelated three-participant schema without shared changes", () => {
    const sportKey = "test-racing" as SportKey;
    const customContract = defineSportScoutingInputContract({
      schemaId: "scout-input/test-racing",
      schemaVersion: "1",
      sportKey,
      participantCardinality: { minimum: 3, maximum: 3 },
      capabilities: [
        {
          key: "participant-speed",
          required: true,
          scope: "participant",
          availability: "evidence",
          facts: [
            {
              key: "speed-kph",
              required: true,
              cardinality: "one",
              subjectScope: "capability-instance",
              maximumAgeMilliseconds: 60_000,
              validateValue: (value) =>
                typeof value === "number" && Number.isFinite(value)
                  ? { valid: true, value, errors: [] }
                  : { valid: false, errors: ["speed invalid"] },
            },
          ],
        },
      ],
    });
    const customModule = {
      ...soccerModule,
      key: sportKey,
      metadata: {
        ...soccerModule.metadata,
        supportedLeagues: ["test-league"],
        participantStructure: "three entrants",
      },
      scoutingInputContract: customContract,
    };
    const registry = new SportRegistry();
    registry.register(customModule);
    const participantIds = ["entrant-a", "entrant-b", "entrant-c"];
    const evaluatedAt = "2026-08-07T20:00:00.000Z";
    const customEvent = {
      canonicalEventId: "race-1",
      canonicalEventVersion: "v1",
      sportKey,
      leagueKey: "test-league",
      startsAt: "2026-08-07T21:00:00.000Z",
      participantIds,
    };
    const observations = participantIds.map((subjectId, index) => ({
      id: `speed-${index}`,
      capabilityKey: "participant-speed",
      subjectId,
      providerId: "test-provider",
      providerTimestamp: evaluatedAt,
      collectedAt: evaluatedAt,
      evidenceReference: {
        kind: "synthetic-fixture",
        reference: `synthetic://test/${subjectId}`,
      },
      revision: { collectorSequence: index + 1 },
    }));
    const normalized = validateScoutingInput(
      {
        schemaId: "find-the-edge.scouting-input",
        schemaVersion: "1.0.0",
        moduleSchema: {
          id: customContract.schemaId,
          version: customContract.schemaVersion,
        },
        event: customEvent,
        coverage: observations.map((observation) => ({
          capabilityKey: observation.capabilityKey,
          subjectId: observation.subjectId,
          status: "available",
          observationIds: [observation.id],
        })),
        observations,
        facts: observations.map((observation, index) => ({
          id: `fact-${index}`,
          capabilityKey: observation.capabilityKey,
          schemaKey: "speed-kph",
          subjectId: observation.subjectId,
          state: "verified",
          value: 100 + index,
          observationIds: [observation.id],
          observedAt: evaluatedAt,
          confidence: 1,
        })),
      },
      {
        canonicalEvent: customEvent,
        evaluatedAt,
        environment: "test",
        module: registry.get(sportKey),
        sourceAuthorization: {
          id: "test-source",
          providerId: "test-provider",
          maturity: "development",
          productionEligible: false,
          sourceKind: "synthetic-fixture",
          sportKey,
          competitionKeys: ["test-league"],
          capabilities: ["participant-speed"],
          evidenceReferencePrefixes: ["synthetic://test/"],
        },
      },
    );
    expect(normalized.facts.map((fact) => fact.value)).toEqual([100, 101, 102]);
  });
});
