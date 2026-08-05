import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import {
  fixtureOddsGroupAvailabilityIdentity,
  normalizeFixtureOddsObservation,
} from "../../packages/domain/src/index.js";
import { createEventHandler } from "../../apps/api/src/index.js";
import {
  EventCursorCodec,
  MemoryEventIngestionStore,
  MemoryEventRepository,
  MemoryGamesRepository,
  projectionItems,
} from "../../packages/database/src/index.js";
import {
  seedFixtureOdds,
  type FixtureOddsPersister,
} from "../../apps/workers/src/index.js";

class MemoryOdds implements FixtureOddsPersister {
  readonly snapshots = new Map<
    string,
    ReturnType<typeof normalizeFixtureOddsObservation>
  >();
  readonly availability = new Map<
    string,
    {
      readonly identity: string;
      readonly state: "active";
      readonly observedAt: string;
      readonly evidenceId: string;
      readonly reason: string;
    }
  >();

  async persist(input: Parameters<FixtureOddsPersister["persist"]>[0]) {
    await Promise.resolve();
    const value = normalizeFixtureOddsObservation({
      ...input.observation,
      sportsbookId: "hardrock",
      sportsbookLabel: "Hard Rock Bet",
    });
    const comparison = normalizeFixtureOddsObservation({
      ...input.observation,
      sportsbookId: "draftkings",
      sportsbookLabel: "DraftKings",
      americanOdds: input.observation.americanOdds + 5,
    });
    const sharp = normalizeFixtureOddsObservation({
      ...input.observation,
      sportsbookId: "pinnacle",
      sportsbookLabel: "Pinnacle",
      americanOdds: input.observation.americanOdds - 4,
    });
    const existing = this.snapshots.has(value.snapshotId);
    this.snapshots.set(value.snapshotId, value);
    this.snapshots.set(comparison.snapshotId, comparison);
    this.snapshots.set(sharp.snapshotId, sharp);
    for (const snapshot of [value, comparison, sharp]) {
      this.availability.set(snapshot.partitionKey, {
        identity: snapshot.partitionKey,
        state: "active",
        observedAt: snapshot.observedAt,
        evidenceId: snapshot.snapshotId,
        reason: "active-price",
      });
      const group = fixtureOddsGroupAvailabilityIdentity(snapshot);
      this.availability.set(group, {
        identity: group,
        state: "active",
        observedAt: snapshot.observedAt,
        evidenceId: `group-${snapshot.snapshotId}`,
        reason: "market-complete",
      });
    }
    return {
      snapshot: existing ? ("existing" as const) : ("created" as const),
      current: existing ? ("retained" as const) : ("advanced" as const),
      value,
    };
  }

  history(eventId: string) {
    return [...this.snapshots.values()]
      .filter((snapshot) => snapshot.canonicalEventId === eventId)
      .map((snapshot) => ({
        marketKey: snapshot.marketKey,
        selectionKey: snapshot.selectionKey,
        selectionLabel: snapshot.selectionLabel ?? snapshot.selectionKey,
        sportsbookId: snapshot.sportsbookId,
        sportsbookLabel: snapshot.sportsbookLabel,
        points: [
          {
            ...(snapshot.point === undefined
              ? {}
              : { point: snapshot.point + 0.5 }),
            americanOdds: snapshot.americanOdds + 10,
            observedAt: "2026-08-01T11:30:00.000Z",
            retrievedAt: "2026-08-01T11:30:01.000Z",
          },
          {
            ...(snapshot.point === undefined ? {} : { point: snapshot.point }),
            americanOdds: snapshot.americanOdds,
            observedAt: snapshot.observedAt,
            retrievedAt: snapshot.retrievedAt,
          },
        ],
      }));
  }

  async batchGet(
    keys: readonly {
      readonly pk: string;
      readonly sk: "CURRENT" | "AVAILABILITY";
    }[],
  ) {
    await Promise.resolve();
    const rows: unknown[] = [];
    for (const key of keys) {
      if (key.sk === "AVAILABILITY") {
        const value = this.availability.get(key.pk);
        if (value) rows.push({ pk: key.pk, sk: key.sk, value });
        continue;
      }
      const value = [...this.snapshots.values()].find(
        (snapshot) => snapshot.partitionKey === key.pk,
      );
      if (value) rows.push({ pk: key.pk, sk: key.sk, value });
    }
    return rows;
  }
}

