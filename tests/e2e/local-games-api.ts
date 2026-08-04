import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { normalizeFixtureOddsObservation } from "../../packages/domain/src/index.js";
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

  async persist(input: Parameters<FixtureOddsPersister["persist"]>[0]) {
    await Promise.resolve();
    const value = normalizeFixtureOddsObservation(input.observation);
    const existing = this.snapshots.has(value.snapshotId);
    this.snapshots.set(value.snapshotId, value);
    return {
      snapshot: existing ? ("existing" as const) : ("created" as const),
      current: existing ? ("retained" as const) : ("advanced" as const),
      value,
    };
  }

  async batchGet(
    keys: readonly { readonly pk: string; readonly sk: "CURRENT" }[],
  ) {
    await Promise.resolve();
    return keys.flatMap((key) => {
      const value = [...this.snapshots.values()].find(
        (snapshot) => snapshot.partitionKey === key.pk,
      );
      return value ? [{ pk: key.pk, sk: key.sk, value }] : [];
    });
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
    participantLabels: ["Baltimore", "Toronto"],
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
    new MemoryGamesRepository(events, odds),
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
        requestUrl.pathname !== "/games")
    ) {
      response
        .writeHead(404, headers)
        .end(JSON.stringify({ error: "not-found" }));
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
