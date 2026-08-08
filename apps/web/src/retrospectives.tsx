// The retrospective review screens load on demand.
import { useContext, useEffect, useState } from "react";
import { Link, useParams } from "@tanstack/react-router";
import { type RetrospectiveDto } from "./api";
import { GamesClientContext } from "./App";
export function RetrospectivesList() {
  const client = useContext(GamesClientContext),
    [state, setState] = useState<{
      loading: boolean;
      items: readonly RetrospectiveDto[];
      error: string | null;
    }>({ loading: true, items: [], error: null });
  useEffect(() => {
    const controller = new AbortController();
    if (!client.ok || !client.value.listRetrospectives) {
      void Promise.resolve().then(() =>
        setState({
          loading: false,
          items: [],
          error: "Retrospectives are unavailable in this environment.",
        }),
      );
      return () => controller.abort();
    }
    client.value
      .listRetrospectives(controller.signal)
      .then((items) => setState({ loading: false, items, error: null }))
      .catch((error: unknown) => {
        if (!controller.signal.aborted)
          setState({
            loading: false,
            items: [],
            error:
              error instanceof Error
                ? error.message
                : "Retrospectives are temporarily unavailable.",
          });
      });
    return () => controller.abort();
  }, [client]);
  return (
    <>
      <header>
        <div>
          <p className="eyebrow">FROZEN LEARNING · REVIEWABLE HISTORY</p>
          <h1>Retrospectives</h1>
          <p>
            Structured lessons from exact performance evidence. Outcomes invite
            review; they do not prove cause.
          </p>
        </div>
      </header>
      {state.loading ? (
        <section className="performance-state">
          Loading frozen retrospectives…
        </section>
      ) : state.error ? (
        <section className="performance-state" role="alert">
          {state.error}
        </section>
      ) : state.items.length === 0 ? (
        <section className="performance-state">
          <h2>No retrospectives yet</h2>
          <p>A retrospective appears after a completed performance report.</p>
        </section>
      ) : (
        <section className="retrospective-grid">
          {state.items.map((item) => (
            <Link
              key={item.versionId}
              to="/retrospectives/$versionId"
              params={{ versionId: item.versionId }}
              className="retrospective-card"
            >
              <span className="eyebrow">
                VERSION {item.version} · {item.state.toUpperCase()}
              </span>
              <h2>
                {item.memberCount} reviewed decision
                {item.memberCount === 1 ? "" : "s"}
              </h2>
              <p>
                {item.caution === "standard"
                  ? "Established review sample"
                  : item.caution === "single-member"
                    ? "Single-member caution"
                    : "Small-sample caution"}
              </p>
              <small>
                Report revision {item.reportRevision} ·{" "}
                {new Date(item.createdAt).toLocaleString()}
              </small>
            </Link>
          ))}
        </section>
      )}
    </>
  );
}
export function RetrospectiveDetail() {
  const { versionId } = useParams({ from: "/retrospectives/$versionId" }),
    client = useContext(GamesClientContext),
    [state, setState] = useState<{
      loading: boolean;
      item: RetrospectiveDto | null;
      versions: readonly RetrospectiveDto[];
      error: string | null;
    }>({ loading: true, item: null, versions: [], error: null }),
    [canReview, setCanReview] = useState(false),
    [reviewAction, setReviewAction] = useState<
      "approve" | "reject" | "request-changes"
    >("request-changes"),
    [reviewNote, setReviewNote] = useState(""),
    [reviewConfirmed, setReviewConfirmed] = useState(false),
    [reviewStatus, setReviewStatus] = useState<string | null>(null),
    [reviewBusy, setReviewBusy] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    if (!client.ok || !client.value.getRetrospective) {
      void Promise.resolve().then(() =>
        setState({
          loading: false,
          item: null,
          versions: [],
          error: "Retrospective detail is unavailable.",
        }),
      );
      return () => controller.abort();
    }
    client.value
      .getRetrospective(versionId, controller.signal)
      .then(async (item) => ({
        item,
        versions: client.value.listRetrospectiveVersions
          ? await client.value.listRetrospectiveVersions(
              item.retrospectiveId,
              controller.signal,
            )
          : [item],
      }))
      .then(({ item, versions }) =>
        setState({ loading: false, item, versions, error: null }),
      )
      .catch((error: unknown) => {
        if (!controller.signal.aborted)
          setState({
            loading: false,
            item: null,
            versions: [],
            error:
              error instanceof Error
                ? error.message
                : "This retrospective is temporarily unavailable.",
          });
      });
    void client.value.canReviewRetrospectives?.().then((allowed) => {
      if (!controller.signal.aborted) setCanReview(allowed);
    });
    return () => controller.abort();
  }, [client, versionId]);
  if (state.loading)
    return (
      <section className="performance-state">
        Loading exact review evidence…
      </section>
    );
  if (state.error || !state.item)
    return (
      <section className="performance-state" role="alert">
        {state.error ?? "Retrospective unavailable."}
      </section>
    );
  const item = state.item;
  const submitReview = async () => {
    if (
      !client.ok ||
      !client.value.reviewRetrospective ||
      !reviewConfirmed ||
      reviewBusy
    )
      return;
    const controller = new AbortController();
    setReviewBusy(true);
    setReviewStatus(null);
    try {
      const reviewed = await client.value.reviewRetrospective(
        item,
        {
          reasonCode: reviewAction,
          note: reviewNote,
          idempotencyKey: crypto.randomUUID(),
        },
        controller.signal,
      );
      const versions = client.value.listRetrospectiveVersions
        ? await client.value.listRetrospectiveVersions(
            reviewed.retrospectiveId,
            controller.signal,
          )
        : [reviewed];
      setState({ loading: false, item: reviewed, versions, error: null });
      setReviewConfirmed(false);
      setReviewStatus(
        "Review saved. The immutable audit history has been refreshed.",
      );
    } catch (error) {
      if (
        (error as { code?: string }).code === "conflict" &&
        client.value.getRetrospective
      ) {
        const refreshed = await client.value.getRetrospective(
          item.versionId,
          controller.signal,
        );
        const versions = client.value.listRetrospectiveVersions
          ? await client.value.listRetrospectiveVersions(
              refreshed.retrospectiveId,
              controller.signal,
            )
          : [refreshed];
        setState({ loading: false, item: refreshed, versions, error: null });
        setReviewStatus(
          "Another reviewer changed this version. The latest state is now shown; please review it again.",
        );
      } else
        setReviewStatus(
          error instanceof Error
            ? error.message
            : "The review could not be saved.",
        );
    } finally {
      setReviewBusy(false);
    }
  };
  return (
    <>
      <header>
        <div>
          <p className="eyebrow">
            RETROSPECTIVE V{item.version} · {item.state.toUpperCase()}
          </p>
          <h1>Evidence review</h1>
          <p>
            {item.memberCount} frozen decisions ·{" "}
            {item.caution.replace("-", " ")} · no automatic strategy changes
          </p>
        </div>
        <span className="status">READ ONLY</span>
      </header>
      <section className="evidence-layers">
        <article>
          <span className="eyebrow">DECISION-TIME EVIDENCE</span>
          <h2>What was knowable then</h2>
          {item.evidence.decisionTime.map((ref) => (
            <div key={ref.id}>
              <strong>{ref.kind}</strong>
              <small>{ref.observedAt}</small>
            </div>
          ))}
          <code>{item.evidence.decisionTimeDigest}</code>
        </article>
        <article>
          <span className="eyebrow">POST-EVENT EVIDENCE</span>
          <h2>What became known later</h2>
          {item.evidence.postDecision.length ? (
            item.evidence.postDecision.map((ref) => (
              <div key={ref.id}>
                <strong>{ref.kind}</strong>
                <small>{ref.observedAt}</small>
              </div>
            ))
          ) : (
            <p>None available.</p>
          )}
          <code>{item.evidence.postDecisionDigest}</code>
        </article>
      </section>
      <section className="retrospective-panel">
        <div>
          <span className="eyebrow">ERROR TAXONOMY · V1</span>
          <h2>Review observations</h2>
        </div>
        {item.observations.map((observation) => (
          <article key={observation.id}>
            <span>{observation.taxonomyCode}</span>
            <strong>{observation.summary}</strong>
            <small>
              {observation.layer.replace("-", " ")} ·{" "}
              {observation.confidence.replace("-", " ")}
            </small>
          </article>
        ))}
      </section>
      <section className="retrospective-panel">
        <span className="eyebrow">OUTCOME & DIMENSION SLICES</span>
        <div className="slice-grid">
          {item.slices.map((slice) => (
            <article key={`${slice.dimension}-${slice.value}`}>
              <strong>
                {slice.dimension}: {slice.value}
              </strong>
              <span>{slice.memberCount} members</span>
              <small>
                {slice.wins}W · {slice.losses}L · {slice.pushes}P ·{" "}
                {slice.voids}V · {slice.unresolved} unresolved
              </small>
              <small>
                Units{" "}
                {slice.units === null ? "unavailable" : slice.units.toFixed(2)}{" "}
                · ROI{" "}
                {slice.roi === null
                  ? "unavailable"
                  : `${(slice.roi * 100).toFixed(1)}%`}
              </small>
            </article>
          ))}
        </div>
      </section>
      <section className="retrospective-panel">
        <span className="eyebrow">NON-EXECUTABLE CHANGE CANDIDATES</span>
        {item.candidates.length ? (
          item.candidates.map((candidate) => (
            <article key={candidate.candidateId}>
              <strong>
                {candidate.kind}: {candidate.summary}
              </strong>
              <small>Review only · cannot deploy or promote</small>
            </article>
          ))
        ) : (
          <p>
            No change candidates were proposed. A loss alone never creates one.
          </p>
        )}
        <p className="sample-caution">
          False-negative review: unavailable until a frozen non-play universe
          exists.
        </p>
      </section>
      <section className="retrospective-panel" aria-label="Version history">
        <span className="eyebrow">VERSION HISTORY</span>
        {state.versions.map((version) => (
          <article key={version.versionId}>
            <span>v{version.version}</span>
            <strong>
              {version.versionId === item.versionId
                ? "Current immutable version"
                : version.state.replace("-", " ")}
            </strong>
            <small>{version.versionId}</small>
            {version.versionId !== item.versionId ? (
              <Link
                to="/retrospectives/$versionId"
                params={{ versionId: version.versionId }}
              >
                Open immutable version
              </Link>
            ) : null}
          </article>
        ))}
        {state.versions.length === 1 && !item.predecessorVersionId ? (
          <p>Initial version; no predecessor.</p>
        ) : null}
      </section>
      <section
        className="retrospective-panel"
        aria-label="Review audit history"
      >
        <span className="eyebrow">REVIEW AUDIT</span>
        {item.audit?.items.length ? (
          item.audit.items.map((decision) => (
            <article key={decision.decisionId}>
              <strong>{decision.reasonCode.replace("-", " ")}</strong>
              <small>
                {decision.fromState} → {decision.toState} ·{" "}
                {new Date(decision.decidedAt).toLocaleString()}
              </small>
            </article>
          ))
        ) : (
          <p>No human review decisions yet.</p>
        )}
      </section>
      {canReview && item.state === "draft" ? (
        <section
          className="retrospective-panel"
          aria-label="Human review decision"
        >
          <span className="eyebrow">REVIEWER DECISION</span>
          <fieldset>
            <legend>Choose one explicit action</legend>
            {(["request-changes", "approve", "reject"] as const).map(
              (action) => (
                <label key={action}>
                  <input
                    type="radio"
                    name="review-action"
                    value={action}
                    checked={reviewAction === action}
                    onChange={() => {
                      setReviewAction(action);
                      setReviewConfirmed(false);
                    }}
                  />
                  {action.replace("-", " ")}
                </label>
              ),
            )}
          </fieldset>
          <label>
            <span>Reviewer note</span>
            <textarea
              value={reviewNote}
              maxLength={1000}
              onChange={(event) => {
                setReviewNote(event.currentTarget.value);
                setReviewConfirmed(false);
              }}
            />
          </label>
          <label>
            <input
              type="checkbox"
              checked={reviewConfirmed}
              onChange={(event) =>
                setReviewConfirmed(event.currentTarget.checked)
              }
            />
            I confirm this {reviewAction.replace("-", " ")} decision for version{" "}
            {item.version}.
          </label>
          <button
            type="button"
            disabled={!reviewConfirmed || reviewBusy}
            onClick={() => void submitReview()}
          >
            {reviewBusy ? "Saving review…" : "Save human review"}
          </button>
        </section>
      ) : null}
      {reviewStatus ? (
        <p role="status" aria-live="polite">
          {reviewStatus}
        </p>
      ) : null}
      <footer className="performance-provenance">
        Cohort {item.cohortId} · Report {item.reportId} · Manifest{" "}
        {item.evidence.manifestDigest}
        <br />
        Version lineage: {item.predecessorVersionId ?? "initial version"}
      </footer>
    </>
  );
}
