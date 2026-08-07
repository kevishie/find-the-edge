import type { SportKey } from "@find-the-edge/domain";

import {
  defineSportScoutingInputContract,
  type SportScoutingFactSchema,
  type SportScoutingFactValidationContext,
} from "../shared/scouting-input";

export type SoccerLineupState = "predicted" | "probable" | "confirmed";

type UnknownRecord = Record<string, unknown>;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;

function compareUtf8(left: string, right: string): number {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  const length = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index += 1) {
    if (leftBytes[index] !== rightBytes[index])
      return leftBytes[index]! - rightBytes[index]!;
  }
  return leftBytes.length - rightBytes.length;
}

function record(value: unknown): UnknownRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : undefined;
}

function exact(value: UnknownRecord, keys: readonly string[]): boolean {
  return (
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function text(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 256 &&
    value === value.trim()
  );
}

function identifiers(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= 128 &&
    value.every((item) => typeof item === "string" && IDENTIFIER.test(item)) &&
    new Set(value).size === value.length
  );
}

function normalizedParticipantMembers(
  value: unknown,
  context: SportScoutingFactValidationContext,
  requiredCount?: number,
) {
  const input = record(value);
  if (
    !input ||
    !exact(input, ["memberIds"]) ||
    !identifiers(input["memberIds"]) ||
    (requiredCount !== undefined &&
      input["memberIds"].length !== requiredCount) ||
    !membersBelongToCapabilityParticipant(input["memberIds"], context)
  ) {
    return { valid: false, errors: ["Soccer scouting fact value is invalid"] };
  }
  return {
    valid: true,
    value: { memberIds: [...input["memberIds"]].sort(compareUtf8) },
    errors: [],
  };
}

function validObject(
  value: unknown,
  validate: (input: UnknownRecord) => boolean,
) {
  const input = record(value);
  return input && validate(input)
    ? { valid: true, value, errors: [] }
    : { valid: false, errors: ["Soccer scouting fact value is invalid"] };
}

function membersBelongToCapabilityParticipant(
  memberIds: readonly string[],
  context: SportScoutingFactValidationContext,
): boolean {
  return (
    context.capabilitySubjectId !== undefined &&
    context.participantIds.includes(context.capabilitySubjectId) &&
    memberIds.every(
      (memberId) =>
        context.participantIds.filter(
          (participantId) =>
            memberId.startsWith(`${participantId}.player-`) &&
            memberId.length > `${participantId}.player-`.length,
        ).length === 1 &&
        memberId.startsWith(`${context.capabilitySubjectId}.player-`),
    )
  );
}

const fact = (
  input: Omit<SportScoutingFactSchema, "required" | "cardinality"> &
    Partial<Pick<SportScoutingFactSchema, "required" | "cardinality">>,
): SportScoutingFactSchema => ({
  required: true,
  cardinality: "one",
  ...input,
});

const lineupFact = (variant: SoccerLineupState, required: boolean) =>
  fact({
    key: "starting-lineup",
    variant,
    required,
    subjectScope: "capability-instance",
    maximumAgeMilliseconds: 7_200_000,
    validateValue: (value, context) =>
      normalizedParticipantMembers(value, context, 11),
  });

export const soccerScoutingInputContract = defineSportScoutingInputContract({
  schemaId: "scout-input/soccer",
  schemaVersion: "1",
  sportKey: "soccer" as SportKey,
  participantCardinality: { minimum: 2, maximum: 2 },
  capabilities: [
    {
      key: "fixture",
      required: true,
      scope: "event",
      availability: "evidence",
      facts: [
        fact({
          key: "competition-context",
          subjectScope: "event",
          maximumAgeMilliseconds: 86_400_000,
          validateValue: (value, context) =>
            validObject(
              value,
              (input) =>
                exact(input, ["competitionKey"]) &&
                text(input["competitionKey"]) &&
                input["competitionKey"] === context.leagueKey,
            ),
        }),
      ],
    },
    {
      key: "venue",
      required: true,
      scope: "event",
      availability: "evidence",
      facts: [
        fact({
          key: "venue-profile",
          subjectScope: "event",
          maximumAgeMilliseconds: 86_400_000,
          validateValue: (value) =>
            validObject(
              value,
              (input) => exact(input, ["name"]) && text(input["name"]),
            ),
        }),
      ],
    },
    {
      key: "team-roster-profile",
      required: true,
      scope: "participant",
      availability: "evidence",
      facts: [
        fact({
          key: "active-members",
          subjectScope: "capability-instance",
          maximumAgeMilliseconds: 3_600_000,
          validateValue: (value, context) =>
            normalizedParticipantMembers(value, context),
        }),
      ],
    },
    {
      key: "lineup",
      required: true,
      scope: "participant",
      availability: "evidence",
      facts: [
        lineupFact("predicted", true),
        lineupFact("probable", false),
        lineupFact("confirmed", true),
      ],
    },
    {
      key: "injury-suspension",
      required: true,
      scope: "event",
      availability: "evidence",
      facts: [
        fact({
          key: "feed-status",
          subjectScope: "event",
          maximumAgeMilliseconds: 10_800_000,
          validateValue: (value, context) =>
            validObject(
              value,
              (input) =>
                exact(input, ["covered", "reportedCount"]) &&
                input["covered"] === true &&
                Number.isSafeInteger(input["reportedCount"]) &&
                Number(input["reportedCount"]) >= 0 &&
                input["reportedCount"] ===
                  context.capabilityFacts.filter(
                    (candidate) =>
                      candidate.schemaKey === "player-availability" &&
                      candidate.status === "resolved",
                  ).length,
            ),
        }),
        fact({
          key: "player-availability",
          required: false,
          cardinality: "many",
          subjectScope: "entity",
          maximumAgeMilliseconds: 10_800_000,
          validateSubject: ({ subjectId, participantIds }) =>
            IDENTIFIER.test(subjectId) &&
            participantIds.filter(
              (participantId) =>
                subjectId.startsWith(`${participantId}.player-`) &&
                subjectId.length > `${participantId}.player-`.length,
            ).length === 1,
          validateValue: (value) =>
            validObject(
              value,
              (input) =>
                exact(input, ["status"]) &&
                typeof input["status"] === "string" &&
                ["available", "doubtful", "out", "suspended"].includes(
                  input["status"],
                ),
            ),
        }),
      ],
    },
    {
      key: "statistics",
      required: true,
      scope: "participant",
      availability: "evidence",
      facts: [
        fact({
          key: "team-form-summary",
          subjectScope: "capability-instance",
          maximumAgeMilliseconds: 86_400_000,
          validateValue: (value) =>
            validObject(
              value,
              (input) =>
                exact(input, ["matches", "points"]) &&
                typeof input["matches"] === "number" &&
                Number.isSafeInteger(input["matches"]) &&
                Number(input["matches"]) >= 0 &&
                typeof input["points"] === "number" &&
                Number.isSafeInteger(input["points"]) &&
                Number(input["points"]) >= 0 &&
                Number(input["points"]) <= Number(input["matches"]) * 3,
            ),
        }),
      ],
    },
  ],
});
