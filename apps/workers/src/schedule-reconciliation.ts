import type { EventIngestionStore } from "@find-the-edge/database";
import type {
  IsoTimestamp,
  ProviderRevision,
  SportKey,
} from "@find-the-edge/domain";
import {
  fixtureBootstrap,
  normalizedUpcomingEventIdentity,
} from "@find-the-edge/providers";

export interface ScheduledProviderEvent {
  readonly providerEventId: string;
  readonly sportKey: SportKey;
  readonly leagueKey: string;
  readonly participantLabels: readonly [string, string];
  readonly startsAt: IsoTimestamp;
  readonly status: "scheduled";
  readonly revision: ProviderRevision;
}

/** Binds a provider alias without allowing its near-identical schedule to
 * rewrite the existing canonical identity or start time. */
export async function reconcileScheduledProviderEvent(
  store: EventIngestionStore,
  providerId: string,
  event: ScheduledProviderEvent,
  observedAt: IsoTimestamp,
) {
  const original = {
    ...event,
    providerId,
    normalizedIdentity: normalizedUpcomingEventIdentity(event),
    observedAt,
  };
  return store.reconcileScheduledEvent({
    event: original,
    bootstrap: fixtureBootstrap(event, event.providerEventId),
  });
}
