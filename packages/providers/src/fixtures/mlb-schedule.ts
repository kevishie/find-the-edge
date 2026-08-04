import type { IsoTimestamp, SportKey } from "@find-the-edge/domain";
import { fixtureDevelopmentProvider } from "../coverage-registry";
import {
  fixtureBootstrap,
  type BootstrapPageRequest,
  type ProviderUpcomingEvent,
  type UpcomingEventPageRequest,
  type UpcomingEventScheduleAdapter,
} from "../upcoming-events";

const sportKey = "mlb" as SportKey;
const leagueKey = "mlb";
const events: readonly ProviderUpcomingEvent[] = [
  {
    providerEventId: "mlb-1",
    sportKey,
    leagueKey,
    participantLabels: ["Boston Red Sox", "New York Yankees"],
    startsAt: "2026-08-01T23:05:00.000Z" as IsoTimestamp,
    status: "scheduled",
    revision: {
      providerId: "fixture-development",
      authorityRank: 100,
      updatedAt: "2026-07-29T12:00:00.000Z" as IsoTimestamp,
      sequence: 1,
      token: "1",
    },
  },
  {
    providerEventId: "mlb-2",
    sportKey,
    leagueKey,
    participantLabels: ["Chicago Cubs", "Detroit Tigers"],
    startsAt: "2026-08-02T17:10:00.000Z" as IsoTimestamp,
    status: "scheduled",
    revision: {
      providerId: "fixture-development",
      authorityRank: 100,
      updatedAt: "2026-07-29T13:00:00.000Z" as IsoTimestamp,
      sequence: 1,
      token: "2",
    },
  },
];
function eligible(request: UpcomingEventPageRequest) {
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
    request.limit > 100
  )
    throw new Error("invalid-fixture-request");
  return events.filter(
    (event) =>
      Date.parse(event.startsAt) >= start && Date.parse(event.startsAt) < end,
  );
}
function offset(cursor?: string) {
  if (cursor === undefined) return 0;
  const match = /^offset:(\d+)$/.exec(cursor);
  if (!match) throw new Error("invalid-fixture-cursor");
  const value = Number(match[1]);
  if (!Number.isSafeInteger(value) || value > 1_000_000)
    throw new Error("invalid-fixture-cursor");
  return value;
}
export class FixtureMlbScheduleAdapter implements UpcomingEventScheduleAdapter {
  readonly descriptor = fixtureDevelopmentProvider;
  readonly sportKey = sportKey;
  readonly leagueKey = leagueKey;
  readonly authorityRank = 100;
  async listUpcomingEvents(request: UpcomingEventPageRequest) {
    await Promise.resolve();
    const all = eligible(request),
      from = offset(request.cursor);
    const page = all.slice(from, from + request.limit),
      next = from + page.length;
    return {
      events: page,
      providerRequests: 1,
      quotaUsed: 1,
      ...(next < all.length ? { nextCursor: `offset:${next}` } : {}),
    };
  }
  async listCanonicalBootstrap(request: BootstrapPageRequest) {
    await Promise.resolve();
    if (
      request.identities.length < 1 ||
      request.identities.length > 100 ||
      new Set(request.identities).size !== request.identities.length
    )
      throw new Error("invalid-bootstrap-targets");
    const all = eligible(request)
      .map((event) =>
        fixtureBootstrap(
          event,
          event.providerEventId === "mlb-1"
            ? "2026-regular-boston-new-york-001"
            : "2026-regular-chicago-detroit-001",
        ),
      )
      .filter((event) => request.identities.includes(event.normalizedIdentity));
    const from = offset(request.cursor);
    const page = all.slice(from, from + request.limit);
    const next = from + page.length;
    return {
      events: page,
      providerRequests: 1,
      quotaUsed: 1,
      ...(next < all.length ? { nextCursor: `offset:${next}` } : {}),
    };
  }
}
