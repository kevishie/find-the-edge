// The strategy experiment screens load on demand.
import { useCallback, useContext, useEffect, useRef, useState } from "react";
import { Link, useParams } from "@tanstack/react-router";
import { GamesClientContext, type StrategyExperimentDto } from "./App";
import { isRequestCancellation } from "./api";
import { SessionContext, useSession } from "./session";
export function ExperimentsList() {
  const client = useContext(GamesClientContext);
  const [items, setItems] = useState<readonly StrategyExperimentDto[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    if (!client.ok || !client.value.listExperiments)
      void Promise.resolve().then(() =>
        setError("Strategy experiments are unavailable."),
      );
    else
      void client.value
        .listExperiments(controller.signal)
        .then(setItems)
        .catch(() =>
          setError("Strategy experiments are temporarily unavailable."),
        );
    return () => controller.abort();
  }, [client]);
  return (
    <>
      <header className="page-header">
        <p className="eyebrow">WALK-FORWARD · HUMAN-GOVERNED</p>
        <h1>Strategy experiments</h1>
        <p>
          Challengers use frozen shadow evidence. Passing gates never activates
          a strategy without human approval.
        </p>
      </header>
      {error ? (
        <section className="empty-state" role="alert">
          {error}
        </section>
      ) : (
        <section className="performance-cards">
          {items.map((item) => (
            <article className="metric-card" key={item.experimentId}>
              <span>{item.createdAt}</span>
              <h2>
                <Link
                  to="/experiments/$experimentId"
                  params={{ experimentId: item.experimentId }}
                >
                  {item.baseline.version} → {item.challenger.version}
                </Link>
              </h2>
              <strong>{item.state}</strong>
              <ul>
                {item.gates.map((gate) => (
                  <li key={gate.metric}>
                    {gate.metric}: {gate.actual ?? "Unavailable"} —{" "}
                    {gate.passed ? "Pass" : "Fail"}
                  </li>
                ))}
              </ul>
              {item.failureReasons.length ? (
                <p>Blocked: {item.failureReasons.join(", ")}</p>
              ) : null}
              <small>Future paper runs only. No real-money activation.</small>
            </article>
          ))}
        </section>
      )}
    </>
  );
}

