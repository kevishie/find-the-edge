import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import type {
  PublicScoutingJob,
  ScoutingFailureCode,
} from "@find-the-edge/domain";

import { GamesClientError, isScoutingJobId, type GamesClient } from "./api";

const ACTIVE_POLL_MS = 2_500;
const MAX_POLL_MS = 15_000;
const ACTION_KEY = /^[A-Za-z0-9._:-]{1,128}$/;

export type ScoutingClientResult =
  | {
      readonly ok: true;
      readonly value: Pick<
        GamesClient,
        "createScoutingJob" | "getScoutingJob" | "retryScoutingJob"
      >;
    }
  | { readonly ok: false; readonly error: { readonly message: string } };

const storageKey = (
  action: "create" | "retry",
  identity: string,
  stateVersion?: number,
) =>
  `fte.scouting.${action}.${encodeURIComponent(identity)}${
    stateVersion === undefined ? "" : `.${String(stateVersion)}`
  }`;

const createResumeKey = (eventId: string) =>
  `fte.scouting.resume.create.${encodeURIComponent(eventId)}`;

const setCreateResume = (eventId: string, pending: boolean): boolean => {
  try {
    const key = createResumeKey(eventId);
    if (pending) sessionStorage.setItem(key, "1");
    else sessionStorage.removeItem(key);
    return !pending || sessionStorage.getItem(key) === "1";
  } catch {
    return false;
  }
};

const consumeCreateResume = (eventId: string): boolean => {
  try {
    const key = createResumeKey(eventId);
    if (sessionStorage.getItem(key) !== "1") return false;
    sessionStorage.removeItem(key);
    return true;
  } catch {
    return false;
  }
};

const randomActionKey = (): string => {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join(
    "",
  );
};

// eslint-disable-next-line react-refresh/only-export-components
export const persistentScoutingActionKey = (
  action: "create" | "retry",
  identity: string,
  stateVersion?: number,
): {
  readonly key: string;
  readonly persisted: boolean;
  readonly clear: () => void;
} => {
  const name = storageKey(action, identity, stateVersion);
  let prior: string | null = null;
  try {
    prior = sessionStorage.getItem(name);
  } catch {
    // A memory-only key still keeps the mounted action single-flight.
  }
  const key = prior && ACTION_KEY.test(prior) ? prior : randomActionKey();
  let persisted = false;
  try {
    sessionStorage.setItem(name, key);
    persisted = sessionStorage.getItem(name) === key;
  } catch {
    // Callers block mutations when the key cannot survive a refresh.
  }
  return {
    key,
    persisted,
    clear: () => {
      try {
        sessionStorage.removeItem(name);
      } catch {
        // The authoritative response is still usable when storage is blocked.
      }
    },
  };
};

const clientError = (error: unknown): GamesClientError | null =>
  error instanceof GamesClientError ? error : null;

const createErrorMessage = (error: unknown): string => {
  const known = clientError(error);
  if (known?.code === "authentication")
    return "Sign in is required to scout this event.";
  if (known?.code === "forbidden")
    return "This account does not have scouting access.";
  if (known?.code === "not-found") return "This event is unavailable.";
  if (known?.code === "not-eligible")
    return "This event is no longer eligible for scouting.";
  if (known?.code === "conflict")
    return "The request could not be reconciled. Try the same request again.";
  return "The request outcome is not yet known. Try again to safely reconcile it.";
};

