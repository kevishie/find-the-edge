const MAX_PAGES = 100;
const MAX_CURSOR_LENGTH = 4096;
const DEFAULT_MAX_AGE_MINUTES = 60;
const DEFAULT_TIMEOUT_MS = 10_000;
const FUTURE_TOLERANCE_MS = 5 * 60 * 1000;

const plain = (value) =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype;

const canonicalTimestamp = (value) => {
  if (typeof value !== "string") return false;
  const milliseconds = Date.parse(value);
  return (
    Number.isFinite(milliseconds) &&
    new Date(milliseconds).toISOString() === value
  );
};

export const currentEasternDay = (now = new Date()) => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const part = (type) =>
    parts.find((candidate) => candidate.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
};

const validatePage = (value, endpoint) => {
  if (
    !plain(value) ||
    !Array.isArray(value.items) ||
    !["complete", "partial"].includes(value.evaluationState) ||
    typeof value.hasMoreUnknown !== "boolean" ||
    (value.nextCursor !== null &&
      (typeof value.nextCursor !== "string" ||
        value.nextCursor.length < 1 ||
        value.nextCursor.length > MAX_CURSOR_LENGTH))
  )
    throw new Error(`${endpoint}-response-invalid`);
  const partial = value.evaluationState === "partial";
  if (
    partial !== value.hasMoreUnknown ||
    partial !== (value.nextCursor !== null)
  )
    throw new Error(`${endpoint}-pagination-invalid`);
  return value;
};

const exhaust = async ({ apiBase, endpoint, day, fetcher, timeoutMs }) => {
  const items = [];
  const ids = new Set();
  const cursors = new Set();
  let cursor;
  for (let pageNumber = 0; pageNumber < MAX_PAGES; pageNumber += 1) {
    const query = new URLSearchParams({
      sport: "mlb",
      league: "mlb",
      status: "scheduled",
      day,
      limit: "50",
    });
    if (cursor) query.set("cursor", cursor);
    const response = await fetcher(`${apiBase}/${endpoint}?${query}`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response || response.status !== 200)
      throw new Error(`${endpoint}-endpoint-unavailable`);
    let body;
    try {
      body = await response.json();
    } catch {
      throw new Error(`${endpoint}-response-invalid`);
    }
    const page = validatePage(body, endpoint);
    for (const item of page.items) {
      if (
        !plain(item) ||
        typeof item.id !== "string" ||
        item.id.length < 1 ||
        item.status !== "scheduled" ||
        ids.has(item.id)
      )
        throw new Error(`${endpoint}-game-identity-invalid`);
      ids.add(item.id);
      items.push(item);
    }
    if (page.nextCursor === null) return items;
    if (cursors.has(page.nextCursor))
      throw new Error(`${endpoint}-cursor-cycle`);
    cursors.add(page.nextCursor);
    cursor = page.nextCursor;
  }
  throw new Error(`${endpoint}-page-limit-exceeded`);
};

const finitePercentage = (value) =>
  value === undefined ||
  (typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 100);

