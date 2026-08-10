import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  participantSelectionKey,
  type EntityId,
  type RankedOpportunityDto,
} from "@find-the-edge/domain";
import { displayAmericanOdds, displayPercentage } from "@find-the-edge/odds";

import type {
  ArbitrageFindingDto,
  GamesClient,
  GamesSport,
  RankedOpportunityPageDto,
} from "./api";
import { SportsbookLogo, sportsbookMetadata } from "./sportsbooks";
import { ProviderStatusSummary } from "./provider-status";

export type DashboardClientResult =
  | {
      readonly ok: true;
      readonly value: Pick<
        GamesClient,
        "listOpportunities" | "listArbitrage" | "providerStatus"
      >;
    }
  | { readonly ok: false; readonly error: { readonly message: string } };

const sportLabels: Record<GamesSport, string> = { mlb: "MLB", soccer: "MLS" };
const POLL_INTERVAL_MS = 15_000;
const MAX_TIMER_MS = 2_147_000_000;

const words = (value: string) =>
  value
    .replace(/[:/_-]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());

const identifierLabel = (value: string) =>
  /^[a-z0-9]{2,5}$/.test(value) ? value.toUpperCase() : words(value);

const easternTime = (value: string) =>
  new Date(value).toLocaleString("en-US", {
    timeZone: "America/New_York",
    dateStyle: "medium",
    timeStyle: "short",
  });

const selectionLabel = (item: RankedOpportunityDto) => {
  const selection = item.market.selectionKey;
  const participant = item.event.participants.find(
    ({ id }) =>
      id === selection ||
      participantSelectionKey(id as EntityId) === selection ||
      participantSelectionKey(id as EntityId, "over") === selection ||
      participantSelectionKey(id as EntityId, "under") === selection,
  );
  if (!participant) return words(selection);
  if (selection.endsWith(":over")) return `${participant.label} Over`;
  if (selection.endsWith(":under")) return `${participant.label} Under`;
  return participant.label;
};

const warningLabel = (warning: RankedOpportunityDto["warningCodes"][number]) =>
  warning === "comparison-outlier-excluded"
    ? "Comparison outlier excluded"
    : "Market disagreement warning";

