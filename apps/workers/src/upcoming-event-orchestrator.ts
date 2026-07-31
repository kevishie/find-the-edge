import {
  checkpointKey,
  canonicalContinuationCommand,
  cursorChainDigest,
  stableDigest,
  type ContinuationOutbox,
  type EventIngestionStore,
} from "@find-the-edge/database";
import type {
  CheckpointPosition,
  IngestionCounters,
  IngestionFailureCode,
  IngestionCheckpoint,
  IsoTimestamp,
  LeagueIngestionRun,
  SportKey,
  UpcomingEventIngestionCommand,
} from "@find-the-edge/domain";
import {
  normalizedUpcomingEventIdentity,
  validateBootstrapPage,
  validateUpcomingEventPage,
  type BootstrapPageRequest,
  type FeedCoverageRegistry,
  type ScheduleAdapterRegistry,
  type UpcomingEventPageRequest,
} from "@find-the-edge/providers";

const MAX_BOOTSTRAP_PAGES = 100;
const MAX_BOOTSTRAP_REQUESTS_PER_WINDOW = 2_000;
const MAX_FUTURE_REVISION_MS = 5 * 60 * 1000;

const bootstrapPayloadDigest = (page: {
  readonly events: readonly {
    readonly id: string;
    readonly sportKey: string;
    readonly leagueKey: string;
    readonly leagueId: string;
    readonly normalizedIdentity: string;
    readonly participantIds: readonly string[];
    readonly participantLabels: readonly string[];
    readonly startsAt: string;
    readonly phase: string;
    readonly status: string;
    readonly canonicalKey: string;
    readonly revision: {
      readonly providerId: string;
      readonly authorityRank: number;
      readonly updatedAt: string;
      readonly sequence: number;
      readonly token: string;
    };
  }[];
  readonly nextCursor?: string;
  readonly providerRequests: number;
  readonly quotaUsed: number;
}) =>
  stableDigest(
    JSON.stringify([
      page.events.map((event) => [
        event.id,
        event.sportKey,
        event.leagueKey,
        event.leagueId,
        event.normalizedIdentity,
        event.participantIds,
        event.participantLabels,
        event.startsAt,
        event.phase,
        event.status,
        event.canonicalKey,
        event.revision.providerId,
        event.revision.authorityRank,
        event.revision.updatedAt,
        event.revision.sequence,
        event.revision.token,
      ]),
      Object.prototype.hasOwnProperty.call(page, "nextCursor")
        ? page.nextCursor
        : null,
      page.providerRequests,
      page.quotaUsed,
    ]),
  );

export interface ContinuationPublisher {
  publish(command: UpcomingEventIngestionCommand): Promise<void>;
}

export class IngestionError extends Error {
  constructor(readonly code: IngestionFailureCode) {
    super(code);
    this.name = "IngestionError";
  }
}

const text = (value: unknown): string => {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 256 ||
    value !== value.trim()
  )
    throw new IngestionError("invalid-command");
  return value;
};
const instant = (value: unknown): IsoTimestamp => {
  const result = text(value);
  if (
    !Number.isFinite(Date.parse(result)) ||
    new Date(result).toISOString() !== result
  )
    throw new IngestionError("invalid-command");
  return result as IsoTimestamp;
};
const bound = (value: unknown, maximum: number): number => {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > maximum
  )
    throw new IngestionError("invalid-command");
  return value;
};
const commandKeys = [
  "attemptId",
  "checkpointScope",
  "sportKey",
  "leagueKey",
  "windowStart",
  "windowEnd",
  "pageLimit",
  "maxPages",
  "expectedContinuation",
] as const;
const canonicalIdentifier = (value: string) =>
  /^[a-z0-9][a-z0-9-]{0,63}$/.test(value);
export function validateIngestionCommand(
  input: unknown,
): UpcomingEventIngestionCommand {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new IngestionError("invalid-command");
  const value = input as Record<string, unknown>;
  const inputKeys = Object.keys(value);
  if (
    (inputKeys.length !== commandKeys.length &&
      inputKeys.length !== commandKeys.length - 1) ||
    !inputKeys.every((key) =>
      commandKeys.includes(key as (typeof commandKeys)[number]),
    ) ||
    commandKeys
      .slice(0, -1)
      .some((key) => !Object.prototype.hasOwnProperty.call(value, key))
  )
    throw new IngestionError("invalid-command");
  const command: UpcomingEventIngestionCommand = {
    attemptId: text(value["attemptId"]),
    checkpointScope: text(value["checkpointScope"]),
    sportKey: text(value["sportKey"]) as SportKey,
    leagueKey: text(value["leagueKey"]),
    windowStart: instant(value["windowStart"]),
    windowEnd: instant(value["windowEnd"]),
    pageLimit: bound(value["pageLimit"], 100),
    maxPages: bound(value["maxPages"], 20),
    ...(value["expectedContinuation"] !== undefined
      ? {
          expectedContinuation: validateExpectedContinuation(
            value["expectedContinuation"],
          ),
        }
      : {}),
  };
  if (
    !canonicalIdentifier(command.sportKey) ||
    !canonicalIdentifier(command.leagueKey) ||
    Date.parse(command.windowStart) >= Date.parse(command.windowEnd) ||
    Date.parse(command.windowEnd) - Date.parse(command.windowStart) >
      31 * 86_400_000
  )
    throw new IngestionError("invalid-command");
  return command;
}

