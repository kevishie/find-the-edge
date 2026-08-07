import type { SportKey } from "@find-the-edge/domain";
import {
  createDevelopmentScoutingInputPorts,
  developmentScoutingInputSource,
} from "@find-the-edge/providers";
import {
  buildReportPromptRequest,
  validateScoutingInput,
  validateScoutingReportDraft,
} from "@find-the-edge/scouting";
import {
  defineSportScoutingInputContract,
  defineSportScoutingReportContract,
  soccerModule,
  type SportModule,
} from "@find-the-edge/sports";
import { describe, expect, it } from "vitest";

const modelMetadata = {
  providerId: "test-provider",
  modelId: "test-model",
  modelVersion: "1",
  deploymentId: "test-deployment",
  usage: { inputUnits: 1, outputUnits: 1, totalUnits: 2 },
  latencyMilliseconds: 1,
} as const;

const expectedModel = {
  providerId: modelMetadata.providerId,
  modelId: modelMetadata.modelId,
  modelVersion: modelMetadata.modelVersion,
};

describe("sport-owned scouting report conformance", () => {
  it("accepts real soccer evidence, preserves missing sections, and rejects model-authored math", async () => {
    const event = {
      canonicalEventId: "event-mls-report-1",
      canonicalEventVersion: "1",
      sportKey: "soccer" as SportKey,
      leagueKey: "mls",
      startsAt: "2026-08-07T23:00:00.000Z",
      participantIds: ["club-a", "club-b"],
    };
    const request = {
      correlationId: "correlation-report-1",
      ...event,
      evaluatedAt: "2026-08-07T20:00:00.000Z",
      collectorSequence: 200,
    };
    const ports = createDevelopmentScoutingInputPorts("test");
    const fragments = (await Promise.all([
      ports.fixture.collectFixture(request),
      ports.teamRoster.collectTeamRoster(request),
      ports.lineup.collectLineup(request),
      ports.injurySuspension.collectInjurySuspension(request),
      ports.statistics.collectStatistics(request),
    ])) as { coverage: unknown[]; observations: unknown[]; facts: unknown[] }[];
    const normalized = validateScoutingInput(
      {
        schemaId: "find-the-edge.scouting-input",
        schemaVersion: "1.0.0",
        moduleSchema: {
          id: soccerModule.scoutingInputContract.schemaId,
          version: soccerModule.scoutingInputContract.schemaVersion,
        },
        event,
        coverage: fragments.flatMap(({ coverage }) => coverage),
        observations: fragments.flatMap(({ observations }) => observations),
        facts: fragments.flatMap(({ facts }) => facts),
      },
      {
        canonicalEvent: event,
        evaluatedAt: request.evaluatedAt,
        environment: "test",
        module: soccerModule,
        sourceAuthorization: developmentScoutingInputSource,
      },
    );
    const verifiedFixture = normalized.facts.find(
      (fact) => fact.capabilityKey === "fixture" && fact.state === "verified",
    )!;
    const modelRequest = buildReportPromptRequest({
      schema: {
        id: soccerModule.scoutingReportContract.schemaId,
        version: soccerModule.scoutingReportContract.schemaVersion,
      },
      sportKey: "soccer",
      moduleVersion: soccerModule.metadata.version,
      strategy: { id: "find-the-edge", version: "1.0.0-experimental" },
      promptBundle: {
        id: "soccer-report",
        version: "1",
        trustedInstructions: ["Use only cited evidence."],
      },
      scoutingInput: normalized,
      calculationReferences: [],
    });
    const options = {
      module: soccerModule,
      strategy: {
        id: "find-the-edge",
        version: "1.0.0-experimental",
        sportKey: "soccer" as SportKey,
      },
      scoutingInput: normalized,
      modelRequest,
      expectedPromptBundle: {
        id: "soccer-report",
        version: "1",
        trustedInstructions: ["Use only cited evidence."],
      },
      expectedModel,
      calculationReferences: [],
    };
    const report = validateScoutingReportDraft(
      {
        output: {
          schemaId: "scout-report/soccer",
          schemaVersion: "1",
          sections: [
            {
              key: "match-snapshot",
              narrative: "The canonical competition context is available.",
              factCitations: [verifiedFixture.id],
            },
          ],
        },
        metadata: modelMetadata,
      },
      options,
    );
    expect(report.sections).toHaveLength(14);
    expect(report.sections[0]?.state).toBe("available");
    expect(report.sections[1]).toMatchObject({
      state: "unavailable",
      unavailableReason: "model-section-omitted",
    });
    expect(report.disposition.state).toBe("unavailable");
    expect(() =>
      validateScoutingReportDraft(
        {
          output: {
            schemaId: "scout-report/soccer",
            schemaVersion: "1",
            sections: [
              {
                key: "match-snapshot",
                narrative: "The fair odds are +150.",
                factCitations: [verifiedFixture.id],
              },
            ],
          },
          metadata: modelMetadata,
        },
        options,
      ),
    ).toThrow("forged_authority");
  });

  it("accepts an unrelated sport report contract without shared sport branches", () => {
    const sportKey = "test-racing" as SportKey;
    const inputContract = defineSportScoutingInputContract({
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
    const reportContract = defineSportScoutingReportContract({
      schemaId: "scout-report/test-racing",
      schemaVersion: "1",
      sportKey,
      sections: [
        {
          key: "entrant-speed",
          title: "Entrant Speed",
          availability: "evidence",
          content: "narrative",
          allowedFactCategories: ["participant-speed"],
          allowedCalculationKinds: [],
        },
      ],
    });
    const module: SportModule = {
      ...soccerModule,
      key: sportKey,
      metadata: {
        ...soccerModule.metadata,
        supportedLeagues: ["test-league"],
        participantStructure: "three entrants",
      },
      scoutingInputContract: inputContract,
      scoutingReportContract: reportContract,
    };
    const participants = ["entrant-a", "entrant-b", "entrant-c"];
    const evaluatedAt = "2026-08-07T20:00:00.000Z";
    const event = {
      canonicalEventId: "race-report-1",
      canonicalEventVersion: "1",
      sportKey,
      leagueKey: "test-league",
      startsAt: "2026-08-07T21:00:00.000Z",
      participantIds: participants,
    };
    const observations = participants.map((subjectId, index) => ({
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
          id: inputContract.schemaId,
          version: inputContract.schemaVersion,
        },
        event,
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
        canonicalEvent: event,
        evaluatedAt,
        environment: "test",
        module,
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
    const modelRequest = buildReportPromptRequest({
      schema: {
        id: reportContract.schemaId,
        version: reportContract.schemaVersion,
      },
      sportKey,
      moduleVersion: module.metadata.version,
      strategy: { id: "test-strategy", version: "1" },
      promptBundle: {
        id: "test-report",
        version: "1",
        trustedInstructions: ["Cite evidence."],
      },
      scoutingInput: normalized,
      calculationReferences: [],
    });
    const report = validateScoutingReportDraft(
      {
        output: {
          schemaId: reportContract.schemaId,
          schemaVersion: reportContract.schemaVersion,
          sections: [
            {
              key: "entrant-speed",
              narrative: "The entrant has recorded speed evidence.",
              factCitations: ["fact-0"],
            },
          ],
        },
        metadata: modelMetadata,
      },
      {
        module,
        strategy: { id: "test-strategy", version: "1", sportKey },
        scoutingInput: normalized,
        modelRequest,
        expectedPromptBundle: {
          id: "test-report",
          version: "1",
          trustedInstructions: ["Cite evidence."],
        },
        expectedModel,
        calculationReferences: [],
      },
    );
    expect(report.sections[0]).toMatchObject({
      key: "entrant-speed",
      state: "available",
    });
  });
});
