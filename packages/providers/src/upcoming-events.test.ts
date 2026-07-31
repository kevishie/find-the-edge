import type { IsoTimestamp, SportKey } from "@find-the-edge/domain";
import { describe, expect, it } from "vitest";
import { FixtureMlbScheduleAdapter } from "./fixtures/mlb-schedule";
import {
  ScheduleAdapterRegistry,
  fixtureBootstrap,
  validateBootstrapPage,
  validateUpcomingEventPage,
  type ProviderUpcomingEvent,
} from "./upcoming-events";
describe("upcoming providers", () => {
  it("rejects duplicate canonical bootstrap participant IDs", () => {
    const event = {
      providerEventId: "one",
      sportKey: "mlb" as SportKey,
      leagueKey: "mlb",
      participantLabels: ["A", "A"] as [string, string],
      startsAt: "2026-08-01T12:00:00.000Z" as IsoTimestamp,
      status: "scheduled" as const,
      revision: {
        providerId: "fixture-development",
        authorityRank: 100,
        updatedAt: "2026-07-30T00:00:00.000Z" as IsoTimestamp,
        sequence: 1,
        token: "duplicate",
      },
    };
    const bootstrap = fixtureBootstrap(event, "duplicate-participants");
    expect(() =>
      validateBootstrapPage(
        { events: [bootstrap], providerRequests: 1, quotaUsed: 1 },
        {
          providerId: "fixture-development",
          authorityRank: 100,
          sportKey: "mlb" as SportKey,
          leagueKey: "mlb",
          identities: [bootstrap.normalizedIdentity],
          windowStart: "2026-08-01T00:00:00.000Z" as IsoTimestamp,
          windowEnd: "2026-08-02T00:00:00.000Z" as IsoTimestamp,
          limit: 100,
        },
      ),
    ).toThrow("invalid-bootstrap");
  });

  it("uses stable semantic IDs and exact adapter coverage", () => {
    const event = {
      providerEventId: "one",
      sportKey: "mlb" as SportKey,
      leagueKey: "mlb",
      participantLabels: ["A", "B"] as [string, string],
      startsAt: "2026-08-01T00:00:00.000Z" as IsoTimestamp,
      status: "scheduled" as const,
      revision: {
        providerId: "fixture-development",
        authorityRank: 100,
        updatedAt: "2026-07-30T00:00:00.000Z" as IsoTimestamp,
        sequence: 1,
        token: "x",
      },
    } satisfies ProviderUpcomingEvent;
    expect(fixtureBootstrap(event, "canonical-one").id).toBe(
      fixtureBootstrap({ ...event, providerEventId: "other" }, "canonical-one")
        .id,
    );
    const unicodeBootstrap = fixtureBootstrap(
      {
        ...event,
        participantLabels: ["Ａ", "B"],
        startsAt: "2026-08-02T00:00:00.000Z" as IsoTimestamp,
      },
      "canonical-one",
    );
    expect(unicodeBootstrap.id).toBe(
      fixtureBootstrap(event, "canonical-one").id,
    );
    expect(unicodeBootstrap.participantIds).toEqual(
      fixtureBootstrap(event, "canonical-one").participantIds,
    );
    const adapter = new FixtureMlbScheduleAdapter();
    expect(
      new ScheduleAdapterRegistry([adapter]).get(
        "fixture-development",
        "mlb" as SportKey,
        "mlb",
      ),
    ).toBe(adapter);
  });

  it("rejects oversized participant sets", () => {
    const labels = Array.from({ length: 17 }, (_, index) => `Team ${index}`);
    const request = {
      sportKey: "mlb" as SportKey,
      leagueKey: "mlb",
      windowStart: "2026-08-01T00:00:00.000Z" as IsoTimestamp,
      windowEnd: "2026-08-03T00:00:00.000Z" as IsoTimestamp,
      limit: 100,
    };
    expect(() =>
      validateUpcomingEventPage(
        {
          events: [
            {
              providerEventId: "oversized",
              sportKey: request.sportKey,
              leagueKey: request.leagueKey,
              participantLabels: labels,
              startsAt: "2026-08-02T00:00:00.000Z",
              status: "scheduled",
              revision: {
                providerId: "fixture-development",
                authorityRank: 100,
                updatedAt: "2026-07-30T00:00:00.000Z",
                sequence: 1,
                token: "one",
              },
            },
          ],
          providerRequests: 1,
          quotaUsed: 1,
        },
        request,
      ),
    ).toThrow("invalid-event");
  });

  it("rejects parseable but non-canonical provider timestamps", () => {
    const request = {
      sportKey: "mlb" as SportKey,
      leagueKey: "mlb",
      windowStart: "2026-08-01T00:00:00.000Z" as IsoTimestamp,
      windowEnd: "2026-08-03T00:00:00.000Z" as IsoTimestamp,
      limit: 100,
    };
    expect(() =>
      validateUpcomingEventPage(
        {
          events: [
            {
              providerEventId: "noncanonical",
              sportKey: request.sportKey,
              leagueKey: request.leagueKey,
              participantLabels: ["A", "B"],
              startsAt: "2026-08-02T00:00:00Z",
              status: "scheduled",
              revision: {
                providerId: "fixture-development",
                authorityRank: 100,
                updatedAt: "2026-07-30T00:00:00Z",
                sequence: 1,
                token: "one",
              },
            },
          ],
          providerRequests: 1,
          quotaUsed: 1,
        },
        request,
      ),
    ).toThrow("invalid-event");
  });
});
