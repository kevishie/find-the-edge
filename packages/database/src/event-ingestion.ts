import type {
  CanonicalEvent,
  CanonicalEventBootstrap,
  EntityId,
  EventStatus,
  IngestionCheckpoint,
  IsoTimestamp,
  LeagueIngestionRun,
  ProviderRevision,
  ProviderEventMapping,
  SportKey,
  UpcomingEventIngestionCommand,
  UnresolvedEventMapping,
} from "@find-the-edge/domain";
import { createHash } from "node:crypto";
const MAX_CONTINUATION_LEASE_MS = 5 * 60 * 1000;
export interface EventIngestionInput {
  readonly providerId: string;
  readonly providerEventId: string;
  readonly sportKey: SportKey;
  readonly leagueKey: string;
  readonly normalizedIdentity: string;
  readonly startsAt: IsoTimestamp;
  readonly status: EventStatus;
  readonly participantLabels?: readonly string[];
  readonly revision: ProviderRevision;
  readonly observedAt: IsoTimestamp;
  readonly mappingKind?: "source" | "alias";
  readonly reconciliationFence?: ReconciliationFence;
  readonly providerEventFence?: {
    readonly checkpointKey: string;
    readonly pagePosition: IngestionCheckpoint["position"];
    readonly windowEnd: IsoTimestamp;
  };
}
export interface ReconciliationFence {
  readonly pk: string;
  readonly token: string;
}
export type EventIngestionOutcome =
  | { readonly kind: "updated" | "skipped"; readonly eventId: string }
  | {
      readonly kind: "unresolved";
      readonly reason: "no-candidate" | "ambiguous-candidates";
    };
export const NEAR_CANONICAL_START_TOLERANCE_SECONDS = 120;
export type NearCanonicalLookup = Pick<
  EventIngestionInput,
  "sportKey" | "leagueKey" | "startsAt" | "status" | "participantLabels"
>;
export interface ScheduledEventReconciliationInput {
  readonly event: EventIngestionInput;
  readonly bootstrap: CanonicalEventBootstrap;
}
export interface EventIngestionStore {
  resolveExactCanonicalBinding(
    input: Pick<
      EventIngestionInput,
      "providerId" | "providerEventId" | "sportKey" | "leagueKey"
    >,
  ): Promise<CanonicalEvent | null>;
  getExactMapping(
    input: Pick<
      EventIngestionInput,
      "providerId" | "providerEventId" | "sportKey" | "leagueKey"
    >,
  ): Promise<{
    readonly canonicalEventId: string;
    readonly bindingKind: "source" | "alias";
  } | null>;
  getCanonicalByIdentity(
    sportKey: SportKey,
    leagueKey: string,
    identity: string,
  ): Promise<"missing" | "present" | "ambiguous">;
  findNearCanonicalCandidates(
    input: NearCanonicalLookup,
  ): Promise<readonly CanonicalEvent[]>;
  reconcileScheduledEvent(
    input: ScheduledEventReconciliationInput,
  ): Promise<EventIngestionOutcome>;
  recordReconciliationAmbiguity(
    input: EventIngestionInput,
    candidateEventIds: readonly string[],
  ): Promise<void>;
  bootstrapCanonicalEvent(
    input: CanonicalEventBootstrap,
    observedAt: IsoTimestamp,
    reconciliationFence?: ReconciliationFence,
  ): Promise<"created" | "existing" | "repaired">;
  recordBootstrapPageMarkers(
    checkpointKey: string,
    pagePosition: IngestionCheckpoint["position"],
    events: readonly {
      readonly id: string;
      readonly normalizedIdentity: string;
    }[],
    windowEnd: IsoTimestamp,
  ): Promise<"recorded" | "same-position">;
  putBootstrapResponse(
    reservationId: string,
    response: unknown,
    windowEnd: IsoTimestamp,
  ): Promise<void>;
  getBootstrapResponse(reservationId: string): Promise<unknown>;
  registerCandidate(
    event: CanonicalEvent,
  ): Promise<"registered" | "already-registered">;
  getProviderEventFence(
    checkpointKey: string,
    providerEventId: string,
    pagePosition: IngestionCheckpoint["position"],
  ): Promise<"missing" | "same-page" | "duplicate">;
  getProviderEventFences(
    checkpointKey: string,
    providerEventIds: readonly string[],
    pagePosition: IngestionCheckpoint["position"],
  ): Promise<readonly ("missing" | "same-page" | "duplicate")[]>;
  recordProviderPageFingerprint(
    checkpointKey: string,
    pagePosition: IngestionCheckpoint["position"],
    pageFingerprint: string,
    windowEnd: IsoTimestamp,
    observedAt: IsoTimestamp,
  ): Promise<void>;
  ingestEvent(input: EventIngestionInput): Promise<EventIngestionOutcome>;
  getCheckpoint(key: string): Promise<IngestionCheckpoint | null>;
  hasCursorDigest(
    checkpointKey: string,
    cursorDigest: string,
  ): Promise<boolean>;
  compareAndSetCheckpoint(
    expected: IngestionCheckpoint | null,
    next: IngestionCheckpoint,
  ): Promise<boolean>;
  commitCheckpoint(
    expected: IngestionCheckpoint | null,
    next: IngestionCheckpoint,
    run: LeagueIngestionRun,
    continuation?: UpcomingEventIngestionCommand,
    consumedPredecessor?: {
      readonly outbox: ContinuationOutbox;
      readonly activeCommand: UpcomingEventIngestionCommand;
      readonly deliveredAt: IsoTimestamp;
    },
  ): Promise<boolean>;
  claimPendingContinuation(
    claimantId: string,
    claimedAt: IsoTimestamp,
    leaseUntil: IsoTimestamp,
    checkpointKey: string,
  ): Promise<ContinuationOutbox | null>;
  hasUndeliveredContinuation(checkpointKey: string): Promise<boolean>;
  markContinuationDelivered(
    id: string,
    checkpointKey: string,
    cycle: number,
    epoch: number,
    claimantId: string,
    deliveredAt: IsoTimestamp,
  ): Promise<void>;
  putRun(run: LeagueIngestionRun): Promise<void>;
}

const sameCandidateSnapshot = (left: CanonicalEvent, right: CanonicalEvent) =>
  left.id === right.id &&
  left.version === right.version &&
  left.startsAt === right.startsAt &&
  left.status === right.status &&
  left.candidateIdentity === right.candidateIdentity &&
  JSON.stringify(left.participantLabels) ===
    JSON.stringify(right.participantLabels);