export function ScoutEventButton({
  eventId,
  eligible,
  disabledReason,
  client,
}: {
  readonly eventId: string;
  readonly eligible: boolean;
  readonly disabledReason: string;
  readonly client: ScoutingClientResult;
}) {
  const navigate = useNavigate();
  const reasonId = useId();
  const errorId = useId();
  const pending = useRef(false);
  const mounted = useRef(true);
  const mutationController = useRef<AbortController | null>(null);
  const pendingAction = useRef<ReturnType<
    typeof persistentScoutingActionKey
  > | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      mutationController.current?.abort();
    };
  }, []);

  const start = useCallback(
    async (resuming = false) => {
      if (
        !mounted.current ||
        pending.current ||
        !eligible ||
        !client.ok ||
        !client.value.createScoutingJob
      )
        return;
      pending.current = true;
      setBusy(true);
      setError(null);
      const action =
        pendingAction.current ?? persistentScoutingActionKey("create", eventId);
      pendingAction.current = action;
      if (!action.persisted) {
        setError(
          "Scouting cannot start while secure session storage is unavailable.",
        );
        pending.current = false;
        setBusy(false);
        return;
      }
      if (!resuming && !setCreateResume(eventId, true)) {
        setError(
          "Scouting cannot start while secure session storage is unavailable.",
        );
        pending.current = false;
        setBusy(false);
        return;
      }
      const controller = new AbortController();
      mutationController.current = controller;
      try {
        const job = await client.value.createScoutingJob(
          eventId,
          action.key,
          controller.signal,
        );
        if (!mounted.current) return;
        setCreateResume(eventId, false);
        action.clear();
        pendingAction.current = null;
        await navigate({
          to: "/scout-jobs/$jobId",
          params: { jobId: job.jobId },
        });
      } catch (failure) {
        setCreateResume(eventId, false);
        if (mounted.current && !controller.signal.aborted)
          setError(createErrorMessage(failure));
      } finally {
        pending.current = false;
        if (mutationController.current === controller)
          mutationController.current = null;
        if (mounted.current) setBusy(false);
      }
    },
    [client, eligible, eventId, navigate],
  );

  useEffect(() => {
    const resume = consumeCreateResume(eventId);
    if (resume && eligible && client.ok && client.value.createScoutingJob)
      queueMicrotask(() => void start(true));
  }, [client, eligible, eventId, start]);

  const unavailable = !client.ok || !client.value.createScoutingJob;
  const reason = unavailable
    ? "Scouting is unavailable in this environment."
    : disabledReason;
  return (
    <span className="scout-action">
      <button
        type="button"
        disabled={!eligible || unavailable || busy}
        aria-describedby={
          [!eligible || unavailable ? reasonId : null, error ? errorId : null]
            .filter(Boolean)
            .join(" ") || undefined
        }
        onClick={() => void start()}
      >
        {busy ? "Opening scouting…" : "Scout"}
      </button>
      {(!eligible || unavailable) && <small id={reasonId}>{reason}</small>}
      {error && (
        <small id={errorId} className="scout-action-error" role="alert">
          {error}
        </small>
      )}
    </span>
  );
}

const jobPresentation = (job: PublicScoutingJob) => {
  switch (job.status) {
    case "queued":
      return {
        tone: "queued",
        eyebrow: "WAITING TO START",
        title: "Scouting is queued",
        message: "The request is saved and waiting to begin.",
      };
    case "in_progress":
      return {
        tone: "active",
        eyebrow: "IN PROGRESS",
        title: "Scouting is in progress",
        message:
          "The scouting job is running. This page will update automatically.",
      };
    case "completed":
      return {
        tone: "complete",
        eyebrow: "COMPLETE",
        title: "Scouting is complete",
        message:
          "The scouting job finished successfully. A report is not available yet.",
      };
    case "failed_retryable":
      return {
        tone: "failed",
        eyebrow: job.failure?.retryable
          ? "RETRY AVAILABLE"
          : "COULD NOT COMPLETE",
        title: "Scouting could not finish",
        message: failureMessage(job.failure?.code),
      };
    case "failed_terminal":
      return {
        tone: "failed",
        eyebrow: "COULD NOT COMPLETE",
        title: "Scouting could not finish",
        message: failureMessage(job.failure?.code),
      };
    case "cancelled":
      return {
        tone: "cancelled",
        eyebrow: "STOPPED",
        title: "Scouting was stopped",
        message:
          "This scouting job is no longer running and cannot be retried.",
      };
  }
};

const failureMessage = (code: ScoutingFailureCode | undefined): string => {
  if (code === "event-version-changed")
    return "The event changed after scouting began. View the game before starting again.";
  if (code === "event-no-longer-scheduled")
    return "The event is no longer scheduled and cannot be scouted.";
  if (code === "attempt-limit-reached")
    return "The retry limit has been reached for this scouting job.";
  if (code === "fixture-contract-invalid")
    return "The available scouting input could not be validated.";
  return "Scouting was interrupted before it could finish.";
};

const initialErrorMessage = (error: unknown): string => {
  const known = clientError(error);
  if (known?.code === "authentication")
    return "Sign in is required to view scouting progress.";
  if (known?.code === "forbidden")
    return "This account does not have scouting access.";
  if (known?.code === "not-found") return "This scouting job is unavailable.";
  if (known?.code === "invalid-response")
    return "Scouting progress could not be verified.";
  return "Scouting progress is temporarily unavailable.";
};

const sameFailure = (
  left: PublicScoutingJob["failure"],
  right: PublicScoutingJob["failure"],
): boolean =>
  left === right ||
  (left !== undefined &&
    right !== undefined &&
    left.code === right.code &&
    left.retryable === right.retryable);

const sameScoutingJob = (
  left: PublicScoutingJob,
  right: PublicScoutingJob,
): boolean =>
  left.schemaVersion === right.schemaVersion &&
  left.jobId === right.jobId &&
  left.eventId === right.eventId &&
  left.eventVersion === right.eventVersion &&
  left.workflowIntent === right.workflowIntent &&
  left.status === right.status &&
  left.stateVersion === right.stateVersion &&
  left.attemptNumber === right.attemptNumber &&
  left.createdAt === right.createdAt &&
  left.updatedAt === right.updatedAt &&
  sameFailure(left.failure, right.failure);