function validateExpectedContinuation(
  input: unknown,
): NonNullable<UpcomingEventIngestionCommand["expectedContinuation"]> {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new IngestionError("invalid-command");
  const value = input as Record<string, unknown>;
  if (
    Object.keys(value).length !== 3 ||
    !Object.prototype.hasOwnProperty.call(value, "cycle") ||
    !Object.prototype.hasOwnProperty.call(value, "epoch") ||
    !Object.prototype.hasOwnProperty.call(value, "position") ||
    !Number.isSafeInteger(value["cycle"]) ||
    (value["cycle"] as number) < 0 ||
    !Number.isSafeInteger(value["epoch"]) ||
    (value["epoch"] as number) < 1
  )
    throw new IngestionError("invalid-command");
  const position = value["position"] as Record<string, unknown> | undefined;
  if (
    !position ||
    position["state"] !== "cursor" ||
    typeof position["cursor"] !== "string" ||
    !position["cursor"] ||
    position["cursor"].length > 1024 ||
    Object.keys(position).length !== 2
  )
    throw new IngestionError("invalid-command");
  return {
    cycle: value["cycle"] as number,
    epoch: value["epoch"] as number,
    position: {
      state: "cursor",
      cursor: position["cursor"],
    },
  };
}

type MutableCounters = {
  -readonly [Key in keyof IngestionCounters]: IngestionCounters[Key];
};
const newCounters = (): MutableCounters => ({
  providerRequests: 0,
  pages: 0,
  bootstrapped: 0,
  repaired: 0,
  updated: 0,
  skipped: 0,
  unresolved: 0,
  quotaUsed: 0,
});
function add(
  counters: MutableCounters,
  key: keyof MutableCounters,
  value: number,
) {
  const next = counters[key] + value;
  if (!Number.isSafeInteger(next) || next < 0)
    throw new IngestionError("invalid-provider-output");
  counters[key] = next;
}

export class UpcomingEventIngestionOrchestrator {
  constructor(
    readonly coverage: FeedCoverageRegistry,
    readonly adapters: ScheduleAdapterRegistry,
    readonly store: EventIngestionStore,
    readonly clock: () => Date = () => new Date(),
    readonly continuations?: ContinuationPublisher,
  ) {}