/** Called only while the store owns the matchup reconciliation lease. */
export async function reconcileScheduledEventUnderLease(
  store: EventIngestionStore,
  input: ScheduledEventReconciliationInput,
  reconciliationFence?: ReconciliationFence,
): Promise<EventIngestionOutcome> {
  const { event, bootstrap } = input;
  if (
    event.status !== "scheduled" ||
    bootstrap.status !== "scheduled" ||
    event.sportKey !== bootstrap.sportKey ||
    event.leagueKey !== bootstrap.leagueKey ||
    event.startsAt !== bootstrap.startsAt ||
    event.normalizedIdentity !== bootstrap.normalizedIdentity ||
    JSON.stringify(event.participantLabels) !==
      JSON.stringify(bootstrap.participantLabels)
  )
    throw new Error("invalid-scheduled-reconciliation");

  const exactMapping = await store.getExactMapping(event);
  const exact = exactMapping
    ? await store.resolveExactCanonicalBinding(event)
    : null;
  if (exactMapping && exact) {
    // The canonical source may legitimately correct its own schedule. A raw
    // alias may not move the winning canonical schedule on replay.
    if (exactMapping.bindingKind === "source")
      return store.ingestEvent({
        ...event,
        mappingKind: "source",
        ...(reconciliationFence ? { reconciliationFence } : {}),
      });
    if (!exact.participantLabels)
      throw new Error("mapped-canonical-participants-missing");
    return store.ingestEvent({
      ...event,
      startsAt: exact.startsAt,
      status: exact.status,
      participantLabels: exact.participantLabels,
      normalizedIdentity: exact.candidateIdentity,
      mappingKind: "alias",
      ...(reconciliationFence ? { reconciliationFence } : {}),
    });
  }

  const exactIdentity = await store.ingestEvent({
    ...event,
    mappingKind: "alias",
    ...(reconciliationFence ? { reconciliationFence } : {}),
  });
  if (
    exactIdentity.kind !== "unresolved" ||
    exactIdentity.reason !== "no-candidate"
  )
    return exactIdentity;

  const candidates = await store.findNearCanonicalCandidates(event);
  if (candidates.length > 1) {
    await store.recordReconciliationAmbiguity(
      {
        ...event,
        ...(reconciliationFence ? { reconciliationFence } : {}),
      },
      candidates.map(({ id }) => id),
    );
    return { kind: "unresolved", reason: "ambiguous-candidates" };
  }
  const candidate = candidates[0];
  if (candidate) {
    const revalidated = await store.findNearCanonicalCandidates(event);
    if (
      revalidated.length !== 1 ||
      !sameCandidateSnapshot(candidate, revalidated[0]!)
    ) {
      const ids = [
        ...new Set([candidate.id, ...revalidated.map(({ id }) => id)]),
      ];
      if (ids.length > 1)
        await store.recordReconciliationAmbiguity(
          {
            ...event,
            ...(reconciliationFence ? { reconciliationFence } : {}),
          },
          ids,
        );
      return { kind: "unresolved", reason: "ambiguous-candidates" };
    }
    if (!candidate.participantLabels)
      throw new Error("near-canonical-participants-missing");
    return store.ingestEvent({
      ...event,
      startsAt: candidate.startsAt,
      status: candidate.status,
      participantLabels: candidate.participantLabels,
      normalizedIdentity: candidate.candidateIdentity,
      mappingKind: "alias",
      ...(reconciliationFence ? { reconciliationFence } : {}),
    });
  }

  await store.bootstrapCanonicalEvent(
    bootstrap,
    event.observedAt,
    reconciliationFence,
  );
  return store.ingestEvent({
    ...event,
    mappingKind: "source",
    ...(reconciliationFence ? { reconciliationFence } : {}),
  });
}

export const reconciliationScope = (input: NearCanonicalLookup) => {
  if (!input.participantLabels || input.participantLabels.length < 2)
    throw new Error("reconciliation-participants-required");
  const normalize = (value: string) =>
    value.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ");
  return stableDigest(
    JSON.stringify([
      input.sportKey,
      normalize(input.leagueKey),
      input.participantLabels.map(normalize),
    ]),
  );
};
export interface ContinuationOutbox {
  readonly id: string;
  readonly checkpointKey: string;
  readonly providerId: string;
  readonly predecessorRunId: string;
  readonly command: UpcomingEventIngestionCommand;
  readonly cycle: number;
  readonly epoch: number;
  readonly state: "intent" | "claimed" | "delivered";
  readonly claimantId?: string;
  readonly claimedAt?: IsoTimestamp;
  readonly leaseUntil?: IsoTimestamp;
  readonly deliveredAt?: IsoTimestamp;
  readonly version: number;
}
export const canonicalContinuationCommand = (
  command: UpcomingEventIngestionCommand,
) =>
  JSON.stringify([
    command.attemptId,
    command.checkpointScope,
    command.sportKey,
    command.leagueKey,
    command.windowStart,
    command.windowEnd,
    command.pageLimit,
    command.maxPages,
    command.expectedContinuation
      ? [
          command.expectedContinuation.cycle,
          command.expectedContinuation.epoch,
          command.expectedContinuation.position.state,
          command.expectedContinuation.position.state === "cursor"
            ? command.expectedContinuation.position.cursor
            : null,
        ]
      : null,
  ]);
export const continuationOutboxId = (
  checkpoint: IngestionCheckpoint,
  command: UpcomingEventIngestionCommand,
) =>
  stableDigest(
    JSON.stringify([
      checkpoint.key,
      checkpoint.continuationCycle,
      checkpoint.continuationCount,
      checkpoint.position,
      canonicalContinuationCommand(command),
      checkpoint.lastRunId,
    ]),
  );
