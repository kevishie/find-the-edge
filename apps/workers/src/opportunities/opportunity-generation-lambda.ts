import { randomBytes } from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import {
  AwsDynamoGateway,
  AwsFixtureOddsGateway,
  DynamoEventRepository,
  DynamoGamesRepository,
  DynamoOddsControlPlaneStore,
  DynamoOpportunityCandidateRepository,
  DynamoOpportunityEvidenceRepository,
  DynamoOpportunityLifecycleEventEvidenceSource,
  DynamoOpportunityLifecycleRepository,
  EventCursorCodec,
  EventEvaluationCandidateRepository,
  type GamesRepository,
} from "@find-the-edge/database";
import type { GameDisplayDto } from "@find-the-edge/domain";
import {
  ControlPlaneOpportunityProviderHealthSource,
  OpportunityCandidateService,
  type OpportunityGenerationEvent,
  type OpportunityGenerationResult,
  type OpportunityMarketVector,
} from "../opportunity-candidate-service";
import { OpportunityLifecycleService } from "./opportunity-lifecycle-service";

/** Sport/league pairs the odds control plane ingests; generation follows the
 * same coverage so every priced board can produce candidates. */
const GENERATION_TARGETS = [
  { sportKey: "mlb", leagueKey: "mlb" },
  { sportKey: "soccer", leagueKey: "mls" },
  { sportKey: "soccer", leagueKey: "epl" },
  { sportKey: "soccer", leagueKey: "liga-mx" },
  { sportKey: "soccer", leagueKey: "uefa-champions-league" },
] as const;

export function validateOpportunityGenerationInvocation(
  input: unknown,
  now: () => number = Date.now,
): string {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("opportunity-generation-invocation-invalid");
  const value = input as Record<string, unknown>;
  const time = value["time"];
  const scheduledAt = typeof time === "string" ? Date.parse(time) : NaN;
  const currentTime = now();
  if (
    value["source"] !== "aws.events" ||
    value["detail-type"] !== "Scheduled Event" ||
    typeof time !== "string" ||
    !Number.isFinite(scheduledAt) ||
    !Number.isFinite(currentTime) ||
    new Date(scheduledAt).toISOString() !== time ||
    scheduledAt > currentTime ||
    currentTime - scheduledAt > 5 * 60_000
  )
    throw new Error("opportunity-generation-invocation-invalid");
  return time;
}

const easternDayFormat = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** The eastern calendar days a generation pass covers: today and tomorrow. */
export function opportunityGenerationDays(asOf: string): readonly string[] {
  const start = Date.parse(asOf);
  return Object.freeze([
    ...new Set([
      easternDayFormat.format(new Date(start)),
      easternDayFormat.format(new Date(start + 86_400_000)),
    ]),
  ]);
}

/** The market vectors a served board row supports: the displayed selections
 * grouped by market, kept only when the group is a complete 2/3-way vector. */
export function marketVectorsFromGame(
  game: GameDisplayDto,
): readonly OpportunityMarketVector[] {
  if (game.odds.state !== "available") return [];
  const byMarket = new Map<
    string,
    { selectionKey: string; point: number | null }[]
  >();
  for (const selection of game.odds.selections) {
    const group = byMarket.get(selection.marketKey) ?? [];
    group.push({
      selectionKey: selection.selectionKey,
      point: selection.point ?? null,
    });
    byMarket.set(selection.marketKey, group);
  }
  return Object.freeze(
    [...byMarket.entries()]
      .filter(
        ([, selections]) =>
          (selections.length === 2 || selections.length === 3) &&
          new Set(selections.map(({ selectionKey }) => selectionKey)).size ===
            selections.length,
      )
      .map(([marketKey, selections]) => ({ marketKey, selections })),
  );
}

export interface OpportunityGenerationRunTelemetry {
  emit(event: {
    readonly outcome: "success" | "failure";
    readonly sportKey: string;
    readonly leagueKey: string;
    readonly eventCount: number;
    readonly qualifiedCount: number;
    readonly disqualifiedCount: number;
    readonly createdCount: number;
    readonly duplicateCount: number;
    readonly failureCount: number;
  }): void;
}

export interface OpportunityGenerationRunResult {
  readonly evaluatedTargets: number;
  readonly failedTargets: number;
  readonly eventCount: number;
  readonly qualifiedCount: number;
}

/** One generation pass: list each target's served board for today/tomorrow,
 * turn priced scheduled games into generation events, and hand each batch to
 * the candidate service. A target failure never blocks the other targets. */
