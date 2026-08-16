import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import {
  DynamoClosingCandidateSource,
  DynamoCohortRepository,
  DynamoExactOddsSnapshotRepository,
  DynamoPaperEvaluationRepository,
  DynamoPaperGradeRepository,
  DynamoRetrospectiveRepository,
  PerformanceEvidenceRepository,
  ProductionPerformanceEvidenceStore,
} from "@find-the-edge/database";
import { CohortBuilder } from "./cohort-builder.js";
import { DayIndexedCohortMemberSource } from "./day-indexed-cohort-member-source.js";
import {
  ExactPerformanceEvidenceAdapter,
  PerformanceReportBuilder,
} from "./performance-report.js";
import { createPerformanceScheduledHandler } from "./performance-scheduled-runtime.js";
import { ProductionCohortMemberMaterializer } from "./production-cohort-member-materializer.js";
import {
  ExactRetrospectiveEvidenceAdapter,
  RetrospectiveBuilder,
} from "./retrospective-builder.js";

const tableName = process.env["FTE_EVENT_TABLE_NAME"] ?? "";
if (!tableName) throw new Error("missing-performance-configuration");
const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const evaluations = new DynamoPaperEvaluationRepository(client, tableName);
const grades = new DynamoPaperGradeRepository(client, tableName);
const snapshots = new DynamoExactOddsSnapshotRepository(client, tableName);
const closing = new DynamoClosingCandidateSource(client, tableName);
const cohorts = new DynamoCohortRepository(client, tableName);
const memberSource = new DayIndexedCohortMemberSource(
  evaluations,
  new ProductionCohortMemberMaterializer(grades, snapshots, closing),
);
const evidence = new PerformanceEvidenceRepository(
  new ProductionPerformanceEvidenceStore(evaluations, grades, snapshots),
);

export const handler = createPerformanceScheduledHandler({
  cohorts: new CohortBuilder(memberSource, cohorts),
  reports: new PerformanceReportBuilder(
    new ExactPerformanceEvidenceAdapter(evidence),
    cohorts,
  ),
  repository: cohorts,
  retrospectives: new RetrospectiveBuilder(
    new ExactRetrospectiveEvidenceAdapter(evidence),
    new DynamoRetrospectiveRepository(client, tableName),
  ),
});