function OpportunityCard({ item }: { readonly item: RankedOpportunityDto }) {
  const target = sportsbookMetadata(item.target.sportsbookId);
  const comparison = item.bestComparison
    ? sportsbookMetadata(item.bestComparison.sportsbookId)
    : null;
  const matchup = item.event.participants
    .map(({ label }) => label)
    .join(" vs ");
  return (
    <li className="opportunity-card" data-opportunity-id={item.opportunityId}>
      <article aria-labelledby={`opportunity-${item.opportunityId}`}>
        <header className="opportunity-card-heading">
          <div>
            <p className="eyebrow">
              {sportLabels[item.sportKey as GamesSport] ??
                identifierLabel(item.sportKey)}{" "}
              · {identifierLabel(item.event.competitionKey)}
            </p>
            <h2 id={`opportunity-${item.opportunityId}`}>{matchup}</h2>
            <p>
              <time dateTime={item.event.startsAt}>
                {easternTime(item.event.startsAt)} Eastern
              </time>
              <span aria-hidden="true"> · </span>
              {words(item.market.key)} · {selectionLabel(item)}
              {item.market.point === null
                ? ""
                : ` ${item.market.point > 0 ? "+" : ""}${String(item.market.point)}`}
            </p>
          </div>
          <div className="opportunity-ev" aria-label="Estimated expected value">
            <span>ESTIMATED EV</span>
            <strong>{displayPercentage(item.expectedValue).text}</strong>
            <small>Model estimate, not a guarantee</small>
          </div>
        </header>

        <div className="opportunity-evidence-grid">
          <section aria-label="Target sportsbook evidence">
            <span className="opportunity-label">Target price</span>
            <div className="opportunity-book">
              <span aria-hidden="true">
                <SportsbookLogo scope={item.target.sportsbookId} />
              </span>
              <strong>{target.name}</strong>
            </div>
            <b>{displayAmericanOdds(item.target.americanOdds).text}</b>
            <small>
              Implied probability{" "}
              {displayPercentage(item.target.impliedProbability).text}
            </small>
          </section>
          <section aria-label="Best comparison evidence">
            <span className="opportunity-label">Best comparison</span>
            {comparison && item.bestComparison ? (
              <>
                <div className="opportunity-book">
                  <span aria-hidden="true">
                    <SportsbookLogo scope={item.bestComparison.sportsbookId} />
                  </span>
                  <strong>{comparison.name}</strong>
                </div>
                <b>
                  {displayAmericanOdds(item.bestComparison.americanOdds).text}
                </b>
              </>
            ) : (
              <strong className="opportunity-unavailable">
                No included comparison price
              </strong>
            )}
          </section>
          <section aria-label="Consensus fair value">
            <span className="opportunity-label">Consensus fair value</span>
            <b>{displayAmericanOdds(item.consensus.fairAmericanOdds).text}</b>
            <small>
              Estimated fair probability{" "}
              {displayPercentage(item.consensus.probability).text}
            </small>
          </section>
          <section aria-label="Contributing sportsbook coverage">
            <span className="opportunity-label">Book coverage</span>
            <b>{item.contributingBooks.length} books</b>
            <small>
              {item.contributingBooks
                .map((sportsbookId) => sportsbookMetadata(sportsbookId).name)
                .join(", ")}
            </small>
          </section>
        </div>

        <div className="opportunity-quality-grid">
          <section>
            <span className="opportunity-label">Confidence</span>
            <strong>
              {item.confidence.score}/100 · {words(item.confidence.bucket)}
            </strong>
            <div
              className="confidence-meter"
              role="meter"
              aria-label={`Confidence ${String(item.confidence.score)} out of 100`}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={item.confidence.score}
            >
              <i style={{ width: `${String(item.confidence.score)}%` }} />
            </div>
            <small>Model and data confidence, not win probability</small>
          </section>
          <section>
            <span className="opportunity-label">Data quality</span>
            <strong>
              {item.dataQuality.score}/100 · weakest:{" "}
              {words(item.dataQuality.weakestComponent)}
            </strong>
            <dl className="quality-components">
              {Object.entries(item.confidence.components).map(
                ([key, value]) => (
                  <div key={key}>
                    <dt>{words(key)}</dt>
                    <dd>{value}/100</dd>
                  </div>
                ),
              )}
            </dl>
          </section>
          <section>
            <span className="opportunity-label">Live freshness</span>
            <strong>
              {item.liveFreshness.ageMinutes.toFixed(1)} min at snapshot
            </strong>
            <small>
              Maximum {item.liveFreshness.maximumAgeMinutes.toFixed(1)} min ·
              scored{" "}
              <time dateTime={item.liveFreshness.scoredAt}>
                {easternTime(item.liveFreshness.scoredAt)} Eastern
              </time>
            </small>
            <small>
              Active until{" "}
              <time dateTime={item.liveFreshness.expiresAt}>
                {easternTime(item.liveFreshness.expiresAt)} Eastern
              </time>
            </small>
          </section>
        </div>

        <div className="opportunity-card-footer">
          <div
            className="opportunity-warnings"
            aria-label="Opportunity warnings"
          >
            {item.warningCodes.length ? (
              item.warningCodes.map((warning) => (
                <span key={warning} className="warning-badge">
                  {warningLabel(warning)}
                </span>
              ))
            ) : (
              <span className="clear-badge">No active warnings</span>
            )}
          </div>
          <div className="opportunity-actions">
            <Link
              className="detail-link"
              to="/events/$gameId"
              params={{ gameId: item.event.id }}
              search={{
                sport: item.sportKey === "soccer" ? "soccer" : "mlb",
                day: item.event.eastern.calendarDay,
                status: "all",
                competition: "",
                query: "",
                sort: "kickoff",
                direction: "asc",
              }}
              aria-label={`Open event ${matchup}`}
            >
              Open Event
            </Link>
            <span className="disabled-action">
              <button
                type="button"
                disabled
                aria-describedby={`add-bet-${item.opportunityId}`}
              >
                Add Bet
              </button>
              <small id={`add-bet-${item.opportunityId}`}>
                Unavailable until Bet Tracker is built.
              </small>
            </span>
          </div>
        </div>
      </article>
    </li>
  );
}