export function validateCheckpointCommitLineage(
  next: IngestionCheckpoint,
  run: LeagueIngestionRun,
  continuation?: UpcomingEventIngestionCommand,
): void {
  if (
    run.id !== next.lastRunId ||
    run.providerId !== next.providerId ||
    run.sportKey !== next.sportKey ||
    run.leagueKey !== next.leagueKey ||
    JSON.stringify(run.finalPosition) !== JSON.stringify(next.position)
  )
    throw new Error("invalid-checkpoint-run-lineage");
  const cursorCommit = next.position.state === "cursor";
  if (
    (cursorCommit &&
      !["continuation-queued", "delivery-required"].includes(run.status)) ||
    (!cursorCommit && run.status !== "succeeded") ||
    (cursorCommit && run.checkpointKey !== next.key) ||
    (!cursorCommit &&
      Object.prototype.hasOwnProperty.call(run, "checkpointKey"))
  )
    throw new Error("invalid-checkpoint-run-status");
  if (!continuation) {
    if (cursorCommit) throw new Error("missing-continuation-command");
    return;
  }
  if (!cursorCommit) throw new Error("unexpected-continuation-command");
  const expected = continuation.expectedContinuation;
  if (
    run.checkpointKey !== next.key ||
    expected?.position.state !== "cursor" ||
    expected.cycle !== next.continuationCycle ||
    expected.epoch !== next.continuationCount ||
    JSON.stringify(expected.position) !== JSON.stringify(next.position) ||
    continuation.checkpointScope !== next.checkpointScope ||
    continuation.sportKey !== next.sportKey ||
    continuation.leagueKey !== next.leagueKey ||
    continuation.windowStart !== next.windowStart ||
    continuation.windowEnd !== next.windowEnd ||
    continuation.attemptId !==
      stableDigest(
        JSON.stringify([
          run.id,
          next.key,
          next.continuationCycle,
          next.continuationCount,
          expected.position.cursor,
        ]),
      )
  )
    throw new Error("invalid-continuation-lineage");
}
export function validateConsumedPredecessor(
  expected: IngestionCheckpoint | null,
  next: IngestionCheckpoint,
  run: LeagueIngestionRun,
  consumed: NonNullable<Parameters<EventIngestionStore["commitCheckpoint"]>[4]>,
  successor?: UpcomingEventIngestionCommand,
): void {
  const { outbox, activeCommand, deliveredAt } = consumed;
  const continuation = outbox.command.expectedContinuation;
  if (
    !expected ||
    outbox.state !== "claimed" ||
    !outbox.claimantId ||
    !outbox.claimedAt ||
    !outbox.leaseUntil ||
    outbox.checkpointKey !== expected.key ||
    outbox.checkpointKey !== next.key ||
    outbox.providerId !== expected.providerId ||
    outbox.predecessorRunId !== expected.lastRunId ||
    outbox.claimantId !== expected.lastRunId ||
    outbox.id !== continuationOutboxId(expected, outbox.command) ||
    canonicalContinuationCommand(outbox.command) !==
      canonicalContinuationCommand(activeCommand) ||
    outbox.cycle !== expected.continuationCycle ||
    outbox.epoch !== expected.continuationCount ||
    continuation?.cycle !== expected.continuationCycle ||
    continuation.epoch !== expected.continuationCount ||
    JSON.stringify(continuation.position) !==
      JSON.stringify(expected.position) ||
    outbox.command.attemptId !== run.attemptId ||
    outbox.command.checkpointScope !== next.checkpointScope ||
    outbox.command.sportKey !== next.sportKey ||
    outbox.command.leagueKey !== next.leagueKey ||
    outbox.command.windowStart !== next.windowStart ||
    outbox.command.windowEnd !== next.windowEnd ||
    Date.parse(deliveredAt) < Date.parse(outbox.claimedAt)
  )
    throw new Error("invalid-consumed-predecessor");
  if (
    next.position.state === "cursor" &&
    (!successor ||
      successor.checkpointScope !== activeCommand.checkpointScope ||
      successor.sportKey !== activeCommand.sportKey ||
      successor.leagueKey !== activeCommand.leagueKey ||
      successor.windowStart !== activeCommand.windowStart ||
      successor.windowEnd !== activeCommand.windowEnd ||
      successor.pageLimit !== activeCommand.pageLimit ||
      successor.maxPages !== Math.max(1, activeCommand.maxPages - 1))
  )
    throw new Error("invalid-successor-budget-lineage");
}
export function validateCursorTransition(
  expected: IngestionCheckpoint | null,
  next: IngestionCheckpoint,
): void {
  if (next.cursorHistory === undefined && next.cursorChain === undefined)
    return;
  const previousHistory =
    expected?.cursorHistory ??
    (expected?.position.state === "cursor"
      ? [stableDigest(expected.position.cursor)]
      : []);
  const previousChain =
    expected?.cursorChain ?? cursorChainDigest(next.key, previousHistory);
  if (next.position.state === "cursor") {
    const digest = stableDigest(next.position.cursor);
    if (
      next.cursorHistory?.at(-1) !== digest ||
      next.cursorChain !== stableDigest(JSON.stringify([previousChain, digest]))
    )
      throw new Error("invalid-cursor-transition");
  } else if (
    expected &&
    (JSON.stringify(next.cursorHistory ?? []) !==
      JSON.stringify(expected.cursorHistory ?? []) ||
      next.cursorChain !== expected.cursorChain)
  )
    throw new Error("invalid-cursor-transition");
}
export function validateContinuationLease(
  claimantId: string,
  claimedAt: IsoTimestamp,
  leaseUntil: IsoTimestamp,
): void {
  if (
    !claimantId ||
    claimantId.length > 256 ||
    claimantId !== claimantId.trim() ||
    !Number.isFinite(Date.parse(claimedAt)) ||
    new Date(claimedAt).toISOString() !== claimedAt ||
    !Number.isFinite(Date.parse(leaseUntil)) ||
    new Date(leaseUntil).toISOString() !== leaseUntil ||
    Date.parse(leaseUntil) <= Date.parse(claimedAt) ||
    Date.parse(leaseUntil) - Date.parse(claimedAt) > MAX_CONTINUATION_LEASE_MS
  )
    throw new Error("invalid-continuation-lease");
}
export function validateContinuationOutbox(value: unknown): ContinuationOutbox {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("invalid-continuation-outbox");
  const item = value as Record<string, unknown>;
  const allowed = new Set([
    "id",
    "checkpointKey",
    "providerId",
    "predecessorRunId",
    "command",
    "cycle",
    "epoch",
    "state",
    "claimantId",
    "claimedAt",
    "leaseUntil",
    "deliveredAt",
    "version",
  ]);
  const command = item["command"] as Record<string, unknown> | undefined;
  const expected = command?.["expectedContinuation"] as
    Record<string, unknown> | undefined;
  const position = expected?.["position"] as
    Record<string, unknown> | undefined;
  const canonicalInstant = (instant: unknown) =>
    typeof instant === "string" &&
    Number.isFinite(Date.parse(instant)) &&
    new Date(instant).toISOString() === instant;
  if (
    !Object.keys(item).every((key) => allowed.has(key)) ||
    typeof item["id"] !== "string" ||
    !/^[a-f0-9]{64}$/.test(item["id"]) ||
    typeof item["checkpointKey"] !== "string" ||
    !/^[a-f0-9]{64}$/.test(item["checkpointKey"]) ||
    typeof item["providerId"] !== "string" ||
    !item["providerId"] ||
    item["providerId"].length > 256 ||
    item["providerId"] !== item["providerId"].trim() ||
    typeof item["predecessorRunId"] !== "string" ||
    !/^[a-f0-9]{64}$/.test(item["predecessorRunId"]) ||
    !command ||
    Object.keys(command).length !== 9 ||
    !Object.keys(command).every((key) =>
      [
        "attemptId",
        "checkpointScope",
        "sportKey",
        "leagueKey",
        "windowStart",
        "windowEnd",
        "pageLimit",
        "maxPages",
        "expectedContinuation",
      ].includes(key),
    ) ||
    !["attemptId", "checkpointScope", "sportKey", "leagueKey"].every(
      (key) =>
        typeof command[key] === "string" &&
        !!command[key] &&
        command[key].length <= 256 &&
        command[key] === command[key].trim(),
    ) ||
    !canonicalInstant(command["windowStart"]) ||
    !canonicalInstant(command["windowEnd"]) ||
    Date.parse(command["windowStart"] as string) >=
      Date.parse(command["windowEnd"] as string) ||
    Date.parse(command["windowEnd"] as string) -
      Date.parse(command["windowStart"] as string) >
      31 * 86_400_000 ||
    !/^[a-z0-9][a-z0-9-]{0,63}$/.test(command["sportKey"] as string) ||
    !/^[a-z0-9][a-z0-9-]{0,63}$/.test(command["leagueKey"] as string) ||
    !Number.isSafeInteger(command["pageLimit"]) ||
    (command["pageLimit"] as number) < 1 ||
    (command["pageLimit"] as number) > 100 ||
    !Number.isSafeInteger(command["maxPages"]) ||
    (command["maxPages"] as number) < 1 ||
    (command["maxPages"] as number) > 20 ||
    !expected ||
    Object.keys(expected).length !== 3 ||
    expected["cycle"] !== item["cycle"] ||
    expected["epoch"] !== item["epoch"] ||
    !/^[a-f0-9]{64}$/.test(command["attemptId"] as string) ||
    !position ||
    Object.keys(position).length !== 2 ||
    position["state"] !== "cursor" ||
    typeof position["cursor"] !== "string" ||
    !position["cursor"] ||
    position["cursor"].length > 1024 ||
    !Number.isSafeInteger(item["cycle"]) ||
    (item["cycle"] as number) < 0 ||
    !Number.isSafeInteger(item["epoch"]) ||
    (item["epoch"] as number) < 1 ||
    !["intent", "claimed", "delivered"].includes(item["state"] as string) ||
    !Number.isSafeInteger(item["version"]) ||
    (item["version"] as number) < 1 ||
    (item["version"] as number) > Number.MAX_SAFE_INTEGER ||
    ((item["state"] === "claimed" || item["state"] === "delivered") &&
      (typeof item["claimantId"] !== "string" ||
        !item["claimantId"] ||
        item["claimantId"].length > 256 ||
        item["claimantId"] !== item["claimantId"].trim() ||
        !canonicalInstant(item["claimedAt"]) ||
        !canonicalInstant(item["leaseUntil"]) ||
        Date.parse(item["leaseUntil"] as string) <=
          Date.parse(item["claimedAt"] as string) ||
        Date.parse(item["leaseUntil"] as string) -
          Date.parse(item["claimedAt"] as string) >
          MAX_CONTINUATION_LEASE_MS)) ||
    (item["state"] === "delivered" &&
      (!canonicalInstant(item["deliveredAt"]) ||
        Date.parse(item["deliveredAt"] as string) <
          Date.parse(item["claimedAt"] as string))) ||
    (item["state"] === "intent" &&
      ["claimantId", "claimedAt", "leaseUntil", "deliveredAt"].some((key) =>
        Object.prototype.hasOwnProperty.call(item, key),
      )) ||
    (item["state"] === "claimed" &&
      Object.prototype.hasOwnProperty.call(item, "deliveredAt")) ||
    (item["id"] !==
      stableDigest(
        JSON.stringify([
          item["checkpointKey"],
          item["cycle"],
          item["epoch"],
          position,
          canonicalContinuationCommand(
            command as unknown as UpcomingEventIngestionCommand,
          ),
          item["predecessorRunId"],
        ]),
      ) &&
      item["id"] !==
        stableDigest(
          JSON.stringify([
            item["checkpointKey"],
            item["cycle"],
            item["epoch"],
            position,
            command["attemptId"],
            item["predecessorRunId"],
          ]),
        )) ||
    command["attemptId"] !==
      stableDigest(
        JSON.stringify([
          item["predecessorRunId"],
          item["checkpointKey"],
          item["cycle"],
          item["epoch"],
          position["cursor"],
        ]),
      ) ||
    item["checkpointKey"] !==
      checkpointKey({
        providerId: item["providerId"],
        sportKey: command["sportKey"] as SportKey,
        leagueKey: command["leagueKey"] as string,
        checkpointScope: command["checkpointScope"] as string,
        windowStart: command["windowStart"] as IsoTimestamp,
        windowEnd: command["windowEnd"] as IsoTimestamp,
      })
  )
    throw new Error("invalid-continuation-outbox");
  return value as ContinuationOutbox;
}
export function validateProviderEventMapping(
  value: unknown,
): ProviderEventMapping {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("invalid-provider-event-mapping");
  const item = value as Record<string, unknown>;
  if (
    ![7, 8].includes(Object.keys(item).length) ||
    !Object.keys(item).every((key) =>
      [
        "id",
        "providerId",
        "providerEventId",
        "canonicalEventId",
        "sportKey",
        "leagueKey",
        "createdAt",
        "bindingKind",
      ].includes(key),
    ) ||
    (item["bindingKind"] !== undefined &&
      !["source", "alias"].includes(item["bindingKind"] as string)) ||
    typeof item["id"] !== "string" ||
    !/^[a-f0-9]{64}$/.test(item["id"]) ||
    ![
      "providerId",
      "providerEventId",
      "canonicalEventId",
      "sportKey",
      "leagueKey",
    ].every(
      (key) =>
        typeof item[key] === "string" &&
        !!item[key] &&
        item[key].length <= 512 &&
        item[key] === item[key].trim(),
    ) ||
    typeof item["createdAt"] !== "string" ||
    !Number.isFinite(Date.parse(item["createdAt"])) ||
    new Date(item["createdAt"]).toISOString() !== item["createdAt"] ||
    item["id"] !==
      mappingId({
        providerId: item["providerId"] as string,
        providerEventId: item["providerEventId"] as string,
        sportKey: item["sportKey"] as SportKey,
        leagueKey: item["leagueKey"] as string,
      })
  )
    throw new Error("invalid-provider-event-mapping");
  return {
    ...(value as Omit<ProviderEventMapping, "bindingKind">),
    bindingKind:
      (item["bindingKind"] as
        ProviderEventMapping["bindingKind"] | undefined) ?? "source",
  };
}
export function validateProviderRevision(value: unknown): ProviderRevision {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("invalid-provider-revision");
  const item = value as Record<string, unknown>;
  if (
    Object.keys(item).length !== 5 ||
    !Object.keys(item).every((key) =>
      [
        "providerId",
        "authorityRank",
        "updatedAt",
        "sequence",
        "token",
      ].includes(key),
    ) ||
    typeof item["providerId"] !== "string" ||
    !item["providerId"] ||
    item["providerId"].length > 256 ||
    item["providerId"] !== item["providerId"].trim() ||
    !Number.isSafeInteger(item["authorityRank"]) ||
    (item["authorityRank"] as number) < 0 ||
    (item["authorityRank"] as number) > 1_000 ||
    typeof item["updatedAt"] !== "string" ||
    !Number.isFinite(Date.parse(item["updatedAt"])) ||
    new Date(item["updatedAt"]).toISOString() !== item["updatedAt"] ||
    !Number.isSafeInteger(item["sequence"]) ||
    (item["sequence"] as number) < 0 ||
    typeof item["token"] !== "string" ||
    !item["token"] ||
    item["token"].length > 512 ||
    item["token"] !== item["token"].trim()
  )
    throw new Error("invalid-provider-revision");
  return value as ProviderRevision;
}
export function validateCanonicalEvent(value: unknown): CanonicalEvent {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("invalid-canonical-event");
  const item = value as Record<string, unknown>;
  const allowed = new Set([
    "id",
    "sportKey",
    "leagueKey",
    "leagueId",
    "participantIds",
    "participantLabels",
    "startsAt",
    "phase",
    "evidence",
    "status",
    "revisions",
    "updatedAt",
    "candidateIdentity",
    "authoritativeRevision",
    "bootstrapRevision",
    "version",
  ]);
  const required = [
    "id",
    "sportKey",
    "leagueKey",
    "leagueId",
    "participantIds",
    "startsAt",
    "phase",
    "evidence",
    "status",
    "revisions",
    "updatedAt",
    "candidateIdentity",
    "version",
  ];
  if (
    !Object.keys(item).every((key) => allowed.has(key)) ||
    !required.every((key) => Object.prototype.hasOwnProperty.call(item, key)) ||
    ![
      "id",
      "sportKey",
      "leagueKey",
      "leagueId",
      "phase",
      "candidateIdentity",
    ].every(
      (key) =>
        typeof item[key] === "string" &&
        !!item[key] &&
        item[key].length <= 512 &&
        item[key] === item[key].trim(),
    ) ||
    !Array.isArray(item["participantIds"]) ||
    item["participantIds"].length < 2 ||
    item["participantIds"].length > 16 ||
    !item["participantIds"].every(
      (id) =>
        typeof id === "string" && !!id && id.length <= 512 && id === id.trim(),
    ) ||
    new Set(item["participantIds"]).size !== item["participantIds"].length ||
    (item["participantLabels"] !== undefined &&
      (!Array.isArray(item["participantLabels"]) ||
        item["participantLabels"].length !== item["participantIds"].length ||
        !item["participantLabels"].every(
          (label) =>
            typeof label === "string" &&
            label === label.trim() &&
            label.length > 0 &&
            label.length <= 120,
        ))) ||
    !Array.isArray(item["evidence"]) ||
    item["evidence"].length > 50 ||
    !item["evidence"].every((raw) => {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
      const evidence = raw as Record<string, unknown>;
      return (
        Object.keys(evidence).length === 4 &&
        ["sourceId", "observedAt", "retrievedAt", "verification"].every((key) =>
          Object.prototype.hasOwnProperty.call(evidence, key),
        ) &&
        typeof evidence["sourceId"] === "string" &&
        !!evidence["sourceId"] &&
        evidence["sourceId"].length <= 256 &&
        evidence["sourceId"] === evidence["sourceId"].trim() &&
        ["observedAt", "retrievedAt"].every(
          (key) =>
            typeof evidence[key] === "string" &&
            Number.isFinite(Date.parse(evidence[key])) &&
            new Date(evidence[key]).toISOString() === evidence[key],
        ) &&
        Date.parse(evidence["observedAt"] as string) <=
          Date.parse(evidence["retrievedAt"] as string) &&
        [
          "verified",
          "unavailable",
          "inferred",
          "stale",
          "conflicting",
        ].includes(evidence["verification"] as string)
      );
    }) ||
    typeof item["startsAt"] !== "string" ||
    new Date(item["startsAt"]).toISOString() !== item["startsAt"] ||
    typeof item["updatedAt"] !== "string" ||
    new Date(item["updatedAt"]).toISOString() !== item["updatedAt"] ||
    !Number.isSafeInteger(item["version"]) ||
    (item["version"] as number) < 1 ||
    ![
      "scheduled",
      "postponed",
      "cancelled",
      "started",
      "completed",
      "unknown",
    ].includes(item["status"] as string) ||
    !item["revisions"] ||
    typeof item["revisions"] !== "object" ||
    Array.isArray(item["revisions"])
  )
    throw new Error("invalid-canonical-event");
  if (Object.keys(item["revisions"]).length > 64)
    throw new Error("invalid-canonical-event");
  Object.entries(item["revisions"] as Record<string, unknown>).forEach(
    ([providerId, revision]) => {
      if (validateProviderRevision(revision).providerId !== providerId)
        throw new Error("invalid-canonical-event");
    },
  );
  if (item["authoritativeRevision"]) {
    const authoritative = validateProviderRevision(
      item["authoritativeRevision"],
    );
    if (
      JSON.stringify(
        (item["revisions"] as Record<string, unknown>)[
          authoritative.providerId
        ],
      ) !== JSON.stringify(authoritative) &&
      JSON.stringify(item["bootstrapRevision"]) !==
        JSON.stringify(authoritative)
    )
      throw new Error("invalid-canonical-event");
  }
  if (item["bootstrapRevision"])
    validateProviderRevision(item["bootstrapRevision"]);
  const authorityWinner = maxAuthority(
    item["bootstrapRevision"] as ProviderRevision | undefined,
    ...Object.values(item["revisions"] as Record<string, ProviderRevision>),
  );
  if (
    !authorityWinner ||
    JSON.stringify(item["authoritativeRevision"]) !==
      JSON.stringify(authorityWinner)
  )
    throw new Error("invalid-canonical-event");
  return value as CanonicalEvent;
}
export function validateUnresolvedEventMapping(
  value: unknown,
): UnresolvedEventMapping {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("invalid-unresolved-event");
  const item = value as Record<string, unknown>;
  const keys = [
    "id",
    "providerId",
    "providerEventId",
    "sportKey",
    "leagueKey",
    "normalizedIdentity",
    "reason",
    "candidateEventIds",
    "observations",
    "version",
  ];
  if (
    Object.keys(item).length !== keys.length ||
    !Object.keys(item).every((key) => keys.includes(key)) ||
    !keys
      .slice(0, 6)
      .every(
        (key) =>
          typeof item[key] === "string" &&
          !!item[key] &&
          item[key].length <= 512 &&
          item[key] === item[key].trim(),
      ) ||
    item["id"] !==
      stableDigest(
        JSON.stringify([
          mappingId({
            providerId: item["providerId"] as string,
            providerEventId: item["providerEventId"] as string,
            sportKey: item["sportKey"] as SportKey,
            leagueKey: item["leagueKey"] as string,
          }),
          item["normalizedIdentity"],
        ]),
      ) ||
    !["no-candidate", "ambiguous-candidates"].includes(
      item["reason"] as string,
    ) ||
    !Array.isArray(item["candidateEventIds"]) ||
    item["candidateEventIds"].length > 2 ||
    !item["candidateEventIds"].every(
      (id) =>
        typeof id === "string" && !!id && id.length <= 512 && id === id.trim(),
    ) ||
    new Set(item["candidateEventIds"]).size !==
      item["candidateEventIds"].length ||
    (item["reason"] === "no-candidate"
      ? item["candidateEventIds"].length !== 0
      : item["candidateEventIds"].length < 2) ||
    !Array.isArray(item["observations"]) ||
    item["observations"].length === 0 ||
    item["observations"].length > 20 ||
    !item["observations"].every((raw) => {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
      const observation = raw as Record<string, unknown>;
      return (
        Object.keys(observation).length === 3 &&
        typeof observation["observedAt"] === "string" &&
        Number.isFinite(Date.parse(observation["observedAt"])) &&
        new Date(observation["observedAt"]).toISOString() ===
          observation["observedAt"] &&
        ["no-candidate", "ambiguous-candidates"].includes(
          observation["reason"] as string,
        ) &&
        Array.isArray(observation["candidateEventIds"]) &&
        observation["candidateEventIds"].length <= 2 &&
        observation["candidateEventIds"].every(
          (id) =>
            typeof id === "string" &&
            !!id &&
            id.length <= 512 &&
            id === id.trim(),
        ) &&
        new Set(observation["candidateEventIds"]).size ===
          observation["candidateEventIds"].length &&
        (observation["reason"] === "no-candidate"
          ? observation["candidateEventIds"].length === 0
          : observation["candidateEventIds"].length >= 2)
      );
    }) ||
    !Number.isSafeInteger(item["version"]) ||
    (item["version"] as number) < 1 ||
    (item["version"] as number) > Number.MAX_SAFE_INTEGER
  )
    throw new Error("invalid-unresolved-event");
  const latest = item["observations"][item["observations"].length - 1] as {
    reason: unknown;
    candidateEventIds: unknown;
  };
  if (
    latest.reason !== item["reason"] ||
    JSON.stringify(latest.candidateEventIds) !==
      JSON.stringify(item["candidateEventIds"])
  )
    throw new Error("invalid-unresolved-event");
  return value as UnresolvedEventMapping;
}
export interface IdentityClaim {
  readonly candidateEventIds:
    readonly [] | readonly [EntityId] | readonly [EntityId, EntityId];
  readonly sportKey: SportKey;
  readonly leagueKey: string;
  readonly normalizedIdentity: string;
  readonly conflictCount: number;
  readonly overflow: boolean;
  readonly version: number;
}
export function validateIdentityClaim(
  value: unknown,
  sportKey: SportKey,
  leagueKey: string,
  normalizedIdentity: string,
): IdentityClaim {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("invalid-identity-claim");
  const item = value as Record<string, unknown>;
  if (
    Object.keys(item).length !== 7 ||
    !Object.keys(item).every((key) =>
      [
        "candidateEventIds",
        "sportKey",
        "leagueKey",
        "normalizedIdentity",
        "conflictCount",
        "overflow",
        "version",
      ].includes(key),
    ) ||
    !Array.isArray(item["candidateEventIds"]) ||
    item["candidateEventIds"].length > 2 ||
    new Set(item["candidateEventIds"]).size !==
      item["candidateEventIds"].length ||
    !item["candidateEventIds"].every(
      (id, index, ids) =>
        typeof id === "string" &&
        id.length > 0 &&
        id.length <= 512 &&
        id === id.trim() &&
        (index === 0 ||
          (typeof ids[index - 1] === "string" && ids[index - 1] <= id)),
    ) ||
    item["sportKey"] !== sportKey ||
    item["leagueKey"] !== leagueKey ||
    item["normalizedIdentity"] !== normalizedIdentity ||
    !Number.isSafeInteger(item["conflictCount"]) ||
    (item["conflictCount"] as number) < item["candidateEventIds"].length ||
    (item["overflow"] !== true && item["overflow"] !== false) ||
    (item["overflow"] === false &&
      item["conflictCount"] !== item["candidateEventIds"].length) ||
    (item["overflow"] === true &&
      (item["candidateEventIds"].length !== 2 ||
        (item["conflictCount"] as number) < 3)) ||
    !Number.isSafeInteger(item["version"]) ||
    (item["version"] as number) < 1
  )
    throw new Error("invalid-identity-claim");
  return value as IdentityClaim;
}
export const mappingId = (
  input: Pick<
    EventIngestionInput,
    "providerId" | "sportKey" | "leagueKey" | "providerEventId"
  >,
) =>
  stableDigest(
    JSON.stringify([
      input.providerId,
      input.sportKey,
      input.leagueKey,
      input.providerEventId,
    ]),
  );
