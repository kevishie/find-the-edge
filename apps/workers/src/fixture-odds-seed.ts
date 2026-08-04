import type {
  EventIngestionStore,
  FixtureOddsIngestInput,
  FixtureOddsPersistResult,
} from "@find-the-edge/database";
import type {
  FixtureOddsObservation,
  IsoTimestamp,
} from "@find-the-edge/domain";
import {
  FixtureMlbScheduleAdapter,
  FixtureMlsScheduleAdapter,
  mvpFixtureOdds,
  normalizedUpcomingEventIdentity,
  type FixtureOddsSeedEvent,
  type UpcomingEventScheduleAdapter,
} from "@find-the-edge/providers";

export interface FixtureOddsPersister {
  persist(input: FixtureOddsIngestInput): Promise<FixtureOddsPersistResult>;
}

export interface FixtureOddsSeedSummary {
  readonly events: number;
  readonly observations: number;
  readonly snapshotsCreated: number;
  readonly snapshotsExisting: number;
  readonly currentAdvanced: number;
  readonly currentRetained: number;
}

const windowStart = "2026-08-01T00:00:00.000Z" as IsoTimestamp;
const windowEnd = "2026-08-03T00:00:00.000Z" as IsoTimestamp;

export class FixtureOddsSeedError extends Error {
  override readonly name = "FixtureOddsSeedError";
  constructor(
    message: string,
    readonly providerEventId: string,
    readonly marketKey?: string,
    readonly selectionKey?: string,
    cause?: unknown,
  ) {
    super(
      `${message}: ${providerEventId}${marketKey ? `/${marketKey}` : ""}${selectionKey ? `/${selectionKey}` : ""}`,
      cause === undefined ? undefined : { cause },
    );
  }
}

export interface FixtureOddsSeedDependencies {
  readonly fixtures?: readonly FixtureOddsSeedEvent[];
  readonly adapters?: readonly UpcomingEventScheduleAdapter[];
}

const scopedEventId = (event: {
  readonly providerId: string;
  readonly providerEventId: string;
  readonly sportKey: string;
  readonly leagueKey: string;
}) =>
  `${event.providerId}\0${event.sportKey}\0${event.leagueKey}\0${event.providerEventId}`;

