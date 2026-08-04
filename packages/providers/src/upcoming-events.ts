import type {
  CanonicalEventBootstrap,
  EntityId,
  EventStatus,
  IsoTimestamp,
  ProviderRevision,
  SportKey,
} from "@find-the-edge/domain";
import { supportsRequest, type ProviderDescriptor } from "./index";

export interface UpcomingEventPageRequest {
  readonly sportKey: SportKey;
  readonly leagueKey: string;
  readonly windowStart: IsoTimestamp;
  readonly windowEnd: IsoTimestamp;
  readonly limit: number;
  readonly cursor?: string;
}
export interface ProviderUpcomingEvent {
  readonly providerEventId: string;
  readonly sportKey: SportKey;
  readonly leagueKey: string;
  readonly participantLabels: readonly [string, string, ...string[]];
  readonly participantIdentityKeys?: readonly [string, string, ...string[]];
  readonly startsAt: IsoTimestamp;
  readonly status: EventStatus;
  readonly revision: ProviderRevision;
}
export interface UpcomingEventPage {
  readonly events: readonly ProviderUpcomingEvent[];
  readonly nextCursor?: string;
  readonly providerRequests: number;
  readonly quotaUsed: number;
}
export interface BootstrapPage {
  readonly events: readonly CanonicalEventBootstrap[];
  readonly nextCursor?: string;
  readonly providerRequests: number;
  readonly quotaUsed: number;
}
export interface BootstrapPageRequest extends Omit<
  UpcomingEventPageRequest,
  "cursor"
> {
  readonly identities: readonly string[];
  readonly providerId: string;
  readonly authorityRank: number;
  readonly cursor?: string;
}
export interface UpcomingEventScheduleAdapter {
  readonly descriptor: ProviderDescriptor;
  readonly sportKey: SportKey;
  readonly leagueKey: string;
  readonly authorityRank: number;
  listUpcomingEvents(
    request: UpcomingEventPageRequest,
  ): Promise<UpcomingEventPage>;
  listCanonicalBootstrap(request: BootstrapPageRequest): Promise<BootstrapPage>;
}
const normalize = (value: string) =>
  value.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ");