export function ExperimentDetail() {
  const { experimentId } = useParams({ from: "/experiments/$experimentId" });
  const client = useContext(GamesClientContext);
  const session = useSession(useContext(SessionContext));
  const sessionKey =
    session === null ? null : `${session.accountId}\u0000${session.token}`;
  type ExperimentDetailItem = StrategyExperimentDto & {
    readonly train: { startsAt: string; endsAt: string; digest: string };
    readonly tune: { startsAt: string; endsAt: string; digest: string };
    readonly holdout: { startsAt: string; endsAt: string; digest: string };
    readonly contentDigest: string;
    readonly audit: readonly {
      readonly activationId?: string;
      readonly effectiveAt?: string;
    }[];
    readonly active: { readonly activationId: string } | null;
  };
  type ExperimentDetailState =
    | {
        readonly kind: "loading";
        readonly client: typeof client;
        readonly experimentId: string;
      }
    | {
        readonly kind: "ready";
        readonly client: typeof client;
        readonly experimentId: string;
        readonly item: ExperimentDetailItem;
      }
    | {
        readonly kind: "error";
        readonly client: typeof client;
        readonly experimentId: string;
      };
  const [detail, setDetail] = useState<ExperimentDetailState>({
    kind: "loading",
    client,
    experimentId,
  });
  const currentDetail =
    detail.client === client && detail.experimentId === experimentId
      ? detail
      : ({ kind: "loading", client, experimentId } as const);
  const item = currentDetail.kind === "ready" ? currentDetail.item : null;
  const [authority, setAuthority] = useState<{
    readonly client: unknown;
    readonly sessionKey: string | null;
    readonly allowed: boolean;
  }>({ client: null, sessionKey: null, allowed: false });
  const allowed =
    authority.client === client &&
    authority.sessionKey === sessionKey &&
    authority.allowed === true;
  const [reason, setReason] = useState("");
  const [effectiveAt, setEffectiveAt] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [actionState, setActionState] = useState<string | null>(null);
  const actionController = useRef<AbortController | null>(null);
  const load = useCallback(
    async (signal: AbortSignal) => {
      await Promise.resolve();
      if (signal.aborted) return;
      if (!client.ok || !client.value.getExperiment) {
        setDetail({ kind: "error", client, experimentId });
        return;
      }
      try {
        const value = await client.value.getExperiment(experimentId, signal);
        if (!signal.aborted)
          setDetail({
            kind: "ready",
            client,
            experimentId,
            item: value as ExperimentDetailItem,
          });
      } catch (error) {
        if (signal.aborted || isRequestCancellation(error)) return;
        setDetail({ kind: "error", client, experimentId });
      }
    },
    [client, experimentId],
  );
  useEffect(() => {
    const controller = new AbortController();
    void Promise.resolve().then(() => load(controller.signal));
    return () => controller.abort();
  }, [client, experimentId, load]);
  useEffect(() => {
    const controller = new AbortController();
    if (client.ok && sessionKey !== null)
      void client.value
        .canManageExperiments?.(controller.signal)
        .then((nextAllowed) => {
          if (!controller.signal.aborted)
            setAuthority({ client, sessionKey, allowed: nextAllowed });
        })
        .catch(() => {
          if (!controller.signal.aborted)
            setAuthority({ client, sessionKey, allowed: false });
        });
    return () => controller.abort();
  }, [client, sessionKey]);
  useEffect(
    () => () => {
      actionController.current?.abort();
      actionController.current = null;
    },
    [sessionKey],
  );
  if (currentDetail.kind === "error")
    return (
      <section className="empty-state" role="alert">
        Strategy experiment evidence is unavailable.
      </section>
    );
  if (!item)
    return (
      <section className="empty-state">
        Loading immutable experiment evidence…
      </section>
    );
  return (
    <>
      <header className="page-header">
        <p className="eyebrow">EXACT EVIDENCE · {item.state}</p>
        <h1>
          {item.baseline.version} → {item.challenger.version}
        </h1>
        <p>Digest {item.contentDigest}</p>
      </header>
      <section className="metric-card">
        <h2>Walk-forward timeline</h2>
        <ol>
          <li>
            Train: {item.train.startsAt} – {item.train.endsAt}
            <br />
            {item.train.digest}
          </li>
          <li>
            Tune: {item.tune.startsAt} – {item.tune.endsAt}
            <br />
            {item.tune.digest}
          </li>
          <li>
            Holdout: {item.holdout.startsAt} – {item.holdout.endsAt}
            <br />
            {item.holdout.digest}
          </li>
        </ol>
      </section>
      <section className="performance-cards">
        {item.gates.map((gate) => (
          <article className="metric-card" key={gate.metric}>
            <span>{gate.metric}</span>
            <strong>{gate.actual ?? "Unavailable"}</strong>
            <p>{gate.passed ? "Passed" : `Failed: ${gate.reason}`}</p>
          </article>
        ))}
      </section>
      <section className="metric-card">
        <h2>Immutable approval and activation history</h2>
        <p>
          {item.audit.length
            ? `${item.audit.length} recorded actions`
            : "No human action recorded."}
        </p>
        <small>
          Promotion and rollback require the dedicated promoter identity, an
          exact digest, confirmation reason, and a future effective time.
          Historical paper runs never change.
        </small>
      </section>
      <section className="metric-card" aria-label="Strategy promotion controls">
        <h2>Human promotion control</h2>
        {!allowed ? (
          <p>Read-only. Strategy promoter access is unavailable.</p>
        ) : (
          <>
            <label>
              Reason
              <input
                value={reason}
                maxLength={1000}
                onChange={(event) => setReason(event.target.value)}
              />
            </label>
            <label>
              Future effective time
              <input
                type="datetime-local"
                value={effectiveAt}
                onChange={(event) => setEffectiveAt(event.target.value)}
              />
            </label>
            <label>
              <input
                type="checkbox"
                checked={confirmed}
                onChange={(event) => setConfirmed(event.target.checked)}
              />{" "}
              I confirm this only changes future paper runs, targets the
              displayed artifact/digest, and never changes historical runs or
              enables real-money betting.
            </label>
            <div className="review-actions">
              {(["approve", "promote", "rollback"] as const).map((action) => (
                <button
                  key={action}
                  disabled={
                    !confirmed ||
                    !reason.trim() ||
                    (action !== "approve" && !effectiveAt)
                  }
                  onClick={() => {
                    if (!client.ok || !client.value.manageExperiment) return;
                    actionController.current?.abort();
                    const controller = new AbortController();
                    actionController.current = controller;
                    const idempotencyKey = crypto.randomUUID();
                    const body =
                      action === "approve"
                        ? {
                            reason: reason.trim(),
                            idempotencyKey,
                            expectedStateVersion: item.stateVersion,
                            expectedDigest: item.contentDigest,
                            artifactDigest: item.challenger.version.length
                              ? (
                                  item as unknown as {
                                    challenger: { digest: string };
                                  }
                                ).challenger.digest
                              : "",
                          }
                        : {
                            strategyId:
                              action === "rollback"
                                ? item.baseline.strategyId
                                : item.challenger.strategyId,
                            artifactVersion:
                              action === "rollback"
                                ? item.baseline.version
                                : item.challenger.version,
                            artifactDigest:
                              action === "rollback"
                                ? item.baseline.digest
                                : item.challenger.digest,
                            effectiveAt: new Date(effectiveAt).toISOString(),
                            expectedActivationId:
                              item.active?.activationId ?? null,
                            reason: reason.trim(),
                            idempotencyKey,
                          };
                    setActionState("Saving…");
                    void client.value
                      .manageExperiment(
                        experimentId,
                        action,
                        body,
                        controller.signal,
                      )
                      .then(() => {
                        if (controller.signal.aborted) return;
                        setActionState("Saved. Reloaded immutable history.");
                        return load(controller.signal);
                      })
                      .catch(() => {
                        if (controller.signal.aborted) return;
                        setActionState(
                          "Conflict or unavailable. Reloaded current evidence.",
                        );
                        return load(controller.signal);
                      })
                      .finally(() => {
                        if (actionController.current === controller)
                          actionController.current = null;
                      });
                  }}
                >
                  {action}
                </button>
              ))}
            </div>
          </>
        )}
        <p role="status">{actionState}</p>
      </section>
    </>
  );
}
