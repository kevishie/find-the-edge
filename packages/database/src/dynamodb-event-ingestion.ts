import type {
  CanonicalEvent,
  CanonicalEventBootstrap,
  EntityId,
  EventHistoryEntry,
  IngestionCheckpoint,
  IsoTimestamp,
  LeagueIngestionRun,
  ProviderRevision,
  ProviderEventMapping,
  SportKey,
  UnresolvedEventMapping,
} from "@find-the-edge/domain";
import { randomUUID } from "node:crypto";
import {
  bootstrapMarkerId,
  canonicalContinuationCommand,
  compareAuthority,
  compareRevision,
  equalProviderRevision,
  EventDataConflict,
  continuationPendingSortKey,
  continuationOutboxId,
  identityKey,
  mappingId,
  maxAuthority,
  repairAuthorityPointer,
  reconciliationScope,
  reconcileScheduledEventUnderLease,
  NEAR_CANONICAL_START_TOLERANCE_SECONDS,
  nextIdentityVersion,
  nextBoundedVersion,
  providerEventFenceId,
  providerEventPagePositionDigest,
  participantIdentityMatches,
  stableDigest,
  validateCheckpoint,
  validateCanonicalEvent,
  validateContinuationOutbox,
  validateContinuationLease,
  validateCheckpointCommitLineage,
  validateConsumedPredecessor,
  validateCursorTransition,
  validateProviderEventMapping,
  validateProviderEventFence,
  validateProviderRevision,
  validateIdentityClaim,
  validateUnresolvedEventMapping,
  type EventIngestionInput,
  type EventIngestionOutcome,
  type EventIngestionStore,
  type ContinuationOutbox,
  type ProviderEventFence,
} from "./event-ingestion";
import {
  closeProjection,
  easternDay,
  leaguePartition,
  projectionItems,
  validateProjection,
  type EventDetailPointer,
} from "./event-read-projection";

const waitForIdentityRetry = (attempt: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, Math.min(8, 2 ** attempt));
  });
const canonicalStorageValue = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(canonicalStorageValue)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.entries(value as Record<string, unknown>)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, nested]) => [key, canonicalStorageValue(nested)]),
        )
      : value;
const storageDigest = (value: unknown) =>
  stableDigest(JSON.stringify(canonicalStorageValue(value)));
export interface DynamoItem {
  readonly pk: string;
  readonly sk: string;
  readonly value: unknown;
  readonly expiresAt?: number;
}
export type DynamoWrite =
  | { readonly kind: "insert"; readonly item: DynamoItem }
  | {
      readonly kind: "put-projection";
      readonly item: DynamoItem;
      readonly expectedValue?: unknown;
      readonly requireAbsent?: boolean;
    }
  | {
      readonly kind: "claim-identity";
      readonly item: DynamoItem;
      readonly eventId: string;
    }
  | {
      readonly kind: "replace";
      readonly item: DynamoItem;
      readonly expectedVersion: number;
    }
  | {
      readonly kind: "check-event";
      readonly pk: string;
      readonly sk: string;
      readonly expectedVersion: number;
      readonly expectedIdentity: string;
      readonly expectedSnapshot?: CanonicalEvent;
    }
  | {
      readonly kind: "check-identity";
      readonly pk: string;
      readonly sk: string;
      readonly expectedVersion: number;
      readonly expectedCandidateEventIds: readonly string[];
    }
  | {
      readonly kind: "put-provider-event-fence";
      readonly item: DynamoItem;
      readonly expectedPagePositionDigest: string;
    }
  | {
      readonly kind: "put-bootstrap-marker";
      readonly item: DynamoItem;
      readonly expectedPagePositionDigest: string;
    }
  | {
      readonly kind: "check-identity-absent";
      readonly pk: string;
      readonly sk: string;
    }
  | {
      readonly kind: "check-reconciliation-lock";
      readonly pk: string;
      readonly sk: "CURRENT";
      readonly expectedToken: string;
      readonly leaseAfter: IsoTimestamp;
    }
  | {
      readonly kind: "renew-reconciliation-lock";
      readonly item: DynamoItem;
      readonly expectedToken: string;
      readonly leaseAfter: string;
    }
  | {
      readonly kind: "delete";
      readonly pk: string;
      readonly sk: string;
      readonly expectedVersion?: number;
      readonly expectedEventId?: string;
      readonly expectedLeaseUntil?: string;
    };
export class DynamoConditionalConflict extends Error {
  constructor() {
    super("dynamo-conditional-conflict");
    this.name = "DynamoConditionalConflict";
  }
}
export class DynamoTransactionConflict extends Error {
  constructor() {
    super("dynamo-transaction-conflict");
    this.name = "DynamoTransactionConflict";
  }
}
class IdentitySnapshotRetry extends Error {}
const reconciliationStorageFailure = (
  phase: "acquisition" | "execution" | "renewal" | "cleanup",
  error: unknown,
) => {
  const storageClass =
    error instanceof Error
      ? new Map([
          ["ValidationException", "storage-validation"],
          ["ResourceNotFoundException", "storage-resource-missing"],
          ["AccessDeniedException", "storage-access-denied"],
          ["TransactionCanceledException", "storage-transaction-cancelled"],
          ["InternalServerError", "storage-unavailable"],
          ["ServiceUnavailable", "storage-unavailable"],
        ]).get(error.name)
      : undefined;
  return new Error(
    `event-reconciliation-${phase}-${storageClass ?? "failed"}`,
    { cause: error },
  );
};
export interface DynamoGateway {
  get(pk: string, sk: string): Promise<DynamoItem | null>;
  batchGet(
    keys: readonly { readonly pk: string; readonly sk: string }[],
  ): Promise<readonly DynamoItem[]>;
  queryUpTo(pk: string, limit: number): Promise<readonly DynamoItem[]>;
  queryPage(
    pk: string,
    startSk: string | undefined,
    limit: number,
  ): Promise<{
    readonly items: readonly DynamoItem[];
    readonly lastEvaluatedSk?: string;
  }>;
  transactGet(
    keys: readonly { readonly pk: string; readonly sk: string }[],
  ): Promise<readonly (DynamoItem | null)[]>;
  queryAll(pk: string): Promise<readonly DynamoItem[]>;
  insert(item: DynamoItem): Promise<"inserted" | "exists">;
  transact(writes: readonly DynamoWrite[]): Promise<void>;
  compareAndSetCheckpoint(
    pk: string,
    expected: IngestionCheckpoint | null,
    next: IngestionCheckpoint,
  ): Promise<boolean>;
  transactCheckpoint(
    pk: string,
    expected: IngestionCheckpoint | null,
    next: IngestionCheckpoint,
    writes: readonly DynamoWrite[],
  ): Promise<boolean>;
  put(item: DynamoItem): Promise<void>;
}
const eventKey = (id: string) => `EVENT#${id}`;
const identityOwnerPk = (sport: string, league: string, identity: string) =>
  `IDENTITY_OWNER#${identityKey(sport as never, league, identity)}`;