export function semanticId(scope: readonly string[]): string {
  return scope.map(normalize).map(encodeURIComponent).join(":");
}
export function normalizedUpcomingEventIdentity(input: {
  leagueKey: string;
  participantLabels: readonly string[];
  participantIdentityKeys?: readonly string[];
  startsAt: string;
}): string {
  return JSON.stringify([
    normalize(input.leagueKey),
    (input.participantIdentityKeys ?? input.participantLabels).map(normalize),
    new Date(input.startsAt).toISOString(),
  ]);
}
function validText(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 512 &&
    value === value.trim()
  );
}
function validShortText(value: unknown): value is string {
  return validText(value) && value.length <= 128;
}
function validInstant(value: unknown): value is IsoTimestamp {
  return (
    validText(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}
function validCount(
  value: unknown,
  min: number,
  max = 1_000_000,
): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= min &&
    value <= max
  );
}
function exactKeys(
  record: Record<string, unknown>,
  allowed: readonly string[],
) {
  return Object.keys(record).every((key) => allowed.includes(key));
}
const statuses: readonly EventStatus[] = [
  "scheduled",
  "postponed",
  "cancelled",
  "started",
  "completed",
  "unknown",
];
export function validateBootstrapPage(
  input: unknown,
  request: BootstrapPageRequest,
): BootstrapPage {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("invalid-bootstrap");
  const page = input as Record<string, unknown>;
  if (
    !exactKeys(page, [
      "events",
      "nextCursor",
      "providerRequests",
      "quotaUsed",
    ]) ||
    !Array.isArray(page["events"]) ||
    page["events"].length > request.limit ||
    !validCount(page["providerRequests"], 1) ||
    !validCount(page["quotaUsed"], 0) ||
    (Object.prototype.hasOwnProperty.call(page, "nextCursor") &&
      (typeof page["nextCursor"] !== "string" ||
        !page["nextCursor"] ||
        page["nextCursor"].length > 1024))
  )
    throw new Error("invalid-bootstrap");
  const ids = new Set<string>();
  const identities = new Set<string>();
  for (const raw of page["events"] as unknown[]) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
      throw new Error("invalid-bootstrap");
    const event = raw as Record<string, unknown>;
    if (
      !exactKeys(event, [
        "id",
        "canonicalKey",
        "sportKey",
        "leagueKey",
        "leagueId",
        "participantIds",
        "participantLabels",
        "startsAt",
        "phase",
        "status",
        "normalizedIdentity",
        "revision",
      ]) ||
      !validText(event["id"]) ||
      !validShortText(event["canonicalKey"]) ||
      !validText(event["leagueId"]) ||
      ids.has(event["id"]) ||
      event["sportKey"] !== request.sportKey ||
      event["leagueKey"] !== request.leagueKey ||
      !Array.isArray(event["participantIds"]) ||
      !Array.isArray(event["participantLabels"]) ||
      event["participantIds"].length < 2 ||
      event["participantIds"].length > 16 ||
      event["participantIds"].length !== event["participantLabels"].length ||
      !validInstant(event["startsAt"]) ||
      Date.parse(event["startsAt"]) < Date.parse(request.windowStart) ||
      Date.parse(event["startsAt"]) >= Date.parse(request.windowEnd) ||
      !validText(event["normalizedIdentity"]) ||
      identities.has(event["normalizedIdentity"]) ||
      !validText(event["phase"]) ||
      !statuses.includes(event["status"] as EventStatus) ||
      !(event["participantIds"] as unknown[]).every(validText) ||
      new Set(event["participantIds"] as string[]).size !==
        event["participantIds"].length ||
      new Set(
        (event["participantIds"] as string[]).map((id) =>
          id.normalize("NFKC").toLocaleLowerCase("en-US"),
        ),
      ).size !== event["participantIds"].length ||
      !(event["participantLabels"] as unknown[]).every(validShortText)
    )
      throw new Error("invalid-bootstrap");
    const typed = event as unknown as CanonicalEventBootstrap;
    const revision = event["revision"] as Record<string, unknown> | undefined;
    const leagueScope = semanticId([typed.sportKey, typed.leagueKey]);
    const labels = typed.participantLabels.map(normalize);
    if (
      typed.normalizedIdentity !== normalizedUpcomingEventIdentity(typed) ||
      !revision ||
      !exactKeys(revision, [
        "providerId",
        "authorityRank",
        "updatedAt",
        "sequence",
        "token",
      ]) ||
      revision["providerId"] !== request.providerId ||
      revision["authorityRank"] !== request.authorityRank ||
      !validInstant(revision["updatedAt"]) ||
      !validCount(revision["sequence"], 0) ||
      !validText(revision["token"]) ||
      !request.identities.includes(typed.normalizedIdentity) ||
      typed.id !== semanticId(["event", leagueScope, typed.canonicalKey]) ||
      typed.leagueId !== semanticId(["league", leagueScope]) ||
      typed.participantIds.some(
        (id, index) =>
          id !== semanticId(["participant", leagueScope, labels[index]!]),
      )
    )
      throw new Error("invalid-bootstrap");
    ids.add(event["id"]);
    identities.add(event["normalizedIdentity"]);
  }
  return input as BootstrapPage;
}
export function validateUpcomingEventPage(
  input: unknown,
  request: UpcomingEventPageRequest,
): UpcomingEventPage {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("invalid-page");
  const page = input as Record<string, unknown>;
  if (
    !exactKeys(page, [
      "events",
      "nextCursor",
      "providerRequests",
      "quotaUsed",
    ]) ||
    !Array.isArray(page["events"]) ||
    page["events"].length > request.limit ||
    !validCount(page["providerRequests"], 1) ||
    !validCount(page["quotaUsed"], 0) ||
    (Object.prototype.hasOwnProperty.call(page, "nextCursor") &&
      (typeof page["nextCursor"] !== "string" ||
        page["nextCursor"].length > 1024))
  )
    throw new Error("invalid-page");
  const ids = new Set<string>();
  for (const raw of page["events"] as unknown[]) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
      throw new Error("invalid-event");
    const event = raw as Record<string, unknown>;
    const revision = event["revision"] as Record<string, unknown> | undefined;
    if (
      !exactKeys(event, [
        "providerEventId",
        "sportKey",
        "leagueKey",
        "participantLabels",
        "startsAt",
        "status",
        "revision",
      ]) ||
      !validText(event["providerEventId"]) ||
      ids.has(event["providerEventId"]) ||
      event["sportKey"] !== request.sportKey ||
      event["leagueKey"] !== request.leagueKey ||
      !Array.isArray(event["participantLabels"]) ||
      event["participantLabels"].length < 2 ||
      event["participantLabels"].length > 16 ||
      !event["participantLabels"].every(validShortText) ||
      !validInstant(event["startsAt"]) ||
      Date.parse(event["startsAt"]) < Date.parse(request.windowStart) ||
      Date.parse(event["startsAt"]) >= Date.parse(request.windowEnd) ||
      !revision ||
      !exactKeys(revision, [
        "providerId",
        "authorityRank",
        "updatedAt",
        "sequence",
        "token",
      ]) ||
      !validText(revision["providerId"]) ||
      !validCount(revision["authorityRank"], 0, 1000) ||
      !validInstant(revision["updatedAt"]) ||
      !validCount(revision["sequence"], 0) ||
      !validText(revision["token"]) ||
      !statuses.includes(event["status"] as EventStatus)
    )
      throw new Error("invalid-event");
    ids.add(event["providerEventId"]);
  }
  return input as UpcomingEventPage;
}
export class ScheduleAdapterRegistry {
  readonly #items = new Map<string, UpcomingEventScheduleAdapter>();
  constructor(adapters: readonly UpcomingEventScheduleAdapter[]) {
    for (const item of adapters) {
      if (!validCount(item.authorityRank, 0, 1000))
        throw new Error("invalid-adapter-authority");
      if (
        !supportsRequest(item.descriptor, "schedule", {
          sportKey: item.sportKey,
          leagueKey: item.leagueKey,
        })
      )
        throw new Error("adapter-coverage-mismatch");
      const key = JSON.stringify([
        item.descriptor.id,
        item.sportKey,
        item.leagueKey,
      ]);
      if (this.#items.has(key)) throw new Error("duplicate-adapter");
      this.#items.set(key, item);
    }
  }
  get(providerId: string, sportKey: SportKey, leagueKey: string) {
    return this.#items.get(JSON.stringify([providerId, sportKey, leagueKey]));
  }
}
export function fixtureBootstrap(
  input: ProviderUpcomingEvent,
  canonicalKey: string,
): CanonicalEventBootstrap {
  const labels = (input.participantIdentityKeys ?? input.participantLabels).map(
    normalize,
  ) as [string, string, ...string[]];
  const leagueScope = semanticId([input.sportKey, input.leagueKey]);
  return {
    id: semanticId(["event", leagueScope, canonicalKey]) as EntityId,
    sportKey: input.sportKey,
    leagueKey: input.leagueKey,
    leagueId: semanticId(["league", leagueScope]) as EntityId,
    participantIds: labels.map(
      (label) => semanticId(["participant", leagueScope, label]) as EntityId,
    ) as [EntityId, EntityId, ...EntityId[]],
    participantLabels: input.participantLabels,
    startsAt: input.startsAt,
    phase: "pregame",
    status: input.status,
    normalizedIdentity: normalizedUpcomingEventIdentity(input),
    canonicalKey,
    revision: input.revision,
  };
}
