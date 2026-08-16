import type {
  ClosingLinesRepository,
  ClvRepository,
  GamesRepository,
} from "@find-the-edge/database";
import { projectFinalizedClosingSelections } from "@find-the-edge/database";
import {
  CLOSING_BOOK_SCHEMA_VERSION,
  CLOSING_RETRIEVAL_WINDOW_MS,
  computeClvResult,
  createClosingLinesRecord,
  participantSelectionKey,
  type ClosingBookRecord,
  type ClosingEventBinding,
  type ClvResult,
  type EntityId,
  type GameDisplayDto,
} from "@find-the-edge/domain";
import type {
  SharpApiError,
  SharpApiClosingSnapshot,
  SharpApiResponseMetadata,
} from "@find-the-edge/providers";

const CAPTURE_TARGETS = [
  { sportKey: "mlb", leagueKey: "mlb" },
  { sportKey: "soccer", leagueKey: "mls" },
] as const;
const easternDayFormat = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
const comparable = (value: string) =>
  value.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ");

export interface ClosingLinesCaptureResult {
  readonly captured: number;
  readonly pending: number;
  readonly failed: number;
  readonly clvScored: number;
  readonly requests: number;
}

const identityMatches = (
  snapshot: SharpApiClosingSnapshot,
  game: GameDisplayDto,
) => {
  const expectedSports =
    game.sportKey === "mlb"
      ? new Set(["baseball", "mlb"])
      : new Set([game.sportKey]);
  if (
    (snapshot.sport && !expectedSports.has(comparable(snapshot.sport))) ||
    (snapshot.league &&
      comparable(snapshot.league) !== comparable(game.leagueKey))
  )
    return false;
  if (
    snapshot.startsAt &&
    Math.abs(Date.parse(snapshot.startsAt) - Date.parse(game.startsAt)) >
      3_600_000
  )
    return false;
  const [away, home] = game.participants;
  return (
    (!snapshot.awayTeam ||
      (!!away && comparable(snapshot.awayTeam) === comparable(away.label))) &&
    (!snapshot.homeTeam ||
      (!!home && comparable(snapshot.homeTeam) === comparable(home.label)))
  );
};

const bookRecord = (
  snapshot: SharpApiClosingSnapshot,
  game: GameDisplayDto,
  book: SharpApiClosingSnapshot["books"][number],
): ClosingBookRecord | null => {
  if (!book.isFinal) return null;
  const [away, home] = game.participants;
  if (!away || !home) return null;
  return {
    schemaVersion: CLOSING_BOOK_SCHEMA_VERSION,
    canonicalEventId: game.id,
    canonicalEventVersion: game.version,
    providerId: "sharpapi",
    providerEventId: snapshot.providerEventId,
    sportKey: game.sportKey,
    leagueKey: game.leagueKey,
    startsAt: game.startsAt,
    sportsbookId: book.id,
    providerSportsbookId: book.providerSportsbookId,
    capturedAt: book.capturedAt,
    secondsBeforeKickoff: book.secondsBeforeKickoff,
    retrievedAt: snapshot.retrievedAt,
    captureTrigger: book.captureTrigger,
    isFinal: true,
    selections: book.prices.map((price) => ({
      marketKey: price.marketKey,
      selectionKey:
        price.selectionKey === "away"
          ? participantSelectionKey(away.id as EntityId)
          : price.selectionKey === "home"
            ? participantSelectionKey(home.id as EntityId)
            : price.selectionKey,
      selectionLabel:
        price.selectionKey === "away"
          ? away.label
          : price.selectionKey === "home"
            ? home.label
            : price.selectionKey === "draw"
              ? "Draw"
              : price.selectionKey === "over"
                ? "Over"
                : "Under",
      sportsbookId: book.id,
      ...(price.point === undefined ? {} : { point: price.point }),
      americanOdds: price.americanOdds,
      observedAt: price.sourceUpdatedAt,
      retrievedAt: snapshot.retrievedAt,
      providerMarketId: price.providerMarketId,
      providerSelectionId: price.providerSelectionId,
      canonicalKey: price.canonicalKey,
      decimalOdds: price.decimalOdds,
      impliedProbability: price.impliedProbability,
      ...(price.noVigProbability === undefined
        ? {}
        : { noVigProbability: price.noVigProbability }),
      fairCloseDecimal: price.fairCloseDecimal,
      closingProbability: price.closingProbability,
    })),
  };
};

/** Reconciles independently finalized provider books. Empty and partial
 * responses remain retryable; one malformed event never fails live odds. */