  async execute(raw: unknown): Promise<LeagueIngestionRun> {
    const command = validateIngestionCommand(raw);
    let auditCommand = command;
    const started = this.clock();
    let counters = newCounters();
    let providerId: string | undefined;
    let finalPosition: CheckpointPosition | undefined;
    let runId = stableDigest(
      JSON.stringify([
        "setup",
        command.sportKey,
        command.leagueKey,
        command.checkpointScope,
        command.windowStart,
        command.windowEnd,
        command.attemptId,
      ]),
    );
    try {
      const coverage = this.coverage.resolve({
        sportKey: command.sportKey,
        leagueKey: command.leagueKey,
        capability: "schedule",
      });
      if (!coverage.supported) throw new IngestionError("coverage-unavailable");
      providerId = coverage.providerId;
      const adapter = this.adapters.get(
        providerId,
        command.sportKey,
        command.leagueKey,
      );
      if (!adapter) throw new IngestionError("adapter-unavailable");
      const key = checkpointKey({ providerId, ...command });
      runId = stableDigest(
        JSON.stringify([
          providerId,
          command.sportKey,
          command.leagueKey,
          key,
          command.attemptId,
        ]),
      );
      let checkpoint = await this.persistence(() =>
        this.store.getCheckpoint(key),
      );
      let expected: CheckpointPosition | null = checkpoint?.position ?? null;
      let continuationCycle = checkpoint?.continuationCycle ?? 0;
      let continuationCount = checkpoint?.continuationCount ?? 0;
      let bootstrapRequestCount = checkpoint?.bootstrapRequestCount ?? 0;
      let bootstrapQuotaUsed = checkpoint?.bootstrapQuotaUsed ?? 0;
      let cursorHistory = [...(checkpoint?.cursorHistory ?? [])];
      let cursorChain =
        checkpoint?.cursorChain ?? cursorChainDigest(key, cursorHistory);
      runId = stableDigest(
        JSON.stringify([
          providerId,
          command.sportKey,
          command.leagueKey,
          key,
          command.attemptId,
          continuationCycle,
          continuationCount,
          expected,
        ]),
      );
      finalPosition = expected ?? undefined;
      if (
        command.expectedContinuation &&
        (checkpoint?.continuationCycle !== command.expectedContinuation.cycle ||
          checkpoint?.continuationCount !==
            command.expectedContinuation.epoch ||
          JSON.stringify(checkpoint?.position) !==
            JSON.stringify(command.expectedContinuation.position) ||
          command.attemptId !==
            stableDigest(
              JSON.stringify([
                checkpoint?.lastRunId,
                key,
                command.expectedContinuation.cycle,
                command.expectedContinuation.epoch,
                command.expectedContinuation.position.state === "cursor"
                  ? command.expectedContinuation.position.cursor
                  : "",
              ]),
            ))
      ) {
        // A delayed or duplicated continuation from an older epoch must not
        // race current provider work or mutate audit state.
        return await this.recordRequired(
          this.run(
            runId,
            command,
            providerId,
            started,
            counters,
            "no-op",
            expected ?? undefined,
            undefined,
            checkpoint?.updatedAt,
          ),
        );
      }
      if (!command.expectedContinuation && expected?.state === "cursor")
        throw new IngestionError("invalid-command");
      // Recovery is scoped to this exact workflow. A scheduled/manual request
      // that repairs delivery continues its requested ingestion; FIFO ordering
      // keeps the newly published continuation behind this record.
      const recovery = await this.drainAllContinuations(key, runId);
      if (recovery === "no-publisher" && checkpoint)
        return await this.recordRequired({
          ...this.run(
            runId,
            command,
            providerId,
            started,
            counters,
            "delivery-required",
            expected ?? undefined,
            "continuation-delivery-required",
            checkpoint.updatedAt,
          ),
          checkpointKey: key,
        });
      if (expected?.state === "terminal")
        return await this.recordRequired(
          this.run(
            runId,
            command,
            providerId,
            started,
            counters,
            "no-op",
            expected,
            undefined,
            checkpoint?.updatedAt,
          ),
        );
      const observedAt = this.clock().toISOString() as IsoTimestamp;
      let activeCommand = auditCommand;
      let locallyClaimed: ContinuationOutbox | undefined;
      const seenCursors = new Set(cursorHistory);
      const seenProviderEvents = new Set<string>();
      const seenBootstrapEvents = new Set<string>();
      const seenBootstrapIdentities = new Set<string>();
      if (expected?.state === "cursor" && cursorHistory.length === 0) {
        const digest = stableDigest(expected.cursor);
        seenCursors.add(digest);
        cursorHistory.push(digest);
        cursorChain = cursorChainDigest(key, cursorHistory);
      }

      for (let pageNumber = 0; pageNumber < command.maxPages; pageNumber++) {
        const currentCursorHistory = cursorHistory;
        const currentCursorChain = cursorChain;
        const request: UpcomingEventPageRequest = {
          sportKey: command.sportKey,
          leagueKey: command.leagueKey,
          windowStart: command.windowStart,
          windowEnd: command.windowEnd,
          limit: command.pageLimit,
          ...(expected?.state === "cursor" ? { cursor: expected.cursor } : {}),
        };
        const rawPage = await this.provider(() =>
          adapter.listUpcomingEvents(request),
        );
        let page;
        try {
          page = validateUpcomingEventPage(rawPage, request);
        } catch {
          throw new IngestionError("invalid-provider-output");
        }
        if (
          page.events.some(
            (event) =>
              event.revision.providerId !== providerId ||
              event.revision.authorityRank !== adapter.authorityRank ||
              Date.parse(event.revision.updatedAt) >
                this.clock().getTime() + MAX_FUTURE_REVISION_MS,
          )
        )
          throw new IngestionError("invalid-provider-output");
        const next: CheckpointPosition = Object.prototype.hasOwnProperty.call(
          page,
          "nextCursor",
        )
          ? { state: "cursor", cursor: page.nextCursor as string }
          : { state: "terminal" };
        if (
          next.state === "cursor" &&
          (!next.cursor ||
            next.cursor.length > 1024 ||
            seenCursors.has(stableDigest(next.cursor)) ||
            (await this.persistence(() =>
              this.store.hasCursorDigest(key, stableDigest(next.cursor)),
            )))
        )
          throw new IngestionError("cursor-stalled");
        const nextContinuationCount =
          next.state === "cursor"
            ? continuationCount === Number.MAX_SAFE_INTEGER
              ? 1
              : continuationCount + 1
            : continuationCount;
        const rolledContinuation =
          next.state === "cursor" &&
          continuationCount === Number.MAX_SAFE_INTEGER;
        if (rolledContinuation && continuationCycle === Number.MAX_SAFE_INTEGER)
          throw new IngestionError("invalid-provider-output");
        const nextContinuationCycle = rolledContinuation
          ? continuationCycle + 1
          : continuationCycle;
        if (next.state === "cursor") {
          const digest = stableDigest(next.cursor);
          seenCursors.add(digest);
          cursorHistory = [...cursorHistory.slice(-31), digest];
          cursorChain = stableDigest(JSON.stringify([cursorChain, digest]));
        }
        const pagePosition = expected ?? ({ state: "start" } as const);
        const durableFenceStates = await this.persistence(() =>
          this.store.getProviderEventFences(
            key,
            page.events.map((event) => event.providerEventId),
            pagePosition,
          ),
        );
        if (durableFenceStates.some((state) => state === "duplicate"))
          throw new IngestionError("invalid-provider-output");
        add(counters, "providerRequests", page.providerRequests);
        add(counters, "quotaUsed", page.quotaUsed);
        for (const event of page.events) {
          if (seenProviderEvents.has(event.providerEventId))
            throw new IngestionError("invalid-provider-output");
          seenProviderEvents.add(event.providerEventId);
        }
        const semanticPageFingerprint = stableDigest(
          JSON.stringify([
            page.events.map((event) => [
              event.providerEventId,
              event.sportKey,
              event.leagueKey,
              event.participantLabels,
              event.startsAt,
              event.status,
              event.revision.providerId,
              event.revision.authorityRank,
              event.revision.updatedAt,
              event.revision.sequence,
              event.revision.token,
            ]),
            Object.prototype.hasOwnProperty.call(page, "nextCursor")
              ? page.nextCursor
              : null,
          ]),
        );
        await this.persistence(() =>
          this.store.recordProviderPageFingerprint(
            key,
            pagePosition,
            semanticPageFingerprint,
            command.windowEnd,
            observedAt,
          ),
        );

        const exactMappings = await Promise.all(
          page.events.map((event) =>
            this.persistence(() =>
              this.store.getExactMapping({
                providerId: providerId!,
                providerEventId: event.providerEventId,
                sportKey: event.sportKey,
                leagueKey: event.leagueKey,
              }),
            ),
          ),
        );
        const unmappedIdentities = [
          ...new Set(
            page.events
              .filter((_, index) => !exactMappings[index])
              .map(normalizedUpcomingEventIdentity),
          ),
        ];
        const identityStates = await Promise.all(
          unmappedIdentities.map(async (identity) => ({
            identity,
            state: await this.persistence(() =>
              this.store.getCanonicalByIdentity(
                command.sportKey,
                command.leagueKey,
                identity,
              ),
            ),
          })),
        );
        const missingIdentities = identityStates
          .filter(({ state }) => state === "missing")
          .map(({ identity }) => identity);
        if (
          missingIdentities.length &&
          checkpoint?.bootstrapCompletedPositionDigest !==
            stableDigest(JSON.stringify(pagePosition))
        ) {
          if (!checkpoint) {
            const initialCheckpoint = {
              key,
              providerId,
              sportKey: command.sportKey,
              leagueKey: command.leagueKey,
              checkpointScope: command.checkpointScope,
              windowStart: command.windowStart,
              windowEnd: command.windowEnd,
              position: { state: "start" as const },
              continuationCycle: 0,
              continuationCount: 0,
              bootstrapRequestCount: 0,
              bootstrapQuotaUsed: 0,
              cursorHistory: currentCursorHistory,
              cursorChain: currentCursorChain,
              lastRunId: runId,
              updatedAt: observedAt,
            };
            const claimed = await this.persistence(() =>
              this.store.compareAndSetCheckpoint(null, initialCheckpoint),
            );
            if (!claimed) throw new IngestionError("checkpoint-conflict");
            checkpoint = initialCheckpoint;
            expected = initialCheckpoint.position;
          }
          let bootstrapCursor = checkpoint.bootstrapCursor;
          let bootstrapCursorHistory = [
            ...(checkpoint.bootstrapCursorHistory ?? []),
          ];
          let bootstrapCursorChain =
            checkpoint.bootstrapCursorChain ??
            stableDigest(JSON.stringify(["bootstrap-cursor-chain", key]));
          if (!bootstrapCursor) {
            bootstrapCursorHistory = [];
            bootstrapCursorChain = stableDigest(
              JSON.stringify(["bootstrap-cursor-chain", key]),
            );
          }
          if (bootstrapCursor && bootstrapCursorHistory.length === 0) {
            const digest = stableDigest(bootstrapCursor);
            bootstrapCursorHistory = [digest];
            bootstrapCursorChain = stableDigest(
              JSON.stringify([bootstrapCursorChain, digest]),
            );
          }
          const seenBootstrapCursors = new Set(bootstrapCursorHistory);
          let bootstrapPageNumber = checkpoint.bootstrapPageOrdinal ?? 0;
          do {
            if (bootstrapPageNumber >= MAX_BOOTSTRAP_PAGES)
              throw new IngestionError("invalid-provider-output");
            const checkpointReservation = checkpoint.bootstrapReservation;
            const reservationIdentities =
              checkpointReservation &&
              checkpointReservation.cursor === bootstrapCursor &&
              checkpointReservation.pageOrdinal === bootstrapPageNumber
                ? [...checkpointReservation.identities]
                : missingIdentities;
            const bootstrapRequest: BootstrapPageRequest = {
              sportKey: command.sportKey,
              leagueKey: command.leagueKey,
              windowStart: command.windowStart,
              windowEnd: command.windowEnd,
              limit: 50,
              identities: reservationIdentities,
              providerId,
              authorityRank: adapter.authorityRank,
              ...(bootstrapCursor ? { cursor: bootstrapCursor } : {}),
            };
            const reservationId = stableDigest(
              JSON.stringify([
                key,
                pagePosition,
                bootstrapCursor ?? null,
                bootstrapPageNumber,
                reservationIdentities,
              ]),
            );
            const requestDigest = stableDigest(
              JSON.stringify([
                bootstrapRequest.sportKey,
                bootstrapRequest.leagueKey,
                bootstrapRequest.windowStart,
                bootstrapRequest.windowEnd,
                bootstrapRequest.limit,
                bootstrapRequest.identities,
                bootstrapRequest.providerId,
                bootstrapRequest.authorityRank,
                bootstrapRequest.cursor ?? null,
              ]),
            );
            const responseId = stableDigest(
              JSON.stringify(["bootstrap-response", reservationId]),
            );
            let existingReservation = checkpoint.bootstrapReservation;
            const storedEnvelope = await this.persistence(() =>
              this.store.getBootstrapResponse(responseId),
            );
            if (existingReservation?.id !== reservationId) {
              if (
                bootstrapRequestCount >= MAX_BOOTSTRAP_REQUESTS_PER_WINDOW ||
                bootstrapQuotaUsed >= MAX_BOOTSTRAP_REQUESTS_PER_WINDOW
              )
                throw new IngestionError("invalid-provider-output");
              const claimedAt = this.clock();
              const reservedCheckpoint: IngestionCheckpoint = {
                ...checkpoint,
                bootstrapRequestCount: bootstrapRequestCount + 1,
                bootstrapQuotaUsed,
                bootstrapReservation: {
                  id: reservationId,
                  status: "reserved",
                  ...(bootstrapCursor ? { cursor: bootstrapCursor } : {}),
                  pageOrdinal: bootstrapPageNumber,
                  identities: reservationIdentities,
                  authorityRank: adapter.authorityRank,
                  requestDigest,
                  claimedAt: claimedAt.toISOString() as IsoTimestamp,
                  leaseUntil: new Date(
                    claimedAt.getTime() + 300_000,
                  ).toISOString() as IsoTimestamp,
                },
                updatedAt: this.clock().toISOString() as IsoTimestamp,
              };
              const reserved = await this.persistence(() =>
                this.store.compareAndSetCheckpoint(
                  checkpoint,
                  reservedCheckpoint,
                ),
              );
              if (!reserved) throw new IngestionError("checkpoint-conflict");
              checkpoint = reservedCheckpoint;
              bootstrapRequestCount += 1;
            } else if (
              existingReservation.requestDigest !== requestDigest ||
              JSON.stringify(existingReservation.identities) !==
                JSON.stringify(reservationIdentities)
            ) {
              throw new IngestionError("checkpoint-conflict");
            } else if (
              !storedEnvelope &&
              (existingReservation.status === "failed" ||
                existingReservation.status === "reserved")
            ) {
              if (
                existingReservation.status === "reserved" &&
                Date.parse(existingReservation.leaseUntil as string) >
                  this.clock().getTime()
              )
                throw new IngestionError("retry-required");
              if (
                bootstrapRequestCount >= MAX_BOOTSTRAP_REQUESTS_PER_WINDOW ||
                bootstrapQuotaUsed >= MAX_BOOTSTRAP_REQUESTS_PER_WINDOW
              )
                throw new IngestionError("invalid-provider-output");
              const claimedAt = this.clock();
              const takeoverCheckpoint: IngestionCheckpoint = {
                ...checkpoint,
                bootstrapRequestCount: bootstrapRequestCount + 1,
                bootstrapReservation: {
                  ...existingReservation,
                  status: "reserved",
                  claimedAt: claimedAt.toISOString() as IsoTimestamp,
                  leaseUntil: new Date(
                    claimedAt.getTime() + 300_000,
                  ).toISOString() as IsoTimestamp,
                },
                updatedAt: this.clock().toISOString() as IsoTimestamp,
              };
              const taken = await this.persistence(() =>
                this.store.compareAndSetCheckpoint(
                  checkpoint,
                  takeoverCheckpoint,
                ),
              );
              if (!taken) throw new IngestionError("checkpoint-conflict");
              checkpoint = takeoverCheckpoint;
              bootstrapRequestCount += 1;
              existingReservation = takeoverCheckpoint.bootstrapReservation;
            }
            const failBootstrapReservation = async (usage?: {
              providerRequests: number;
              quotaUsed: number;
            }) => {
              const currentCheckpoint = checkpoint;
              if (!currentCheckpoint)
                throw new IngestionError("checkpoint-conflict");
              if (
                currentCheckpoint.bootstrapReservation?.status === "succeeded"
              )
                throw new IngestionError("persistence-failed");
              const failedCheckpoint: IngestionCheckpoint = {
                ...currentCheckpoint,
                bootstrapQuotaUsed:
                  bootstrapQuotaUsed + (usage?.quotaUsed ?? 0),
                bootstrapReservation: {
                  id: reservationId,
                  status: "failed",
                  ...(bootstrapCursor ? { cursor: bootstrapCursor } : {}),
                  pageOrdinal: bootstrapPageNumber,
                  identities: reservationIdentities,
                  authorityRank: adapter.authorityRank,
                  requestDigest,
                  ...(usage
                    ? {
                        providerRequests: usage.providerRequests,
                        quotaUsed: usage.quotaUsed,
                      }
                    : {}),
                },
                updatedAt: this.clock().toISOString() as IsoTimestamp,
              };
              const recorded = await this.persistence(() =>
                this.store.compareAndSetCheckpoint(
                  currentCheckpoint,
                  failedCheckpoint,
                ),
              );
              if (!recorded) throw new IngestionError("checkpoint-conflict");
              checkpoint = failedCheckpoint;
              bootstrapQuotaUsed += usage?.quotaUsed ?? 0;
            };
            let rawBootstrap: unknown;
            let madeProviderCall = false;
            if (existingReservation?.status === "succeeded" && !storedEnvelope)
              throw new IngestionError("persistence-failed");
            if (storedEnvelope) {
              if (
                typeof storedEnvelope !== "object" ||
                Array.isArray(storedEnvelope) ||
                storedEnvelope === null
              )
                throw new IngestionError("persistence-failed");
              const envelope = storedEnvelope as Record<string, unknown>;
              if (
                Object.keys(envelope).length !== 4 ||
                envelope["id"] !== responseId ||
                envelope["reservationId"] !== reservationId ||
                typeof envelope["digest"] !== "string"
              )
                throw new IngestionError("persistence-failed");
              rawBootstrap = envelope["payload"];
            }
            if (!rawBootstrap) {
              try {
                rawBootstrap =
                  await adapter.listCanonicalBootstrap(bootstrapRequest);
                madeProviderCall = true;
              } catch {
                await failBootstrapReservation({
                  providerRequests: 1,
                  quotaUsed: 1,
                });
                throw new IngestionError("provider-failed");
              }
            }
            let bootstrap;
            try {
              bootstrap = validateBootstrapPage(rawBootstrap, bootstrapRequest);
            } catch {
              await failBootstrapReservation(
                madeProviderCall
                  ? { providerRequests: 1, quotaUsed: 1 }
                  : undefined,
              );
              throw new IngestionError("invalid-provider-output");
            }
            if (madeProviderCall) {
              add(counters, "providerRequests", bootstrap.providerRequests);
              add(counters, "quotaUsed", bootstrap.quotaUsed);
            }
            if (
              bootstrap.events.some(
                (item) =>
                  item.revision.providerId !== providerId ||
                  item.revision.authorityRank !== adapter.authorityRank ||
                  Date.parse(item.revision.updatedAt) >
                    this.clock().getTime() + MAX_FUTURE_REVISION_MS,
              )
            ) {
              await failBootstrapReservation(
                madeProviderCall ? bootstrap : undefined,
              );
              throw new IngestionError("invalid-provider-output");
            }
            const responseDigest = bootstrapPayloadDigest(bootstrap);
            if (storedEnvelope) {
              const envelope = storedEnvelope as Record<string, unknown>;
              if (
                envelope["digest"] !== responseDigest ||
                (existingReservation?.status === "succeeded" &&
                  (existingReservation.responseRef !== responseId ||
                    existingReservation.responseDigest !== responseDigest))
              )
                throw new IngestionError("persistence-failed");
            }
            for (const item of bootstrap.events) {
              if (
                seenBootstrapEvents.has(item.id) ||
                seenBootstrapIdentities.has(item.normalizedIdentity)
              ) {
                await failBootstrapReservation(
                  madeProviderCall ? bootstrap : undefined,
                );
                throw new IngestionError("invalid-provider-output");
              }
            }
            if (
              bootstrap.providerRequests !== 1 ||
              bootstrapQuotaUsed + bootstrap.quotaUsed >
                MAX_BOOTSTRAP_REQUESTS_PER_WINDOW
            ) {
              await failBootstrapReservation(
                madeProviderCall ? bootstrap : undefined,
              );
              throw new IngestionError("invalid-provider-output");
            }
            if (existingReservation?.status !== "succeeded") {
              await this.persistence(() =>
                this.store.putBootstrapResponse(
                  responseId,
                  {
                    id: responseId,
                    reservationId,
                    digest: responseDigest,
                    payload: bootstrap,
                  },
                  command.windowEnd,
                ),
              );
              bootstrapQuotaUsed += bootstrap.quotaUsed;
              const outcomeCheckpoint: IngestionCheckpoint = {
                ...checkpoint,
                bootstrapQuotaUsed,
                bootstrapReservation: {
                  id: reservationId,
                  status: "succeeded",
                  ...(bootstrapCursor ? { cursor: bootstrapCursor } : {}),
                  pageOrdinal: bootstrapPageNumber,
                  identities: reservationIdentities,
                  authorityRank: adapter.authorityRank,
                  requestDigest,
                  responseRef: responseId,
                  responseDigest,
                  providerRequests: bootstrap.providerRequests,
                  quotaUsed: bootstrap.quotaUsed,
                },
                updatedAt: this.clock().toISOString() as IsoTimestamp,
              };
              const recorded = await this.persistence(() =>
                this.store.compareAndSetCheckpoint(
                  checkpoint,
                  outcomeCheckpoint,
                ),
              );
              if (!recorded) throw new IngestionError("checkpoint-conflict");
              checkpoint = outcomeCheckpoint;
            }
            await this.persistence(() =>
              this.store.recordBootstrapPageMarkers(
                key,
                { state: "cursor", cursor: reservationId },
                bootstrap.events,
                command.windowEnd,
              ),
            );
            const {
              bootstrapReservation: _completedReservation,
              bootstrapCursor: _completedCursor,
              ...progress
            } = checkpoint;
            void _completedReservation;
            void _completedCursor;
            bootstrapCursor = bootstrap.nextCursor;
            bootstrapPageNumber += 1;
            if (bootstrapCursor) {
              const digest = stableDigest(bootstrapCursor);
              if (seenBootstrapCursors.has(digest)) {
                throw new IngestionError("cursor-stalled");
              }
              seenBootstrapCursors.add(digest);
              bootstrapCursorHistory = [...bootstrapCursorHistory, digest];
              bootstrapCursorChain = stableDigest(
                JSON.stringify([bootstrapCursorChain, digest]),
              );
            }
            const bootstrapCheckpoint: IngestionCheckpoint = {
              ...progress,
              bootstrapRequestCount,
              bootstrapQuotaUsed,
              ...(bootstrapCursor ? { bootstrapCursor } : {}),
              bootstrapPageOrdinal: bootstrapPageNumber,
              bootstrapCursorHistory,
              bootstrapCursorChain,
              ...(!bootstrapCursor
                ? {
                    bootstrapCompletedPositionDigest: stableDigest(
                      JSON.stringify(pagePosition),
                    ),
                  }
                : {}),
              updatedAt: this.clock().toISOString() as IsoTimestamp,
            };
            for (const item of bootstrap.events) {
              seenBootstrapEvents.add(item.id);
              seenBootstrapIdentities.add(item.normalizedIdentity);
              const result = await this.persistence(() =>
                this.store.bootstrapCanonicalEvent(item, observedAt),
              );
              if (result === "created") add(counters, "bootstrapped", 1);
              if (result === "repaired") add(counters, "repaired", 1);
            }
            const recordedAttempt = await this.persistence(() =>
              this.store.compareAndSetCheckpoint(
                checkpoint,
                bootstrapCheckpoint,
              ),
            );
            if (!recordedAttempt)
              throw new IngestionError("checkpoint-conflict");
            checkpoint = bootstrapCheckpoint;
          } while (bootstrapCursor);
        }

        for (let offset = 0; offset < page.events.length; offset += 5) {
          const settledOutcomes = await Promise.allSettled(
            page.events.slice(offset, offset + 5).map((event) =>
              this.persistence(() =>
                this.store.ingestEvent({
                  providerId: providerId!,
                  providerEventId: event.providerEventId,
                  sportKey: event.sportKey,
                  leagueKey: event.leagueKey,
                  normalizedIdentity: normalizedUpcomingEventIdentity(event),
                  startsAt: event.startsAt,
                  status: event.status,
                  revision: event.revision,
                  observedAt,
                  providerEventFence: {
                    checkpointKey: key,
                    pagePosition,
                    windowEnd: command.windowEnd,
                  },
                }),
              ),
            ),
          );
          const rejected = settledOutcomes.find(
            (outcome) => outcome.status === "rejected",
          );
          for (const outcome of settledOutcomes)
            if (outcome.status === "fulfilled")
              add(counters, outcome.value.kind, 1);
          if (rejected?.status === "rejected") throw rejected.reason;
        }

        const nextCheckpoint = {
          key,
          providerId,
          sportKey: command.sportKey,
          leagueKey: command.leagueKey,
          checkpointScope: command.checkpointScope,
          windowStart: command.windowStart,
          windowEnd: command.windowEnd,
          position: next,
          continuationCycle: nextContinuationCycle,
          continuationCount: nextContinuationCount,
          bootstrapRequestCount,
          bootstrapQuotaUsed,
          cursorHistory,
          cursorChain,
          lastRunId: runId,
          updatedAt: this.clock().toISOString() as IsoTimestamp,
        };
        add(counters, "pages", 1);
        // A cursor is never stored without its resumable command. Returning
        // after this atomic commit prevents a crash between an intermediate
        // checkpoint CAS and construction of the continuation outbox.
        const continuationCommand =
          next.state === "cursor"
            ? {
                ...activeCommand,
                maxPages: Math.max(1, activeCommand.maxPages - 1),
                attemptId: stableDigest(
                  JSON.stringify([
                    runId,
                    key,
                    nextContinuationCycle,
                    nextContinuationCount,
                    next.cursor,
                  ]),
                ),
                expectedContinuation: {
                  cycle: nextContinuationCycle,
                  epoch: nextContinuationCount,
                  position: next,
                },
              }
            : undefined;
        const baseFinalRun = this.run(
          runId,
          activeCommand,
          providerId,
          started,
          counters,
          next.state === "terminal"
            ? "succeeded"
            : this.continuations
              ? "continuation-queued"
              : "delivery-required",
          next,
        );
        const finalRun =
          baseFinalRun && continuationCommand
            ? { ...baseFinalRun, checkpointKey: key }
            : baseFinalRun;
        const consumedPredecessor = locallyClaimed
          ? {
              outbox: locallyClaimed,
              activeCommand,
              deliveredAt: this.clock().toISOString() as IsoTimestamp,
            }
          : undefined;
        const saved = await this.persistence(() =>
          this.store.commitCheckpoint(
            checkpoint,
            nextCheckpoint,
            finalRun,
            continuationCommand,
            consumedPredecessor,
          ),
        );
        if (!saved) throw new IngestionError("checkpoint-conflict");
        // The predecessor stays claimed (and therefore recoverable after its
        // lease expires) until the successor checkpoint/run/outbox is durable.
        // Only then is it safe to archive the predecessor as consumed.
        locallyClaimed = undefined;
        checkpoint = nextCheckpoint;
        expected = next;
        continuationCount = nextContinuationCount;
        continuationCycle = nextContinuationCycle;
        finalPosition = next;
        if (!continuationCommand) return finalRun;

        // Every cursor boundary is independently crash recoverable because the
        // checkpoint, audit and continuation intent were committed above. If
        // this invocation still has page budget, consume that exact intent
        // locally before doing more provider work. This prevents an external
        // publisher from creating a competing delivery while still leaving a
        // durable pending intent behind if the process dies after the commit.
        if (activeCommand.maxPages > 1) {
          locallyClaimed = await this.claimContinuationLocally(
            key,
            runId,
            continuationCommand,
          );
          activeCommand = continuationCommand;
          auditCommand = continuationCommand;
          runId = stableDigest(
            JSON.stringify([
              providerId,
              command.sportKey,
              command.leagueKey,
              key,
              activeCommand.attemptId,
              continuationCycle,
              continuationCount,
              expected,
            ]),
          );
          counters = newCounters();
          continue;
        }
        if (this.continuations) await this.drainContinuation(key, runId);
        return finalRun;
      }

      const retryRun = this.run(
        runId,
        activeCommand,
        providerId,
        started,
        counters,
        "retry-required",
        finalPosition,
        "retry-required",
      );
      await this.recordRequired(retryRun);
      throw new IngestionError("retry-required");
    } catch (error) {
      const failure =
        error instanceof IngestionError
          ? error
          : new IngestionError("persistence-failed");
      if (
        failure.code !== "retry-required" &&
        failure.code !== "run-record-failed"
      ) {
        const failedRun = this.run(
          stableDigest(
            JSON.stringify([
              runId,
              "failed-audit",
              failure.code,
              finalPosition,
              counters,
            ]),
          ),
          auditCommand,
          providerId,
          started,
          counters,
          "failed",
          finalPosition,
          failure.code,
          command.windowStart,
        );
        try {
          await this.store.putRun(failedRun);
        } catch {
          // The original failure still causes retry; raw details remain hidden.
        }
      }
      throw failure;
    }
  }

