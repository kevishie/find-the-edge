import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type {
  ProviderStatusPageDto,
  ProviderStatusScopeDto,
} from "@find-the-edge/domain";

import type { GamesClient } from "./api";

export type ProviderStatusClientResult =
  | { readonly ok: true; readonly value: Pick<GamesClient, "providerStatus"> }
  | { readonly ok: false; readonly error: { readonly message: string } };

const eastern = (value: string) =>
  new Date(value).toLocaleString("en-US", {
    timeZone: "America/New_York",
    dateStyle: "medium",
    timeStyle: "short",
  });
const label = (value: string) =>
  value
    .replace(/[-_]/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());

function useProviderStatus(client: ProviderStatusClientResult) {
  const available =
    client.ok && typeof client.value.providerStatus === "function";
  return {
    available,
    query: useQuery({
      queryKey: ["provider-status"],
      enabled: available,
      retry: false,
      refetchInterval: 30_000,
      refetchIntervalInBackground: false,
      queryFn: ({ signal }) =>
        client.ok && client.value.providerStatus
          ? client.value.providerStatus(signal)
          : Promise.reject(new Error("Provider status unavailable")),
    }),
  };
}

const impactCopy = (item: ProviderStatusScopeDto) =>
  item.recommendationImpact === "suppressed"
    ? "New opportunities for this scope are suppressed server-side."
    : item.recommendationImpact === "limited"
      ? "New evidence or opportunities may be limited."
      : "No current recommendation impact.";

function Capacity({ item }: { readonly item: ProviderStatusScopeDto }) {
  const capacity = item.capacity;
  if (capacity.state === "unknown")
    return (
      <p className="capacity-unknown">
        Provider request-window capacity unknown
      </p>
    );
  const percentage = Math.max(
    0,
    Math.min(100, (capacity.remaining! / capacity.limit!) * 100),
  );
  return (
    <div className="provider-capacity">
      <div
        className={`capacity-meter capacity-${capacity.state}`}
        role="meter"
        aria-label={`${item.providerName} ${item.leagueKey} request-window capacity`}
        aria-valuemin={0}
        aria-valuemax={capacity.limit!}
        aria-valuenow={capacity.remaining!}
      >
        <i style={{ width: `${String(percentage)}%` }} />
      </div>
      <p>
        <strong>{capacity.remaining}</strong> of {capacity.limit} requests
        remain · {label(capacity.state)}
      </p>
      <small>
        Automation reserve: {capacity.reserve} · resets{" "}
        {eastern(capacity.resetsAt!)} Eastern
      </small>
    </div>
  );
}

export function ProviderStatusSummary({
  client,
}: {
  readonly client: ProviderStatusClientResult;
}) {
  const { available, query } = useProviderStatus(client);
  const page = query.data;
  return (
    <section
      className="provider-summary"
      aria-labelledby="provider-summary-title"
    >
      <div>
        <p className="eyebrow">DATA SOURCE STATUS</p>
        <h2 id="provider-summary-title">
          Provider status and request capacity
        </h2>
      </div>
      {!available || query.isError ? (
        <div className="provider-summary-state" role="alert">
          <strong>Status unavailable</strong>
          <span>
            Ranked opportunities remain governed by their own verified snapshot.
          </span>
          {available ? (
            <button type="button" onClick={() => void query.refetch()}>
              Retry status
            </button>
          ) : null}
        </div>
      ) : query.isPending ? (
        <div className="provider-summary-state" role="status">
          Loading provider status…
        </div>
      ) : page ? (
        <div className="provider-summary-state" role="status">
          <strong>
            {page.summary.healthy} of {page.summary.total} scopes healthy
          </strong>
          <span>
            {page.summary.impacted > 0
              ? `${String(page.summary.impacted)} scopes may limit new recommendations.`
              : "No current server-authored recommendation impact."}
          </span>
          <span>
            {page.summary.partial} partial · {page.summary.stale} stale ·{" "}
            {page.summary.outage} outage · {page.summary.unknown} unknown
          </span>
        </div>
      ) : null}
      <Link className="detail-link" to="/data-sources">
        Open Data Sources
      </Link>
    </section>
  );
}