export async function seedFixtureOdds(
  store: EventIngestionStore,
  odds: FixtureOddsPersister,
  dependencies: FixtureOddsSeedDependencies = {},
): Promise<FixtureOddsSeedSummary> {
  const observedAt = "2026-08-01T12:30:00.000Z" as IsoTimestamp;
  const fixtures = dependencies.fixtures ?? mvpFixtureOdds;
  const adapters =
    dependencies.adapters ??
    ([
      new FixtureMlbScheduleAdapter(),
      new FixtureMlsScheduleAdapter(),
    ] as const);
  const fixtureIds = fixtures.map(scopedEventId);
  if (new Set(fixtureIds).size !== fixtureIds.length)
    throw new FixtureOddsSeedError(
      "duplicate scoped odds provider event",
      "fixture-preflight",
    );
  const plans: {
    readonly adapter: UpcomingEventScheduleAdapter;
    readonly page: Awaited<
      ReturnType<UpcomingEventScheduleAdapter["listUpcomingEvents"]>
    >;
    readonly bootstraps: Awaited<
      ReturnType<UpcomingEventScheduleAdapter["listCanonicalBootstrap"]>
    >;
  }[] = [];
  const allScheduleIds: string[] = [];
  for (const adapter of adapters) {
    const request = {
      sportKey: adapter.sportKey,
      leagueKey: adapter.leagueKey,
      windowStart,
      windowEnd,
      limit: 100,
    };
    const page = await adapter.listUpcomingEvents(request);
    if ("nextCursor" in page && page.nextCursor)
      throw new FixtureOddsSeedError(
        "fixture page was not bounded",
        adapter.leagueKey,
      );
    const identities = page.events.map(normalizedUpcomingEventIdentity);
    const bootstraps = await adapter.listCanonicalBootstrap({
      ...request,
      providerId: adapter.descriptor.id,
      authorityRank: adapter.authorityRank,
      identities,
    });
    if (
      ("nextCursor" in bootstraps && bootstraps.nextCursor) ||
      bootstraps.events.length !== page.events.length ||
      JSON.stringify(
        bootstraps.events.map((event) => event.normalizedIdentity).sort(),
      ) !== JSON.stringify([...identities].sort())
    )
      throw new FixtureOddsSeedError(
        "fixture bootstrap was incomplete",
        adapter.leagueKey,
      );
    const scheduleIds = page.events
      .map((event) =>
        scopedEventId({
          providerId: adapter.descriptor.id,
          providerEventId: event.providerEventId,
          sportKey: event.sportKey,
          leagueKey: event.leagueKey,
        }),
      )
      .sort();
    allScheduleIds.push(...scheduleIds);
    const oddsIds = fixtures
      .filter(
        (fixture) =>
          fixture.providerId === adapter.descriptor.id &&
          fixture.sportKey === adapter.sportKey &&
          fixture.leagueKey === adapter.leagueKey,
      )
      .map(scopedEventId)
      .sort();
    if (JSON.stringify(scheduleIds) !== JSON.stringify(oddsIds))
      throw new FixtureOddsSeedError(
        "schedule and odds fixture coverage differ",
        adapter.leagueKey,
      );
    plans.push({ adapter, page, bootstraps });
  }
  if (
    JSON.stringify(allScheduleIds.sort()) !==
    JSON.stringify([...fixtureIds].sort())
  )
    throw new FixtureOddsSeedError(
      "global schedule and odds fixture coverage differ",
      "fixture-preflight",
    );
  for (const { adapter, page, bootstraps } of plans) {
    for (const canonical of bootstraps.events)
      await store.bootstrapCanonicalEvent(canonical, observedAt);
    for (const event of page.events) {
      const result = await store.ingestEvent({
        providerId: adapter.descriptor.id,
        providerEventId: event.providerEventId,
        sportKey: event.sportKey,
        leagueKey: event.leagueKey,
        normalizedIdentity: normalizedUpcomingEventIdentity(event),
        startsAt: event.startsAt,
        status: event.status,
        ...(event.participantLabels
          ? { participantLabels: event.participantLabels }
          : {}),
        revision: event.revision,
        observedAt,
      });
      if (result.kind === "unresolved")
        throw new FixtureOddsSeedError(
          "fixture mapping unresolved",
          event.providerEventId,
        );
    }
  }

  let snapshotsCreated = 0;
  let snapshotsExisting = 0;
  let currentAdvanced = 0;
  let currentRetained = 0;
  for (const fixture of fixtures) {
    const canonical = await store.resolveExactCanonicalBinding(fixture);
    if (!canonical)
      throw new FixtureOddsSeedError(
        "exact canonical binding unavailable",
        fixture.providerEventId,
      );
    for (const price of fixture.prices) {
      const observation: FixtureOddsObservation = {
        canonicalEventId: canonical.id,
        canonicalEventVersion: canonical.version,
        sportKey: canonical.sportKey,
        ...price,
      };
      try {
        const result = await odds.persist({
          providerId: fixture.providerId,
          providerEventId: fixture.providerEventId,
          leagueKey: fixture.leagueKey,
          expectedStartsAt: canonical.startsAt,
          expectedStatus: "scheduled",
          observation,
        });
        if (result.snapshot === "created") snapshotsCreated += 1;
        else snapshotsExisting += 1;
        if (result.current === "advanced") currentAdvanced += 1;
        else currentRetained += 1;
      } catch (error) {
        throw new FixtureOddsSeedError(
          "odds persistence failed",
          fixture.providerEventId,
          price.marketKey,
          price.selectionKey,
          error,
        );
      }
    }
  }
  return {
    events: fixtures.length,
    observations: snapshotsCreated + snapshotsExisting,
    snapshotsCreated,
    snapshotsExisting,
    currentAdvanced,
    currentRetained,
  };
}
