import type {
  CompletedEventState,
  IsoTimestamp,
  ProviderRevision,
  ResultScoreScope,
  SportKey,
} from "@find-the-edge/domain";
import { supportsRequest, type ProviderDescriptor } from "./index";

export interface ProviderParticipantScore {
  readonly providerParticipantId: string;
  readonly score: number;
}
export interface ProviderCompletedResult {
  readonly providerEventId: string;
  readonly sportKey: SportKey;
  readonly leagueKey: string;
  readonly state: CompletedEventState;
  readonly scoreScope: ResultScoreScope;
  readonly scores?: readonly ProviderParticipantScore[];
  readonly providerTimestamp: IsoTimestamp;
  readonly revision: ProviderRevision;
  readonly detail?: {
    readonly schemaId: string;
    readonly schemaVersion: string;
    readonly value: unknown;
  };
}
export interface CompletedResultPageRequest {
  readonly sportKey: SportKey;
  readonly leagueKey: string;
  readonly windowStart: IsoTimestamp;
  readonly windowEnd: IsoTimestamp;
  readonly limit: number;
  readonly cursor?: string;
}
export interface CompletedResultPage {
  readonly results: readonly ProviderCompletedResult[];
  readonly retrievedAt: IsoTimestamp;
  readonly providerRequests: number;
  readonly quotaUsed: number;
  readonly nextCursor?: string;
}
export interface CompletedResultsAdapter {
  readonly descriptor: ProviderDescriptor;
  readonly sportKey: SportKey;
  readonly leagueKey: string;
  listCompletedResults(
    request: CompletedResultPageRequest,
  ): Promise<CompletedResultPage>;
}
const text = (value: unknown, max = 256): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= max &&
  value === value.trim();
const iso = (value: unknown): value is IsoTimestamp =>
  text(value, 40) &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString() === value;