const validatePersistedProviderRevision = (
  value: unknown,
  expectedProviderId: string,
): ProviderRevision & {
  readonly version: number;
  readonly materialFingerprint?: string;
} => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("invalid-provider-revision-row");
  const item = value as Record<string, unknown>;
  if (
    (Object.keys(item).length !== 6 && Object.keys(item).length !== 7) ||
    ![
      "providerId",
      "authorityRank",
      "updatedAt",
      "sequence",
      "token",
      "version",
      ...(Object.prototype.hasOwnProperty.call(item, "materialFingerprint")
        ? ["materialFingerprint"]
        : []),
    ].every((key) => Object.prototype.hasOwnProperty.call(item, key)) ||
    !Number.isSafeInteger(item["version"]) ||
    (item["version"] as number) < 1 ||
    (item["version"] as number) > Number.MAX_SAFE_INTEGER
  )
    throw new Error("invalid-provider-revision-row");
  const revision = validateProviderRevision({
    providerId: item["providerId"],
    authorityRank: item["authorityRank"],
    updatedAt: item["updatedAt"],
    sequence: item["sequence"],
    token: item["token"],
  });
  if (revision.providerId !== expectedProviderId)
    throw new Error("provider-revision-scope-mismatch");
  if (
    item["materialFingerprint"] !== undefined &&
    (typeof item["materialFingerprint"] !== "string" ||
      !/^[a-f0-9]{64}$/.test(item["materialFingerprint"]))
  )
    throw new Error("invalid-provider-revision-row");
  return value as ProviderRevision & { readonly version: number };
};
export class DynamoEventIngestionStore implements EventIngestionStore {
  private readonly reconciliationOperations = new Map<string, Promise<void>>();
  private readonly reconciliationLeases = new Map<
    string,
    { readonly pk: string; readonly leaseMs: number; leaseUntil: number }
  >();
  constructor(
    readonly gateway: DynamoGateway,
    readonly reconciliationOptions: {
      readonly clock?: () => Date;
      readonly leaseMs?: number;
      readonly heartbeatMs?: number;
    } = {},
  ) {
    const leaseMs = reconciliationOptions.leaseMs ?? 10_000;
    const heartbeatMs =
      reconciliationOptions.heartbeatMs ?? Math.max(10, leaseMs / 3);
    if (
      !Number.isFinite(leaseMs) ||
      leaseMs <= 0 ||
      !Number.isFinite(heartbeatMs) ||
      heartbeatMs <= 0 ||
      heartbeatMs >= leaseMs
    )
      throw new Error("invalid-reconciliation-lease-options");
  }
  private reconciliationNow() {
    return this.reconciliationOptions.clock?.() ?? new Date();
  }
  private async withReconciliationOperation<T>(
    token: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const prior = this.reconciliationOperations.get(token) ?? Promise.resolve();
    let release!: () => void;
    const slot = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = prior.then(() => slot);
    this.reconciliationOperations.set(token, tail);
    await prior;
    try {
      return await operation();
    } finally {
      release();
      if (this.reconciliationOperations.get(token) === tail)
        this.reconciliationOperations.delete(token);
    }
  }
  private reconciliationFenceWrite(
    fence: EventIngestionInput["reconciliationFence"],
  ): Extract<DynamoWrite, { kind: "check-reconciliation-lock" }> | undefined {
    return fence
      ? {
          kind: "check-reconciliation-lock",
          pk: fence.pk,
          sk: "CURRENT",
          expectedToken: fence.token,
          leaseAfter: this.reconciliationNow().toISOString() as IsoTimestamp,
        }
      : undefined;
  }
  private async transactReconciled(
    fence: EventIngestionInput["reconciliationFence"],
    writes: readonly DynamoWrite[],
  ) {
    if (!fence) return this.gateway.transact(writes);
    return this.withReconciliationOperation(fence.token, async () => {
      const lease = this.reconciliationLeases.get(fence.token);
      if (!lease || lease.pk !== fence.pk)
        throw new Error("event-reconciliation-ownership-lost");
      let now = this.reconciliationNow().getTime();
      if (now >= lease.leaseUntil)
        throw new Error("event-reconciliation-ownership-lost");
      if (lease.leaseUntil - now <= lease.leaseMs / 2) {
        let renewed = false;
        for (let attempt = 0; attempt < 6; attempt += 1) {
          now = this.reconciliationNow().getTime();
          const priorLeaseUntil = lease.leaseUntil;
          if (now >= priorLeaseUntil)
            throw new Error("event-reconciliation-ownership-lost");
          const nextLeaseUntil = now + lease.leaseMs;
          try {
            await this.gateway.transact([
              {
                kind: "renew-reconciliation-lock",
                item: {
                  pk: fence.pk,
                  sk: "CURRENT",
                  value: {
                    eventId: fence.token,
                    leaseUntil: new Date(nextLeaseUntil).toISOString(),
                    version: 1,
                  },
                  expiresAt: Math.ceil(nextLeaseUntil / 1_000),
                },
                expectedToken: fence.token,
                leaseAfter: new Date(now).toISOString(),
              },
            ]);
            if (this.reconciliationNow().getTime() >= priorLeaseUntil)
              throw new Error("event-reconciliation-ownership-lost");
            lease.leaseUntil = nextLeaseUntil;
            renewed = true;
            break;
          } catch (error) {
            if (error instanceof DynamoConditionalConflict)
              throw new Error("event-reconciliation-ownership-lost");
            if (!(error instanceof DynamoTransactionConflict) || attempt >= 5)
              throw error;
            const delayMs = 5 * 2 ** attempt;
            if (this.reconciliationNow().getTime() + delayMs >= priorLeaseUntil)
              throw new Error("event-reconciliation-ownership-lost");
            await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
          }
        }
        if (!renewed) throw new Error("event-reconciliation-ownership-lost");
      }
      for (let attempt = 0; attempt < 6; attempt += 1)
        try {
          await this.gateway.transact([
            // The token check is the commit-time fence: either these writes
            // commit before a replacement lock, or the whole transaction is
            // rejected. Transaction contention is safe to retry because the
            // attempted write is atomic and remains fenced by this token.
            this.reconciliationFenceWrite(fence)!,
            ...writes,
          ]);
          return;
        } catch (error) {
          if (!(error instanceof DynamoTransactionConflict) || attempt >= 5)
            throw error;
          const delayMs = 5 * 2 ** attempt;
          if (this.reconciliationNow().getTime() + delayMs >= lease.leaseUntil)
            throw new Error("event-reconciliation-ownership-lost");
          await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
        }
    });
  }
  async getProviderEventFence(
    checkpointKey: string,
    providerEventId: string,
    pagePosition: IngestionCheckpoint["position"],
  ) {
    const id = providerEventFenceId(checkpointKey, providerEventId);
    const item = await this.gateway.get(
      `PROVIDER_EVENT_FENCE#${checkpointKey}`,
      id,
    );
    if (!item) return "missing" as const;
    const fence = validateProviderEventFence(item.value, checkpointKey, id);
    return fence.pagePositionDigest ===
      providerEventPagePositionDigest(pagePosition)
      ? ("same-page" as const)
      : ("duplicate" as const);
  }
  async getProviderEventFences(
    checkpointKey: string,
    providerEventIds: readonly string[],
    pagePosition: IngestionCheckpoint["position"],
  ) {
    const ids = providerEventIds.map((providerEventId) =>
      providerEventFenceId(checkpointKey, providerEventId),
    );
    const items = await this.gateway.batchGet(
      ids.map((id) => ({
        pk: `PROVIDER_EVENT_FENCE#${checkpointKey}`,
        sk: id,
      })),
    );
    const byId = new Map(items.map((item) => [item.sk, item]));
    const expectedDigest = providerEventPagePositionDigest(pagePosition);
    return ids.map((id) => {
      const item = byId.get(id);
      if (!item) return "missing" as const;
      const fence = validateProviderEventFence(item.value, checkpointKey, id);
      return fence.pagePositionDigest === expectedDigest
        ? ("same-page" as const)
        : ("duplicate" as const);
    });
  }
  async recordProviderPageFingerprint(
    checkpointKey: string,
    pagePosition: IngestionCheckpoint["position"],
    pageFingerprint: string,
    windowEnd: IsoTimestamp,
    observedAt: IsoTimestamp,
  ) {
    if (!/^[a-f0-9]{64}$/.test(pageFingerprint))
      throw new Error("invalid-provider-page-fingerprint");
    const positionDigest = providerEventPagePositionDigest(pagePosition);
    try {
      await this.gateway.transact([
        {
          kind: "put-bootstrap-marker",
          item: {
            pk: `PROVIDER_PAGE#${checkpointKey}`,
            sk: positionDigest,
            value: {
              checkpointKey,
              positionDigest,
              pagePositionDigest: pageFingerprint,
            },
            expiresAt:
              Math.floor(
                Math.max(Date.parse(windowEnd), Date.parse(observedAt)) / 1000,
              ) + 31_536_000,
          },
          expectedPagePositionDigest: pageFingerprint,
        },
      ]);
    } catch (error) {
      if (error instanceof DynamoConditionalConflict)
        throw new Error("provider-page-replay-conflict");
      throw error;
    }
  }
  async hasCursorDigest(checkpointKey: string, cursorDigest: string) {
    if (!/^[a-f0-9]{64}$/.test(cursorDigest))
      throw new Error("invalid-cursor-digest");
    const item = await this.gateway.get(
      `CURSOR_MARKER#${checkpointKey}`,
      cursorDigest,
    );
    if (!item) return false;
    if (
      item.pk !== `CURSOR_MARKER#${checkpointKey}` ||
      item.sk !== cursorDigest ||
      JSON.stringify(item.value) !==
        JSON.stringify({ checkpointKey, cursorDigest })
    )
      throw new Error("invalid-cursor-marker");
    return true;
  }
  private providerEventFenceWrite(
    input: EventIngestionInput,
  ): Extract<DynamoWrite, { kind: "put-provider-event-fence" }> | undefined {
    const context = input.providerEventFence;
    if (!context) return undefined;
    const id = providerEventFenceId(
      context.checkpointKey,
      input.providerEventId,
    );
    const pk = `PROVIDER_EVENT_FENCE#${context.checkpointKey}`;
    const pagePositionDigest = providerEventPagePositionDigest(
      context.pagePosition,
    );
    const value: ProviderEventFence = {
      id,
      checkpointKey: context.checkpointKey,
      pagePositionDigest,
      version: 1,
    };
    return {
      kind: "put-provider-event-fence",
      item: {
        pk,
        sk: id,
        value,
        expiresAt:
          Math.floor(
            Math.max(
              Date.parse(context.windowEnd),
              Date.parse(input.observedAt),
            ) / 1000,
          ) + 31_536_000,
      },
      expectedPagePositionDigest: pagePositionDigest,
    };
  }
  private async transactIngestion(
    input: EventIngestionInput,
    writes: readonly DynamoWrite[],
  ): Promise<void> {
    const fence = this.providerEventFenceWrite(input);
    try {
      await this.transactReconciled(input.reconciliationFence, [
        ...(fence ? [fence] : []),
        ...writes,
      ]);
    } catch (error) {
      if (!(error instanceof DynamoConditionalConflict) || !fence) throw error;
      const persisted = await this.gateway.get(fence.item.pk, fence.item.sk);
      if (persisted) {
        const context = input.providerEventFence!;
        const validated = validateProviderEventFence(
          persisted.value,
          context.checkpointKey,
          fence.item.sk,
        );
        if (validated.pagePositionDigest !== fence.expectedPagePositionDigest)
          throw new Error("duplicate-provider-event");
      }
      throw error;
    }
  }
  private async resolveIdentity(
    sportKey: SportKey,
    leagueKey: string,
    identity: string,
  ): Promise<{
    readonly state: "missing" | "present" | "ambiguous";
    readonly candidateIds: readonly EntityId[];
    readonly claimVersion?: number;
    readonly physicallyMissing?: boolean;
  }> {
    for (let attempt = 0; attempt < 4; attempt++) {
      const ownerItem = await this.gateway.get(
        identityOwnerPk(sportKey, leagueKey, identity),
        "CURRENT",
      );
      if (!ownerItem) {
        const confirmedMissing = await this.gateway.get(
          identityOwnerPk(sportKey, leagueKey, identity),
          "CURRENT",
        );
        if (!confirmedMissing)
          return {
            state: "missing",
            candidateIds: [],
            physicallyMissing: true,
          };
        await waitForIdentityRetry(attempt);
        continue;
      }
      const owner = validateIdentityClaim(
        ownerItem.value,
        sportKey,
        leagueKey,
        identity,
      );
      const candidateEventIds = [...owner.candidateEventIds].sort();
      const canonicalSnapshots = new Map<EntityId, CanonicalEvent>();
      for (const eventId of candidateEventIds) {
        const event = await this.gateway.get(eventKey(eventId), "CURRENT");
        if (!event) throw new Error("dangling-identity-aggregate");
        const canonical = validateCanonicalEvent(event.value);
        if (
          canonical.id !== eventId ||
          canonical.sportKey !== sportKey ||
          canonical.leagueKey !== leagueKey ||
          canonical.candidateIdentity !== identity
        )
          throw new Error("stale-identity-aggregate");
        canonicalSnapshots.set(eventId, canonical);
      }
      const confirmed = await this.gateway.get(
        identityOwnerPk(sportKey, leagueKey, identity),
        "CURRENT",
      );
      const confirmedOwner = confirmed
        ? validateIdentityClaim(confirmed.value, sportKey, leagueKey, identity)
        : undefined;
      if (
        confirmedOwner?.version === owner.version &&
        JSON.stringify(confirmedOwner.candidateEventIds) ===
          JSON.stringify(owner.candidateEventIds) &&
        confirmedOwner.conflictCount === owner.conflictCount &&
        confirmedOwner.overflow === owner.overflow
      ) {
        let canonicalStable = true;
        for (const eventId of candidateEventIds) {
          const confirmedEvent = await this.gateway.get(
            eventKey(eventId),
            "CURRENT",
          );
          if (!confirmedEvent) {
            canonicalStable = false;
            break;
          }
          const confirmedCanonical = validateCanonicalEvent(
            confirmedEvent.value,
          );
          if (
            confirmedCanonical.id !== eventId ||
            confirmedCanonical.sportKey !== sportKey ||
            confirmedCanonical.leagueKey !== leagueKey ||
            confirmedCanonical.candidateIdentity !== identity
          )
            throw new Error("stale-identity-aggregate");
          const snapshot = canonicalSnapshots.get(eventId);
          if (
            !snapshot ||
            confirmedCanonical.id !== snapshot.id ||
            confirmedCanonical.sportKey !== snapshot.sportKey ||
            confirmedCanonical.leagueKey !== snapshot.leagueKey ||
            confirmedCanonical.candidateIdentity !==
              snapshot.candidateIdentity ||
            confirmedCanonical.version !== snapshot.version
          ) {
            canonicalStable = false;
            break;
          }
        }
        if (!canonicalStable) {
          await waitForIdentityRetry(attempt);
          continue;
        }
        return {
          state:
            owner.overflow || candidateEventIds.length === 2
              ? "ambiguous"
              : candidateEventIds.length === 0
                ? "missing"
                : "present",
          candidateIds: candidateEventIds,
          claimVersion: owner.version,
          physicallyMissing: false,
        };
      }
      await waitForIdentityRetry(attempt);
    }
    throw new Error("identity-snapshot-unstable");
  }
  async getExactMapping(
    input: Pick<
      EventIngestionInput,
      "providerId" | "providerEventId" | "sportKey" | "leagueKey"
    >,
  ) {
    const item = await this.gateway.get(
      `MAPPING#${mappingId(input)}`,
      "CURRENT",
    );
    if (!item) return null;
    const mapping = validateProviderEventMapping(item.value);
    if (
      mapping.sportKey !== input.sportKey ||
      mapping.leagueKey !== input.leagueKey ||
      mapping.providerId !== input.providerId ||
      mapping.providerEventId !== input.providerEventId
    )
      throw new Error("mapping-scope-mismatch");
    const canonicalItem = await this.gateway.get(
      eventKey(mapping.canonicalEventId),
      "CURRENT",
    );
    if (!canonicalItem) throw new Error("mapping-canonical-missing");
    const canonical = validateCanonicalEvent(canonicalItem.value);
    if (
      canonical.id !== mapping.canonicalEventId ||
      canonical.sportKey !== input.sportKey ||
      canonical.leagueKey !== input.leagueKey
    )
      throw new Error("mapping-canonical-scope-mismatch");
    return {
      canonicalEventId: mapping.canonicalEventId,
      bindingKind: mapping.bindingKind,
    };
  }
  async resolveExactCanonicalBinding(
    input: Pick<
      EventIngestionInput,
      "providerId" | "providerEventId" | "sportKey" | "leagueKey"
    >,
  ) {
    const mapping = await this.getExactMapping(input);
    if (!mapping) return null;
    const item = await this.gateway.get(
      eventKey(mapping.canonicalEventId),
      "CURRENT",
    );
    if (!item) throw new Error("mapping-canonical-missing");
    const event = validateCanonicalEvent(item.value);
    if (
      event.id !== mapping.canonicalEventId ||
      event.sportKey !== input.sportKey ||
      event.leagueKey !== input.leagueKey
    )
      throw new Error("mapping-canonical-scope-mismatch");
    return event;
  }
  async findNearCanonicalCandidates(
    input: Parameters<EventIngestionStore["findNearCanonicalCandidates"]>[0],
  ) {
    if (input.status !== "scheduled" || !input.participantLabels) return [];
    const normalize = (value: string) =>
      value.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ");
    const expected = input.participantLabels.map(normalize);
    const target = Date.parse(input.startsAt);
    const toleranceMs = NEAR_CANONICAL_START_TOLERANCE_SECONDS * 1_000;
    const days = new Set(
      [-toleranceMs, 0, toleranceMs].map((offset) =>
        easternDay(new Date(target + offset).toISOString()),
      ),
    );
    const rows = (
      await Promise.all(
        [...days].map((day) =>
          this.gateway.queryAll(
            leaguePartition(input.sportKey, input.leagueKey, "scheduled", day),
          ),
        ),
      )
    ).flat();
    const projections = new Map<
      string,
      ReturnType<typeof validateProjection>[]
    >();
    for (const row of rows) {
      const projection = validateProjection(row, "league", input.startsAt);
      if (
        projection.visibleUntil === null &&
        (input.participantIdentityIds
          ? true
          : projection.participantLabels.length === expected.length &&
            projection.participantLabels.every(
              (label, index) => normalize(label) === expected[index],
            )) &&
        Math.abs(Date.parse(projection.startsAt) - target) <= toleranceMs
      )
        projections.set(projection.eventId, [
          ...(projections.get(projection.eventId) ?? []),
          projection,
        ]);
    }
    const candidates: CanonicalEvent[] = [];
    for (const id of [...projections.keys()].sort()) {
      const item = await this.gateway.get(eventKey(id), "CURRENT");
      if (!item) continue;
      const candidate = validateCanonicalEvent(item.value);
      const currentProjections = projections
        .get(id)!
        .filter(
          (projection) =>
            projection.materialVersion === candidate.version &&
            projection.visibleUntil === null,
        );
      if (currentProjections.length === 0) continue;
      if (currentProjections.length > 1)
        throw new Error("multiple-current-event-projections");
      if (
        candidate.id !== id ||
        candidate.sportKey !== input.sportKey ||
        candidate.leagueKey !== input.leagueKey ||
        candidate.status !== "scheduled" ||
        !participantIdentityMatches(input, candidate) ||
        Math.abs(Date.parse(candidate.startsAt) - target) > toleranceMs
      )
        throw new Error("near-canonical-projection-stale");
      candidates.push(candidate);
    }
    return candidates;
  }
  async reconcileScheduledEvent(
    input: Parameters<EventIngestionStore["reconcileScheduledEvent"]>[0],
  ) {
    const scope = reconciliationScope(input.event);
    const pk = `EVENT_RECONCILIATION#${scope}`;
    const token = randomUUID();
    const leaseMs = this.reconciliationOptions.leaseMs ?? 10_000;
    const heartbeatMs =
      this.reconciliationOptions.heartbeatMs ?? Math.max(10, leaseMs / 3);
    let acquired = false;
    try {
      for (let attempt = 0; attempt < 400; attempt += 1) {
        const now = this.reconciliationNow().getTime();
        const value = {
          eventId: token,
          leaseUntil: new Date(now + leaseMs).toISOString(),
          version: 1,
        };
        if (
          (await this.gateway.insert({
            pk,
            sk: "CURRENT",
            value,
            expiresAt: Math.ceil((now + leaseMs) / 1_000),
          })) === "inserted"
        ) {
          acquired = true;
          this.reconciliationLeases.set(token, {
            pk,
            leaseMs,
            leaseUntil: now + leaseMs,
          });
          break;
        }
        const persisted = await this.gateway.get(pk, "CURRENT");
        if (!persisted) continue;
        const lock = persisted.value as Partial<typeof value>;
        if (
          !lock ||
          typeof lock !== "object" ||
          typeof lock.eventId !== "string" ||
          typeof lock.leaseUntil !== "string" ||
          !Number.isFinite(Date.parse(lock.leaseUntil)) ||
          lock.version !== 1
        )
          throw new Error("invalid-event-reconciliation-lock");
        if (Date.parse(lock.leaseUntil) <= now)
          try {
            await this.gateway.transact([
              {
                kind: "delete",
                pk,
                sk: "CURRENT",
                expectedEventId: lock.eventId,
                expectedLeaseUntil: lock.leaseUntil,
              },
            ]);
          } catch (error) {
            if (!(error instanceof DynamoConditionalConflict)) throw error;
          }
        await new Promise<void>((resolve) => {
          setTimeout(resolve, Math.min(25, attempt + 1));
        });
      }
    } catch (error) {
      if (
        error instanceof Error &&
        [
          "invalid-event-reconciliation-lock",
          "event-reconciliation-ownership-lost",
        ].includes(error.message)
      )
        throw error;
      throw reconciliationStorageFailure("acquisition", error);
    }
    if (!acquired) throw new Error("event-reconciliation-lock-timeout");
    const ownedLease = this.reconciliationLeases.get(token);
    if (!ownedLease) throw new Error("event-reconciliation-ownership-lost");
    let ownershipLost: Error | undefined;
    let renewalFailure: Error | undefined;
    let renewal = Promise.resolve();
    const renew = () => {
      renewal = renewal.then(async () => {
        if (ownershipLost || renewalFailure) return;
        try {
          await this.withReconciliationOperation(token, async () => {
            for (let attempt = 0; attempt < 6; attempt += 1) {
              const now = this.reconciliationNow().getTime();
              const priorLeaseUntil = ownedLease.leaseUntil;
              if (now >= priorLeaseUntil)
                throw new Error("event-reconciliation-ownership-lost");
              const nextLeaseUntil = now + leaseMs;
              try {
                await this.gateway.transact([
                  {
                    kind: "renew-reconciliation-lock",
                    item: {
                      pk,
                      sk: "CURRENT",
                      value: {
                        eventId: token,
                        leaseUntil: new Date(nextLeaseUntil).toISOString(),
                        version: 1,
                      },
                      expiresAt: Math.ceil(nextLeaseUntil / 1_000),
                    },
                    expectedToken: token,
                    leaseAfter: new Date(now).toISOString(),
                  },
                ]);
                if (this.reconciliationNow().getTime() >= priorLeaseUntil)
                  throw new Error("event-reconciliation-ownership-lost");
                ownedLease.leaseUntil = nextLeaseUntil;
                return;
              } catch (error) {
                if (error instanceof DynamoConditionalConflict)
                  throw new Error("event-reconciliation-ownership-lost");
                if (
                  !(error instanceof DynamoTransactionConflict) ||
                  attempt >= 5
                )
                  throw error;
                const delayMs = 5 * 2 ** attempt;
                if (
                  this.reconciliationNow().getTime() + delayMs >=
                  priorLeaseUntil
                )
                  throw new Error("event-reconciliation-ownership-lost");
                await new Promise<void>((resolve) => {
                  setTimeout(resolve, delayMs);
                });
              }
            }
          });
        } catch (error) {
          if (
            error instanceof Error &&
            error.message === "event-reconciliation-ownership-lost"
          )
            ownershipLost = error;
          else renewalFailure = reconciliationStorageFailure("renewal", error);
        }
      });
    };
    const heartbeat = setInterval(renew, heartbeatMs);
    let outcome:
      | Awaited<ReturnType<EventIngestionStore["reconcileScheduledEvent"]>>
      | undefined;
    let reconciliationFailure: unknown;
    let cleanupFailure: Error | undefined;
    try {
      outcome = await reconcileScheduledEventUnderLease(this, input, {
        pk,
        token,
      });
    } catch (error) {
      reconciliationFailure =
        error instanceof EventDataConflict ||
        (error instanceof Error &&
          [
            "invalid-scheduled-reconciliation",
            "mapped-canonical-participants-missing",
            "near-canonical-participants-missing",
            "event-reconciliation-ownership-lost",
          ].includes(error.message))
          ? error
          : reconciliationStorageFailure("execution", error);
    }
    clearInterval(heartbeat);
    await renewal;
    if (ownershipLost) reconciliationFailure = ownershipLost;
    else if (renewalFailure) reconciliationFailure = renewalFailure;
    try {
      for (let attempt = 0; attempt < 6; attempt += 1)
        try {
          await this.gateway.transact([
            {
              kind: "delete",
              pk,
              sk: "CURRENT",
              expectedEventId: token,
            },
          ]);
          break;
        } catch (error) {
          if (error instanceof DynamoConditionalConflict)
            throw new Error("event-reconciliation-ownership-lost");
          if (!(error instanceof DynamoTransactionConflict) || attempt >= 5)
            throw reconciliationStorageFailure("cleanup", error);
          await new Promise<void>((resolve) => {
            setTimeout(resolve, 5 * 2 ** attempt);
          });
        }
    } catch (error) {
      cleanupFailure =
        error instanceof Error &&
        error.message === "event-reconciliation-ownership-lost"
          ? error
          : reconciliationStorageFailure("cleanup", error);
    } finally {
      this.reconciliationLeases.delete(token);
    }
    if (reconciliationFailure !== undefined)
      throw reconciliationFailure instanceof Error
        ? reconciliationFailure
        : new Error("event-reconciliation-failed");
    if (cleanupFailure) throw cleanupFailure;
    return outcome!;
  }
  async recordReconciliationAmbiguity(
    input: EventIngestionInput,
    candidateEventIds: readonly string[],
  ) {
    const candidates = [...new Set(candidateEventIds)].sort().slice(0, 2);
    if (candidates.length < 2) throw new Error("ambiguous-candidates-required");
    const mid = mappingId(input);
    const id = stableDigest(JSON.stringify([mid, input.normalizedIdentity]));
    const pk = `UNRESOLVED#${id}`;
    const existing = await this.gateway.get(pk, "CURRENT");
    const current = existing
      ? validateUnresolvedEventMapping(existing.value)
      : undefined;
    const observation = {
      observedAt: input.observedAt,
      reason: "ambiguous-candidates" as const,
      candidateEventIds: candidates as EntityId[],
    };
    const next: UnresolvedEventMapping = {
      id,
      providerId: input.providerId,
      providerEventId: input.providerEventId,
      sportKey: input.sportKey,
      leagueKey: input.leagueKey,
      normalizedIdentity: input.normalizedIdentity,
      reason: observation.reason,
      candidateEventIds: observation.candidateEventIds,
      observations: [...(current?.observations ?? []).slice(-19), observation],
      version: nextBoundedVersion(current?.version ?? 0),
    };
    validateUnresolvedEventMapping(next);
    await this.transactIngestion(input, [
      current
        ? {
            kind: "replace",
            item: { pk, sk: "CURRENT", value: next },
            expectedVersion: current.version,
          }
        : {
            kind: "insert",
            item: { pk, sk: "CURRENT", value: next },
          },
    ]);
  }
  async getCanonicalByIdentity(
    sportKey: SportKey,
    leagueKey: string,
    identity: string,
  ): Promise<"missing" | "present" | "ambiguous"> {
    return (await this.resolveIdentity(sportKey, leagueKey, identity)).state;
  }
  async registerCandidate(event: CanonicalEvent) {
    const canonical = validateCanonicalEvent(repairAuthorityPointer(event));
    const pk = identityOwnerPk(
      canonical.sportKey,
      canonical.leagueKey,
      canonical.candidateIdentity,
    );
    for (let attempt = 0; attempt < 2; attempt++) {
      const resolution = await this.resolveIdentity(
        canonical.sportKey,
        canonical.leagueKey,
        canonical.candidateIdentity,
      );
      const existingEventItem = await this.gateway.get(
        eventKey(canonical.id),
        "CURRENT",
      );
      const existingEvent = existingEventItem
        ? validateCanonicalEvent(
            repairAuthorityPointer(existingEventItem.value as CanonicalEvent),
          )
        : undefined;
      if (
        existingEvent &&
        (existingEvent.id !== canonical.id ||
          existingEvent.sportKey !== canonical.sportKey ||
          existingEvent.leagueKey !== canonical.leagueKey ||
          existingEvent.candidateIdentity !== canonical.candidateIdentity)
      )
        throw new EventDataConflict("canonical-candidate-conflict");
      if (resolution.candidateIds.includes(canonical.id)) {
        if (!existingEvent) throw new Error("dangling-identity-aggregate");
        return "already-registered" as const;
      }
      const currentClaimItem = resolution.physicallyMissing
        ? undefined
        : await this.gateway.get(pk, "CURRENT");
      const currentClaim = currentClaimItem
        ? validateIdentityClaim(
            currentClaimItem.value,
            canonical.sportKey,
            canonical.leagueKey,
            canonical.candidateIdentity,
          )
        : undefined;
      if (resolution.candidateIds.length === 2 && currentClaim?.overflow)
        return "already-registered" as const;
      if (currentClaim?.conflictCount === Number.MAX_SAFE_INTEGER)
        throw new Error("identity-conflict-count-exhausted");
      const nextConflictCount =
        resolution.candidateIds.length === 2
          ? 3
          : (currentClaim?.conflictCount ?? 0) + 1;
      const candidateEventIds =
        resolution.candidateIds.length < 2
          ? [...resolution.candidateIds, canonical.id].sort()
          : [...resolution.candidateIds];
      const value = {
        candidateEventIds,
        sportKey: canonical.sportKey,
        leagueKey: canonical.leagueKey,
        normalizedIdentity: canonical.candidateIdentity,
        conflictCount: nextConflictCount,
        overflow: nextConflictCount > 2,
        version: nextIdentityVersion(resolution.claimVersion ?? 0),
      };
      try {
        await this.gateway.transact([
          ...(resolution.candidateIds.length === 2
            ? []
            : [
                existingEvent
                  ? {
                      kind: "check-event" as const,
                      pk: eventKey(canonical.id),
                      sk: "CURRENT",
                      expectedVersion: existingEvent.version,
                      expectedIdentity: existingEvent.candidateIdentity,
                    }
                  : {
                      kind: "insert" as const,
                      item: {
                        pk: eventKey(canonical.id),
                        sk: "CURRENT",
                        value: canonical,
                      },
                    },
              ]),
          resolution.candidateIds.length === 2
            ? {
                kind: "replace",
                item: { pk, sk: "CURRENT", value },
                expectedVersion: resolution.claimVersion!,
              }
            : resolution.physicallyMissing
              ? {
                  kind: "claim-identity",
                  item: { pk, sk: "CURRENT", value },
                  eventId: canonical.id,
                }
              : {
                  kind: "replace",
                  item: { pk, sk: "CURRENT", value },
                  expectedVersion: resolution.claimVersion!,
                },
        ]);
        return "registered" as const;
      } catch (error) {
        if (!(error instanceof DynamoConditionalConflict) || attempt === 1)
          throw error;
      }
    }
    throw new Error("identity-register-conflict");
  }
  async recordBootstrapPageMarkers(
    checkpointKey: string,
    pagePosition: IngestionCheckpoint["position"],
    events: readonly {
      readonly id: string;
      readonly normalizedIdentity: string;
    }[],
    windowEnd: IsoTimestamp,
  ) {
    if (events.length > 50) throw new Error("bootstrap-marker-page-limit");
    const pagePositionDigest = providerEventPagePositionDigest(pagePosition);
    const markerIds = events.flatMap((event) => [
      bootstrapMarkerId(checkpointKey, "id", event.id),
      bootstrapMarkerId(checkpointKey, "identity", event.normalizedIdentity),
    ]);
    if (markerIds.length === 0) return "recorded" as const;
    const pk = `BOOTSTRAP_MARKER#${checkpointKey}`;
    const existing = await this.gateway.batchGet(
      markerIds.map((sk) => ({ pk, sk })),
    );
    for (const item of existing) {
      const value = item.value as Record<string, unknown>;
      if (
        item.pk !== pk ||
        !markerIds.includes(item.sk) ||
        value["checkpointKey"] !== checkpointKey ||
        value["markerId"] !== item.sk ||
        typeof value["pagePositionDigest"] !== "string"
      )
        throw new Error("invalid-bootstrap-marker");
      if (value["pagePositionDigest"] !== pagePositionDigest)
        throw new Error("duplicate-bootstrap-position");
    }
    const allSame =
      markerIds.length > 0 && existing.length === markerIds.length;
    try {
      await this.gateway.transact(
        markerIds.map((markerId) => ({
          kind: "put-bootstrap-marker" as const,
          item: {
            pk,
            sk: markerId,
            value: { checkpointKey, markerId, pagePositionDigest },
            expiresAt: Math.floor(Date.parse(windowEnd) / 1000) + 31_536_000,
          },
          expectedPagePositionDigest: pagePositionDigest,
        })),
      );
    } catch (error) {
      if (error instanceof DynamoConditionalConflict)
        throw new Error("duplicate-bootstrap-position");
      throw error;
    }
    return allSame ? ("same-position" as const) : ("recorded" as const);
  }
  async putBootstrapResponse(
    reservationId: string,
    response: unknown,
    windowEnd: IsoTimestamp,
  ) {
    if (!/^[a-f0-9]{64}$/.test(reservationId))
      throw new Error("invalid-bootstrap-response-ref");
    if (!response || typeof response !== "object" || Array.isArray(response))
      throw new Error("invalid-bootstrap-response");
    const envelope = response as Record<string, unknown>;
    const payload = envelope["payload"] as Record<string, unknown> | undefined;
    if (!payload || !Array.isArray(payload["events"]))
      throw new Error("invalid-bootstrap-response");
    const chunks: unknown[][] = [];
    let active: unknown[] = [];
    for (const event of payload["events"]) {
      const candidate = [...active, event];
      if (Buffer.byteLength(JSON.stringify(candidate), "utf8") > 90_000) {
        if (active.length === 0) throw new Error("bootstrap-event-too-large");
        chunks.push(active);
        active = [event];
      } else active = candidate;
    }
    if (active.length > 0 || chunks.length === 0) chunks.push(active);
    const chunkDigests = chunks.map(storageDigest);
    const manifestPayload = {
      ...(payload["nextCursor"] !== undefined
        ? { nextCursor: payload["nextCursor"] }
        : {}),
      providerRequests: payload["providerRequests"],
      quotaUsed: payload["quotaUsed"],
      chunkCount: chunks.length,
      chunkDigests,
    };
    const manifest = {
      ...envelope,
      payload: manifestPayload,
    };
    const item = {
      pk: `BOOTSTRAP_RESPONSE#${reservationId}`,
      sk: "CURRENT",
      value: manifest,
      expiresAt: Math.floor(Date.parse(windowEnd) / 1000) + 31_536_000,
    };
    for (const [index, events] of chunks.entries()) {
      const chunkValue = {
        index,
        digest: chunkDigests[index],
        events,
      };
      const chunk = {
        pk: item.pk,
        sk: `CHUNK#${index.toString().padStart(4, "0")}`,
        value: chunkValue,
        expiresAt: item.expiresAt,
      };
      const insertedChunk = await this.gateway.insert(chunk);
      if (insertedChunk !== "inserted") {
        const existingChunk = await this.gateway.get(chunk.pk, chunk.sk);
        if (storageDigest(existingChunk?.value) !== storageDigest(chunkValue))
          throw new Error("bootstrap-response-conflict");
      }
    }
    const inserted = await this.gateway.insert(item);
    if (inserted === "inserted") return;
    const existing = await this.gateway.get(item.pk, item.sk);
    if (storageDigest(existing?.value) !== storageDigest(manifest))
      throw new Error("bootstrap-response-conflict");
  }
  async getBootstrapResponse(reservationId: string) {
    if (!/^[a-f0-9]{64}$/.test(reservationId))
      throw new Error("invalid-bootstrap-response-ref");
    const item = await this.gateway.get(
      `BOOTSTRAP_RESPONSE#${reservationId}`,
      "CURRENT",
    );
    if (!item) return null;
    const envelope = item.value as Record<string, unknown>;
    const payload = envelope["payload"] as Record<string, unknown> | undefined;
    if (
      Object.keys(envelope).length !== 4 ||
      !["id", "reservationId", "digest", "payload"].every((key) =>
        Object.prototype.hasOwnProperty.call(envelope, key),
      ) ||
      envelope["id"] !== reservationId ||
      typeof envelope["reservationId"] !== "string" ||
      !/^[a-f0-9]{64}$/.test(envelope["reservationId"]) ||
      typeof envelope["digest"] !== "string" ||
      !/^[a-f0-9]{64}$/.test(envelope["digest"]) ||
      !payload ||
      !Object.keys(payload).every((key) =>
        [
          "nextCursor",
          "providerRequests",
          "quotaUsed",
          "chunkCount",
          "chunkDigests",
        ].includes(key),
      ) ||
      !["providerRequests", "quotaUsed", "chunkCount", "chunkDigests"].every(
        (key) => Object.prototype.hasOwnProperty.call(payload, key),
      ) ||
      !Number.isSafeInteger(payload["chunkCount"])
    )
      throw new Error("invalid-bootstrap-response-manifest");
    const chunkCount = payload["chunkCount"] as number;
    const chunkDigests = payload["chunkDigests"];
    if (chunkCount < 1 || chunkCount > 100)
      throw new Error("invalid-bootstrap-response-manifest");
    if (
      !Array.isArray(chunkDigests) ||
      chunkDigests.length !== chunkCount ||
      !chunkDigests.every(
        (digest) => typeof digest === "string" && /^[a-f0-9]{64}$/.test(digest),
      )
    )
      throw new Error("invalid-bootstrap-response-manifest");
    const chunkItems = await Promise.all(
      Array.from({ length: chunkCount }, (_, index) =>
        this.gateway.get(
          `BOOTSTRAP_RESPONSE#${reservationId}`,
          `CHUNK#${index.toString().padStart(4, "0")}`,
        ),
      ),
    );
    if (
      chunkItems.some((chunk, index) => {
        if (!chunk || !chunk.value || typeof chunk.value !== "object")
          return true;
        const value = chunk.value as Record<string, unknown>;
        return (
          Object.keys(value).length !== 3 ||
          value["index"] !== index ||
          value["digest"] !== chunkDigests[index] ||
          !Array.isArray(value["events"]) ||
          storageDigest(value["events"]) !== value["digest"]
        );
      })
    )
      throw new Error("incomplete-bootstrap-response");
    const events = chunkItems.flatMap(
      (chunk) => (chunk!.value as { events: unknown[] }).events,
    );
    return {
      ...envelope,
      payload: {
        events,
        ...(payload["nextCursor"] !== undefined
          ? { nextCursor: payload["nextCursor"] }
          : {}),
        providerRequests: payload["providerRequests"],
        quotaUsed: payload["quotaUsed"],
      },
    };
  }