function SourceRow({ item }: { readonly item: ProviderStatusScopeDto }) {
  return (
    <li className={`provider-source provider-${item.connection}`}>
      <article>
        <header>
          <div>
            <p className="eyebrow">
              {item.providerName} ·{" "}
              {item.sportKey ? item.sportKey.toUpperCase() : "GLOBAL"}
            </p>
            <h2>
              {label(item.leagueKey)} {label(item.capability)}
            </h2>
            <p>{item.purpose}</p>
          </div>
          <span className={`provider-state state-${item.connection}`}>
            {label(item.connection)}
          </span>
        </header>
        <dl className="provider-details">
          <div>
            <dt>Last checked</dt>
            <dd>
              {item.lastCheckedAt
                ? `${eastern(item.lastCheckedAt)} Eastern`
                : "Unavailable"}
            </dd>
          </div>
          <div>
            <dt>Last successful sync</dt>
            <dd>
              {item.lastSuccessfulAt
                ? `${eastern(item.lastSuccessfulAt)} Eastern`
                : "Unavailable"}
            </dd>
          </div>
          <div>
            <dt>Next retry</dt>
            <dd>
              {item.retryAt
                ? `${eastern(item.retryAt)} Eastern`
                : "Not scheduled"}
            </dd>
          </div>
          <div>
            <dt>Freshness</dt>
            <dd>
              {item.freshness.ageSeconds === null
                ? "Unknown"
                : `${String(item.freshness.ageSeconds)} sec old; expected within ${String(item.freshness.expectedSeconds)} sec`}
            </dd>
          </div>
          <div>
            <dt>Supported data</dt>
            <dd>{item.supportedData.map(label).join(", ")}</dd>
          </div>
          <div>
            <dt>Recommendation impact</dt>
            <dd>{impactCopy(item)}</dd>
          </div>
        </dl>
        <Capacity item={item} />
      </article>
    </li>
  );
}

export function DataSources({
  client,
}: {
  readonly client: ProviderStatusClientResult;
}) {
  const { available, query } = useProviderStatus(client);
  const page: ProviderStatusPageDto | undefined = query.data;
  return (
    <div className="data-sources">
      <header className="dashboard-header">
        <div>
          <p className="eyebrow">PUBLIC OPERATIONAL EVIDENCE</p>
          <h1>Data Sources</h1>
          <p className="lede">
            Connection health and provider request-window capacity are
            independent. Capacity is not subscription quota.
          </p>
        </div>
      </header>
      {!available || query.isError ? (
        <section className="dashboard-state error" role="alert">
          <h2>Provider status unavailable</h2>
          <p>A safe status snapshot could not be loaded.</p>
          {available ? (
            <button type="button" onClick={() => void query.refetch()}>
              Retry status
            </button>
          ) : null}
        </section>
      ) : query.isPending ? (
        <section
          className="dashboard-skeleton"
          role="status"
          aria-label="Loading data sources"
        >
          <span>Loading data sources…</span>
        </section>
      ) : page ? (
        <>
          {page.evaluationState === "partial" ? (
            <section className="dashboard-state partial" role="status">
              <h2>Verified partial status</h2>
              <p>
                Missing scopes remain unknown; verified sibling scopes are
                shown.
              </p>
            </section>
          ) : null}
          <p className="provider-snapshot">
            Snapshot{" "}
            <time dateTime={page.snapshotAt}>
              {eastern(page.snapshotAt)} Eastern
            </time>
          </p>
          <ol className="provider-source-list">
            {page.items.map((item) => (
              <SourceRow key={item.scopeId} item={item} />
            ))}
          </ol>
        </>
      ) : null}
    </div>
  );
}
