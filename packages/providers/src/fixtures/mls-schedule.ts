import type { IsoTimestamp, SportKey } from "@find-the-edge/domain";
import { fixtureDevelopmentProvider } from "../coverage-registry";
import {
  fixtureBootstrap,
  type BootstrapPageRequest,
  type ProviderUpcomingEvent,
  type UpcomingEventPageRequest,
  type UpcomingEventScheduleAdapter,
} from "../upcoming-events";
const sportKey = "soccer" as SportKey,
  leagueKey = "mls";
const events: readonly ProviderUpcomingEvent[] = [
  {
    providerEventId: "mls-1",
    sportKey,
    leagueKey,
    participantLabels: ["Miami", "Atlanta"],
    startsAt: "2026-08-01T23:30:00.000Z" as IsoTimestamp,
    status: "scheduled",
    revision: {
      providerId: "fixture-development",
      authorityRank: 100,
      updatedAt: "2026-07-29T12:00:00.000Z" as IsoTimestamp,
      sequence: 1,
      token: "1",
    },
  },
];
export class FixtureMlsScheduleAdapter implements UpcomingEventScheduleAdapter {
  readonly descriptor = fixtureDevelopmentProvider;
  readonly sportKey = sportKey;
  readonly leagueKey = leagueKey;
  readonly authorityRank = 100;
  async listUpcomingEvents(request: UpcomingEventPageRequest) {
    await Promise.resolve();
    const start = Date.parse(request.windowStart),
      end = Date.parse(request.windowEnd);
    if (
      request.sportKey !== sportKey ||
      request.leagueKey !== leagueKey ||
      !Number.isFinite(start) ||
      !Number.isFinite(end) ||
      start >= end ||
      !Number.isSafeInteger(request.limit) ||
      request.limit < 1 ||
      request.limit > 100 ||
      request.cursor !== undefined
    )
      throw new Error("invalid-fixture-request");
    return {
      events: events.filter(
        (event) =>
          Date.parse(event.startsAt) >= start &&
          Date.parse(event.startsAt) < end,
      ),
      providerRequests: 1,
      quotaUsed: 1,
    };
  }
  async listCanonicalBootstrap(request: BootstrapPageRequest) {
    if (
      request.identities.length < 1 ||
      request.identities.length > 100 ||
      request.cursor !== undefined
    )
      throw new Error("invalid-bootstrap-targets");
    const pageRequest: UpcomingEventPageRequest = {
      sportKey: request.sportKey,
      leagueKey: request.leagueKey,
      windowStart: request.windowStart,
      windowEnd: request.windowEnd,
      limit: request.limit,
    };
    const page = await this.listUpcomingEvents(pageRequest);
    return {
      events: page.events
        .map((event) =>
          fixtureBootstrap(event, "2026-regular-miami-atlanta-001"),
        )
        .filter((event) =>
          request.identities.includes(event.normalizedIdentity),
        ),
      providerRequests: 1,
      quotaUsed: 1,
    };
  }
}
