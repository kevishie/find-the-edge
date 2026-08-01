import type {
  CanonicalEvent,
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
import {
  bootstrapMarkerId,
  canonicalContinuationCommand,
  compareAuthority,
  compareRevision,
  equalProviderRevision,
  continuationPendingSortKey,
  continuationOutboxId,
  identityKey,
  mappingId,
  maxAuthority,
  repairAuthorityPointer,
  nextIdentityVersion,
  nextBoundedVersion,
  providerEventFenceId,
  providerEventPagePositionDigest,
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
  validateIdentityClaim,
  validateUnresolvedEventMapping,
  type EventIngestionInput,
  type EventIngestionStore,
  type ContinuationOutbox,
  type ProviderEventFence,
  type IdentityClaim,
} from "./event-ingestion";
import {
  closeProjection,
  projectionItems,
  validateProjection,
  type EventDetailPointer,
} from "./event-read-projection";
export class MemoryEventIngestionStore implements EventIngestionStore {
  readonly eventReadItems = new Map<
    string,
    import("./dynamodb-event-ingestion").DynamoItem
  >();
  eventReadInitialized = false;
  private putProjection(item: import("./dynamodb-event-ingestion").DynamoItem) {
    this.eventReadItems.set(`${item.pk}\0${item.sk}`, item);
  }
  private initializeProjection(event: CanonicalEvent, commitAt: string) {
    const projected = projectionItems(event, commitAt as IsoTimestamp);
    this.putProjection(projected.pointer);
    this.putProjection(projected.sport);
    this.putProjection(projected.league);
    this.eventReadInitialized = true;
  }
  private transitionProjection(
    previous: CanonicalEvent,
    next: CanonicalEvent,
    trustedNow: string,
  ) {
    const pointerItem = this.eventReadItems.get(
      `EVENT_DETAIL#${previous.id}\0CURRENT`,
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
      pointer.eventId !== previous.id ||
      pointer.materialVersion !== previous.version
    )
      throw new Error("event-projection-pointer-corrupt");
    const sportItem = this.eventReadItems.get(
      `${pointer.sportPk}\0${pointer.sportSk}`,
    );
    const leagueItem = this.eventReadItems.get(
      `${pointer.leaguePk}\0${pointer.leagueSk}`,
    );
    if (!sportItem || !leagueItem)
      throw new Error("event-projection-active-missing");
    const sport = validateProjection(sportItem, "sport", trustedNow);
    const league = validateProjection(leagueItem, "league", trustedNow);
    if (
      sport.visibleUntil !== null ||
      league.visibleUntil !== null ||
      sport.eventId !== previous.id ||
      league.eventId !== previous.id ||
      sport.materialVersion !== previous.version ||
      league.materialVersion !== previous.version
    )
      throw new Error("event-projection-active-corrupt");
    const commitAt = new Date(
      Math.max(
        Date.parse(trustedNow),
        Date.parse(sport.visibleFrom) + 1,
        Date.parse(league.visibleFrom) + 1,
      ),
    ).toISOString();
    this.putProjection(closeProjection(sportItem, commitAt));
    this.putProjection(closeProjection(leagueItem, commitAt));
    this.initializeProjection(next, commitAt);
  }
  readonly events = new Map<string, CanonicalEvent>();
  readonly identityAggregates = new Map<string, IdentityClaim>();
  readonly providerEventFences = new Map<string, ProviderEventFence>();
  readonly providerPageFingerprints = new Map<string, string>();
  readonly bootstrapMarkers = new Map<string, string>();
  readonly bootstrapResponses = new Map<string, unknown>();
  readonly mappings = new Map<string, ProviderEventMapping>();
  readonly providerRevisions = new Map<
    string,
    | ProviderRevision
    | {
        readonly revision: ProviderRevision;
        readonly materialFingerprint: string;
      }
  >();
  readonly histories = new Map<string, EventHistoryEntry>();
  readonly unresolved = new Map<string, UnresolvedEventMapping>();
  readonly unresolvedObservations = new Map<
    string,
    UnresolvedEventMapping["observations"][number]
  >();
  readonly checkpoints = new Map<string, IngestionCheckpoint>();
  readonly cursorDigests = new Set<string>();
  readonly runs = new Map<string, LeagueIngestionRun>();
  readonly continuations = new Map<string, ContinuationOutbox>();
  readonly deliveredContinuations = new Map<string, ContinuationOutbox>();
  private resolveIdentity(
    sportKey: SportKey,
    leagueKey: string,
    identity: string,
  ) {
    const key = identityKey(sportKey, leagueKey, identity);
    const rawAggregate = this.identityAggregates.get(key);
    if (!rawAggregate) return { state: "missing" as const, candidateIds: [] };
    const aggregate = validateIdentityClaim(
      rawAggregate,
      sportKey,
      leagueKey,
      identity,
    );
    const candidateIds = [...aggregate.candidateEventIds].sort();
    if (
      JSON.stringify(candidateIds) !==
        JSON.stringify(aggregate.candidateEventIds) ||
      new Set(candidateIds).size !== candidateIds.length
    )
      throw new Error("invalid-identity-aggregate");
    if (candidateIds.length > 2) throw new Error("identity-candidate-limit");
    for (const eventId of candidateIds) {
      const event = this.events.get(eventId);
      if (!event) throw new Error("dangling-identity-aggregate");
      const canonical = validateCanonicalEvent(event);
      if (
        canonical.id !== eventId ||
        canonical.sportKey !== sportKey ||
        canonical.leagueKey !== leagueKey ||
        canonical.candidateIdentity !== identity
      )
        throw new Error("stale-identity-aggregate");
    }
    return aggregate.overflow || candidateIds.length === 2
      ? { state: "ambiguous" as const, candidateIds }
      : candidateIds.length === 0
        ? { state: "missing" as const, candidateIds }
        : { state: "present" as const, candidateIds };
  }
  async registerCandidate(event: CanonicalEvent) {
    await Promise.resolve();
    const canonical = validateCanonicalEvent(repairAuthorityPointer(event));
    const key = identityKey(
      canonical.sportKey,
      canonical.leagueKey,
      canonical.candidateIdentity,
    );
    const rawCurrent = this.identityAggregates.get(key);
    const current = rawCurrent
      ? validateIdentityClaim(
          rawCurrent,
          canonical.sportKey,
          canonical.leagueKey,
          canonical.candidateIdentity,
        )
      : undefined;
    const candidates = new Set(current?.candidateEventIds ?? []);
    const rawExisting = this.events.get(canonical.id);
    const existing = rawExisting
      ? validateCanonicalEvent(repairAuthorityPointer(rawExisting))
      : undefined;
    if (existing && rawExisting !== existing)
      this.events.set(existing.id, existing);
    if (
      existing &&
      (existing.id !== canonical.id ||
        existing.sportKey !== canonical.sportKey ||
        existing.leagueKey !== canonical.leagueKey ||
        existing.candidateIdentity !== canonical.candidateIdentity)
    )
      throw new Error("canonical-candidate-conflict");
    if (candidates.has(canonical.id)) {
      if (!existing) throw new Error("dangling-identity-aggregate");
      return "already-registered" as const;
    }
    if (candidates.size === 2 && current?.overflow)
      return "already-registered" as const;
    if (current?.conflictCount === Number.MAX_SAFE_INTEGER)
      throw new Error("identity-conflict-count-exhausted");
    const isOverflow = candidates.size === 2;
    if (candidates.size < 2) candidates.add(canonical.id);
    const sorted = [...candidates].sort().slice(0, 2);
    const nextVersion = nextIdentityVersion(current?.version ?? 0);
    if (!isOverflow) this.events.set(canonical.id, canonical);
    this.identityAggregates.set(key, {
      candidateEventIds: sorted as [EntityId] | [EntityId, EntityId],
      sportKey: canonical.sportKey,
      leagueKey: canonical.leagueKey,
      normalizedIdentity: canonical.candidateIdentity,
      conflictCount: isOverflow ? 3 : (current?.conflictCount ?? 0) + 1,
      overflow: isOverflow,
      version: nextVersion,
    });
    return "registered" as const;
  }
  async getExactMapping(
    input: Pick<
      EventIngestionInput,
      "providerId" | "providerEventId" | "sportKey" | "leagueKey"
    >,
  ) {
    await Promise.resolve();
    const rawMapping = this.mappings.get(mappingId(input));
    const mapping = rawMapping
      ? validateProviderEventMapping(rawMapping)
      : undefined;
    if (!mapping) return null;
    if (
      mapping.sportKey !== input.sportKey ||
      mapping.leagueKey !== input.leagueKey ||
      mapping.providerId !== input.providerId ||
      mapping.providerEventId !== input.providerEventId
    )
      throw new Error("mapping-scope-mismatch");
    const canonical = this.events.get(mapping.canonicalEventId);
    if (!canonical) throw new Error("mapping-canonical-missing");
    const validated = validateCanonicalEvent(canonical);
    if (
      validated.id !== mapping.canonicalEventId ||
      validated.sportKey !== input.sportKey ||
      validated.leagueKey !== input.leagueKey
    )
      throw new Error("mapping-canonical-scope-mismatch");
    return { canonicalEventId: mapping.canonicalEventId };
  }
  async getProviderEventFence(
    checkpointKey: string,
    providerEventId: string,
    pagePosition: Parameters<EventIngestionStore["getProviderEventFence"]>[2],
  ) {
    await Promise.resolve();
    const id = providerEventFenceId(checkpointKey, providerEventId);
    const value = this.providerEventFences.get(id);
    if (!value) return "missing" as const;
    const fence = validateProviderEventFence(value, checkpointKey, id);
    return fence.pagePositionDigest ===
      providerEventPagePositionDigest(pagePosition)
      ? ("same-page" as const)
      : ("duplicate" as const);
  }
  async getProviderEventFences(
    checkpointKey: string,
    providerEventIds: readonly string[],
    pagePosition: Parameters<EventIngestionStore["getProviderEventFences"]>[2],
  ) {
    return Promise.all(
      providerEventIds.map((providerEventId) =>
        this.getProviderEventFence(
          checkpointKey,
          providerEventId,
          pagePosition,
        ),
      ),
    );
  }
  async recordProviderPageFingerprint(
    checkpointKey: string,
    pagePosition: IngestionCheckpoint["position"],
    pageFingerprint: string,
    windowEnd: IsoTimestamp,
    observedAt: IsoTimestamp,
  ) {
    await Promise.resolve();
    void windowEnd;
    void observedAt;
    const key = `${checkpointKey}:${providerEventPagePositionDigest(pagePosition)}`;
    const current = this.providerPageFingerprints.get(key);
    if (current && current !== pageFingerprint)
      throw new Error("provider-page-replay-conflict");
    this.providerPageFingerprints.set(key, pageFingerprint);
  }
  private commitProviderEventFence(input: EventIngestionInput): void {
    const context = input.providerEventFence;
    if (!context) return;
    const id = providerEventFenceId(
      context.checkpointKey,
      input.providerEventId,
    );
    const pagePositionDigest = providerEventPagePositionDigest(
      context.pagePosition,
    );
    const current = this.providerEventFences.get(id);
    if (current) {
      const fence = validateProviderEventFence(
        current,
        context.checkpointKey,
        id,
      );
      if (fence.pagePositionDigest !== pagePositionDigest)
        throw new Error("duplicate-provider-event");
      return;
    }
    this.providerEventFences.set(id, {
      id,
      checkpointKey: context.checkpointKey,
      pagePositionDigest,
      version: 1,
    });
  }
  async getCanonicalByIdentity(
    sportKey: SportKey,
    leagueKey: string,
    identity: string,
  ) {
    await Promise.resolve();
    return this.resolveIdentity(sportKey, leagueKey, identity).state;
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
    await Promise.resolve();
    void windowEnd;
    const positionDigest = providerEventPagePositionDigest(pagePosition);
    const markerIds = events.flatMap((event) => [
      bootstrapMarkerId(checkpointKey, "id", event.id),
      bootstrapMarkerId(checkpointKey, "identity", event.normalizedIdentity),
    ]);
    const existing = markerIds.map((id) => this.bootstrapMarkers.get(id));
    if (existing.some((digest) => digest && digest !== positionDigest))
      throw new Error("duplicate-bootstrap-position");
    const allSame =
      existing.length > 0 &&
      existing.every((digest) => digest === positionDigest);
    if (!allSame)
      for (const id of markerIds) this.bootstrapMarkers.set(id, positionDigest);
    return allSame ? ("same-position" as const) : ("recorded" as const);
  }
  async putBootstrapResponse(
    reservationId: string,
    response: unknown,
    windowEnd: IsoTimestamp,
  ) {
    await Promise.resolve();
    void windowEnd;
    const existing = this.bootstrapResponses.get(reservationId);
    if (existing && JSON.stringify(existing) !== JSON.stringify(response))
      throw new Error("bootstrap-response-conflict");
    this.bootstrapResponses.set(reservationId, structuredClone(response));
  }
  async getBootstrapResponse(reservationId: string) {
    await Promise.resolve();
    const response = this.bootstrapResponses.get(reservationId);
    return response === undefined ? null : structuredClone(response);
  }

  async bootstrapCanonicalEvent(
    input: Parameters<EventIngestionStore["bootstrapCanonicalEvent"]>[0],
    observedAt: Parameters<EventIngestionStore["bootstrapCanonicalEvent"]>[1],
  ) {
    await Promise.resolve();
    const rawExisting = this.events.get(input.id);
    const existing = rawExisting
      ? validateCanonicalEvent(rawExisting)
      : undefined;
    const key = identityKey(
      input.sportKey,
      input.leagueKey,
      input.normalizedIdentity,
    );
    const resolution = this.resolveIdentity(
      input.sportKey,
      input.leagueKey,
      input.normalizedIdentity,
    );
    if (
      resolution.state === "ambiguous" ||
      (resolution.candidateIds[0] && resolution.candidateIds[0] !== input.id)
    )
      throw new Error("bootstrap-identity-already-exists");
    if (existing) {
      const currentWinner = maxAuthority(
        existing.authoritativeRevision,
        existing.bootstrapRevision,
        ...Object.values(existing.revisions),
      );
      if (
        existing.sportKey !== input.sportKey ||
        existing.leagueKey !== input.leagueKey ||
        existing.leagueId !== input.leagueId ||
        existing.phase !== input.phase ||
        JSON.stringify(existing.participantIds) !==
          JSON.stringify(input.participantIds)
      )
        throw new Error("bootstrap-content-mismatch");
      if (currentWinner && compareAuthority(input.revision, currentWinner) < 0)
        throw new Error("bootstrap-stale");
      if (
        currentWinner &&
        compareAuthority(input.revision, currentWinner) === 0 &&
        (existing.candidateIdentity !== input.normalizedIdentity ||
          existing.startsAt !== input.startsAt ||
          existing.status !== input.status)
      )
        throw new Error("bootstrap-revision-content-conflict");
      const previousKey = identityKey(
        input.sportKey,
        input.leagueKey,
        existing.candidateIdentity,
      );
      const requestedKey = identityKey(
        input.sportKey,
        input.leagueKey,
        input.normalizedIdentity,
      );
      const requestedAggregate = this.identityAggregates.get(requestedKey);
      const requestedIds: readonly EntityId[] = requestedAggregate
        ? [...requestedAggregate.candidateEventIds]
        : [];
      if (
        requestedIds.length > 1 ||
        (requestedIds[0] && requestedIds[0] !== existing.id)
      )
        throw new Error("bootstrap-identity-already-exists");
      const repaired =
        existing.candidateIdentity !== input.normalizedIdentity ||
        !requestedIds.includes(existing.id) ||
        existing.startsAt !== input.startsAt ||
        existing.status !== input.status ||
        compareAuthority(input.revision, currentWinner) > 0;
      const previous = this.identityAggregates.get(previousKey);
      const nextPreviousVersion =
        previousKey !== requestedKey && previous
          ? nextIdentityVersion(previous.version)
          : undefined;
      const nextEventVersion =
        existing.candidateIdentity !== input.normalizedIdentity ||
        existing.startsAt !== input.startsAt ||
        existing.status !== input.status ||
        compareAuthority(input.revision, currentWinner) > 0
          ? nextIdentityVersion(existing.version)
          : undefined;
      const nextRequestedVersion = !requestedIds.includes(existing.id)
        ? nextIdentityVersion(requestedAggregate?.version ?? 0)
        : undefined;
      const nextEvent =
        nextEventVersion === undefined
          ? undefined
          : validateCanonicalEvent({
              ...existing,
              startsAt: input.startsAt,
              status: input.status,
              candidateIdentity: input.normalizedIdentity,
              bootstrapRevision: input.revision,
              authoritativeRevision: maxAuthority(
                existing.authoritativeRevision,
                existing.bootstrapRevision,
                ...Object.values(existing.revisions),
                input.revision,
              ),
              updatedAt:
                Date.parse(observedAt) > Date.parse(existing.updatedAt)
                  ? observedAt
                  : existing.updatedAt,
              version: nextEventVersion,
            });
      if (
        existing.candidateIdentity !== input.normalizedIdentity ||
        existing.startsAt !== input.startsAt ||
        existing.status !== input.status ||
        compareAuthority(input.revision, currentWinner) > 0
      ) {
        if (
          !previous ||
          previous.candidateEventIds.length !== 1 ||
          previous.candidateEventIds[0] !== existing.id
        )
          throw new Error("identity-claim-conflict");
        if (previousKey !== requestedKey)
          this.identityAggregates.set(previousKey, {
            candidateEventIds: [],
            sportKey: input.sportKey,
            leagueKey: input.leagueKey,
            normalizedIdentity: existing.candidateIdentity,
            conflictCount: 0,
            overflow: false,
            version: nextPreviousVersion!,
          });
        this.events.set(existing.id, nextEvent!);
      }
      if (!requestedIds.includes(existing.id))
        this.identityAggregates.set(requestedKey, {
          candidateEventIds: [existing.id],
          sportKey: input.sportKey,
          leagueKey: input.leagueKey,
          normalizedIdentity: input.normalizedIdentity,
          conflictCount: 1,
          overflow: false,
          version: nextRequestedVersion!,
        });
      return repaired ? ("repaired" as const) : ("existing" as const);
    }
    const identityAggregate = this.identityAggregates.get(key);
    if (
      identityAggregate &&
      (identityAggregate.candidateEventIds.length > 1 ||
        (identityAggregate.candidateEventIds[0] &&
          identityAggregate.candidateEventIds[0] !== input.id))
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
    this.events.set(event.id, event);
    this.initializeProjection(event, observedAt);
    this.identityAggregates.set(key, {
      candidateEventIds: [event.id],
      sportKey: input.sportKey,
      leagueKey: input.leagueKey,
      normalizedIdentity: input.normalizedIdentity,
      conflictCount: 1,
      overflow: false,
      version: nextIdentityVersion(identityAggregate?.version ?? 0),
    });
    return "created" as const;
  }
  async ingestEvent(input: EventIngestionInput) {
    await Promise.resolve();
    const mid = mappingId(input),
      rawMapped = this.mappings.get(mid),
      mapped = rawMapped ? validateProviderEventMapping(rawMapped) : undefined;
    if (
      mapped &&
      (mapped.sportKey !== input.sportKey ||
        mapped.leagueKey !== input.leagueKey)
    )
      throw new Error("mapping-scope-mismatch");
    const key = identityKey(
      input.sportKey,
      input.leagueKey,
      input.normalizedIdentity,
    );
    const resolution = mapped
      ? undefined
      : this.resolveIdentity(
          input.sportKey,
          input.leagueKey,
          input.normalizedIdentity,
        );
    const candidates = mapped
      ? [mapped.canonicalEventId]
      : resolution!.candidateIds;
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
      const current = this.unresolved.get(unresolved.id);
      const observationId = stableDigest(
        JSON.stringify([unresolved.id, observation]),
      );
      if (this.unresolvedObservations.has(observationId)) {
        this.commitProviderEventFence(input);
        return { kind: "unresolved" as const, reason: unresolved.reason };
      }
      this.commitProviderEventFence(input);
      if (!current) {
        this.unresolved.set(unresolved.id, unresolved);
        this.unresolvedObservations.set(observationId, observation);
      } else if (
        !current.observations.some(
          (item) =>
            item.observedAt === observation.observedAt &&
            item.reason === observation.reason &&
            JSON.stringify(item.candidateEventIds) ===
              JSON.stringify(observation.candidateEventIds),
        )
      )
        this.unresolved.set(unresolved.id, {
          ...current,
          reason: observation.reason,
          candidateEventIds: candidates,
          observations: [...current.observations, observation].slice(-20),
          version: nextBoundedVersion(current.version),
        });
      this.unresolvedObservations.set(observationId, observation);
      return { kind: "unresolved" as const, reason: unresolved.reason };
    }
    const id = candidates[0]!,
      current = this.events.get(id);
    if (!current) throw new Error("missing-event");
    const canonical = validateCanonicalEvent(current);
    if (
      canonical.id !== id ||
      canonical.sportKey !== input.sportKey ||
      canonical.leagueKey !== input.leagueKey
    )
      throw new Error("mapping-canonical-scope-mismatch");
    const persistedEvidence = this.providerRevisions.get(
      stableDigest(JSON.stringify([id, input.providerId])),
    );
    const persistedRevision =
      persistedEvidence && "revision" in persistedEvidence
        ? persistedEvidence.revision
        : persistedEvidence;
    const materialFingerprint = stableDigest(
      JSON.stringify([
        input.normalizedIdentity,
        input.startsAt,
        input.status,
        input.participantLabels ?? current.participantLabels,
      ]),
    );
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
      (!!canonical.authoritativeRevision &&
        canonical.authoritativeRevision.providerId === input.providerId &&
        compareRevision(canonical.authoritativeRevision, providerPrior) ===
          0) ||
      (!!canonical.bootstrapRevision &&
        canonical.bootstrapRevision.providerId === input.providerId &&
        compareRevision(canonical.bootstrapRevision, providerPrior) === 0);
    const canonicalSupportsPersistedRevision =
      !!persistedRevision &&
      ((!!canonical.authoritativeRevision &&
        canonical.authoritativeRevision.providerId === input.providerId &&
        equalProviderRevision(
          canonical.authoritativeRevision,
          persistedRevision,
        )) ||
        (!!canonical.bootstrapRevision &&
          canonical.bootstrapRevision.providerId === input.providerId &&
          equalProviderRevision(
            canonical.bootstrapRevision,
            persistedRevision,
          )));
    const mapping: ProviderEventMapping = mapped ?? {
      id: mid,
      providerId: input.providerId,
      providerEventId: input.providerEventId,
      canonicalEventId: id,
      sportKey: input.sportKey,
      leagueKey: input.leagueKey,
      createdAt: input.observedAt,
    };
    if (
      providerComparison === 0 &&
      (persistedIsProviderPrior &&
      persistedEvidence &&
      "revision" in persistedEvidence
        ? persistedEvidence.materialFingerprint !== materialFingerprint
        : persistedIsProviderPrior
          ? !canonicalSupportsProviderPrior ||
            canonical.startsAt !== input.startsAt ||
            canonical.status !== input.status ||
            canonical.candidateIdentity !== input.normalizedIdentity
          : !canonicalSupportsProviderPrior ||
            canonical.startsAt !== input.startsAt ||
            canonical.status !== input.status ||
            canonical.candidateIdentity !== input.normalizedIdentity)
    )
      throw new Error("provider-revision-content-conflict");
    if (providerComparison <= 0) {
      this.commitProviderEventFence(input);
      if (!mapped) this.mappings.set(mid, mapping);
      if (
        persistedEvidence &&
        !("revision" in persistedEvidence) &&
        equalProviderRevision(input.revision, persistedEvidence) &&
        canonicalSupportsPersistedRevision &&
        canonical.startsAt === input.startsAt &&
        canonical.status === input.status &&
        canonical.candidateIdentity === input.normalizedIdentity &&
        (canonical.authoritativeRevision?.providerId === input.providerId ||
          canonical.bootstrapRevision?.providerId === input.providerId)
      )
        this.providerRevisions.set(
          stableDigest(JSON.stringify([id, input.providerId])),
          { revision: persistedEvidence, materialFingerprint },
        );
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
      this.commitProviderEventFence(input);
      if (!mapped) this.mappings.set(mid, mapping);
      this.providerRevisions.set(
        stableDigest(JSON.stringify([id, input.providerId])),
        { revision: input.revision, materialFingerprint },
      );
      return { kind: "skipped" as const, eventId: id };
    }
    if (current.candidateIdentity !== input.normalizedIdentity) {
      const target = this.identityAggregates.get(key);
      if (target && target.candidateEventIds.length > 0)
        throw new Error("identity-claim-conflict");
      const oldKey = identityKey(
        input.sportKey,
        input.leagueKey,
        current.candidateIdentity,
      );
      const old = this.identityAggregates.get(oldKey);
      if (
        !old ||
        old.candidateEventIds.length !== 1 ||
        old.candidateEventIds[0] !== current.id
      )
        throw new Error("identity-claim-conflict");
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
    const previousIdentity =
      current.candidateIdentity !== input.normalizedIdentity
        ? this.identityAggregates.get(
            identityKey(
              input.sportKey,
              input.leagueKey,
              current.candidateIdentity,
            ),
          )
        : undefined;
    const targetIdentity =
      current.candidateIdentity !== input.normalizedIdentity
        ? this.identityAggregates.get(key)
        : undefined;
    const previousIdentityVersion = previousIdentity
      ? nextIdentityVersion(previousIdentity.version)
      : undefined;
    const targetIdentityVersion =
      current.candidateIdentity !== input.normalizedIdentity
        ? nextIdentityVersion(targetIdentity?.version ?? 0)
        : undefined;
    this.commitProviderEventFence(input);
    this.mappings.set(mid, mapping);
    this.providerRevisions.set(
      stableDigest(JSON.stringify([id, input.providerId])),
      { revision: input.revision, materialFingerprint },
    );
    this.events.set(id, next);
    this.transitionProjection(current, next, input.observedAt);
    if (current.candidateIdentity !== input.normalizedIdentity) {
      const oldKey = identityKey(
        input.sportKey,
        input.leagueKey,
        current.candidateIdentity,
      );
      this.identityAggregates.set(oldKey, {
        candidateEventIds: [],
        sportKey: input.sportKey,
        leagueKey: input.leagueKey,
        normalizedIdentity: current.candidateIdentity,
        conflictCount: 0,
        overflow: false,
        version: previousIdentityVersion!,
      });
      this.identityAggregates.set(key, {
        candidateEventIds: [id],
        sportKey: input.sportKey,
        leagueKey: input.leagueKey,
        normalizedIdentity: input.normalizedIdentity,
        conflictCount: 1,
        overflow: false,
        version: targetIdentityVersion!,
      });
    }
    if (history) this.histories.set(history.id, history);
    return { kind: "updated" as const, eventId: id };
  }
  async getCheckpoint(key: string) {
    await Promise.resolve();
    const checkpoint = this.checkpoints.get(key);
    return checkpoint ? validateCheckpoint(checkpoint, key) : null;
  }
  async hasCursorDigest(checkpointKey: string, cursorDigest: string) {
    await Promise.resolve();
    return this.cursorDigests.has(`${checkpointKey}:${cursorDigest}`);
  }
  async compareAndSetCheckpoint(
    expected: IngestionCheckpoint | null,
    next: IngestionCheckpoint,
  ) {
    await Promise.resolve();
    const current = this.checkpoints.get(next.key) ?? null;
    if (JSON.stringify(current) !== JSON.stringify(expected)) return false;
    this.checkpoints.set(next.key, next);
    return true;
  }
  async putRun(run: LeagueIngestionRun) {
    await Promise.resolve();
    const existing = this.runs.get(run.id);
    if (existing && JSON.stringify(existing) !== JSON.stringify(run))
      throw new Error("run-id-collision");
    this.runs.set(run.id, run);
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
    await Promise.resolve();
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
    const current = this.checkpoints.get(next.key) ?? null;
    if (JSON.stringify(current) !== JSON.stringify(expected)) {
      const existingRun = this.runs.get(run.id);
      const id = continuation
        ? continuationOutboxId(next, continuation)
        : undefined;
      const existingOutbox = continuation
        ? this.continuations.get(
            continuationPendingSortKey(
              next.continuationCycle,
              next.continuationCount,
              id!,
            ),
          )
        : undefined;
      return (
        JSON.stringify(current) === JSON.stringify(next) &&
        JSON.stringify(existingRun) === JSON.stringify(run) &&
        (!consumedPredecessor ||
          this.deliveredContinuations.get(consumedPredecessor.outbox.id)
            ?.state === "delivered") &&
        (!continuation ||
          (existingOutbox?.checkpointKey === next.key &&
            canonicalContinuationCommand(existingOutbox.command) ===
              canonicalContinuationCommand(continuation)))
      );
    }
    const existingRun = this.runs.get(run.id);
    if (existingRun && JSON.stringify(existingRun) !== JSON.stringify(run))
      throw new Error("run-id-collision");
    let deliveredPredecessor: ContinuationOutbox | undefined;
    let predecessorKey: string | undefined;
    if (consumedPredecessor) {
      const { outbox, deliveredAt } = consumedPredecessor;
      predecessorKey = continuationPendingSortKey(
        outbox.cycle,
        outbox.epoch,
        outbox.id,
      );
      const currentPredecessor = this.continuations.get(predecessorKey);
      if (
        !currentPredecessor ||
        JSON.stringify(currentPredecessor) !== JSON.stringify(outbox) ||
        outbox.state !== "claimed"
      )
        return false;
      deliveredPredecessor = {
        ...outbox,
        state: "delivered",
        deliveredAt,
        version: nextBoundedVersion(outbox.version),
      };
      validateContinuationOutbox(deliveredPredecessor);
    }
    if (next.position.state === "cursor") {
      const marker = `${next.key}:${stableDigest(next.position.cursor)}`;
      if (this.cursorDigests.has(marker)) return false;
      this.cursorDigests.add(marker);
    }
    this.checkpoints.set(next.key, next);
    this.runs.set(run.id, run);
    if (continuation) {
      const id = continuationOutboxId(next, continuation);
      this.continuations.set(
        continuationPendingSortKey(
          next.continuationCycle,
          next.continuationCount,
          id,
        ),
        {
          id,
          checkpointKey: next.key,
          providerId: next.providerId,
          predecessorRunId: run.id,
          command: continuation,
          cycle: next.continuationCycle,
          epoch: next.continuationCount,
          state: "intent",
          version: 1,
        },
      );
    }
    if (predecessorKey && deliveredPredecessor) {
      this.continuations.delete(predecessorKey);
      this.deliveredContinuations.set(
        deliveredPredecessor.id,
        deliveredPredecessor,
      );
    }
    return true;
  }
  async claimPendingContinuation(
    claimantId: string,
    claimedAt: IsoTimestamp,
    leaseUntil: IsoTimestamp,
    checkpointKey: string,
  ) {
    await Promise.resolve();
    validateContinuationLease(claimantId, claimedAt, leaseUntil);
    const now = Date.parse(claimedAt);
    const head = [...this.continuations.entries()]
      .filter(
        ([, value]) =>
          (value as Partial<ContinuationOutbox>).checkpointKey ===
          checkpointKey,
      )
      .sort(([left], [right]) => left.localeCompare(right))[0];
    const pending = head ? validateContinuationOutbox(head[1]) : undefined;
    if (!pending) return null;
    if (
      head?.[0] !==
      continuationPendingSortKey(pending.cycle, pending.epoch, pending.id)
    )
      throw new Error("continuation-storage-key-mismatch");
    if (pending.state === "delivered")
      throw new Error("invalid-pending-continuation-state");
    if (
      pending.state === "claimed" &&
      (!pending.leaseUntil || Date.parse(pending.leaseUntil) > now)
    )
      return null;
    const claimed: ContinuationOutbox = {
      ...pending,
      state: "claimed",
      claimantId,
      claimedAt,
      leaseUntil,
      version: nextBoundedVersion(pending.version),
    };
    this.continuations.set(
      continuationPendingSortKey(pending.cycle, pending.epoch, pending.id),
      claimed,
    );
    return claimed;
  }
  async hasUndeliveredContinuation(checkpointKey: string) {
    await Promise.resolve();
    return [...this.continuations.entries()]
      .filter(
        ([, value]) =>
          (value as Partial<ContinuationOutbox>).checkpointKey ===
          checkpointKey,
      )
      .some(([storageId, value]) => {
        const item = validateContinuationOutbox(value);
        if (
          storageId !==
          continuationPendingSortKey(item.cycle, item.epoch, item.id)
        )
          throw new Error("continuation-storage-key-mismatch");
        if (item.state === "delivered")
          throw new Error("invalid-pending-continuation-state");
        return true;
      });
  }
  async markContinuationDelivered(
    id: string,
    checkpointKey: string,
    cycle: number,
    epoch: number,
    claimantId: string,
    deliveredAt: IsoTimestamp,
  ) {
    await Promise.resolve();
    const pendingSk = continuationPendingSortKey(cycle, epoch, id);
    const current = this.continuations.get(pendingSk);
    if (!current) {
      const rawDelivered = this.deliveredContinuations.get(id);
      const delivered = rawDelivered
        ? validateContinuationOutbox(rawDelivered)
        : undefined;
      if (delivered && delivered.state !== "delivered")
        throw new Error("invalid-delivered-continuation-state");
      if (
        delivered?.state === "delivered" &&
        delivered.checkpointKey === checkpointKey &&
        delivered.cycle === cycle &&
        delivered.epoch === epoch
      )
        return;
      throw new Error("missing-continuation");
    }
    if (current.checkpointKey !== checkpointKey || current.cycle !== cycle)
      throw new Error("continuation-scope-mismatch");
    if (current.id !== id) throw new Error("continuation-storage-key-mismatch");
    if (current.state !== "claimed" || current.claimantId !== claimantId)
      throw new Error("continuation-claim-lost");
    const delivered: ContinuationOutbox = {
      ...current,
      state: "delivered",
      deliveredAt,
      version: nextBoundedVersion(current.version),
    };
    validateContinuationOutbox(delivered);
    this.continuations.delete(pendingSk);
    this.deliveredContinuations.set(id, delivered);
  }
}
