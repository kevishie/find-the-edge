import type { GameDisplayDto } from "@find-the-edge/domain";
import { describe, expect, it, vi } from "vitest";
import type {
  OpportunityGenerationCommand,
  OpportunityGenerationResult,
} from "../opportunity-candidate-service";
import {
  marketVectorsFromGame,
  opportunityGenerationDays,
  runOpportunityGeneration,
  validateOpportunityGenerationInvocation,
} from "./opportunity-generation-lambda";

const asOf = "2026-08-10T12:00:00.000Z";

const game = (overrides: Partial<GameDisplayDto> = {}): GameDisplayDto =>
  ({
    id: "event-1",
    version: 3,
    sportKey: "mlb",
    leagueKey: "mlb",
    participants: [
      { id: "away", label: "Away Club" },
      { id: "home", label: "Home Club" },
    ],
    startsAt: "2026-08-10T22:00:00.000Z",
    status: "scheduled",
    odds: {
      state: "available",
      selections: [
        {
          marketKey: "moneyline",
          selectionKey: "participant:away",
          sportsbookId: "hardrock",
          americanOdds: 120,
          observedAt: asOf,
          retrievedAt: asOf,
        },
        {
          marketKey: "moneyline",
          selectionKey: "participant:home",
          sportsbookId: "hardrock",
          americanOdds: -135,
          observedAt: asOf,
          retrievedAt: asOf,
        },
        {
          marketKey: "total",
          selectionKey: "over",
          sportsbookId: "hardrock",
          point: 8.5,
          americanOdds: -110,
          observedAt: asOf,
          retrievedAt: asOf,
        },
        {
          marketKey: "total",
          selectionKey: "under",
          sportsbookId: "hardrock",
          point: 8.5,
          americanOdds: -110,
          observedAt: asOf,
          retrievedAt: asOf,
        },
      ],
    },
    ...overrides,
  }) as GameDisplayDto;

const page = (items: readonly GameDisplayDto[]) =>
  Promise.resolve({
    items,
    nextCursor: null,
    projectionState: "ready",
    evaluationState: "complete",
    hasMoreUnknown: false,
    snapshotAt: asOf,
    freshness: asOf,
    unavailableReason: null,
  }) as ReturnType<
    Parameters<typeof runOpportunityGeneration>[0]["games"]["list"]
  >;

describe("market vectors", () => {
  it("groups served selections into complete vectors with null points", () => {
    expect(marketVectorsFromGame(game())).toEqual([
      {
        marketKey: "moneyline",
        selections: [
          { selectionKey: "participant:away", point: null },
          { selectionKey: "participant:home", point: null },
        ],
      },
      {
        marketKey: "total",
        selections: [
          { selectionKey: "over", point: 8.5 },
          { selectionKey: "under", point: 8.5 },
        ],
      },
    ]);
  });

  it("drops incomplete groups and unpriced games", () => {
    const base = game();
    const partial = {
      ...base,
      odds: {
        state: "available" as const,
        selections:
          base.odds.state === "available"
            ? base.odds.selections.slice(0, 1)
            : [],
      },
    } as GameDisplayDto;
    expect(marketVectorsFromGame(partial)).toEqual([]);
    expect(
      marketVectorsFromGame({
        ...base,
        odds: { state: "unavailable" },
      }),
    ).toEqual([]);
  });
});

describe("generation days", () => {
  it("covers today and tomorrow in eastern time", () => {
    // 12:00Z on Aug 10 is 08:00 eastern; the pass covers Aug 10 and 11.
    expect(opportunityGenerationDays(asOf)).toEqual([
      "2026-08-10",
      "2026-08-11",
    ]);
    // 02:00Z on Aug 10 is still Aug 9 eastern.
    expect(opportunityGenerationDays("2026-08-10T02:00:00.000Z")).toEqual([
      "2026-08-09",
      "2026-08-10",
    ]);
  });
});