  private async recordRequired(
    run: LeagueIngestionRun,
  ): Promise<LeagueIngestionRun> {
    try {
      await this.store.putRun(run);
      return run;
    } catch {
      throw new IngestionError("run-record-failed");
    }
  }

  async drainPendingContinuation(
    checkpointKey: string,
    claimantId: string,
  ): Promise<"no-publisher" | "nothing" | "delivered"> {
    if (
      !/^[a-zA-Z0-9][a-zA-Z0-9:_-]{0,255}$/.test(claimantId) ||
      !/^[a-f0-9]{64}$/.test(checkpointKey)
    )
      throw new IngestionError("invalid-command");
    if (!this.continuations) {
      if (
        await this.persistence(() =>
          this.store.hasUndeliveredContinuation(checkpointKey),
        )
      )
        return "no-publisher";
      return "nothing";
    }
    const claimedAt = this.clock();
    // Longer than the Lambda/publisher timeout, but below FIFO's dedup window.
    const leaseUntil = new Date(claimedAt.getTime() + 120_000);
    const pending = await this.persistence(() =>
      this.store.claimPendingContinuation(
        claimantId,
        claimedAt.toISOString() as IsoTimestamp,
        leaseUntil.toISOString() as IsoTimestamp,
        checkpointKey,
      ),
    );
    if (!pending) {
      const blocked = await this.persistence(() =>
        this.store.hasUndeliveredContinuation(checkpointKey),
      );
      if (blocked) throw new IngestionError("continuation-delivery-failed");
      return "nothing";
    }
    try {
      await this.continuations.publish(pending.command);
    } catch {
      throw new IngestionError("continuation-delivery-failed");
    }
    await this.persistence(() =>
      this.store.markContinuationDelivered(
        pending.id,
        pending.checkpointKey,
        pending.cycle,
        pending.epoch,
        claimantId,
        this.clock().toISOString() as IsoTimestamp,
      ),
    );
    return "delivered";
  }