export function validateCompletedResultPage(
  input: unknown,
  request: CompletedResultPageRequest,
  providerId: string,
  now: () => number = Date.now,
): CompletedResultPage {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("invalid-result-page");
  const page = input as Record<string, unknown>;
  if (
    !Object.keys(page).every((key) =>
      [
        "results",
        "retrievedAt",
        "providerRequests",
        "quotaUsed",
        "nextCursor",
      ].includes(key),
    ) ||
    !Array.isArray(page["results"]) ||
    page["results"].length > request.limit ||
    !iso(page["retrievedAt"]) ||
    Date.parse(String(page["retrievedAt"])) > now() + 5 * 60_000 ||
    !Number.isSafeInteger(page["providerRequests"]) ||
    (page["providerRequests"] as number) < 1 ||
    !Number.isSafeInteger(page["quotaUsed"]) ||
    (page["quotaUsed"] as number) < 0 ||
    (page["nextCursor"] !== undefined && !text(page["nextCursor"], 1024))
  )
    throw new Error("invalid-result-page");
  const ids = new Set<string>();
  for (const raw of page["results"] as unknown[]) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
      throw new Error("invalid-result");
    const result = raw as Record<string, unknown>,
      revision = result["revision"] as Record<string, unknown> | undefined;
    let serialized: string;
    try {
      serialized = JSON.stringify(result);
    } catch {
      throw new Error("invalid-result");
    }
    if (
      serialized.length > 65_536 ||
      !Object.keys(result).every((key) =>
        [
          "providerEventId",
          "sportKey",
          "leagueKey",
          "state",
          "scoreScope",
          "scores",
          "providerTimestamp",
          "revision",
          "detail",
        ].includes(key),
      ) ||
      !text(result["providerEventId"]) ||
      ids.has(result["providerEventId"]) ||
      result["sportKey"] !== request.sportKey ||
      result["leagueKey"] !== request.leagueKey ||
      !["final", "postponed", "cancelled", "no-contest"].includes(
        String(result["state"]),
      ) ||
      !["regulation", "overtime", "extra-innings", "unknown"].includes(
        String(result["scoreScope"]),
      ) ||
      (result["state"] !== "final" && result["scoreScope"] !== "unknown") ||
      !iso(result["providerTimestamp"]) ||
      Date.parse(result["providerTimestamp"]) <
        Date.parse(request.windowStart) ||
      Date.parse(result["providerTimestamp"]) >=
        Date.parse(request.windowEnd) ||
      Date.parse(result["providerTimestamp"]) >
        Date.parse(page["retrievedAt"]) ||
      !revision ||
      Object.keys(revision).length !== 5 ||
      !Object.keys(revision).every((key) =>
        [
          "providerId",
          "updatedAt",
          "authorityRank",
          "sequence",
          "token",
        ].includes(key),
      ) ||
      revision["providerId"] !== providerId ||
      !iso(revision["updatedAt"]) ||
      Date.parse(String(revision["updatedAt"])) >
        Date.parse(String(page["retrievedAt"])) ||
      !Number.isSafeInteger(revision["authorityRank"]) ||
      Number(revision["authorityRank"]) < 0 ||
      Number(revision["authorityRank"]) > 999_999 ||
      !Number.isSafeInteger(revision["sequence"]) ||
      Number(revision["sequence"]) < 0 ||
      Number(revision["sequence"]) > 999_999_999_999 ||
      !text(revision["token"], 128) ||
      !/^[\x20-\x7e]+$/.test(String(revision["token"]))
    )
      throw new Error("invalid-result");
    if (
      result["scores"] !== undefined &&
      (!Array.isArray(result["scores"]) ||
        result["scores"].length !== 2 ||
        result["scores"].some((score) => {
          if (!score || typeof score !== "object") return true;
          const record = score as Record<string, unknown>;
          const scoreValue = record["score"];
          return (
            !Object.keys(record).every((key) =>
              ["providerParticipantId", "score"].includes(key),
            ) ||
            !text(record["providerParticipantId"]) ||
            !Number.isSafeInteger(scoreValue) ||
            typeof scoreValue !== "number" ||
            scoreValue < 0
          );
        }))
    )
      throw new Error("invalid-result");
    const scores = result["scores"] as
      readonly Record<string, unknown>[] | undefined;
    if (
      scores &&
      new Set(scores.map((score) => score["providerParticipantId"])).size !==
        scores.length
    )
      throw new Error("invalid-result");
    const detail = result["detail"];
    if (detail !== undefined) {
      if (!detail || typeof detail !== "object" || Array.isArray(detail))
        throw new Error("invalid-result");
      const record = detail as Record<string, unknown>;
      let detailValue: string | undefined;
      try {
        detailValue = JSON.stringify(record["value"]);
      } catch {
        throw new Error("invalid-result");
      }
      if (
        !Object.keys(record).every((key) =>
          ["schemaId", "schemaVersion", "value"].includes(key),
        ) ||
        !text(record["schemaId"], 128) ||
        !String(record["schemaId"]).startsWith(`${request.sportKey}.result.`) ||
        !text(record["schemaVersion"], 32) ||
        detailValue === undefined ||
        detailValue.length > 32_768
      )
        throw new Error("invalid-result");
    }
    ids.add(result["providerEventId"]);
  }
  return input as CompletedResultPage;
}
export class CompletedResultsAdapterRegistry {
  readonly #items = new Map<string, CompletedResultsAdapter>();
  constructor(items: readonly CompletedResultsAdapter[]) {
    for (const item of items) {
      if (
        !supportsRequest(item.descriptor, "results", {
          sportKey: item.sportKey,
          leagueKey: item.leagueKey,
        })
      )
        throw new Error("result-adapter-coverage-mismatch");
      const key = JSON.stringify([
        item.descriptor.id,
        item.sportKey,
        item.leagueKey,
      ]);
      if (this.#items.has(key)) throw new Error("duplicate-result-adapter");
      this.#items.set(key, item);
    }
  }
  get(providerId: string, sportKey: SportKey, leagueKey: string) {
    return this.#items.get(JSON.stringify([providerId, sportKey, leagueKey]));
  }
}
export class FixtureCompletedResultsAdapter implements CompletedResultsAdapter {
  constructor(
    readonly descriptor: ProviderDescriptor,
    readonly sportKey: SportKey,
    readonly leagueKey: string,
    readonly pages: readonly (readonly ProviderCompletedResult[])[],
  ) {}
  listCompletedResults(
    request: CompletedResultPageRequest,
  ): Promise<CompletedResultPage> {
    const index = request.cursor === undefined ? 0 : Number(request.cursor);
    if (!Number.isSafeInteger(index) || index < 0)
      throw new Error("fixture-results-cursor-invalid");
    const results = this.pages[index] ?? [];
    const retrievedAt = results.reduce(
      (latest, item) =>
        item.providerTimestamp > latest ? item.providerTimestamp : latest,
      request.windowStart,
    );
    return Promise.resolve({
      results,
      retrievedAt,
      providerRequests: 1,
      quotaUsed: 0,
      ...(index + 1 < this.pages.length
        ? { nextCursor: String(index + 1) }
        : {}),
    });
  }
}