describe("generation run", () => {
  const result: OpportunityGenerationResult = {
    candidates: [],
    createdCount: 2,
    duplicateCount: 0,
    qualifiedCount: 1,
    disqualifiedCount: 1,
    reasonCounts: {},
  };

  it("evaluates priced upcoming games and skips started or unpriced ones", async () => {
    const commands: OpportunityGenerationCommand[] = [];
    const summary = await runOpportunityGeneration(
      {
        games: {
          list: (filter) =>
            page(
              filter.day === "2026-08-10"
                ? [
                    game(),
                    game({
                      id: "event-started",
                      startsAt: "2026-08-10T11:00:00.000Z",
                    }),
                    game({
                      id: "event-unpriced",
                      odds: { state: "unavailable" },
                    }),
                  ]
                : [],
            ),
        },
        service: {
          generate: (command) => {
            commands.push(command);
            return Promise.resolve(result);
          },
        },
        targets: [{ sportKey: "mlb", leagueKey: "mlb" }],
      },
      asOf,
    );
    expect(commands).toHaveLength(1);
    expect(commands[0]?.evaluatedAt).toBe(asOf);
    expect(commands[0]?.events.map(({ eventId }) => eventId)).toEqual([
      "event-1",
    ]);
    expect(commands[0]?.events[0]?.markets).toHaveLength(2);
    expect(summary).toEqual({
      evaluatedTargets: 1,
      failedTargets: 0,
      eventCount: 1,
      qualifiedCount: 1,
    });
  });

  it("skips a torn event without discarding the rest of the league pass", async () => {
    const generate = vi
      .fn<
        (
          command: OpportunityGenerationCommand,
        ) => Promise<OpportunityGenerationResult>
      >()
      .mockRejectedValueOnce(new Error("opportunity-evidence-time-invalid"))
      .mockResolvedValue(result);
    const telemetry: unknown[] = [];
    const summary = await runOpportunityGeneration(
      {
        games: {
          list: (filter) =>
            page(
              filter.day === "2026-08-10"
                ? [game(), game({ id: "event-2" })]
                : [],
            ),
        },
        service: { generate },
        telemetry: { emit: (event) => telemetry.push(event) },
        targets: [{ sportKey: "mlb", leagueKey: "mlb" }],
      },
      asOf,
    );
    expect(generate).toHaveBeenCalledTimes(2);
    expect(generate.mock.calls[0]?.[0]?.events).toHaveLength(1);
    expect(summary).toEqual({
      evaluatedTargets: 1,
      failedTargets: 0,
      eventCount: 2,
      qualifiedCount: 1,
    });
    expect(telemetry[0]).toMatchObject({
      outcome: "success",
      failureCount: 1,
      qualifiedCount: 1,
    });
  });

  it("isolates a failing target so the other leagues still evaluate", async () => {
    const generate = vi
      .fn<
        (
          command: OpportunityGenerationCommand,
        ) => Promise<OpportunityGenerationResult>
      >()
      .mockRejectedValueOnce(new Error("provider-health-invalid"))
      .mockResolvedValue(result);
    const telemetry: unknown[] = [];
    const summary = await runOpportunityGeneration(
      {
        games: {
          list: (filter) => page(filter.day === "2026-08-10" ? [game()] : []),
        },
        service: { generate },
        telemetry: { emit: (event) => telemetry.push(event) },
        targets: [
          { sportKey: "mlb", leagueKey: "mlb" },
          { sportKey: "mlb", leagueKey: "mlb" },
        ],
      },
      asOf,
    );
    expect(generate).toHaveBeenCalledTimes(2);
    expect(summary.failedTargets).toBe(1);
    expect(summary.evaluatedTargets).toBe(1);
    expect(summary.qualifiedCount).toBe(1);
    expect(telemetry).toHaveLength(2);
    expect(telemetry[0]).toMatchObject({ outcome: "failure" });
    expect(telemetry[1]).toMatchObject({ outcome: "success" });
  });

  it("skips the service entirely when no game qualifies", async () => {
    const generate = vi.fn();
    const summary = await runOpportunityGeneration(
      {
        games: { list: () => page([]) },
        service: {
          generate: generate,
        },
        targets: [{ sportKey: "soccer", leagueKey: "mls" }],
      },
      asOf,
    );
    expect(generate).not.toHaveBeenCalled();
    expect(summary).toEqual({
      evaluatedTargets: 1,
      failedTargets: 0,
      eventCount: 0,
      qualifiedCount: 0,
    });
  });
});

describe("invocation validation", () => {
  const now = () => Date.parse("2026-08-10T12:01:00.000Z");
  it("accepts a fresh scheduled event and returns its time", () => {
    expect(
      validateOpportunityGenerationInvocation(
        { source: "aws.events", "detail-type": "Scheduled Event", time: asOf },
        now,
      ),
    ).toBe(asOf);
  });
  it("normalizes EventBridge's second-precision timestamp", () => {
    // Live EventBridge sends "2026-08-10T12:00:00Z"; downstream evaluation
    // contracts require the exact millisecond ISO instant.
    expect(
      validateOpportunityGenerationInvocation(
        {
          source: "aws.events",
          "detail-type": "Scheduled Event",
          time: "2026-08-10T12:00:00Z",
        },
        now,
      ),
    ).toBe(asOf);
  });
  it("rejects foreign sources, malformed times, and stale events", () => {
    for (const input of [
      null,
      {},
      { source: "aws.s3", "detail-type": "Scheduled Event", time: asOf },
      { source: "aws.events", "detail-type": "Scheduled Event", time: "soon" },
      {
        source: "aws.events",
        "detail-type": "Scheduled Event",
        time: "2026-08-10T11:00:00.000Z",
      },
      {
        source: "aws.events",
        "detail-type": "Scheduled Event",
        time: "2026-08-10T12:02:00.000Z",
      },
    ])
      expect(() => validateOpportunityGenerationInvocation(input, now)).toThrow(
        "opportunity-generation-invocation-invalid",
      );
  });
});