  async bootstrapCanonicalEvent(
    input: CanonicalEventBootstrap,
    observedAt: IsoTimestamp,
    reconciliationFence?: EventIngestionInput["reconciliationFence"],
  ) {
    const transact = (writes: readonly DynamoWrite[]) =>
      this.transactReconciled(reconciliationFence, writes);
    const identityResolution = await this.resolveIdentity(
      input.sportKey,
      input.leagueKey,
      input.normalizedIdentity,
    );
    if (
      identityResolution.state === "ambiguous" ||
      (identityResolution.candidateIds[0] &&
        identityResolution.candidateIds[0] !== input.id)
    )
      throw new Error("bootstrap-identity-already-exists");
    const event: CanonicalEvent = {
      id: input.id,
      sportKey: input.sportKey,
      leagueKey: input.leagueKey,
      leagueId: input.leagueId,
      participantIds: [...input.participantIds],
      participantLabels: [...input.participantLabels],
      startsAt: input.startsAt,
      phase: input.phase,
      evidence: [],
      status: input.status,
      revisions: {},
      updatedAt: observedAt,
      candidateIdentity: input.normalizedIdentity,
      bootstrapRevision: input.revision,
      authoritativeRevision: input.revision,
      version: 1,
    };
    validateCanonicalEvent(event);
    const projections = projectionItems(event, observedAt);
    try {
      await transact([
        {
          kind: "insert",
          item: { pk: eventKey(event.id), sk: "CURRENT", value: event },
        },
        { kind: "put-projection", item: projections.pointer },
        { kind: "put-projection", item: projections.sport },
        { kind: "put-projection", item: projections.league },
        {
          kind: "put-projection",
          item: {
            pk: "EVENT_PROJECTIONS",
            sk: "READINESS",
            value: { schemaVersion: 1, state: "initialized" },
          },
        },
        identityResolution.physicallyMissing
          ? {
              kind: "claim-identity",
              item: {
                pk: identityOwnerPk(
                  input.sportKey,
                  input.leagueKey,
                  input.normalizedIdentity,
                ),
                sk: "CURRENT",
                value: {
                  candidateEventIds: [event.id],
                  sportKey: input.sportKey,
                  leagueKey: input.leagueKey,
                  normalizedIdentity: input.normalizedIdentity,
                  conflictCount: 1,
                  overflow: false,
                  version: 1,
                },
              },
              eventId: event.id,
            }
          : {
              kind: "replace",
              item: {
                pk: identityOwnerPk(
                  input.sportKey,
                  input.leagueKey,
                  input.normalizedIdentity,
                ),
                sk: "CURRENT",
                value: {
                  candidateEventIds: [event.id],
                  sportKey: input.sportKey,
                  leagueKey: input.leagueKey,
                  normalizedIdentity: input.normalizedIdentity,
                  conflictCount: 1,
                  overflow: false,
                  version: nextIdentityVersion(
                    identityResolution.claimVersion!,
                  ),
                },
              },
              expectedVersion: identityResolution.claimVersion!,
            },
      ]);
      return "created" as const;
    } catch (error) {
      if (!(error instanceof DynamoConditionalConflict)) throw error;
      const existing = await this.gateway.get(eventKey(event.id), "CURRENT");
      if (existing) {
        const value = validateCanonicalEvent(existing.value);
        const currentWinner = maxAuthority(
          value.authoritativeRevision,
          value.bootstrapRevision,
          ...Object.values(value.revisions),
        );
        if (
          value.sportKey !== input.sportKey ||
          value.leagueKey !== input.leagueKey ||
          value.leagueId !== input.leagueId ||
          value.phase !== input.phase ||
          JSON.stringify(value.participantIds) !==
            JSON.stringify(input.participantIds)
        )
          throw new EventDataConflict("bootstrap-content-mismatch");
        if (
          currentWinner &&
          compareAuthority(input.revision, currentWinner) < 0
        )
          throw new Error("bootstrap-stale");
        if (
          currentWinner &&
          compareAuthority(input.revision, currentWinner) === 0 &&
          (value.candidateIdentity !== input.normalizedIdentity ||
            value.startsAt !== input.startsAt ||
            value.status !== input.status)
        )
          throw new EventDataConflict("bootstrap-revision-content-conflict");
        const requestedOwnerPk = identityOwnerPk(
          input.sportKey,
          input.leagueKey,
          input.normalizedIdentity,
        );
        const requestedOwner = await this.gateway.get(
          requestedOwnerPk,
          "CURRENT",
        );
        if (requestedOwner) {
          const claim = validateIdentityClaim(
            requestedOwner.value,
            input.sportKey,
            input.leagueKey,
            input.normalizedIdentity,
          );
          if (
            claim.candidateEventIds.length > 0 &&
            (claim.candidateEventIds.length !== 1 ||
              claim.candidateEventIds[0] !== event.id)
          )
            throw new Error("bootstrap-identity-already-exists");
        }
        if (value.candidateIdentity === input.normalizedIdentity) {
          const requestedClaim = requestedOwner
            ? validateIdentityClaim(
                requestedOwner.value,
                input.sportKey,
                input.leagueKey,
                input.normalizedIdentity,
              )
            : undefined;
          if (
            requestedClaim?.candidateEventIds.length === 1 &&
            compareAuthority(input.revision, currentWinner) === 0 &&
            value.startsAt === input.startsAt &&
            value.status === input.status
          ) {
            await transact([
              {
                kind: "check-event",
                pk: eventKey(value.id),
                sk: "CURRENT",
                expectedVersion: value.version,
                expectedIdentity: value.candidateIdentity,
              },
              {
                kind: "check-identity",
                pk: requestedOwnerPk,
                sk: "CURRENT",
                expectedVersion: requestedClaim.version,
                expectedCandidateEventIds: requestedClaim.candidateEventIds,
              },
            ]);
            return "existing" as const;
          }
          if (
            compareAuthority(input.revision, currentWinner) > 0 ||
            value.startsAt !== input.startsAt ||
            value.status !== input.status
          )
            await transact([
              {
                kind: "replace",
                item: {
                  ...existing,
                  value: {
                    ...value,
                    startsAt: input.startsAt,
                    status: input.status,
                    bootstrapRevision: input.revision,
                    authoritativeRevision: maxAuthority(
                      value.authoritativeRevision,
                      value.bootstrapRevision,
                      ...Object.values(value.revisions),
                      input.revision,
                    ),
                    updatedAt:
                      Date.parse(observedAt) > Date.parse(value.updatedAt)
                        ? observedAt
                        : value.updatedAt,
                    version: nextIdentityVersion(value.version),
                  },
                },
                expectedVersion: value.version,
              },
              ...(!requestedOwner
                ? [
                    {
                      kind: "claim-identity" as const,
                      item: {
                        pk: requestedOwnerPk,
                        sk: "CURRENT",
                        value: {
                          candidateEventIds: [event.id],
                          sportKey: input.sportKey,
                          leagueKey: input.leagueKey,
                          normalizedIdentity: input.normalizedIdentity,
                          conflictCount: 1,
                          overflow: false,
                          version: 1,
                        },
                      },
                      eventId: event.id,
                    },
                  ]
                : requestedClaim?.candidateEventIds.length === 0
                  ? [
                      {
                        kind: "replace" as const,
                        item: {
                          pk: requestedOwnerPk,
                          sk: "CURRENT",
                          value: {
                            candidateEventIds: [event.id],
                            sportKey: input.sportKey,
                            leagueKey: input.leagueKey,
                            normalizedIdentity: input.normalizedIdentity,
                            conflictCount: 1,
                            overflow: false,
                            version: nextIdentityVersion(
                              requestedClaim.version,
                            ),
                          },
                        },
                        expectedVersion: requestedClaim.version,
                      },
                    ]
                  : requestedClaim
                    ? [
                        {
                          kind: "check-identity" as const,
                          pk: requestedOwnerPk,
                          sk: "CURRENT",
                          expectedVersion: requestedClaim.version,
                          expectedCandidateEventIds:
                            requestedClaim.candidateEventIds,
                        },
                      ]
                    : []),
            ]);
          else if (
            !requestedOwner ||
            validateIdentityClaim(
              requestedOwner.value,
              input.sportKey,
              input.leagueKey,
              input.normalizedIdentity,
            ).candidateEventIds.length === 0
          )
            await transact([
              {
                kind: "check-event",
                pk: eventKey(value.id),
                sk: "CURRENT",
                expectedVersion: value.version,
                expectedIdentity: value.candidateIdentity,
              },
              !requestedOwner
                ? {
                    kind: "claim-identity",
                    item: {
                      pk: requestedOwnerPk,
                      sk: "CURRENT",
                      value: {
                        candidateEventIds: [event.id],
                        sportKey: input.sportKey,
                        leagueKey: input.leagueKey,
                        normalizedIdentity: input.normalizedIdentity,
                        conflictCount: 1,
                        overflow: false,
                        version: 1,
                      },
                    },
                    eventId: event.id,
                  }
                : {
                    kind: "replace",
                    item: {
                      pk: requestedOwnerPk,
                      sk: "CURRENT",
                      value: {
                        candidateEventIds: [event.id],
                        sportKey: input.sportKey,
                        leagueKey: input.leagueKey,
                        normalizedIdentity: input.normalizedIdentity,
                        conflictCount: 1,
                        overflow: false,
                        version: nextIdentityVersion(
                          validateIdentityClaim(
                            requestedOwner.value,
                            input.sportKey,
                            input.leagueKey,
                            input.normalizedIdentity,
                          ).version,
                        ),
                      },
                    },
                    expectedVersion: validateIdentityClaim(
                      requestedOwner.value,
                      input.sportKey,
                      input.leagueKey,
                      input.normalizedIdentity,
                    ).version,
                  },
            ]);
          return "repaired" as const;
        }
        const previousIdentityResolution = await this.resolveIdentity(
          input.sportKey,
          input.leagueKey,
          value.candidateIdentity,
        );
        if (
          previousIdentityResolution.state !== "present" ||
          previousIdentityResolution.candidateIds[0] !== event.id
        )
          throw new Error("bootstrap-identity-snapshot-mismatch");
        await transact([
          {
            kind: "replace",
            item: {
              ...existing,
              value: {
                ...value,
                startsAt: input.startsAt,
                status: input.status,
                candidateIdentity: input.normalizedIdentity,
                bootstrapRevision: input.revision,
                authoritativeRevision: maxAuthority(
                  value.authoritativeRevision,
                  value.bootstrapRevision,
                  ...Object.values(value.revisions),
                  input.revision,
                ),
                updatedAt:
                  Date.parse(observedAt) > Date.parse(value.updatedAt)
                    ? observedAt
                    : value.updatedAt,
                version: nextIdentityVersion(value.version),
              },
            },
            expectedVersion: value.version,
          },
          {
            kind: "replace",
            item: {
              pk: identityOwnerPk(
                input.sportKey,
                input.leagueKey,
                value.candidateIdentity,
              ),
              sk: "CURRENT",
              value: {
                candidateEventIds: [],
                sportKey: input.sportKey,
                leagueKey: input.leagueKey,
                normalizedIdentity: value.candidateIdentity,
                conflictCount: 0,
                overflow: false,
                version: nextIdentityVersion(
                  previousIdentityResolution.claimVersion!,
                ),
              },
            },
            expectedVersion: previousIdentityResolution.claimVersion!,
          },
          identityResolution.physicallyMissing
            ? {
                kind: "claim-identity",
                item: {
                  pk: identityOwnerPk(
                    input.sportKey,
                    input.leagueKey,
                    input.normalizedIdentity,
                  ),
                  sk: "CURRENT",
                  value: {
                    candidateEventIds: [event.id],
                    sportKey: input.sportKey,
                    leagueKey: input.leagueKey,
                    normalizedIdentity: input.normalizedIdentity,
                    conflictCount: 1,
                    overflow: false,
                    version: 1,
                  },
                },
                eventId: event.id,
              }
            : {
                kind: "replace",
                item: {
                  pk: identityOwnerPk(
                    input.sportKey,
                    input.leagueKey,
                    input.normalizedIdentity,
                  ),
                  sk: "CURRENT",
                  value: {
                    candidateEventIds: [event.id],
                    sportKey: input.sportKey,
                    leagueKey: input.leagueKey,
                    normalizedIdentity: input.normalizedIdentity,
                    conflictCount: 1,
                    overflow: false,
                    version: nextIdentityVersion(
                      identityResolution.claimVersion!,
                    ),
                  },
                },
                expectedVersion: identityResolution.claimVersion!,
              },
        ]);
        return "repaired" as const;
      }
      const owner = await this.gateway.get(
        identityOwnerPk(
          input.sportKey,
          input.leagueKey,
          input.normalizedIdentity,
        ),
        "CURRENT",
      );
      if (owner) throw new Error("bootstrap-identity-already-exists");
      throw new Error("bootstrap-failed");
    }
  }
  async ingestEvent(
    input: EventIngestionInput,
  ): Promise<EventIngestionOutcome> {
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        return await this.ingestEventAttempt(input);
      } catch (error) {
        if (!(error instanceof IdentitySnapshotRetry)) throw error;
        await Promise.resolve();
      }
    }
    throw new Error("identity-snapshot-unstable");
  }
  private async ingestEventAttempt(
    input: EventIngestionInput,
  ): Promise<EventIngestionOutcome> {
    const mid = mappingId(input),
      mappingItem = await this.gateway.get(`MAPPING#${mid}`, "CURRENT");
    const mapped = mappingItem
      ? validateProviderEventMapping(mappingItem.value)
      : undefined;
    if (
      mapped &&
      (mapped.sportKey !== input.sportKey ||
        mapped.leagueKey !== input.leagueKey ||
        mapped.providerId !== input.providerId ||
        mapped.providerEventId !== input.providerEventId)
    )
      throw new Error("mapping-scope-mismatch");
    let candidates = mapped ? [mapped.canonicalEventId] : [];
    let identityState: "missing" | "present" | "ambiguous" | undefined;
    let identityClaimVersion: number | undefined;
    let identityCandidateIds: readonly EntityId[] = [];
    let identityPhysicallyMissing = false;
    if (!mapped) {
      const resolution = await this.resolveIdentity(
        input.sportKey,
        input.leagueKey,
        input.normalizedIdentity,
      );
      identityState = resolution.state;
      identityClaimVersion = resolution.claimVersion;
      identityPhysicallyMissing = resolution.physicallyMissing ?? false;
      candidates = [...resolution.candidateIds];
      identityCandidateIds = resolution.candidateIds;
    }
    if (candidates.length !== 1) {
      const observation = {
        observedAt: input.observedAt,
        reason: candidates.length
          ? ("ambiguous-candidates" as const)
          : ("no-candidate" as const),
        candidateEventIds: candidates,
      };
      const unresolved: UnresolvedEventMapping = {
        id: stableDigest(JSON.stringify([mid, input.normalizedIdentity])),
        providerId: input.providerId,
        providerEventId: input.providerEventId,
        sportKey: input.sportKey,
        leagueKey: input.leagueKey,
        normalizedIdentity: input.normalizedIdentity,
        reason: observation.reason,
        candidateEventIds: candidates,
        observations: [observation],
        version: 1,
      };
      validateUnresolvedEventMapping(unresolved);
      const pk = `UNRESOLVED#${unresolved.id}`;
      const existing = await this.gateway.get(pk, "CURRENT");
      const current = existing
        ? validateUnresolvedEventMapping(existing.value)
        : undefined;
      const observationKey = stableDigest(
        JSON.stringify([unresolved.id, observation]),
      );
      const existingObservation = await this.gateway.get(
        pk,
        `OBSERVATION_ID#${observationKey}`,
      );
      const duplicate = current?.observations.some(
        (item) =>
          stableDigest(JSON.stringify([unresolved.id, item])) ===
          observationKey,
      );
      if (existingObservation || (current && duplicate)) {
        const confirmed = await this.resolveIdentity(
          input.sportKey,
          input.leagueKey,
          input.normalizedIdentity,
        );
        if (
          confirmed.state !== identityState ||
          confirmed.claimVersion !== identityClaimVersion ||
          JSON.stringify(confirmed.candidateIds) !==
            JSON.stringify(identityCandidateIds)
        ) {
          throw new IdentitySnapshotRetry();
        }
        try {
          await this.transactIngestion(input, [
            identityState === "missing" && identityPhysicallyMissing
              ? {
                  kind: "check-identity-absent",
                  pk: identityOwnerPk(
                    input.sportKey,
                    input.leagueKey,
                    input.normalizedIdentity,
                  ),
                  sk: "CURRENT",
                }
              : {
                  kind: "check-identity",
                  pk: identityOwnerPk(
                    input.sportKey,
                    input.leagueKey,
                    input.normalizedIdentity,
                  ),
                  sk: "CURRENT",
                  expectedVersion: identityClaimVersion!,
                  expectedCandidateEventIds: identityCandidateIds,
                },
          ]);
        } catch (error) {
          if (error instanceof DynamoConditionalConflict)
            throw new IdentitySnapshotRetry();
          throw error;
        }
        return { kind: "unresolved" as const, reason: unresolved.reason };
      }
      try {
        await this.transactIngestion(input, [
          identityState === "missing" && identityPhysicallyMissing
            ? {
                kind: "check-identity-absent",
                pk: identityOwnerPk(
                  input.sportKey,
                  input.leagueKey,
                  input.normalizedIdentity,
                ),
                sk: "CURRENT",
              }
            : {
                kind: "check-identity",
                pk: identityOwnerPk(
                  input.sportKey,
                  input.leagueKey,
                  input.normalizedIdentity,
                ),
                sk: "CURRENT",
                expectedVersion: identityClaimVersion!,
                expectedCandidateEventIds: identityCandidateIds,
              },
          current
            ? {
                kind: "replace",
                item: {
                  pk,
                  sk: "CURRENT",
                  value: {
                    ...current,
                    reason: observation.reason,
                    candidateEventIds: candidates,
                    observations: [...current.observations, observation].slice(
                      -20,
                    ),
                    version: nextBoundedVersion(current.version),
                  },
                },
                expectedVersion: current.version,
              }
            : {
                kind: "insert",
                item: { pk, sk: "CURRENT", value: unresolved },
              },
          {
            kind: "insert",
            item: {
              pk,
              sk: `OBSERVATION_ID#${observationKey}`,
              value: { id: observationKey },
              expiresAt:
                Math.floor(Date.parse(input.observedAt) / 1000) + 2_592_000,
            },
          },
          {
            kind: "insert",
            item: {
              pk,
              sk: `OBSERVATION#${observationKey}`,
              value: observation,
              expiresAt:
                Math.floor(Date.parse(input.observedAt) / 1000) + 2_592_000,
            },
          },
        ]);
      } catch (error) {
        if (!(error instanceof DynamoConditionalConflict)) throw error;
        await this.gateway.get(pk, `OBSERVATION_ID#${observationKey}`);
        await this.resolveIdentity(
          input.sportKey,
          input.leagueKey,
          input.normalizedIdentity,
        );
        throw new IdentitySnapshotRetry();
      }
      return { kind: "unresolved" as const, reason: unresolved.reason };
    }
    const id = candidates[0]!,
      item = await this.gateway.get(eventKey(id), "CURRENT");
    if (!item) throw new Error("missing-event");
    const current = validateCanonicalEvent(item.value);
    if (
      current.id !== id ||
      current.sportKey !== input.sportKey ||
      current.leagueKey !== input.leagueKey
    )
      throw new Error("mapping-canonical-scope-mismatch");
    let previousIdentityClaimVersion: number | undefined;
    let targetIdentityResolution:
      | Awaited<ReturnType<DynamoEventIngestionStore["resolveIdentity"]>>
      | undefined;
    const identitySnapshotWrites = (): DynamoWrite[] =>
      !mapped && identityState === "present"
        ? [
            {
              kind: "check-identity",
              pk: identityOwnerPk(
                input.sportKey,
                input.leagueKey,
                input.normalizedIdentity,
              ),
              sk: "CURRENT",
              expectedVersion: identityClaimVersion!,
              expectedCandidateEventIds: identityCandidateIds,
            },
          ]
        : [];
    const revisionSk = `PROVIDER_REVISION#${stableDigest(input.providerId)}`;
    const materialFingerprint = stableDigest(
      JSON.stringify([
        input.normalizedIdentity,
        input.startsAt,
        input.status,
        input.participantLabels ?? current.participantLabels,
      ]),
    );
    const revisionItem = await this.gateway.get(eventKey(id), revisionSk);
    const persistedRevision = revisionItem
      ? validatePersistedProviderRevision(revisionItem.value, input.providerId)
      : undefined;
    const mapping: ProviderEventMapping = mapped ?? {
      id: mid,
      providerId: input.providerId,
      providerEventId: input.providerEventId,
      canonicalEventId: id,
      sportKey: input.sportKey,
      leagueKey: input.leagueKey,
      createdAt: input.observedAt,
      bindingKind: input.mappingKind ?? "source",
    };
    if (mapped && input.mappingKind && mapped.bindingKind !== input.mappingKind)
      throw new EventDataConflict("mapping-provenance-conflict");
    const providerPrior = [
      persistedRevision,
      current.revisions[input.providerId],
      current.bootstrapRevision?.providerId === input.providerId
        ? current.bootstrapRevision
        : undefined,
    ].reduce<ProviderRevision | undefined>(
      (latest, revision) =>
        revision && (!latest || compareRevision(revision, latest) > 0)
          ? revision
          : latest,
      undefined,
    );
    const providerComparison = compareRevision(input.revision, providerPrior);
    const persistedIsProviderPrior =
      !!persistedRevision &&
      compareRevision(persistedRevision, providerPrior) === 0;
    const canonicalSupportsProviderPrior =
      (!!current.authoritativeRevision &&
        current.authoritativeRevision.providerId === input.providerId &&
        compareRevision(current.authoritativeRevision, providerPrior) === 0) ||
      (!!current.bootstrapRevision &&
        current.bootstrapRevision.providerId === input.providerId &&
        compareRevision(current.bootstrapRevision, providerPrior) === 0);
    const canonicalSupportsPersistedRevision =
      !!persistedRevision &&
      ((!!current.authoritativeRevision &&
        current.authoritativeRevision.providerId === input.providerId &&
        equalProviderRevision(
          current.authoritativeRevision,
          persistedRevision,
        )) ||
        (!!current.bootstrapRevision &&
          current.bootstrapRevision.providerId === input.providerId &&
          equalProviderRevision(current.bootstrapRevision, persistedRevision)));
    if (
      providerComparison === 0 &&
      (persistedIsProviderPrior && persistedRevision?.materialFingerprint
        ? persistedRevision.materialFingerprint !== materialFingerprint
        : persistedIsProviderPrior
          ? !canonicalSupportsProviderPrior ||
            current.startsAt !== input.startsAt ||
            current.status !== input.status ||
            current.candidateIdentity !== input.normalizedIdentity
          : !canonicalSupportsProviderPrior ||
            current.startsAt !== input.startsAt ||
            current.status !== input.status ||
            current.candidateIdentity !== input.normalizedIdentity)
    )
      throw new EventDataConflict("provider-revision-content-conflict");
    if (providerComparison <= 0) {
      const legacyBackfill: DynamoWrite[] =
        revisionItem &&
        !persistedRevision?.materialFingerprint &&
        equalProviderRevision(input.revision, persistedRevision) &&
        canonicalSupportsPersistedRevision &&
        current.startsAt === input.startsAt &&
        current.status === input.status &&
        current.candidateIdentity === input.normalizedIdentity &&
        (current.authoritativeRevision?.providerId === input.providerId ||
          current.bootstrapRevision?.providerId === input.providerId)
          ? [
              {
                kind: "replace",
                item: {
                  pk: eventKey(id),
                  sk: revisionSk,
                  value: {
                    ...persistedRevision,
                    materialFingerprint,
                    version: nextBoundedVersion(persistedRevision.version),
                  },
                },
                expectedVersion: persistedRevision.version,
              },
            ]
          : [];
      if (!mapped && identityState === "present")
        await this.transactIngestion(input, [
          ...identitySnapshotWrites(),
          {
            kind: "check-event",
            pk: eventKey(id),
            sk: "CURRENT",
            expectedVersion: current.version,
            expectedIdentity: input.normalizedIdentity,
            ...(legacyBackfill.length ? { expectedSnapshot: current } : {}),
          },
          {
            kind: "insert",
            item: { pk: `MAPPING#${mid}`, sk: "CURRENT", value: mapping },
          },
          ...legacyBackfill,
        ]);
      else if (
        input.providerEventFence ||
        input.reconciliationFence ||
        legacyBackfill.length
      )
        await this.transactIngestion(input, [
          ...(legacyBackfill.length
            ? [
                {
                  kind: "check-event" as const,
                  pk: eventKey(id),
                  sk: "CURRENT",
                  expectedVersion: current.version,
                  expectedIdentity: input.normalizedIdentity,
                  expectedSnapshot: current,
                },
              ]
            : []),
          ...legacyBackfill,
        ]);
      return { kind: "skipped" as const, eventId: id };
    }
    const authoritative =
      compareAuthority(
        input.revision,
        maxAuthority(
          current.authoritativeRevision,
          current.bootstrapRevision,
          ...Object.values(current.revisions),
        ),
      ) >= 0;
    if (!authoritative) {
      await this.transactIngestion(input, [
        ...identitySnapshotWrites(),
        ...(!mapped
          ? [
              {
                kind: "check-event" as const,
                pk: eventKey(id),
                sk: "CURRENT",
                expectedVersion: current.version,
                expectedIdentity: input.normalizedIdentity,
              },
            ]
          : []),
        ...(!mapped
          ? [
              {
                kind: "insert" as const,
                item: { pk: `MAPPING#${mid}`, sk: "CURRENT", value: mapping },
              },
            ]
          : []),
        revisionItem
          ? {
              kind: "replace",
              item: {
                pk: eventKey(id),
                sk: revisionSk,
                value: {
                  ...input.revision,
                  materialFingerprint,
                  version: nextBoundedVersion(persistedRevision!.version),
                },
              },
              expectedVersion: persistedRevision!.version,
            }
          : {
              kind: "insert",
              item: {
                pk: eventKey(id),
                sk: revisionSk,
                value: { ...input.revision, materialFingerprint, version: 1 },
              },
            },
      ]);
      return { kind: "skipped" as const, eventId: id };
    }
    if (mapped && current.candidateIdentity !== input.normalizedIdentity) {
      const previous = await this.resolveIdentity(
        input.sportKey,
        input.leagueKey,
        current.candidateIdentity,
      );
      if (
        previous.state !== "present" ||
        previous.candidateIds[0] !== current.id
      )
        throw new Error("identity-snapshot-mismatch");
      previousIdentityClaimVersion = previous.claimVersion;
      const target = await this.resolveIdentity(
        input.sportKey,
        input.leagueKey,
        input.normalizedIdentity,
      );
      if (target.state !== "missing")
        throw new EventDataConflict("identity-claim-conflict");
      targetIdentityResolution = target;
    }
    const next: CanonicalEvent = {
      ...current,
      participantLabels: [
        ...(input.participantLabels ?? current.participantLabels ?? []),
      ],
      startsAt: input.startsAt,
      status: input.status,
      revisions: { ...current.revisions, [input.providerId]: input.revision },
      updatedAt:
        Date.parse(input.observedAt) > Date.parse(current.updatedAt)
          ? input.observedAt
          : current.updatedAt,
      candidateIdentity: input.normalizedIdentity,
      authoritativeRevision: input.revision,
      version: nextIdentityVersion(current.version),
    };
    if (
      !Object.prototype.hasOwnProperty.call(
        current.revisions,
        input.providerId,
      ) &&
      Object.keys(current.revisions).length >= 64
    )
      throw new Error("canonical-revision-provider-limit");
    validateCanonicalEvent(next);
    const pointerItem = await this.gateway.get(
      `EVENT_DETAIL#${current.id}`,
      "CURRENT",
    );
    if (
      !pointerItem ||
      !pointerItem.value ||
      typeof pointerItem.value !== "object" ||
      Array.isArray(pointerItem.value)
    )
      throw new Error("event-projection-pointer-missing");
    const pointer = pointerItem.value as EventDetailPointer;
    if (
      pointer.eventId !== current.id ||
      pointer.materialVersion !== current.version
    )
      throw new Error("event-projection-pointer-corrupt");
    const activeRows = await this.gateway.batchGet([
      { pk: pointer.sportPk, sk: pointer.sportSk },
      { pk: pointer.leaguePk, sk: pointer.leagueSk },
    ]);
    const sportItem = activeRows.find(
      (row) => row.pk === pointer.sportPk && row.sk === pointer.sportSk,
    );
    const leagueItem = activeRows.find(
      (row) => row.pk === pointer.leaguePk && row.sk === pointer.leagueSk,
    );
    if (!sportItem || !leagueItem)
      throw new Error("event-projection-active-missing");
    const sportProjection = validateProjection(
      sportItem,
      "sport",
      input.observedAt,
    );
    const leagueProjection = validateProjection(
      leagueItem,
      "league",
      input.observedAt,
    );
    if (
      sportProjection.visibleUntil !== null ||
      leagueProjection.visibleUntil !== null ||
      sportProjection.eventId !== current.id ||
      leagueProjection.eventId !== current.id ||
      sportProjection.materialVersion !== current.version ||
      leagueProjection.materialVersion !== current.version
    )
      throw new Error("event-projection-active-corrupt");
    const commitAt = new Date(
      Math.max(
        Date.parse(input.observedAt),
        Date.parse(sportProjection.visibleFrom) + 1,
        Date.parse(leagueProjection.visibleFrom) + 1,
      ),
    ).toISOString() as IsoTimestamp;
    const nextProjections = projectionItems(next, commitAt);
    const history: EventHistoryEntry | undefined =
      current.startsAt !== next.startsAt || current.status !== next.status
        ? {
            id: stableDigest(
              JSON.stringify([
                id,
                input.providerId,
                input.revision.updatedAt,
                input.revision.sequence,
                input.revision.token,
              ]),
            ),
            eventId: id,
            providerId: input.providerId,
            revision: input.revision,
            changedAt: input.observedAt,
            previousStartsAt: current.startsAt,
            startsAt: next.startsAt,
            previousStatus: current.status,
            status: next.status,
          }
        : undefined;
    await this.transactIngestion(input, [
      ...identitySnapshotWrites(),
      ...(!mapped
        ? [
            {
              kind: "insert" as const,
              item: { pk: `MAPPING#${mid}`, sk: "CURRENT", value: mapping },
            },
          ]
        : []),
      {
        kind: "replace",
        item: { ...item, value: next },
        expectedVersion: current.version,
      },
      {
        kind: "put-projection",
        item: closeProjection(sportItem, commitAt),
        expectedValue: sportItem.value,
      },
      {
        kind: "put-projection",
        item: closeProjection(leagueItem, commitAt),
        expectedValue: leagueItem.value,
      },
      {
        kind: "put-projection",
        item: nextProjections.pointer,
        expectedValue: pointerItem.value,
      },
      {
        kind: "put-projection",
        item: nextProjections.sport,
        requireAbsent: true,
      },
      {
        kind: "put-projection",
        item: nextProjections.league,
        requireAbsent: true,
      },
      ...(current.candidateIdentity !== input.normalizedIdentity
        ? [
            {
              kind: "replace" as const,
              item: {
                pk: identityOwnerPk(
                  input.sportKey,
                  input.leagueKey,
                  current.candidateIdentity,
                ),
                sk: "CURRENT",
                value: {
                  candidateEventIds: [],
                  sportKey: input.sportKey,
                  leagueKey: input.leagueKey,
                  normalizedIdentity: current.candidateIdentity,
                  conflictCount: 0,
                  overflow: false,
                  version: nextIdentityVersion(previousIdentityClaimVersion!),
                },
              },
              expectedVersion: previousIdentityClaimVersion!,
            },
            targetIdentityResolution!.physicallyMissing
              ? {
                  kind: "claim-identity" as const,
                  item: {
                    pk: identityOwnerPk(
                      input.sportKey,
                      input.leagueKey,
                      input.normalizedIdentity,
                    ),
                    sk: "CURRENT",
                    value: {
                      candidateEventIds: [id],
                      sportKey: input.sportKey,
                      leagueKey: input.leagueKey,
                      normalizedIdentity: input.normalizedIdentity,
                      conflictCount: 1,
                      overflow: false,
                      version: 1,
                    },
                  },
                  eventId: id,
                }
              : {
                  kind: "replace" as const,
                  item: {
                    pk: identityOwnerPk(
                      input.sportKey,
                      input.leagueKey,
                      input.normalizedIdentity,
                    ),
                    sk: "CURRENT",
                    value: {
                      candidateEventIds: [id],
                      sportKey: input.sportKey,
                      leagueKey: input.leagueKey,
                      normalizedIdentity: input.normalizedIdentity,
                      conflictCount: 1,
                      overflow: false,
                      version: nextIdentityVersion(
                        targetIdentityResolution!.claimVersion!,
                      ),
                    },
                  },
                  expectedVersion: targetIdentityResolution!.claimVersion!,
                },
          ]
        : []),
      ...(history
        ? [
            {
              kind: "insert" as const,
              item: {
                pk: eventKey(id),
                sk: `HISTORY#${history.id}`,
                value: history,
              },
            },
          ]
        : []),
      revisionItem
        ? {
            kind: "replace",
            item: {
              pk: eventKey(id),
              sk: revisionSk,
              value: {
                ...input.revision,
                materialFingerprint,
                version: nextBoundedVersion(persistedRevision!.version),
              },
            },
            expectedVersion: persistedRevision!.version,
          }
        : {
            kind: "insert",
            item: {
              pk: eventKey(id),
              sk: revisionSk,
              value: { ...input.revision, materialFingerprint, version: 1 },
            },
          },
    ]);
    return { kind: "updated" as const, eventId: id };
  }
  async getCheckpoint(key: string) {
    const item = await this.gateway.get(`CHECKPOINT#${key}`, "CURRENT");
    return item ? validateCheckpoint(item.value, key) : null;
  }
  compareAndSetCheckpoint(
    expected: IngestionCheckpoint | null,
    next: IngestionCheckpoint,
  ) {
    return this.gateway.compareAndSetCheckpoint(
      `CHECKPOINT#${next.key}`,
      expected,
      next,
    );
  }
  putRun(run: LeagueIngestionRun) {
    return (async () => {
      const item = { pk: `RUN#${run.id}`, sk: "CURRENT", value: run };
      const inserted = await this.gateway.insert(item);
      if (inserted === "inserted") return;
      const existing = await this.gateway.get(item.pk, item.sk);
      if (JSON.stringify(existing?.value) !== JSON.stringify(run))
        throw new Error("run-id-collision");
    })();
  }
  async commitCheckpoint(
    expected: IngestionCheckpoint | null,
    next: IngestionCheckpoint,
    run: LeagueIngestionRun,
    continuation?: Parameters<EventIngestionStore["commitCheckpoint"]>[3],
    consumedPredecessor?: Parameters<
      EventIngestionStore["commitCheckpoint"]
    >[4],
  ) {
    validateCheckpointCommitLineage(next, run, continuation);
    validateCursorTransition(expected, next);
    if (consumedPredecessor)
      validateConsumedPredecessor(
        expected,
        next,
        run,
        consumedPredecessor,
        continuation,
      );
    const writes: DynamoWrite[] = [
      {
        kind: "insert",
        item: { pk: `RUN#${run.id}`, sk: "CURRENT", value: run },
      },
    ];
    if (next.position.state === "cursor") {
      const cursorDigest = stableDigest(next.position.cursor);
      writes.push({
        kind: "insert",
        item: {
          pk: `CURSOR_MARKER#${next.key}`,
          sk: cursorDigest,
          value: { checkpointKey: next.key, cursorDigest },
          expiresAt: Math.floor(Date.parse(next.windowEnd) / 1000) + 31_536_000,
        },
      });
    }
    if (continuation) {
      const id = continuationOutboxId(next, continuation);
      const outbox: ContinuationOutbox = {
        id,
        checkpointKey: next.key,
        providerId: next.providerId,
        predecessorRunId: run.id,
        command: continuation,
        cycle: next.continuationCycle,
        epoch: next.continuationCount,
        state: "intent",
        version: 1,
      };
      writes.push({
        kind: "insert",
        item: {
          pk: `OUTBOX_PENDING#${next.key}`,
          sk: continuationPendingSortKey(
            next.continuationCycle,
            next.continuationCount,
            id,
          ),
          value: outbox,
        },
      });
    }
    if (consumedPredecessor) {
      const { outbox, deliveredAt } = consumedPredecessor;
      if (outbox.state !== "claimed" || !outbox.claimantId)
        throw new Error("invalid-consumed-predecessor");
      const delivered: ContinuationOutbox = {
        ...outbox,
        state: "delivered",
        deliveredAt,
        version: nextBoundedVersion(outbox.version),
      };
      validateContinuationOutbox(delivered);
      writes.push(
        {
          kind: "delete",
          pk: `OUTBOX_PENDING#${outbox.checkpointKey}`,
          sk: continuationPendingSortKey(outbox.cycle, outbox.epoch, outbox.id),
          expectedVersion: outbox.version,
        },
        {
          kind: "insert",
          item: {
            pk: `OUTBOX_DELIVERED#${outbox.checkpointKey}`,
            sk: outbox.id,
            expiresAt: Math.floor(Date.parse(deliveredAt) / 1000) + 604_800,
            value: delivered,
          },
        },
      );
    }
    let uncertainError: unknown;
    let committed = false;
    try {
      committed = await this.gateway.transactCheckpoint(
        `CHECKPOINT#${next.key}`,
        expected,
        next,
        writes,
      );
    } catch (error) {
      uncertainError = error;
    }
    if (committed) return true;
    // A transaction may have committed even when its response was lost.
    const [checkpoint, existingRun] = await Promise.all([
      this.getCheckpoint(next.key),
      this.gateway.get(`RUN#${run.id}`, "CURRENT"),
    ]);
    if (
      JSON.stringify(checkpoint) !== JSON.stringify(next) ||
      JSON.stringify(existingRun?.value) !== JSON.stringify(run)
    ) {
      if (uncertainError)
        throw uncertainError instanceof Error
          ? uncertainError
          : new Error("checkpoint-commit-failed", {
              cause: uncertainError,
            });
      return false;
    }
    if (consumedPredecessor) {
      const consumed = await this.gateway.get(
        `OUTBOX_DELIVERED#${consumedPredecessor.outbox.checkpointKey}`,
        consumedPredecessor.outbox.id,
      );
      const value = consumed
        ? validateContinuationOutbox(consumed.value)
        : undefined;
      if (!value || value.state !== "delivered") {
        if (uncertainError)
          throw new Error("checkpoint-commit-uncertain", {
            cause: uncertainError,
          });
        return false;
      }
    }
    if (!continuation) return true;
    const id = continuationOutboxId(next, continuation);
    const pendingSk = continuationPendingSortKey(
      next.continuationCycle,
      next.continuationCount,
      id,
    );
    const [existingPending, existingDelivered] = await Promise.all([
      this.gateway.get(`OUTBOX_PENDING#${next.key}`, pendingSk),
      this.gateway.get(`OUTBOX_DELIVERED#${next.key}`, id),
    ]);
    const matchesRecoveredOutbox = (
      item: DynamoItem | null,
      partition: "pending" | "delivered",
    ) => {
      if (!item) return false;
      const value = validateContinuationOutbox(item.value);
      const physicalMatch =
        partition === "pending"
          ? item.pk === `OUTBOX_PENDING#${next.key}` && item.sk === pendingSk
          : item.pk === `OUTBOX_DELIVERED#${next.key}` && item.sk === id;
      const stateMatch =
        partition === "pending"
          ? value.state === "intent" || value.state === "claimed"
          : value.state === "delivered";
      if (
        !physicalMatch ||
        !stateMatch ||
        value.checkpointKey !== next.key ||
        value.id !== id
      )
        throw new Error("continuation-storage-key-mismatch");
      return (
        canonicalContinuationCommand(value.command) ===
        canonicalContinuationCommand(continuation)
      );
    };
    const recovered =
      matchesRecoveredOutbox(existingPending, "pending") ||
      matchesRecoveredOutbox(existingDelivered, "delivered");
    if (!recovered && uncertainError)
      throw uncertainError instanceof Error
        ? uncertainError
        : new Error("checkpoint-commit-failed", {
            cause: uncertainError,
          });
    return recovered;
  }
  async claimPendingContinuation(
    claimantId: string,
    claimedAt: IsoTimestamp,
    leaseUntil: IsoTimestamp,
    checkpointKey: string,
  ) {
    validateContinuationLease(claimantId, claimedAt, leaseUntil);
    const items = await this.gateway.queryUpTo(
      `OUTBOX_PENDING#${checkpointKey}`,
      1,
    );
    const now = Date.parse(claimedAt);
    const validated = items.map((candidate) => {
      const outbox = validateContinuationOutbox(candidate.value);
      if (
        candidate.pk !== `OUTBOX_PENDING#${checkpointKey}` ||
        candidate.sk !==
          continuationPendingSortKey(outbox.cycle, outbox.epoch, outbox.id) ||
        outbox.checkpointKey !== checkpointKey
      )
        throw new Error("continuation-storage-key-mismatch");
      if (outbox.state === "delivered")
        throw new Error("invalid-pending-continuation-state");
      return { candidate, outbox };
    });
    const first = validated[0];
    if (!first) return null;
    const { candidate: item, outbox: current } = first;
    if (
      current.checkpointKey !== checkpointKey ||
      (current.state === "claimed" &&
        !!current.leaseUntil &&
        Date.parse(current.leaseUntil) > now)
    )
      return null;
    const claimed: ContinuationOutbox = {
      ...current,
      state: "claimed",
      claimantId,
      claimedAt,
      leaseUntil,
      version: nextBoundedVersion(current.version),
    };
    validateContinuationOutbox(claimed);
    try {
      await this.gateway.transact([
        {
          kind: "replace",
          item: { ...item, value: claimed },
          expectedVersion: current.version,
        },
      ]);
      return claimed;
    } catch (error) {
      if (error instanceof DynamoConditionalConflict) return null;
      throw error;
    }
  }
  async hasUndeliveredContinuation(checkpointKey: string) {
    const items = await this.gateway.queryUpTo(
      `OUTBOX_PENDING#${checkpointKey}`,
      100,
    );
    for (const item of items) {
      const outbox = validateContinuationOutbox(item.value);
      if (
        item.pk !== `OUTBOX_PENDING#${checkpointKey}` ||
        item.sk !==
          continuationPendingSortKey(outbox.cycle, outbox.epoch, outbox.id) ||
        outbox.checkpointKey !== checkpointKey
      )
        throw new Error("continuation-storage-key-mismatch");
      if (outbox.state === "delivered")
        throw new Error("invalid-pending-continuation-state");
    }
    return items.length > 0;
  }
  async markContinuationDelivered(
    id: string,
    checkpointKey: string,
    cycle: number,
    epoch: number,
    claimantId: string,
    deliveredAt: IsoTimestamp,
  ) {
    const pendingSk = continuationPendingSortKey(cycle, epoch, id);
    const item = await this.gateway.get(
      `OUTBOX_PENDING#${checkpointKey}`,
      pendingSk,
    );
    if (!item) {
      const delivered = await this.gateway.get(
        `OUTBOX_DELIVERED#${checkpointKey}`,
        id,
      );
      if (delivered) {
        const value = validateContinuationOutbox(delivered.value);
        if (
          delivered.pk !== `OUTBOX_DELIVERED#${checkpointKey}` ||
          delivered.sk !== id ||
          value.checkpointKey !== checkpointKey ||
          value.id !== id
        )
          throw new Error("continuation-storage-key-mismatch");
        if (value.state !== "delivered")
          throw new Error("invalid-delivered-continuation-state");
        if (
          value.id === id &&
          value.checkpointKey === checkpointKey &&
          value.cycle === cycle &&
          value.epoch === epoch
        )
          return;
      }
      throw new Error("missing-continuation");
    }
    const current = validateContinuationOutbox(item.value);
    if (
      item.pk !== `OUTBOX_PENDING#${checkpointKey}` ||
      item.sk !==
        continuationPendingSortKey(current.cycle, current.epoch, current.id) ||
      current.cycle !== cycle ||
      current.checkpointKey !== checkpointKey
    )
      throw new Error("continuation-storage-key-mismatch");
    if (current.state !== "claimed" || current.claimantId !== claimantId)
      throw new Error("continuation-claim-lost");
    const delivered: ContinuationOutbox = {
      ...current,
      state: "delivered",
      deliveredAt,
      version: nextBoundedVersion(current.version),
    };
    validateContinuationOutbox(delivered);
    await this.gateway.transact([
      {
        kind: "delete",
        pk: item.pk,
        sk: item.sk,
        expectedVersion: current.version,
      },
      {
        kind: "insert",
        item: {
          pk: `OUTBOX_DELIVERED#${checkpointKey}`,
          sk: id,
          expiresAt: Math.floor(Date.parse(deliveredAt) / 1000) + 604_800,
          value: delivered,
        },
      },
    ]);
  }
}