const preservesJobIdentityAndChronology = (
  incoming: PublicScoutingJob,
  prior: PublicScoutingJob,
): boolean =>
  incoming.jobId === prior.jobId &&
  incoming.eventId === prior.eventId &&
  incoming.eventVersion === prior.eventVersion &&
  incoming.workflowIntent === prior.workflowIntent &&
  incoming.createdAt === prior.createdAt &&
  incoming.attemptNumber >= prior.attemptNumber &&
  incoming.updatedAt >= prior.updatedAt;

interface ProgressView {
  readonly loading: boolean;
  readonly job: PublicScoutingJob | null;
  readonly fatal: string | null;
  readonly refreshError: string | null;
  readonly announcement: string;
}

const emptyProgress: ProgressView = {
  loading: true,
  job: null,
  fatal: null,
  refreshError: null,
  announcement: "",
};

export function ScoutingProgress({
  jobId,
  client,
}: {
  readonly jobId: string;
  readonly client: ScoutingClientResult;
}) {
  const latest = useRef<PublicScoutingJob | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const retryPending = useRef(false);
  const mounted = useRef(true);
  const mutationController = useRef<AbortController | null>(null);
  const retryAction = useRef<ReturnType<
    typeof persistentScoutingActionKey
  > | null>(null);
  const [view, setView] = useState<ProgressView>(() =>
    !isScoutingJobId(jobId)
      ? {
          ...emptyProgress,
          loading: false,
          fatal: "This scouting job address is invalid.",
        }
      : !client.ok || !client.value.getScoutingJob
        ? {
            ...emptyProgress,
            loading: false,
            fatal: "Scouting progress is unavailable in this environment.",
          }
        : emptyProgress,
  );
  const [visible, setVisible] = useState(
    () =>
      typeof document === "undefined" || document.visibilityState !== "hidden",
  );
  const [refreshGeneration, setRefreshGeneration] = useState(0);
  const [retryBusy, setRetryBusy] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      mutationController.current?.abort();
    };
  }, []);

  useEffect(() => {
    const update = () => setVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);

  const applyJob = useCallback(
    (incoming: PublicScoutingJob): boolean => {
      if (incoming.jobId !== jobId) return false;
      const prior = latest.current;
      if (prior && incoming.stateVersion < prior.stateVersion) return false;
      if (
        prior &&
        (!preservesJobIdentityAndChronology(incoming, prior) ||
          (incoming.stateVersion === prior.stateVersion &&
            !sameScoutingJob(incoming, prior)))
      ) {
        setView((current) => ({
          ...current,
          refreshError: "The latest scouting update could not be verified.",
        }));
        return false;
      }
      if (prior && incoming.stateVersion === prior.stateVersion) {
        setView((current) => ({ ...current, refreshError: null }));
        setRetryError(null);
        return true;
      }
      if (prior && incoming.stateVersion > prior.stateVersion) {
        retryAction.current?.clear();
        retryAction.current = null;
      }
      latest.current = incoming;
      setRetryError(null);
      const presentation = jobPresentation(incoming);
      setView({
        loading: false,
        job: incoming,
        fatal: null,
        refreshError: null,
        announcement:
          !prior || prior.status !== incoming.status ? presentation.title : "",
      });
      return true;
    },
    [jobId],
  );

  useEffect(() => {
    if (!isScoutingJobId(jobId) || !client.ok || !client.value.getScoutingJob)
      return;
    if (!visible) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | undefined;
    let failures = 0;
    const load = async () => {
      controller = new AbortController();
      try {
        const job = await client.value.getScoutingJob!(
          jobId,
          controller.signal,
        );
        if (stopped) return;
        failures = 0;
        applyJob(job);
        const current = latest.current;
        if (
          current &&
          (current.status === "queued" || current.status === "in_progress")
        )
          timer = setTimeout(() => void load(), ACTIVE_POLL_MS);
      } catch (error) {
        if (stopped || controller.signal.aborted) return;
        const known = clientError(error);
        if (
          known?.code === "authentication" ||
          known?.code === "forbidden" ||
          known?.code === "not-found"
        ) {
          latest.current = null;
          setRetryError(null);
          setView({
            ...emptyProgress,
            loading: false,
            fatal: initialErrorMessage(error),
          });
          return;
        }
        if (!latest.current) {
          setView({
            ...emptyProgress,
            loading: false,
            fatal: initialErrorMessage(error),
          });
          return;
        }
        failures += 1;
        setView((current) => ({
          ...current,
          refreshError:
            "The latest status could not be refreshed. Confirmed progress is still shown.",
        }));
        const confirmed = latest.current;
        if (confirmed.status === "queued" || confirmed.status === "in_progress")
          timer = setTimeout(
            () => void load(),
            Math.min(MAX_POLL_MS, ACTIVE_POLL_MS * 2 ** failures),
          );
      }
    };
    void load();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      controller?.abort();
    };
  }, [applyJob, client, jobId, refreshGeneration, visible]);

  const retry = async () => {
    const job = latest.current;
    if (
      retryPending.current ||
      !client.ok ||
      !client.value.retryScoutingJob ||
      !job ||
      job.status !== "failed_retryable" ||
      job.failure?.retryable !== true
    )
      return;
    retryPending.current = true;
    setRetryBusy(true);
    setRetryError(null);
    const action =
      retryAction.current ??
      persistentScoutingActionKey("retry", job.jobId, job.stateVersion);
    retryAction.current = action;
    if (!action.persisted) {
      setRetryError(
        "Retry is unavailable while secure session storage is unavailable.",
      );
      retryPending.current = false;
      setRetryBusy(false);
      return;
    }
    const controller = new AbortController();
    mutationController.current = controller;
    try {
      const next = await client.value.retryScoutingJob(
        job.jobId,
        job.stateVersion,
        action.key,
        controller.signal,
      );
      if (!mounted.current || !applyJob(next)) return;
      action.clear();
      retryAction.current = null;
      heading.current?.focus();
      setRefreshGeneration((value) => value + 1);
    } catch (error) {
      if (!mounted.current || controller.signal.aborted) return;
      const known = clientError(error);
      if (known?.code === "conflict" || known?.code === "retry-limit") {
        setRetryError(
          "Checking the latest scouting status before another action.",
        );
        setRefreshGeneration((value) => value + 1);
      } else {
        setRetryError(
          "The retry outcome is not yet known. Try again to safely reconcile it.",
        );
      }
    } finally {
      retryPending.current = false;
      if (mutationController.current === controller)
        mutationController.current = null;
      if (mounted.current) setRetryBusy(false);
    }
  };

  if (view.loading)
    return (
      <section className="scouting-progress-state" role="status">
        <p>Loading scouting progress…</p>
      </section>
    );
  if (view.fatal)
    return (
      <section className="scouting-progress-state error" role="alert">
        <h1>Scouting progress unavailable</h1>
        <p>{view.fatal}</p>
        {client.ok && client.value.getScoutingJob && isScoutingJobId(jobId) && (
          <button
            type="button"
            onClick={() => setRefreshGeneration((value) => value + 1)}
          >
            Try again
          </button>
        )}
      </section>
    );
  if (!view.job) return null;
  const presentation = jobPresentation(view.job);
  const retryAllowed =
    view.job.status === "failed_retryable" &&
    view.job.failure?.retryable === true;
  return (
    <article className={`scouting-progress ${presentation.tone}`}>
      <span className="sr-only" aria-live="polite" aria-atomic="true">
        {view.announcement}
      </span>
      <header>
        <div>
          <p className="eyebrow">{presentation.eyebrow}</p>
          <h1 ref={heading} tabIndex={-1}>
            {presentation.title}
          </h1>
          <p className="lede">{presentation.message}</p>
        </div>
        <span className={`scouting-status ${presentation.tone}`}>
          {presentation.eyebrow}
        </span>
      </header>
      <section
        className="scouting-progress-details"
        aria-label="Scouting job details"
      >
        <div>
          <span>Attempt</span>
          <strong>{view.job.attemptNumber} of 3</strong>
        </div>
        <div>
          <span>Last update</span>
          <strong>
            <time dateTime={view.job.updatedAt}>
              {new Date(view.job.updatedAt).toLocaleString()}
            </time>
          </strong>
        </div>
      </section>
      {view.refreshError && (
        <section className="scouting-reconnect" role="alert">
          <p>{view.refreshError}</p>
          <button
            type="button"
            onClick={() => setRefreshGeneration((value) => value + 1)}
          >
            Reconnect
          </button>
        </section>
      )}
      {retryError && (
        <p className="scouting-retry-error" role="alert">
          {retryError}
        </p>
      )}
      <div className="scouting-progress-actions">
        {retryAllowed && (
          <button
            type="button"
            disabled={retryBusy}
            onClick={() => void retry()}
          >
            {retryBusy ? "Retrying…" : "Retry scouting"}
          </button>
        )}
        <a
          className="detail-link"
          href={`/games/${encodeURIComponent(view.job.eventId)}`}
        >
          View game
        </a>
      </div>
      {!visible && (
        <p className="scouting-paused" role="status">
          Updates pause while this page is hidden.
        </p>
      )}
    </article>
  );
}
