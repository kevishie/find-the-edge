import { describe, expect, it } from "vitest";
import {
  type EvaluationCandidateRepository,
  MemoryEvaluationCandidateRepository,
  MemoryPaperPickRunRepository,
} from "@find-the-edge/database";
import type { PaperPickSchedulePolicy } from "@find-the-edge/config";
import { PaperPickScheduler } from "./paper-pick-scheduler";
import type {
  PickEvaluationService,
  PickEvaluationInput,
} from "./pick-evaluation";
const at = "2026-08-04T12:00:00.000Z";
const tuple = {
  sportKey: "baseball",
  leagueKey: "mlb",
  strategyId: "ml",
  strategyVersion: "1",
  marketKey: "moneyline",
  mode: "shadow" as const,
};
const policy = (): PaperPickSchedulePolicy => ({
  id: "schedule",
  version: "1",
  enabled: true,
  killSwitch: "open",
  generationMinutes: 15,
  candidateWindowMinutes: { minimum: 1, maximum: 180 },
  limits: {
    events: 8,
    concurrency: 2,
    modelCalls: 8,
    inputTokens: 8000,
    outputTokens: 4000,
    costMicros: 8000,
  },
  allowlist: [tuple],
});
const candidate = {
  eventId: "event",
  eventVersion: 1,
  sportKey: "baseball",
  leagueKey: "mlb",
  participantIds: ["away", "home"],
  startsAt: "2026-08-04T14:00:00.000Z",
  status: "scheduled" as const,
};
const fakeInput = {} as PickEvaluationInput;
const evaluation = {
  terminal: "evaluation" as const,
  outcome: "created" as const,
  pair: {
    evaluation: {
      evaluationId: `evaluation:${"a".repeat(64)}`,
      decision: "play" as const,
    },
    paperBet: null,
  },
};
const scheduler = (
  overrides: {
    policy?: () => Promise<PaperPickSchedulePolicy>;
    candidates?: EvaluationCandidateRepository;
    calls?: unknown[];
    mode?: "disabled" | "approved";
    resolveStrategyVersion?: (
      strategyId: string,
      scheduledFor: string,
    ) => Promise<string | null>;
  } = {},
) => {
  const calls = overrides.calls ?? [];
  return {
    calls,
    runs: new MemoryPaperPickRunRepository(),
    create(runs = new MemoryPaperPickRunRepository()) {
      return {
        runs,
        value: new PaperPickScheduler({
          policy: overrides.policy ?? (() => Promise.resolve(policy())),
          candidates:
            overrides.candidates ??
            new MemoryEvaluationCandidateRepository([candidate]),
          runs,
          evaluator: {
            evaluate(input: unknown) {
              calls.push(input);
              return Promise.resolve(evaluation);
            },
          } as unknown as PickEvaluationService,
          assemble: () => Promise.resolve(fakeInput),
          modelCapability: overrides.mode ?? "approved",
          reservation: { inputTokens: 100, outputTokens: 50, costMicros: 100 },
          now: () => new Date(at),
          resolveStrategyVersion:
            overrides.resolveStrategyVersion ??
            (() => Promise.resolve(tuple.strategyVersion)),
        }),
      };
    },
  };
};
describe("paper-pick scheduler", () => {
  it("freezes the future-effective approved strategy version into the run", async () => {
    const fixture = scheduler({
      resolveStrategyVersion: () => Promise.resolve("approved-v2"),
    });
    const built = fixture.create();
    const result = await built.value.generate(at);
    const run = await built.runs.getRun(result.runIds[0]!);
    expect(run?.strategyVersion).toBe("approved-v2");
  });
  it("fails closed when no approved deployed strategy is active", async () => {
    const fixture = scheduler({
      resolveStrategyVersion: () => Promise.resolve(null),
    });
    expect(await fixture.create().value.generate(at)).toMatchObject({
      runIds: [],
      discovered: 0,
    });
    expect(fixture.calls).toHaveLength(0);
  });
  it("fails closed while disabled and never calls the evaluator", async () => {
    const fixture = scheduler({
      policy: () =>
        Promise.resolve({
          ...policy(),
          enabled: false,
          killSwitch: "killed",
          allowlist: [],
        }),
    });
    const built = fixture.create();
    expect(await built.value.generate(at)).toMatchObject({
      reasonCode: "disabled",
      discovered: 0,
    });
    expect(fixture.calls).toHaveLength(0);
  });
  it("converges duplicate generations to one run/item/evaluation terminal", async () => {
    const fixture = scheduler();
    const built = fixture.create(fixture.runs);
    const first = await built.value.generate(at);
    const second = await built.value.generate(at);
    expect(first).toMatchObject({ discovered: 1, terminal: 1 });
    expect(second).toMatchObject({ discovered: 1, terminal: 1 });
    expect(fixture.calls).toHaveLength(1);
    expect(await fixture.runs.listItems(first.runIds[0]!)).toHaveLength(1);
  });
  it("rechecks the durable kill switch immediately before any model call", async () => {
    let reads = 0;
    const fixture = scheduler({
      policy: () =>
        Promise.resolve(
          reads++
            ? { ...policy(), enabled: false, killSwitch: "killed" }
            : policy(),
        ),
    });
    const built = fixture.create();
    expect(await built.value.generate(at)).toMatchObject({ terminal: 1 });
    expect(fixture.calls).toHaveLength(0);
    expect(
      await built.runs.listItems(
        (await built.runs.getRun(`missing`))?.runId ?? "",
      ),
    ).toHaveLength(0);
  });
  it("records paper model-disabled before invoking paid work", async () => {
    const paper = {
      ...policy(),
      allowlist: [{ ...tuple, mode: "paper" as const }],
    };
    const fixture = scheduler({
      policy: () => Promise.resolve(paper),
      mode: "disabled",
    });
    const built = fixture.create();
    const result = await built.value.generate(at);
    expect(fixture.calls).toHaveLength(0);
    const items = await built.runs.listItems(result.runIds[0]!);
    expect(items[0]).toMatchObject({
      terminal: "attempt",
      reasonCode: "model-disabled",
    });
  });
  it("rejects non-allowlisted candidates at discovery", async () => {
    const fixture = scheduler({
      candidates: new MemoryEvaluationCandidateRepository([
        { ...candidate, sportKey: "soccer", leagueKey: "mls" },
      ]),
    });
    const built = fixture.create();
    expect(await built.value.generate(at)).toMatchObject({
      discovered: 0,
      terminal: 0,
    });
    expect(fixture.calls).toHaveLength(0);
  });
  it("converges duplicate shadow and paper generations independently end to end", async () => {
    const mixed = {
      ...policy(),
      allowlist: [tuple, { ...tuple, mode: "paper" as const }],
    };
    const fixture = scheduler({ policy: () => Promise.resolve(mixed) });
    const built = fixture.create(fixture.runs);
    const first = await built.value.generate(at);
    const second = await built.value.generate(at);
    expect(first).toMatchObject({ discovered: 2, terminal: 2 });
    expect(second).toMatchObject({ discovered: 2, terminal: 2 });
    expect(first.runIds).toHaveLength(2);
    expect(fixture.calls).toHaveLength(2);
    for (const runId of first.runIds) {
      const run = await fixture.runs.getRun(runId);
      expect(run).toMatchObject({
        state: "complete",
        counters: { discovered: 1, terminal: 1, evaluations: 1 },
      });
      expect(await fixture.runs.listItems(runId)).toHaveLength(1);
    }
  });
  it("shares event admission across every tuple in one generation", async () => {
    const secondCandidate = {
      ...candidate,
      eventId: "event-two",
      sportKey: "soccer",
      leagueKey: "mls",
      startsAt: "2026-08-04T15:00:00.000Z",
    };
    const sharedPolicy = {
      ...policy(),
      limits: { ...policy().limits, events: 1 },
      allowlist: [
        tuple,
        {
          ...tuple,
          sportKey: "soccer",
          leagueKey: "mls",
          strategyId: "alternate",
          strategyVersion: "2",
        },
      ],
    };
    const candidates: EvaluationCandidateRepository = {
      listEligible: (query) =>
        Promise.resolve(
          query.leagueKey === "mlb" ? [candidate] : [secondCandidate],
        ),
      rereadEligible: (item) => Promise.resolve(item),
    };
    const fixture = scheduler({
      policy: () => Promise.resolve(sharedPolicy),
      candidates,
    });
    const built = fixture.create();
    const result = await built.value.generate(at);
    expect(result).toMatchObject({ discovered: 1, terminal: 1, limits: 1 });
    expect(fixture.calls).toHaveLength(1);
    expect(await built.runs.listItems(result.runIds[0]!)).toHaveLength(1);
    expect(await built.runs.listItems(result.runIds[1]!)).toHaveLength(0);
  });
  it("freezes the first candidate manifest so a retry cannot add a newly discovered event", async () => {
    let discoveries = 0;
    const later = { ...candidate, eventId: "later-event" };
    const candidates: EvaluationCandidateRepository = {
      listEligible: () =>
        Promise.resolve(discoveries++ === 0 ? [candidate] : [later]),
      rereadEligible: (item) => Promise.resolve(item),
    };
    const fixture = scheduler({ candidates });
    const built = fixture.create(fixture.runs);
    const first = await built.value.generate(at);
    await built.value.generate(at);
    const items = await fixture.runs.listItems(first.runIds[0]!);
    expect(items.map(({ eventId }) => eventId)).toEqual(["event"]);
    expect(fixture.calls).toHaveLength(1);
  });
});
