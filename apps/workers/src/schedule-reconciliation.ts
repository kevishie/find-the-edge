import {
  EventDataConflict,
  type EventIngestionStore,
} from "@find-the-edge/database";
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
  /** SharpAPI atlas uuid — the feed-stable identity across id churn. */
  readonly providerEventUuid?: string;
  readonly sportKey: SportKey;
  readonly leagueKey: string;
  readonly participantLabels: readonly [string, string];
  readonly participantIdentityKeys?: readonly [string, string];
  readonly startsAt: IsoTimestamp;
  readonly status: "scheduled";
  readonly revision: ProviderRevision;
}

const SCHEDULE_EVENT_CONFLICT_REASON_CODES = [
  "schedule-mapping-unresolved",
  "canonical-candidate-conflict",
  "identity-claim-conflict",
  "mapping-provenance-conflict",
  "provider-revision-content-conflict",
  "bootstrap-content-mismatch",
  "bootstrap-revision-content-conflict",
] as const;

export type ScheduleEventConflictReason =
  (typeof SCHEDULE_EVENT_CONFLICT_REASON_CODES)[number];

const scheduleEventConflictReasons = new Set<string>(
  SCHEDULE_EVENT_CONFLICT_REASON_CODES,
);

export const isScheduleEventConflictReason = (
  value: unknown,
): value is ScheduleEventConflictReason =>
  typeof value === "string" && scheduleEventConflictReasons.has(value);

/** Created only at the schedule reconciliation boundary after an exact
 * deterministic content conflict has been attributed to this event. */
export class ScheduleEventConflictError extends Error {
  override readonly name = "ScheduleEventConflictError";

  constructor(readonly reason: ScheduleEventConflictReason) {
    super("schedule-event-conflict");
  }
}

/** Binds a provider alias without allowing its near-identical schedule to
 * rewrite the existing canonical identity or start time. */
export async function reconcileScheduledProviderEvent(
  store: EventIngestionStore,
  providerId: string,
  event: ScheduledProviderEvent,
  observedAt: IsoTimestamp,
) {
  const bootstrap = fixtureBootstrap(event, event.providerEventId);
  const { providerEventUuid, ...listed } = event;
  const original = {
    ...listed,
    providerId,
    normalizedIdentity: normalizedUpcomingEventIdentity(event),
    participantIdentityIds: bootstrap.participantIds,
    observedAt,
  };
  try {
    const result = await store.reconcileScheduledEvent({
      event: original,
      bootstrap,
      ...(providerEventUuid ? { providerEventUuid } : {}),
    });
    if (result.kind === "unresolved")
      throw new ScheduleEventConflictError("schedule-mapping-unresolved");
    return result;
  } catch (error) {
    if (error instanceof ScheduleEventConflictError) throw error;
    if (error instanceof EventDataConflict)
      throw new ScheduleEventConflictError(error.reason);
    throw error;
  }
}