export interface LocalGamesApi {
  readonly apiBase: string;
  close(): Promise<void>;
}

export async function startLocalGamesApi(): Promise<LocalGamesApi> {
  const store = new MemoryEventIngestionStore();
  const odds = new MemoryOdds();
  await seedFixtureOdds(store, odds);
  const scheduled = [...store.events.values()].find(
    (event) => event.sportKey === "mlb",
  );
  if (!scheduled) throw new Error("scheduled fixture missing");
  const postponed = {
    ...scheduled,
    id: `${scheduled.id}-postponed` as typeof scheduled.id,
    candidateIdentity: `${scheduled.candidateIdentity}-postponed`,
    participantLabels: ["Baltimore Orioles", "Toronto Blue Jays"],
    startsAt: "2026-08-02T00:15:00.000Z" as typeof scheduled.startsAt,
    status: "postponed" as const,
    version: 1,
    updatedAt: "2026-08-01T12:31:00.000Z" as typeof scheduled.updatedAt,
  };
  await store.registerCandidate(postponed);
  for (const item of Object.values(
    projectionItems(postponed, "2026-08-01T12:31:00.000Z" as never),
  ))
    store.eventReadItems.set(`${item.pk}\0${item.sk}`, item);
  const events = new MemoryEventRepository(
    store,
    new EventCursorCodec({
      current: { id: "e2e", secret: Buffer.alloc(32, 7) },
    }),
    () => new Date("2026-08-01T12:31:00.000Z"),
  );
  const handler = createEventHandler(
    events,
    new MemoryGamesRepository(
      events,
      odds,
      ["hardrock", "draftkings", "pinnacle"],
      () => new Date("2026-08-01T12:31:00.000Z"),
      [
        { id: "hardrock", label: "Hard Rock Bet" },
        { id: "draftkings", label: "DraftKings" },
        { id: "pinnacle", label: "Pinnacle" },
      ],
    ),
    () => undefined,
  );
  const respond = async (
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
    const headers = {
      "access-control-allow-origin": "http://127.0.0.1:4173",
      "access-control-allow-headers": "authorization,content-type",
      "content-type": "application/json",
      "cache-control": "no-store",
    };
    if (request.method === "OPTIONS") {
      response.writeHead(204, headers).end();
      return;
    }
    if (
      request.method !== "GET" ||
      (!requestUrl.pathname.startsWith("/events/") &&
        requestUrl.pathname !== "/games" &&
        !/^\/games\/[^/]+\/odds-history$/.test(requestUrl.pathname))
    ) {
      response
        .writeHead(404, headers)
        .end(JSON.stringify({ error: "not-found" }));
      return;
    }
    const historyMatch = /^\/games\/([^/]+)\/odds-history$/.exec(
      requestUrl.pathname,
    );
    if (historyMatch) {
      const eventId = decodeURIComponent(historyMatch[1]!);
      response.writeHead(200, headers).end(
        JSON.stringify({
          eventId,
          generatedAt: "2026-08-01T12:31:00.000Z",
          series: odds.history(eventId),
          nextCursor: null,
        }),
      );
      return;
    }
    const result = requestUrl.pathname.startsWith("/events/")
      ? await handler({
          route: "detail",
          eventId: decodeURIComponent(
            requestUrl.pathname.slice("/events/".length),
          ),
        })
      : await handler({
          route: "games",
          query: Object.fromEntries(requestUrl.searchParams),
        });
    const body =
      requestUrl.pathname === "/games" &&
      requestUrl.searchParams.get("status") === "postponed" &&
      result.statusCode === 200
        ? JSON.stringify({
            ...(JSON.parse(result.body) as Record<string, unknown>),
            items: (
              JSON.parse(result.body) as { items: Record<string, unknown>[] }
            ).items.map((item) => ({
              ...item,
              competition: { key: "mlb-cup", state: "provisional" },
            })),
          })
        : result.body;
    response.writeHead(result.statusCode, { ...headers, ...result.headers });
    response.end(body);
  };
  const server = createServer((request, response) => {
    void respond(request, response).catch(() => {
      if (!response.headersSent)
        response
          .writeHead(500, { "content-type": "application/json" })
          .end(JSON.stringify({ error: "internal-error" }));
      else response.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onError);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    await close(server);
    throw new Error("local games API did not bind a TCP port");
  }
  return {
    apiBase: `http://127.0.0.1:${String(address.port)}`,
    close: () => close(server),
  };
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
