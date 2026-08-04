import { randomBytes } from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import {
  disabledPaperPickSchedulePolicy,
  validatePaperPickSchedulePolicy,
} from "@find-the-edge/config";
import {
  AwsDynamoGateway,
  AwsFixtureOddsGateway,
  DynamoEvaluationAttemptRepository,
  DynamoEvaluationEvidenceRepository,
  DynamoEvaluationTerminalRepository,
  DynamoEventRepository,
  DynamoPaperEvaluationRepository,
  DynamoPaperPickRunRepository,
  EventCursorCodec,
  EventEvaluationCandidateRepository,
} from "@find-the-edge/database";
import { DisabledStructuredAnalysisModelAdapter } from "@find-the-edge/scouting";
import { createPaperPickSchedulerHandler } from "./paper-pick-scheduler-lambda";
import { PaperPickScheduler } from "./paper-pick-scheduler";
import { PickEvaluationService } from "./pick-evaluation";

const tableName = process.env["FTE_EVENT_TABLE"];
const rawGenerationMinutes = process.env["FTE_PAPER_PICK_GENERATION_MINUTES"];
if (!tableName || !rawGenerationMinutes || !/^\d+$/.test(rawGenerationMinutes))
  throw new Error("paper-pick-runtime-configuration-invalid");
const generationMinutes = Number(rawGenerationMinutes);
if (
  !Number.isSafeInteger(generationMinutes) ||
  generationMinutes < 1 ||
  generationMinutes > 1440
)
  throw new Error("paper-pick-runtime-configuration-invalid");

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const gateway = new AwsDynamoGateway(client, tableName);
const events = new DynamoEventRepository(
  gateway,
  // Candidate pagination is internal to this cold-start instance. The random
  // key prevents these cursors from becoming a public or reusable capability.
  new EventCursorCodec({
    current: { id: "paper-pick-internal-v1", secret: randomBytes(32) },
  }),
  async () => {
    const readiness = await gateway.get("EVENT_PROJECTIONS", "READINESS");
    return (
      !!readiness &&
      JSON.stringify(readiness.value) ===
        JSON.stringify({ schemaVersion: 1, state: "initialized" })
    );
  },
);
const evaluator = new PickEvaluationService({
  evidence: new DynamoEvaluationEvidenceRepository(
    new AwsFixtureOddsGateway(client, tableName),
  ),
  model: new DisabledStructuredAnalysisModelAdapter(),
  attempts: new DynamoEvaluationAttemptRepository(client, tableName),
  evaluations: new DynamoPaperEvaluationRepository(client, tableName),
  terminalClaims: new DynamoEvaluationTerminalRepository(client, tableName),
});
const runtimePolicy = validatePaperPickSchedulePolicy({
  ...disabledPaperPickSchedulePolicy,
  generationMinutes,
});

/** The deployed scheduler is fully composed against durable production
 * repositories, while policy and model capability remain intentionally off.
 * Enabling either requires an explicit reviewed release. */
const scheduler = new PaperPickScheduler({
  policy: () => Promise.resolve(runtimePolicy),
  candidates: new EventEvaluationCandidateRepository(events),
  runs: new DynamoPaperPickRunRepository(client, tableName),
  evaluator,
  assemble: () => Promise.reject(new Error("paper-pick-assembler-disabled")),
  modelCapability: "disabled",
  reservation: { inputTokens: 1, outputTokens: 1, costMicros: 1 },
});

export const handler = createPaperPickSchedulerHandler(
  scheduler,
  () => new Date(),
  (line) => process.stdout.write(`${line}\n`),
  generationMinutes,
);
