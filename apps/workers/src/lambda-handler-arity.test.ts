import { describe, expect, it } from "vitest";

import { handler as fixtureOddsProjection } from "./fixture-odds-projection-lambda.js";
import { handler as scoutingDispatcher } from "./scouting-dispatcher-lambda.js";
import { handler as scoutingOutbox } from "./scouting-outbox-lambda.js";
import { handler as scoutingWorkflow } from "./scouting-workflow-lambda.js";

/**
 * Lambda decides a handler is callback-based purely from the number of
 * parameters it DECLARES, and Node 24 removed callback support: a third
 * parameter makes the function fail to boot on every single invocation with
 * `Runtime.CallbackHandlerDeprecated`, before any handler code runs.
 *
 * Nothing else catches this. The parameter type-checks, the unit tests all
 * pass because they call the inner handler directly, the deploy succeeds, and
 * the function is simply dead. FixtureOddsProjection failed 2,312,637 of
 * 2,312,637 invocations over two days this way, its alarms in ALARM since
 * 2026-08-07, while the odds it was meant to project sat unprojected.
 *
 * So the arity is the contract, and it is asserted here directly.
 */
describe("lambda handler arity", () => {
  it.each([
    ["fixture-odds-projection", fixtureOddsProjection],
    ["scouting-outbox", scoutingOutbox],
    ["scouting-dispatcher", scoutingDispatcher],
    ["scouting-workflow", scoutingWorkflow],
  ])("%s declares at most two parameters", (_name, handler) => {
    expect(handler.length).toBeLessThanOrEqual(2);
  });
});