  private drainContinuation(checkpointKey: string, claimantId: string) {
    return this.drainPendingContinuation(checkpointKey, claimantId);
  }

  private async drainAllContinuations(
    checkpointKey: string,
    claimantId: string,
  ): Promise<"no-publisher" | "nothing" | "delivered"> {
    let delivered = false;
    for (let index = 0; index < 2_000; index++) {
      const result = await this.drainContinuation(checkpointKey, claimantId);
      if (result === "delivered") {
        delivered = true;
        continue;
      }
      return result === "nothing" && delivered ? "delivered" : result;
    }
    if (
      !(await this.persistence(() =>
        this.store.hasUndeliveredContinuation(checkpointKey),
      ))
    )
      return delivered ? "delivered" : "nothing";
    throw new IngestionError("continuation-delivery-failed");
  }

  private async claimContinuationLocally(
    checkpointKey: string,
    claimantId: string,
    expectedCommand: UpcomingEventIngestionCommand,
  ): Promise<ContinuationOutbox> {
    const claimedAt = this.clock();
    const pending = await this.persistence(() =>
      this.store.claimPendingContinuation(
        claimantId,
        claimedAt.toISOString() as IsoTimestamp,
        new Date(claimedAt.getTime() + 120_000).toISOString() as IsoTimestamp,
        checkpointKey,
      ),
    );
    if (
      !pending ||
      canonicalContinuationCommand(pending.command) !==
        canonicalContinuationCommand(expectedCommand)
    )
      throw new IngestionError("continuation-delivery-failed");
    return pending;
  }