export async function runSplitsLiveSmoke({
  apiBase,
  day = currentEasternDay(),
  maxAgeMinutes = DEFAULT_MAX_AGE_MINUTES,
  allowConsensusFallback = false,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  now = new Date(),
  fetcher = fetch,
}) {
  if (
    typeof apiBase !== "string" ||
    !/^https?:\/\/[^\s/]+(?:\/[^\s]*)?$/.test(apiBase) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(day) ||
    !Number.isFinite(maxAgeMinutes) ||
    maxAgeMinutes <= 0 ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    !(now instanceof Date) ||
    !Number.isFinite(now.getTime())
  )
    throw new Error("splits-smoke-config-invalid");
  const normalizedApiBase = apiBase.replace(/\/$/, "");
  const [games, splitGames] = await Promise.all([
    exhaust({
      apiBase: normalizedApiBase,
      endpoint: "games",
      day,
      fetcher,
      timeoutMs,
    }),
    exhaust({
      apiBase: normalizedApiBase,
      endpoint: "splits",
      day,
      fetcher,
      timeoutMs,
    }),
  ]);
  const gameIds = games.map(({ id }) => id);
  const splitGameIds = splitGames.map(({ id }) => id);
  if (
    gameIds.length === 0 ||
    gameIds.length !== splitGameIds.length ||
    gameIds.some((id) => !splitGameIds.includes(id))
  )
    throw new Error("splits-scheduled-coverage-incomplete");

  const scopes = new Set();
  const observationIds = new Set();
  let observationCount = 0;
  let freshestTimestamp = Number.NEGATIVE_INFINITY;
  for (const game of splitGames) {
    if (!Array.isArray(game.splits)) throw new Error("splits-response-invalid");
    for (const observation of game.splits) {
      if (
        !plain(observation) ||
        typeof observation.id !== "string" ||
        observationIds.has(observation.id) ||
        observation.canonicalEventId !== game.id ||
        ![
          "draftkings",
          "circa",
          ...(allowConsensusFallback ? ["consensus"] : []),
        ].includes(observation.scope) ||
        !finitePercentage(observation.betPercent) ||
        !finitePercentage(observation.moneyPercent) ||
        (observation.betPercent === undefined &&
          observation.moneyPercent === undefined) ||
        !canonicalTimestamp(observation.providerTimestamp) ||
        !canonicalTimestamp(observation.retrievedAt)
      )
        throw new Error("splits-observation-invalid");
      observationIds.add(observation.id);
      scopes.add(observation.scope);
      observationCount += 1;
      const providerMs = Date.parse(observation.providerTimestamp);
      const retrievedMs = Date.parse(observation.retrievedAt);
      const oldestAllowed = now.getTime() - maxAgeMinutes * 60 * 1_000;
      const newestAllowed = now.getTime() + FUTURE_TOLERANCE_MS;
      if (
        providerMs < oldestAllowed ||
        providerMs > newestAllowed ||
        retrievedMs < oldestAllowed ||
        retrievedMs > newestAllowed
      )
        throw new Error("splits-evidence-stale");
      freshestTimestamp = Math.max(freshestTimestamp, providerMs, retrievedMs);
    }
  }
  const hasPrimaryScopes = scopes.has("draftkings") && scopes.has("circa");
  if (
    observationCount === 0 ||
    (!hasPrimaryScopes && !(allowConsensusFallback && scopes.has("consensus")))
  )
    throw new Error("splits-required-scopes-missing");
  const age = now.getTime() - freshestTimestamp;
  if (
    !Number.isFinite(age) ||
    age < -FUTURE_TOLERANCE_MS ||
    age > maxAgeMinutes * 60 * 1000
  )
    throw new Error("splits-evidence-stale");

  return {
    day,
    scheduledGames: games.length,
    splitGames: splitGames.length,
    observationCount,
    scopes: [...scopes].sort(),
    freshestAt: new Date(freshestTimestamp).toISOString(),
    mode: hasPrimaryScopes ? "book-scoped" : "consensus-fallback",
  };
}

const invokedDirectly =
  process.argv[1] &&
  new URL(import.meta.url).pathname ===
    new URL(`file://${process.argv[1]}`).pathname;

if (invokedDirectly) {
  const maxAgeMinutes = Number(
    process.env.FTE_SPLITS_MAX_AGE_MINUTES ?? DEFAULT_MAX_AGE_MINUTES,
  );
  const timeoutMs = Number(
    process.env.FTE_SPLITS_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS,
  );
  runSplitsLiveSmoke({
    apiBase: process.env.FTE_API_BASE ?? "",
    day: process.env.FTE_SPLITS_DAY ?? currentEasternDay(),
    maxAgeMinutes,
    timeoutMs,
    allowConsensusFallback:
      process.env.FTE_SPLITS_ALLOW_CONSENSUS_FALLBACK === "1",
  })
    .then((result) => {
      console.log(JSON.stringify({ ok: true, ...result }));
    })
    .catch((error) => {
      console.error(
        JSON.stringify({
          ok: false,
          error: error instanceof Error ? error.message : "splits-smoke-failed",
        }),
      );
      process.exitCode = 1;
    });
}