export const identityKey = (
  sportKey: SportKey,
  leagueKey: string,
  identity: string,
) => stableDigest(JSON.stringify([sportKey, leagueKey, identity]));
export interface ProviderEventFence {
  readonly id: string;
  readonly checkpointKey: string;
  readonly pagePositionDigest: string;
  readonly version: 1;
}
export const providerEventFenceId = (
  checkpointKey: string,
  providerEventId: string,
) => stableDigest(JSON.stringify([checkpointKey, providerEventId]));
export const providerEventPagePositionDigest = (
  pagePosition: IngestionCheckpoint["position"],
) => stableDigest(JSON.stringify(pagePosition));
export const bootstrapMarkerId = (
  checkpointKey: string,
  kind: "id" | "identity",
  value: string,
) => stableDigest(JSON.stringify([checkpointKey, "bootstrap", kind, value]));
export function validateProviderEventFence(
  value: unknown,
  expectedCheckpointKey: string,
  expectedId: string,
): ProviderEventFence {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("invalid-provider-event-fence");
  const item = value as Record<string, unknown>;
  if (
    Object.keys(item).length !== 4 ||
    !["id", "checkpointKey", "pagePositionDigest", "version"].every((key) =>
      Object.prototype.hasOwnProperty.call(item, key),
    ) ||
    item["id"] !== expectedId ||
    item["checkpointKey"] !== expectedCheckpointKey ||
    !/^[a-f0-9]{64}$/.test(item["id"]) ||
    !/^[a-f0-9]{64}$/.test(item["checkpointKey"]) ||
    !/^[a-f0-9]{64}$/.test(item["pagePositionDigest"] as string) ||
    item["version"] !== 1
  )
    throw new Error("invalid-provider-event-fence");
  return value as ProviderEventFence;
}
export const continuationPendingSortKey = (
  cycle: number,
  epoch: number,
  id: string,
): string => {
  if (
    !Number.isSafeInteger(cycle) ||
    cycle < 0 ||
    !Number.isSafeInteger(epoch) ||
    epoch < 1 ||
    !/^[a-f0-9]{64}$/.test(id)
  )
    throw new Error("invalid-continuation-storage-key");
  return `${cycle.toString().padStart(16, "0")}#${epoch
    .toString()
    .padStart(16, "0")}#${id}`;
};
export function nextIdentityVersion(version: number): number {
  if (!Number.isSafeInteger(version) || version < 0)
    throw new Error("invalid-identity-version");
  if (version === Number.MAX_SAFE_INTEGER)
    throw new Error("identity-version-exhausted");
  return version + 1;
}
export function nextBoundedVersion(version: number): number {
  if (!Number.isSafeInteger(version) || version < 1)
    throw new Error("invalid-version");
  if (version === Number.MAX_SAFE_INTEGER) throw new Error("version-exhausted");
  return version + 1;
}
export function stableDigest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
export function cursorChainDigest(
  checkpointKey: string,
  history: readonly string[],
): string {
  return history.reduce(
    (chain, cursorDigest) =>
      stableDigest(JSON.stringify([chain, cursorDigest])),
    stableDigest(JSON.stringify(["cursor-chain", checkpointKey])),
  );
}
function validBootstrapReservation(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  const allowed = [
    "id",
    "status",
    "cursor",
    "pageOrdinal",
    "identities",
    "authorityRank",
    "requestDigest",
    "claimedAt",
    "leaseUntil",
    "responseRef",
    "responseDigest",
    "providerRequests",
    "quotaUsed",
  ];
  const succeeded = item["status"] === "succeeded";
  return (
    Object.keys(item).every((key) => allowed.includes(key)) &&
    typeof item["id"] === "string" &&
    /^[a-f0-9]{64}$/.test(item["id"]) &&
    ["reserved", "succeeded", "failed"].includes(item["status"] as string) &&
    (item["cursor"] === undefined ||
      (typeof item["cursor"] === "string" &&
        !!item["cursor"] &&
        item["cursor"].length <= 1024)) &&
    Number.isSafeInteger(item["pageOrdinal"]) &&
    (item["pageOrdinal"] as number) >= 0 &&
    Array.isArray(item["identities"]) &&
    item["identities"].length > 0 &&
    item["identities"].length <= 100 &&
    new Set(item["identities"]).size === item["identities"].length &&
    item["identities"].every(
      (identity: unknown) =>
        typeof identity === "string" &&
        identity.length > 0 &&
        identity.length <= 512 &&
        identity === identity.trim(),
    ) &&
    Number.isSafeInteger(item["authorityRank"]) &&
    (item["authorityRank"] as number) >= 0 &&
    typeof item["requestDigest"] === "string" &&
    /^[a-f0-9]{64}$/.test(item["requestDigest"]) &&
    (item["status"] === "reserved"
      ? typeof item["claimedAt"] === "string" &&
        typeof item["leaseUntil"] === "string" &&
        Number.isFinite(Date.parse(item["claimedAt"])) &&
        Number.isFinite(Date.parse(item["leaseUntil"])) &&
        new Date(item["claimedAt"]).toISOString() === item["claimedAt"] &&
        new Date(item["leaseUntil"]).toISOString() === item["leaseUntil"] &&
        Date.parse(item["leaseUntil"]) > Date.parse(item["claimedAt"]) &&
        Date.parse(item["leaseUntil"]) - Date.parse(item["claimedAt"]) <=
          300_000
      : item["claimedAt"] === undefined && item["leaseUntil"] === undefined) &&
    (succeeded
      ? ["responseRef", "responseDigest"].every(
          (key) =>
            typeof item[key] === "string" && /^[a-f0-9]{64}$/.test(item[key]),
        ) &&
        item["providerRequests"] === 1 &&
        Number.isSafeInteger(item["quotaUsed"]) &&
        (item["quotaUsed"] as number) >= 0 &&
        (item["quotaUsed"] as number) <= 2_000
      : item["status"] === "failed"
        ? item["responseRef"] === undefined &&
          item["responseDigest"] === undefined &&
          (item["providerRequests"] === undefined ||
            item["providerRequests"] === 1) &&
          (item["quotaUsed"] === undefined ||
            (Number.isSafeInteger(item["quotaUsed"]) &&
              (item["quotaUsed"] as number) >= 0 &&
              (item["quotaUsed"] as number) <= 2_000))
        : [
            "responseRef",
            "responseDigest",
            "providerRequests",
            "quotaUsed",
          ].every((key) => item[key] === undefined))
  );
}
export function validateCheckpoint(
  value: unknown,
  expectedKey: string,
): IngestionCheckpoint {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("invalid-checkpoint");
  const item = value as Record<string, unknown>;
  const keys = [
    "key",
    "providerId",
    "sportKey",
    "leagueKey",
    "checkpointScope",
    "windowStart",
    "windowEnd",
    "position",
    "continuationCycle",
    "continuationCount",
    "bootstrapRequestCount",
    "bootstrapQuotaUsed",
    "bootstrapReservation",
    "bootstrapCursor",
    "bootstrapPageOrdinal",
    "bootstrapCursorHistory",
    "bootstrapCursorChain",
    "bootstrapCompletedPositionDigest",
    "cursorHistory",
    "cursorChain",
    "lastRunId",
    "updatedAt",
  ];
  const position = item["position"] as Record<string, unknown> | undefined;
  if (
    !Object.keys(item).every((key) => keys.includes(key)) ||
    [
      "key",
      "providerId",
      "sportKey",
      "leagueKey",
      "checkpointScope",
      "windowStart",
      "windowEnd",
      "position",
      "continuationCycle",
      "continuationCount",
      "bootstrapRequestCount",
      "lastRunId",
      "updatedAt",
    ].some((key) => !Object.prototype.hasOwnProperty.call(item, key)) ||
    !/^[a-f0-9]{64}$/.test(expectedKey) ||
    item["key"] !== expectedKey ||
    !["providerId", "sportKey", "leagueKey", "checkpointScope"].every(
      (key) =>
        typeof item[key] === "string" &&
        item[key].length > 0 &&
        item[key].length <= 256 &&
        item[key] === item[key].trim(),
    ) ||
    typeof item["lastRunId"] !== "string" ||
    !/^[a-f0-9]{64}$/.test(item["lastRunId"]) ||
    !["windowStart", "windowEnd", "updatedAt"].every(
      (key) =>
        typeof item[key] === "string" &&
        Number.isFinite(Date.parse(item[key])) &&
        new Date(item[key]).toISOString() === item[key],
    ) ||
    Date.parse(item["windowStart"] as string) >=
      Date.parse(item["windowEnd"] as string) ||
    Date.parse(item["windowEnd"] as string) -
      Date.parse(item["windowStart"] as string) >
      31 * 86_400_000 ||
    !/^[a-z0-9][a-z0-9-]{0,63}$/.test(item["sportKey"] as string) ||
    !/^[a-z0-9][a-z0-9-]{0,63}$/.test(item["leagueKey"] as string) ||
    stableDigest(
      JSON.stringify([
        item["providerId"],
        item["sportKey"],
        item["leagueKey"],
        item["checkpointScope"],
        item["windowStart"],
        item["windowEnd"],
      ]),
    ) !== expectedKey ||
    !position ||
    (position["state"] === "cursor"
      ? Object.keys(position).length !== 2
      : Object.keys(position).length !== 1) ||
    (position["state"] !== "start" &&
      position["state"] !== "terminal" &&
      (position["state"] !== "cursor" ||
        typeof position["cursor"] !== "string" ||
        !position["cursor"] ||
        position["cursor"].length > 1024)) ||
    !Number.isSafeInteger(item["continuationCycle"]) ||
    (item["continuationCycle"] as number) < 0 ||
    !Number.isSafeInteger(item["continuationCount"]) ||
    (item["continuationCount"] as number) < 0 ||
    !Number.isSafeInteger(item["bootstrapRequestCount"]) ||
    (item["bootstrapRequestCount"] as number) < 0 ||
    (item["bootstrapRequestCount"] as number) > 2_000 ||
    (item["bootstrapQuotaUsed"] !== undefined &&
      (!Number.isSafeInteger(item["bootstrapQuotaUsed"]) ||
        (item["bootstrapQuotaUsed"] as number) < 0 ||
        (item["bootstrapQuotaUsed"] as number) > 2_000)) ||
    (item["bootstrapReservation"] !== undefined &&
      !validBootstrapReservation(item["bootstrapReservation"])) ||
    (item["bootstrapReservation"] !== undefined &&
      ((item["bootstrapReservation"] as Record<string, unknown>)["cursor"] !==
        item["bootstrapCursor"] ||
        (item["bootstrapReservation"] as Record<string, unknown>)[
          "pageOrdinal"
        ] !== (item["bootstrapPageOrdinal"] ?? 0))) ||
    (item["bootstrapCursor"] !== undefined &&
      (typeof item["bootstrapCursor"] !== "string" ||
        !item["bootstrapCursor"] ||
        item["bootstrapCursor"].length > 1024)) ||
    (item["bootstrapPageOrdinal"] !== undefined &&
      (!Number.isSafeInteger(item["bootstrapPageOrdinal"]) ||
        (item["bootstrapPageOrdinal"] as number) < 0 ||
        (item["bootstrapPageOrdinal"] as number) > 100)) ||
    (item["bootstrapCursorHistory"] === undefined) !==
      (item["bootstrapCursorChain"] === undefined) ||
    (item["bootstrapCursorHistory"] !== undefined &&
      (!Array.isArray(item["bootstrapCursorHistory"]) ||
        item["bootstrapCursorHistory"].length > 100 ||
        new Set(item["bootstrapCursorHistory"]).size !==
          item["bootstrapCursorHistory"].length ||
        !item["bootstrapCursorHistory"].every(
          (digest: unknown) =>
            typeof digest === "string" && /^[a-f0-9]{64}$/.test(digest),
        ) ||
        typeof item["bootstrapCursorChain"] !== "string" ||
        !/^[a-f0-9]{64}$/.test(item["bootstrapCursorChain"]) ||
        item["bootstrapCursorChain"] !==
          (item["bootstrapCursorHistory"] as string[]).reduce(
            (chain, digest) => stableDigest(JSON.stringify([chain, digest])),
            stableDigest(
              JSON.stringify(["bootstrap-cursor-chain", expectedKey]),
            ),
          ) ||
        (item["bootstrapCursor"] !== undefined &&
          item["bootstrapCursorHistory"].at(-1) !==
            stableDigest(item["bootstrapCursor"])))) ||
    (item["bootstrapCompletedPositionDigest"] !== undefined &&
      item["bootstrapCompletedPositionDigest"] !==
        stableDigest(JSON.stringify(position))) ||
    (item["bootstrapReservation"] !== undefined &&
      (item["bootstrapReservation"] as Record<string, unknown>)["status"] ===
        "succeeded" &&
      (item["bootstrapReservation"] as Record<string, unknown>)["quotaUsed"] !==
        undefined &&
      ((item["bootstrapReservation"] as Record<string, unknown>)[
        "quotaUsed"
      ] as number) > (item["bootstrapQuotaUsed"] as number)) ||
    (item["cursorHistory"] === undefined) !==
      (item["cursorChain"] === undefined) ||
    (item["cursorHistory"] !== undefined &&
      (!Array.isArray(item["cursorHistory"]) ||
        item["cursorHistory"].length > 32 ||
        !item["cursorHistory"].every(
          (digest: unknown) =>
            typeof digest === "string" && /^[a-f0-9]{64}$/.test(digest),
        ) ||
        new Set(item["cursorHistory"]).size !== item["cursorHistory"].length ||
        typeof item["cursorChain"] !== "string" ||
        !/^[a-f0-9]{64}$/.test(item["cursorChain"]) ||
        (position?.["state"] === "start" &&
          item["cursorHistory"].length !== 0) ||
        (position?.["state"] === "cursor" &&
          item["cursorHistory"].at(-1) !==
            stableDigest(position["cursor"] as string))))
  )
    throw new Error("invalid-checkpoint");
  const reservation = item["bootstrapReservation"] as
    Record<string, unknown> | undefined;
  if (reservation) {
    const expectedReservationId = stableDigest(
      JSON.stringify([
        expectedKey,
        position,
        reservation["cursor"] ?? null,
        reservation["pageOrdinal"],
        reservation["identities"],
      ]),
    );
    const expectedRequestDigest = stableDigest(
      JSON.stringify([
        item["sportKey"],
        item["leagueKey"],
        item["windowStart"],
        item["windowEnd"],
        50,
        reservation["identities"],
        item["providerId"],
        reservation["authorityRank"],
        reservation["cursor"] ?? null,
      ]),
    );
    if (
      reservation["id"] !== expectedReservationId ||
      reservation["requestDigest"] !== expectedRequestDigest ||
      (item["bootstrapRequestCount"] as number) < 1 ||
      item["bootstrapQuotaUsed"] === undefined
    )
      throw new Error("invalid-checkpoint");
  }
  return value as IngestionCheckpoint;
}
export const checkpointKey = (input: {
  providerId: string;
  sportKey: SportKey;
  leagueKey: string;
  checkpointScope: string;
  windowStart: IsoTimestamp;
  windowEnd: IsoTimestamp;
}) =>
  stableDigest(
    JSON.stringify([
      input.providerId,
      input.sportKey,
      input.leagueKey,
      input.checkpointScope,
      input.windowStart,
      input.windowEnd,
    ]),
  );