  private run(
    id: string,
    command: UpcomingEventIngestionCommand,
    providerId: string | undefined,
    started: Date,
    counters: IngestionCounters,
    status: LeagueIngestionRun["status"],
    finalPosition?: CheckpointPosition,
    failureCode?: IngestionFailureCode,
    deterministicAt?: IsoTimestamp,
  ): LeagueIngestionRun {
    const effectiveStarted = deterministicAt
      ? new Date(deterministicAt)
      : started;
    const finished = deterministicAt ? effectiveStarted : this.clock();
    return {
      id,
      attemptId: command.attemptId,
      sportKey: command.sportKey,
      leagueKey: command.leagueKey,
      ...(providerId ? { providerId } : {}),
      startedAt: effectiveStarted.toISOString() as IsoTimestamp,
      finishedAt: finished.toISOString() as IsoTimestamp,
      durationMs: Math.max(0, finished.getTime() - effectiveStarted.getTime()),
      status,
      counters: { ...counters },
      runRecordPersisted: true,
      ...(finalPosition ? { finalPosition } : {}),
      ...(failureCode ? { failureCode } : {}),
    };
  }

  private async provider<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch {
      throw new IngestionError("provider-failed");
    }
  }

  private async persistence<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof IngestionError) throw error;
      if (
        error instanceof Error &&
        (error.message === "duplicate-provider-event" ||
          error.message === "duplicate-bootstrap-position" ||
          error.message === "provider-page-replay-conflict")
      )
        throw new IngestionError("invalid-provider-output");
      throw new IngestionError("persistence-failed");
    }
  }
}