export async function captureClosingLines(
  dependencies: {
    readonly games: GamesRepository;
    readonly closingLines: ClosingLinesRepository;
    readonly resolveBinding?: (
      game: GameDisplayDto,
    ) => Promise<ClosingEventBinding | null>;
    readonly clv?: Pick<ClvRepository, "listEntries" | "appendResults">;
    readonly targets?: readonly {
      readonly sportKey: string;
      readonly leagueKey: string;
    }[];
    readonly sportsbookIds?: readonly string[];
    readonly fetchClosing?: (
      providerEventId: string,
    ) => Promise<SharpApiClosingSnapshot>;
    readonly reserveQuota?: () => Promise<boolean>;
    readonly reconcileQuota?: (
      metadata: SharpApiResponseMetadata | undefined,
    ) => Promise<void>;
    readonly recordProviderFailure?: (error: SharpApiError) => Promise<void>;
    readonly requestLimit?: number;
  },
  now: Date,
): Promise<ClosingLinesCaptureResult> {
  const days = [
    ...new Set([
      easternDayFormat.format(now),
      easternDayFormat.format(new Date(now.getTime() - 86_400_000)),
      easternDayFormat.format(new Date(now.getTime() - 2 * 86_400_000)),
    ]),
  ];
  let captured = 0,
    pending = 0,
    failed = 0,
    clvScored = 0,
    requests = 0;
  const resultsBySport = new Map<string, ClvResult[]>();
  const requestLimit = dependencies.requestLimit ?? 8;
  const queueClv = async (
    game: GameDisplayDto,
    finalizedBooks: readonly ClosingBookRecord[],
  ) => {
    if (!dependencies.clv) return;
    const participantKeys = new Set<string>(
      game.participants.map(({ id }) =>
        participantSelectionKey(id as EntityId),
      ),
    );
    const eligibleBooks = finalizedBooks.filter(
      (book) =>
        book.canonicalEventId === game.id &&
        book.canonicalEventVersion <= game.version &&
        book.sportKey === game.sportKey &&
        book.leagueKey === game.leagueKey &&
        book.startsAt === game.startsAt &&
        book.selections.every(
          ({ selectionKey }) =>
            !selectionKey.startsWith("participant:") ||
            participantKeys.has(selectionKey),
        ),
    );
    const configuredSportsbooks = dependencies.sportsbookIds ?? [
      "hardrock",
      "pinnacle",
    ];
    const groups = new Map<string, ClosingBookRecord[]>();
    for (const book of eligibleBooks) {
      const key = `${book.canonicalEventVersion}\u0000${book.providerEventId}`;
      groups.set(key, [...(groups.get(key) ?? []), book]);
    }
    const coherent = [...groups.values()]
      .sort(
        (left, right) =>
          (right[0]?.canonicalEventVersion ?? 0) -
            (left[0]?.canonicalEventVersion ?? 0) ||
          (right[0]?.retrievedAt ?? "").localeCompare(
            left[0]?.retrievedAt ?? "",
          ),
      )
      .find(
        (group) =>
          projectFinalizedClosingSelections(group, configuredSportsbooks) !==
          null,
      );
    if (!coherent) return;
    const selections = projectFinalizedClosingSelections(
      coherent,
      configuredSportsbooks,
    );
    if (!selections) return;
    const displayBook = coherent.find(
      ({ sportsbookId }) => sportsbookId === selections[0]?.sportsbookId,
    );
    if (!displayBook) throw new Error("closing-display-book-missing");
    const displaySelections = selections.map(
      ({ sharpAmericanOdds: ignoredAnchor, ...selection }) => {
        void ignoredAnchor;
        return selection;
      },
    );
    const record = createClosingLinesRecord({
      canonicalEventId: game.id,
      canonicalEventVersion: game.version,
      sportKey: game.sportKey,
      leagueKey: game.leagueKey,
      startsAt: game.startsAt,
      capturedAt: displayBook.capturedAt,
      selections: displaySelections,
    });
    for (const entry of await dependencies.clv.listEntries(game.id)) {
      const result = computeClvResult(entry, record);
      if (!result) continue;
      const bucket = resultsBySport.get(game.sportKey) ?? [];
      bucket.push(result);
      resultsBySport.set(game.sportKey, bucket);
    }
  };
  const candidates: GameDisplayDto[] = [];
  for (const target of dependencies.targets ?? CAPTURE_TARGETS) {
    for (const day of days) {
      try {
        const items = (
          await dependencies.games.list(
            {
              sportKey: target.sportKey,
              leagueKey: target.leagueKey,
              status: "all",
              day,
            },
            50,
          )
        ).items;
        for (const game of items) {
          const sinceStart = now.getTime() - Date.parse(game.startsAt);
          if (
            sinceStart >= 0 &&
            sinceStart <= CLOSING_RETRIEVAL_WINDOW_MS &&
            !candidates.some(({ id }) => id === game.id)
          )
            candidates.push(game);
        }
      } catch {
        failed += 1;
      }
    }
  }
  const ordered = candidates.sort(
    (left, right) => Date.parse(right.startsAt) - Date.parse(left.startsAt),
  );
  const rotation =
    ordered.length === 0
      ? 0
      : Math.floor(now.getTime() / 60_000) % ordered.length;
  const rotated = [...ordered.slice(rotation), ...ordered.slice(0, rotation)];
  for (const game of rotated) {
    try {
      let currentBinding = await dependencies.closingLines.getBinding(game.id);
      if (!currentBinding && dependencies.resolveBinding) {
        const recovered = await dependencies.resolveBinding(game);
        if (recovered) {
          await dependencies.closingLines.bind(recovered);
          currentBinding = recovered;
        }
      }
      const historicalBindings = await dependencies.closingLines.listBindings(
        game.id,
      );
      const bindingCandidates = [
        ...(currentBinding ? [currentBinding] : []),
        ...historicalBindings,
      ].filter(
        (binding, index, all) =>
          binding.canonicalEventVersion <= game.version &&
          binding.sportKey === game.sportKey &&
          binding.leagueKey === game.leagueKey &&
          binding.startsAt === game.startsAt &&
          all.findIndex(
            (candidate) =>
              candidate.providerEventId === binding.providerEventId &&
              candidate.canonicalEventVersion === binding.canonicalEventVersion,
          ) === index,
      );
      const binding =
        bindingCandidates[
          bindingCandidates.length === 0
            ? 0
            : Math.floor(now.getTime() / 60_000) % bindingCandidates.length
        ];
      if (!binding || !dependencies.fetchClosing || requests >= requestLimit) {
        pending += 1;
        continue;
      }
      const finalizedBefore = await dependencies.closingLines.listFinalized(
        game.id,
      );
      const configuredBooks = dependencies.sportsbookIds ?? [
        "hardrock",
        "pinnacle",
      ];
      const displayBook = configuredBooks.find((id) => id !== "pinnacle");
      const desiredBooks = [
        ...(displayBook ? [displayBook] : []),
        ...(configuredBooks.includes("pinnacle") ? ["pinnacle"] : []),
      ];
      if (
        desiredBooks.length > 0 &&
        desiredBooks.every((sportsbookId) =>
          finalizedBefore.some(
            (book) =>
              book.sportsbookId === sportsbookId &&
              book.providerEventId === binding.providerEventId &&
              book.canonicalEventVersion <= game.version &&
              book.sportKey === game.sportKey &&
              book.leagueKey === game.leagueKey &&
              book.startsAt === game.startsAt,
          ),
        )
      ) {
        await queueClv(game, finalizedBefore);
        continue;
      }
      if (dependencies.reserveQuota && !(await dependencies.reserveQuota())) {
        pending += 1;
        continue;
      }
      requests += 1;
      const snapshot = await dependencies.fetchClosing(binding.providerEventId);
      await dependencies.reconcileQuota?.(snapshot.responseMetadata);
      if (
        snapshot.providerEventId !== binding.providerEventId ||
        !identityMatches(snapshot, game)
      )
        throw new Error("closing-event-identity-mismatch");
      for (const rejection of snapshot.rejections)
        console.log(
          JSON.stringify({
            event: "closing-lines-book-rejected",
            eventId: game.id,
            reason: rejection.reason,
            auditId: rejection.auditId,
            ...(rejection.providerSportsbookId
              ? { providerSportsbookId: rejection.providerSportsbookId }
              : {}),
          }),
        );
      let createdForEvent = 0;
      for (const book of snapshot.books) {
        try {
          const record = bookRecord(snapshot, game, book);
          if (!record || record.selections.length === 0) continue;
          if (
            (await dependencies.closingLines.finalizeBook(record)) === "created"
          ) {
            captured += 1;
            createdForEvent += 1;
          }
        } catch (error) {
          // Books finalize independently. One malformed/conflicting book
          // must not suppress valid siblings from the same response.
          failed += 1;
          console.log(
            JSON.stringify({
              event: "closing-lines-book-finalization-failed",
              eventId: game.id,
              sportsbookId: book.id,
              errorName: error instanceof Error ? error.name : "unknown",
              errorMessage:
                error instanceof Error
                  ? error.message.slice(0, 160)
                  : "unknown",
            }),
          );
        }
      }
      if (createdForEvent === 0) pending += 1;
      await queueClv(
        game,
        await dependencies.closingLines.listFinalized(game.id),
      );
    } catch (error) {
      failed += 1;
      if (
        error instanceof Error &&
        error.name === "SharpApiError" &&
        dependencies.recordProviderFailure
      )
        await dependencies.recordProviderFailure(error as SharpApiError);
      console.log(
        JSON.stringify({
          event: "closing-lines-capture-failed",
          eventId: game.id,
          errorName: error instanceof Error ? error.name : "unknown",
          errorMessage:
            error instanceof Error ? error.message.slice(0, 300) : "unknown",
        }),
      );
    }
  }
  if (dependencies.clv)
    for (const [sportKey, results] of resultsBySport)
      try {
        await dependencies.clv.appendResults(
          sportKey,
          results,
          now.toISOString(),
        );
        clvScored += results.length;
      } catch {
        failed += 1;
      }
  return { captured, pending, failed, clvScored, requests };
}