function DashboardSkeleton() {
  return (
    <section
      className="dashboard-skeleton"
      role="status"
      aria-label="Loading ranked opportunities"
    >
      <span className="sr-only">Loading ranked opportunities…</span>
      {Array.from({ length: 3 }, (_, index) => (
        <div key={index} />
      ))}
    </section>
  );
}

function ArbitrageCard({ item }: { readonly item: ArbitrageFindingDto }) {
  const isArb = item.classification === "arbitrage";
  const profitPerUnit = isArb ? (1 / item.sumInverseDecimal - 1) * 100 : null;
  return (
    <li className="arbitrage-card" data-finding-id={item.findingId}>
      <header>
        <span className={`arbitrage-badge ${isArb ? "arbitrage" : "low-hold"}`}>
          {isArb ? "Arbitrage" : "Low hold"}
        </span>
        <b>
          {item.holdPercentage >= 0 ? "+" : ""}
          {item.holdPercentage.toFixed(2)}% hold
        </b>
        <span className="arbitrage-market">
          {identifierLabel(item.marketKey)} · {easternTime(item.startsAt)}{" "}
          Eastern
        </span>
      </header>
      <ul className="arbitrage-legs">
        {item.legs.map((leg) => (
          <li key={leg.selectionKey}>
            <SportsbookLogo scope={leg.best.sportsbookId} />
            <span className="arbitrage-selection">
              {identifierLabel(
                leg.selectionKey.replace(/^participant:/, "").slice(0, 40),
              )}
              {leg.point !== null ? ` ${String(leg.point)}` : ""}
            </span>
            <b>{displayAmericanOdds(leg.best.americanOdds).text}</b>
          </li>
        ))}
      </ul>
      <footer>
        {profitPerUnit !== null ? (
          <span>
            Guaranteed {profitPerUnit.toFixed(2)}% per unit when every leg fills
            at its quoted price.
          </span>
        ) : (
          <span>
            Near-zero hold: useful for promo conversion, not guaranteed profit.
          </span>
        )}
        <small>
          Quoted {easternTime(item.evaluatedAt)} · expires{" "}
          {easternTime(item.expiresAt)}
        </small>
      </footer>
    </li>
  );
}

function ArbitrageSection({
  client,
  sport,
}: {
  readonly client: DashboardClientResult;
  readonly sport: GamesSport;
}) {
  const available =
    client.ok && typeof client.value.listArbitrage === "function";
  const query = useQuery({
    queryKey: ["arbitrage", sport],
    enabled: available,
    retry: false,
    refetchInterval: POLL_INTERVAL_MS,
    refetchIntervalInBackground: false,
    queryFn: ({ signal }) =>
      client.ok && client.value.listArbitrage
        ? client.value.listArbitrage(sport, signal)
        : Promise.reject(new Error("Arbitrage client unavailable")),
  });
  if (!available) return null;
  // Expiry is judged against the fetch instant, which stays pure per render;
  // the 15-second poll keeps that instant fresh.
  const visible =
    query.data?.items.filter(
      (item) => Date.parse(item.expiresAt) > query.dataUpdatedAt,
    ) ?? [];
  return (
    <section className="dashboard-arbitrage" aria-label="Arbitrage findings">
      <div className="dashboard-section-heading">
        <div>
          <p className="eyebrow">CROSS-BOOK PRICE SETS</p>
          <h2>Arbitrage &amp; low hold</h2>
        </div>
        {query.data?.snapshotAt ? (
          <p>
            Scanned{" "}
            <time dateTime={query.data.snapshotAt}>
              {easternTime(query.data.snapshotAt)} Eastern
            </time>
          </p>
        ) : null}
      </div>
      {query.isPending ? (
        <p className="dashboard-arbitrage-empty">Scanning current prices…</p>
      ) : query.isError ? (
        <p className="dashboard-arbitrage-empty" role="status">
          Arbitrage findings are temporarily unavailable.
        </p>
      ) : visible.length === 0 ? (
        <p className="dashboard-arbitrage-empty" role="status">
          No {sportLabels[sport]} market currently prices below the low-hold
          threshold across collected books. Absence is measured, not assumed.
        </p>
      ) : (
        <ol className="arbitrage-list">
          {visible.map((item) => (
            <ArbitrageCard key={item.findingId} item={item} />
          ))}
        </ol>
      )}
    </section>
  );
}