export function compareRevision(
  left: ProviderRevision,
  right?: ProviderRevision,
): number {
  if (!right) return 1;
  const time = Date.parse(left.updatedAt) - Date.parse(right.updatedAt);
  if (time) return time < 0 ? -1 : 1;
  if (left.sequence !== right.sequence)
    return left.sequence < right.sequence ? -1 : 1;
  return left.token < right.token ? -1 : left.token > right.token ? 1 : 0;
}
export const equalProviderRevision = (
  left: ProviderRevision,
  right?: ProviderRevision,
): boolean =>
  !!right &&
  left.providerId === right.providerId &&
  left.authorityRank === right.authorityRank &&
  left.updatedAt === right.updatedAt &&
  left.sequence === right.sequence &&
  left.token === right.token;
export function compareAuthority(
  left: ProviderRevision,
  right?: ProviderRevision,
): number {
  if (!right) return 1;
  if (left.providerId === right.providerId) return compareRevision(left, right);
  if (left.authorityRank !== right.authorityRank)
    return left.authorityRank < right.authorityRank ? -1 : 1;
  const freshness = Date.parse(left.updatedAt) - Date.parse(right.updatedAt);
  if (freshness !== 0) return freshness < 0 ? -1 : 1;
  return left.providerId < right.providerId
    ? -1
    : left.providerId > right.providerId
      ? 1
      : 0;
}
export function maxAuthority(
  ...revisions: readonly (ProviderRevision | undefined)[]
): ProviderRevision | undefined {
  return revisions.reduce<ProviderRevision | undefined>(
    (winner, revision) =>
      revision && (!winner || compareAuthority(revision, winner) > 0)
        ? revision
        : winner,
    undefined,
  );
}
export function repairAuthorityPointer(event: CanonicalEvent): CanonicalEvent {
  const winner = maxAuthority(
    event.bootstrapRevision,
    ...Object.values(event.revisions),
  );
  if (!winner) throw new Error("invalid-canonical-event");
  return { ...event, authoritativeRevision: winner };
}