export async function runOpportunityGeneration(
  dependencies: {
    readonly games: GamesRepository;
    readonly service: Pick<OpportunityCandidateService, "generate">;
    readonly telemetry?: OpportunityGenerationRunTelemetry;
    readonly targets?: readonly {
      readonly sportKey: string;
      readonly leagueKey: string;
    }[];
  },
  asOf: string,
): Promise<OpportunityGenerationRunResult> {
  const targets = dependencies.targets ?? GENERATION_TARGETS;
  const days = opportunityGenerationDays(asOf);
  let evaluatedTargets = 0;
  let failedTargets = 0;
  let eventCount = 0;
  let qualifiedCount = 0;
  for (const target of targets) {
    const events: OpportunityGenerationEvent[] = [];
    let outcome: "success" | "failure" = "success";
    let result: OpportunityGenerationResult | null = null;
    try {
      for (const day of days) {
        const page = await dependencies.games.list(
          {
            sportKey: target.sportKey,
            leagueKey: target.leagueKey,
            status: "scheduled",
            day,
          },
          50,
        );
        for (const game of page.items) {
          if (
            game.status !== "scheduled" ||
            game.startsAt <= asOf ||
            events.length >= 100
          )
            continue;
          const markets = marketVectorsFromGame(game);
          if (markets.length === 0) continue;
          events.push({
            eventId: game.id,
            eventVersion: game.version,
            sportKey: game.sportKey,
            leagueKey: game.leagueKey,
            participantIds: game.participants.map(({ id }) => id),
            startsAt: game.startsAt,
            status: "scheduled",
            markets,
          });
        }
      }
      if (events.length > 0)
        result = await dependencies.service.generate({
          evaluatedAt: asOf,
          events,
        });
      evaluatedTargets += 1;
      eventCount += events.length;
      qualifiedCount += result?.qualifiedCount ?? 0;
    } catch {
      outcome = "failure";
      failedTargets += 1;
    }
    try {
      dependencies.telemetry?.emit({
        outcome,
        sportKey: target.sportKey,
        leagueKey: target.leagueKey,
        eventCount: events.length,
        qualifiedCount: result?.qualifiedCount ?? 0,
        disqualifiedCount: result?.disqualifiedCount ?? 0,
        createdCount: result?.createdCount ?? 0,
        duplicateCount: result?.duplicateCount ?? 0,
        failureCount: outcome === "failure" ? 1 : 0,
      });
    } catch {
      // Metrics never change the generation result.
    }
  }
  return { evaluatedTargets, failedTargets, eventCount, qualifiedCount };
}

const telemetry: OpportunityGenerationRunTelemetry = {
  emit(event) {
    console.log(
      JSON.stringify({
        _aws: {
          Timestamp: Date.now(),
          CloudWatchMetrics: [
            {
              Namespace: "FindTheEdge/OpportunityGeneration",
              Dimensions: [["League", "Outcome"]],
              Metrics: [
                { Name: "EventCount", Unit: "Count" },
                { Name: "QualifiedCount", Unit: "Count" },
                { Name: "DisqualifiedCount", Unit: "Count" },
                { Name: "CreatedCount", Unit: "Count" },
                { Name: "DuplicateCount", Unit: "Count" },
                { Name: "FailureCount", Unit: "Count" },
              ],
            },
          ],
        },
        League: event.leagueKey,
        Outcome: event.outcome,
        EventCount: event.eventCount,
        QualifiedCount: event.qualifiedCount,
        DisqualifiedCount: event.disqualifiedCount,
        CreatedCount: event.createdCount,
        DuplicateCount: event.duplicateCount,
        FailureCount: event.failureCount,
      }),
    );
  },
};

let runtime: ((input: unknown) => Promise<unknown>) | undefined;
export const handler = (input: unknown) => {
  if (!runtime) {
    const tableName = process.env["FTE_EVENT_TABLE"] ?? "";
    if (!tableName)
      throw new Error("opportunity-generation-configuration-missing");
    const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));
    const gateway = new AwsDynamoGateway(client, tableName);
    const eventRepository = new DynamoEventRepository(
      gateway,
      // Generation never pages past a fifty-game board, so this codec never
      // signs a cursor a client will see.
      new EventCursorCodec({
        current: { id: "opportunity-generation", secret: randomBytes(32) },
      }),
      async () => {
        const item = await gateway.get("EVENT_PROJECTIONS", "READINESS");
        return (
          !!item &&
          JSON.stringify(item.value) ===
            JSON.stringify({ schemaVersion: 1, state: "initialized" })
        );
      },
    );
    const lifecycle = new DynamoOpportunityLifecycleRepository(
      client,
      tableName,
    );
    const candidates = new DynamoOpportunityCandidateRepository(
      client,
      tableName,
    );
    const service = new OpportunityCandidateService({
      eligibleEvents: new EventEvaluationCandidateRepository(eventRepository),
      evidence: new DynamoOpportunityEvidenceRepository(
        new AwsFixtureOddsGateway(client, tableName),
      ),
      candidates,
      providerHealth: new ControlPlaneOpportunityProviderHealthSource(
        new DynamoOddsControlPlaneStore(client, tableName),
        "sharpapi",
      ),
      lifecycle: new OpportunityLifecycleService({
        lifecycle,
        candidates,
        events: new DynamoOpportunityLifecycleEventEvidenceSource(gateway),
      }),
    });
    const games = new DynamoGamesRepository(eventRepository, gateway);
    runtime = async (event: unknown) =>
      runOpportunityGeneration(
        { games, service, telemetry },
        validateOpportunityGenerationInvocation(event),
      );
  }
  return runtime(input);
};
