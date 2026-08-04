import type {
  Event,
  EventResult,
  Pick,
  PickGrade,
} from "@find-the-edge/domain";

import type {
  EventContext,
  ScoutReport,
  SportModule,
  ValidationResult,
} from "./contracts";

type ModuleDefinition = Omit<
  SportModule,
  | "validateInput"
  | "normalizeEvent"
  | "calculateFeatures"
  | "calculateFairPrice"
  | "evaluateMarkets"
  | "buildScoutInput"
  | "validateLegacyScoutReport"
  | "gradePick"
>;

export function createDeclarativeSportModule(
  definition: ModuleDefinition,
): SportModule {
  return {
    ...definition,
    validateInput(input: unknown): ValidationResult {
      return input === null || input === undefined
        ? { valid: false, errors: ["Sport input is required"] }
        : { valid: true, value: input, errors: [] };
    },
    normalizeEvent(raw: unknown): ValidationResult<Event> {
      void raw;
      return {
        valid: false,
        errors: [
          `${definition.metadata.displayName} event normalization is not implemented`,
        ],
      };
    },
    calculateFeatures(context: EventContext) {
      void context;
      return {
        values: {},
        warnings: ["Feature calculation is not implemented"],
      };
    },
    calculateFairPrice(context: EventContext) {
      void context;
      return [];
    },
    evaluateMarkets(context: EventContext) {
      void context;
      return [];
    },
    buildScoutInput(context: EventContext) {
      return {
        sportKey: definition.key,
        moduleVersion: definition.metadata.version,
        event: context.event,
        evidence: [],
      };
    },
    validateLegacyScoutReport(output: unknown): ValidationResult<ScoutReport> {
      if (typeof output !== "object" || output === null) {
        return { valid: false, errors: ["Scout output must be an object"] };
      }
      return {
        valid: true,
        value: output as ScoutReport,
        errors: [],
      };
    },
    gradePick(pick: Pick, result: EventResult): PickGrade {
      void pick;
      void result;
      return {
        result: "ungraded",
        reason: `${definition.metadata.displayName} grading adapter is not implemented`,
      };
    },
  };
}