export function Dashboard({
  client,
}: {
  readonly client: DashboardClientResult;
}) {
  const [sport, setSport] = useState<GamesSport>("mlb");
  const [clock, setClock] = useState(() => Date.now());
  const available =
    client.ok && typeof client.value.listOpportunities === "function";
  const query = useQuery({
    queryKey: ["ranked-opportunities", sport],
    enabled: available,
    retry: false,
    refetchInterval: POLL_INTERVAL_MS,
    refetchIntervalInBackground: false,
    queryFn: ({ signal }) =>
      client.ok && client.value.listOpportunities
        ? client.value.listOpportunities(sport, signal)
        : Promise.reject(new Error("Opportunity client unavailable")),
  });
  const page: RankedOpportunityPageDto | undefined = query.data;
  const refetch = query.refetch;
  const effectiveNow = Math.max(clock, query.dataUpdatedAt);
  const visibleItems = useMemo(
    () =>
      page?.items.filter(
        (item) => Date.parse(item.liveFreshness.expiresAt) > effectiveNow,
      ) ?? [],
    [effectiveNow, page],
  );

  useEffect(() => {
    if (!page?.items.length) return;
    const now = Date.now();
    const futureExpiries = page.items
      .map((item) => Date.parse(item.liveFreshness.expiresAt))
      .filter((expiry) => expiry > now);
    if (!futureExpiries.length) return;
    const nextExpiry = Math.min(...futureExpiries);
    const timeout = globalThis.setTimeout(
      () => {
        setClock(Date.now());
        void refetch();
      },
      Math.min(MAX_TIMER_MS, Math.max(0, nextExpiry - now + 1)),
    );
    return () => globalThis.clearTimeout(timeout);
  }, [clock, page, refetch]);

  const partialEvaluation =
    !!page &&
    (page.evaluationState === "partial" ||
      page.hasMoreUnknown ||
      page.joinFailureCount > 0);
  const moreKnownResults = !!page && page.nextCursor !== null;
  const countIsLowerBound = partialEvaluation || moreKnownResults;
  const hasKnownExclusions =
    !!page && (page.filteredCount > 0 || page.staleCount > 0);
  const shown = `${String(visibleItems.length)}${countIsLowerBound ? "+" : ""}`;
  const failureMessage = !client.ok
    ? client.error.message
    : "Opportunities are temporarily unavailable.";

  return (
    <div className="dashboard">
      <header className="dashboard-header">
        <div>
          <p className="eyebrow">LIVE EDGE BOARD · SERVER RANKED</p>
          <h1>Where is the edge right now?</h1>
          <p className="lede">
            Qualified opportunities only. Evidence and confidence explain the
            estimate; positive EV never guarantees an outcome.
          </p>
        </div>
        <fieldset className="dashboard-sport-selector">
          <legend>Opportunity sport</legend>
          {(Object.keys(sportLabels) as GamesSport[]).map((value) => (
            <button
              type="button"
              key={value}
              className={sport === value ? "selected" : ""}
              aria-pressed={sport === value}
              onClick={() => setSport(value)}
            >
              {sportLabels[value]}
            </button>
          ))}
        </fieldset>
      </header>

      <section className="dashboard-kpis" aria-label="Dashboard summary">
        <article>
          <span>Active +EV shown</span>
          <strong>{page ? shown : "—"}</strong>
          <small>
            {countIsLowerBound ? "Verified lower bound" : "Exact current page"}
          </small>
        </article>
        <article>
          <span>Highest estimated EV</span>
          <strong>
            {visibleItems[0]
              ? displayPercentage(visibleItems[0].expectedValue).text
              : "—"}
          </strong>
          <small>
            {visibleItems[0]
              ? "First in authoritative rank"
              : "No active opportunity"}
          </small>
        </article>
        <article>
          <span>Open exposure</span>
          <strong>Unavailable</strong>
          <small>Bet Tracker is not connected.</small>
        </article>
        <article>
          <span>Recent CLV</span>
          <strong>Unavailable</strong>
          <small>Closing evidence is not connected.</small>
        </article>
      </section>

      {!available ? (
        <section className="dashboard-state error" role="alert">
          <h2>Dashboard unavailable</h2>
          <p>{failureMessage}</p>
        </section>
      ) : query.isPending ? (
        <DashboardSkeleton />
      ) : query.isError ? (
        <section className="dashboard-state error" role="alert">
          <h2>Unable to load ranked opportunities</h2>
          <p>{failureMessage}</p>
          <button type="button" onClick={() => void query.refetch()}>
            Retry
          </button>
        </section>
      ) : page ? (
        <>
          {partialEvaluation ? (
            <section className="dashboard-state partial" role="status">
              <h2>Verified opportunities from incomplete evaluation</h2>
              <p>
                Counts are a lower bound. Excluded while evaluating:{" "}
                {page.filteredCount} filtered, {page.staleCount} stale,{" "}
                {page.joinFailureCount} join failures
                {page.nextCursor ? "; more ranked rows are available" : ""}.
              </p>
            </section>
          ) : null}
          {!partialEvaluation && moreKnownResults ? (
            <section className="dashboard-state partial" role="status">
              <h2>More ranked opportunities are available</h2>
              <p>
                This page is fully evaluated, but the Dashboard shows only the
                highest-ranked verified results. The count is a lower bound.
              </p>
            </section>
          ) : null}
          {!partialEvaluation && !moreKnownResults && hasKnownExclusions ? (
            <section className="dashboard-state exclusions" role="status">
              <h2>Evaluation exclusions applied</h2>
              <p>
                The current result is complete: {page.filteredCount} filtered
                and {page.staleCount} stale candidates were excluded.
              </p>
            </section>
          ) : null}
          {visibleItems.length === 0 ? (
            <section className="dashboard-state no-edge" role="status">
              <p className="eyebrow">PASS IS A VALID DECISION</p>
              <h2>
                {page.items.length > 0
                  ? "Previously loaded evidence has expired"
                  : partialEvaluation
                    ? "No verified opportunity in this partial result"
                    : "No qualified edge"}
              </h2>
              <p>
                {page.items.length > 0
                  ? `Expired ${sportLabels[sport]} opportunities were removed from active view. Revalidation is ${query.isFetching ? "in progress" : query.isRefetchError ? "temporarily unavailable" : "pending"}; this is not a no-edge claim.`
                  : partialEvaluation
                    ? `The current ${sportLabels[sport]} evaluation is incomplete, so this is not a claim that no edge exists.`
                    : `No active ${sportLabels[sport]} opportunity currently meets the server’s qualification thresholds. Nothing has been promoted to force a recommendation.`}
              </p>
            </section>
          ) : (
            <>
              <div className="dashboard-section-heading">
                <div>
                  <p className="eyebrow">ACTIVE +EV OPPORTUNITIES</p>
                  <h2>Ranked evidence</h2>
                </div>
                <p>
                  Snapshot{" "}
                  <time dateTime={page.snapshotAt}>
                    {easternTime(page.snapshotAt)} Eastern
                  </time>
                </p>
              </div>
              <ol className="opportunity-list">
                {visibleItems.map((item) => (
                  <OpportunityCard key={item.opportunityId} item={item} />
                ))}
              </ol>
            </>
          )}
        </>
      ) : null}

      <ArbitrageSection client={client} sport={sport} />

      <ProviderStatusSummary client={client} />

      <section
        className="dashboard-placeholders"
        aria-label="Upcoming dashboard modules"
      >
        {[
          ["Upcoming watched events", "Not connected · Watchlist is not built"],
          [
            "Recent line movement",
            "Open an Event to inspect available history",
          ],
          [
            "Recently completed reports",
            "Not connected · Scouting Reports are not built",
          ],
        ].map(([title, detail]) => (
          <article key={title}>
            <h2>{title}</h2>
            <p>{detail}</p>
          </article>
        ))}
      </section>
    </div>
  );
}
