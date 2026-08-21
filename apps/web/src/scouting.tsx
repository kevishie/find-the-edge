import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import type {
  PublicScoutingJob,
  ScoutingFailureCode,
} from "@find-the-edge/domain";

import {
  GamesClientError,
  isRequestCancellation,
  isScoutingJobId,
  type GamesClient,
} from "./api";
import { useSession, useSessionStore } from "./session";

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
  accountId: string,
  identity: string,
  stateVersion?: number,
) =>
  `fte.scouting.${action}.${encodeURIComponent(accountId)}.${encodeURIComponent(identity)}${
    stateVersion === undefined ? "" : `.${String(stateVersion)}`
  }`;

const createResumeKey = (accountId: string, eventId: string) =>
  `fte.scouting.resume.create.${encodeURIComponent(accountId)}.${encodeURIComponent(eventId)}`;

const setCreateResume = (
  accountId: string,
  eventId: string,
  pending: boolean,
): boolean => {
  try {
    const key = createResumeKey(accountId, eventId);
    if (pending) sessionStorage.setItem(key, "1");
    else sessionStorage.removeItem(key);
    return !pending || sessionStorage.getItem(key) === "1";
  } catch {
    return false;
  }
};

const hasCreateResume = (accountId: string, eventId: string): boolean => {
  try {
    const key = createResumeKey(accountId, eventId);
    return sessionStorage.getItem(key) === "1";
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
  accountId: string,
  identity: string,
  stateVersion?: number,
): {
  readonly key: string;
  readonly persisted: boolean;
  readonly clear: () => void;
} => {
  const name = storageKey(action, accountId, identity, stateVersion);
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
  const sessionStore = useSessionStore();
  const session = useSession(sessionStore);
  const sessionKey = session
    ? `${session.accountId}\u0000${session.token}`
    : "signed-out";
  const accountId = session?.accountId ?? "signed-out";
  const navigate = useNavigate();
  const reasonId = useId();
  const errorId = useId();
  const pendingOwner = useRef<string | null>(null);
  const mounted = useRef(true);
  const mutationController = useRef<AbortController | null>(null);
  const pendingAction = useRef<{
    readonly accountId: string;
    readonly action: ReturnType<typeof persistentScoutingActionKey>;
  } | null>(null);
  const [actionView, setActionView] = useState<{
    readonly ownerKey: string;
    readonly busy: boolean;
    readonly error: string | null;
  }>({ ownerKey: sessionKey, busy: false, error: null });

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      mutationController.current?.abort();
    };
  }, []);

  useEffect(() => () => mutationController.current?.abort(), [sessionKey]);

  const start = useCallback(
    async (resuming = false) => {
      if (
        !mounted.current ||
        pendingOwner.current === sessionKey ||
        !eligible ||
        !client.ok ||
        !client.value.createScoutingJob ||
        !session
      )
        return;
      mutationController.current?.abort();
      pendingOwner.current = sessionKey;
      setActionView({ ownerKey: sessionKey, busy: true, error: null });
      const action =
        pendingAction.current?.accountId === accountId
          ? pendingAction.current.action
          : persistentScoutingActionKey("create", accountId, eventId);
      pendingAction.current = { accountId, action };
      const isCurrentOwner = () => {
        const current = sessionStore.getSnapshot();
        return (
          mounted.current &&
          current?.accountId === accountId &&
          current.token === session.token
        );
      };
      if (!action.persisted) {
        if (isCurrentOwner())
          setActionView({
            ownerKey: sessionKey,
            busy: false,
            error:
              "Scouting cannot start while secure session storage is unavailable.",
          });
        if (pendingOwner.current === sessionKey) pendingOwner.current = null;
        return;
      }
      if (!resuming && !setCreateResume(accountId, eventId, true)) {
        if (isCurrentOwner())
          setActionView({
            ownerKey: sessionKey,
            busy: false,
            error:
              "Scouting cannot start while secure session storage is unavailable.",
          });
        if (pendingOwner.current === sessionKey) pendingOwner.current = null;
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
        if (!isCurrentOwner()) return;
        setCreateResume(accountId, eventId, false);
        action.clear();
        if (pendingAction.current?.action === action)
          pendingAction.current = null;
        await navigate({
          to: "/scout-jobs/$jobId",
          params: { jobId: job.jobId },
        });
      } catch (failure) {
        if (isRequestCancellation(failure)) return;
        setCreateResume(accountId, eventId, false);
        if (isCurrentOwner() && !controller.signal.aborted)
          setActionView({
            ownerKey: sessionKey,
            busy: true,
            error: createErrorMessage(failure),
          });
      } finally {
        const ownsPending = pendingOwner.current === sessionKey;
        if (ownsPending) pendingOwner.current = null;
        if (mutationController.current === controller)
          mutationController.current = null;
        if (ownsPending && isCurrentOwner())
          setActionView((current) =>
            current.ownerKey === sessionKey
              ? { ...current, busy: false }
              : current,
          );
      }
    },
    [
      accountId,
      client,
      eligible,
      eventId,
      navigate,
      session,
      sessionKey,
      sessionStore,
    ],
  );

  useEffect(() => {
    let active = true;
    if (hasCreateResume(accountId, eventId)) {
      if (eligible && client.ok && client.value.createScoutingJob)
        queueMicrotask(() => {
          if (!active) return;
          const current = sessionStore.getSnapshot();
          const currentKey = current
            ? `${current.accountId}\u0000${current.token}`
            : "signed-out";
          if (current?.accountId !== accountId || currentKey !== sessionKey)
            return;
          void start(true);
        });
      else setCreateResume(accountId, eventId, false);
    }
    return () => {
      active = false;
    };
  }, [accountId, client, eligible, eventId, sessionKey, sessionStore, start]);

  const unavailable = !client.ok || !client.value.createScoutingJob;
  const reason = unavailable
    ? "Scouting is unavailable in this environment."
    : disabledReason;
  const visibleAction =
    actionView.ownerKey === sessionKey
      ? actionView
      : { ownerKey: sessionKey, busy: false, error: null };
  return (
    <span className="scout-action">
      <button
        type="button"
        disabled={!eligible || unavailable || visibleAction.busy}
        aria-describedby={
          [
            !eligible || unavailable ? reasonId : null,
            visibleAction.error ? errorId : null,
          ]
            .filter(Boolean)
            .join(" ") || undefined
        }
        onClick={() => void start()}
      >
        {visibleAction.busy ? "Opening scouting…" : "Scout"}
      </button>
      {(!eligible || unavailable) && <small id={reasonId}>{reason}</small>}
      {visibleAction.error && (
        <small id={errorId} className="scout-action-error" role="alert">
          {visibleAction.error}
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
        message: "The scouting job finished successfully.",
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
  readonly ownerKey: string;
  readonly loading: boolean;
  readonly job: PublicScoutingJob | null;
  readonly fatal: string | null;
  readonly refreshError: string | null;
  readonly announcement: string;
}

const emptyProgress = {
  loading: true,
  job: null,
  fatal: null,
  refreshError: null,
  announcement: "",
} as const;

const loadingProgress = (ownerKey: string): ProgressView => ({
  ...emptyProgress,
  ownerKey,
});

export function ScoutingProgress({
  jobId,
  client,
}: {
  readonly jobId: string;
  readonly client: ScoutingClientResult;
}) {
  const sessionStore = useSessionStore();
  const session = useSession(sessionStore);
  const sessionKey = session
    ? `${session.accountId}\u0000${session.token}`
    : "signed-out";
  const accountId = session?.accountId ?? "signed-out";
  const latest = useRef<PublicScoutingJob | null>(null);
  const latestOwner = useRef(sessionKey);
  const latestAccount = useRef(accountId);
  const heading = useRef<HTMLHeadingElement>(null);
  const retryPendingOwner = useRef<string | null>(null);
  const mounted = useRef(true);
  const mutationController = useRef<AbortController | null>(null);
  const retryAction = useRef<{
    readonly accountId: string;
    readonly action: ReturnType<typeof persistentScoutingActionKey>;
  } | null>(null);
  const [view, setView] = useState<ProgressView>(() =>
    !isScoutingJobId(jobId)
      ? {
          ...emptyProgress,
          ownerKey: sessionKey,
          loading: false,
          fatal: "This scouting job address is invalid.",
        }
      : !client.ok || !client.value.getScoutingJob
        ? {
            ...emptyProgress,
            ownerKey: sessionKey,
            loading: false,
            fatal: "Scouting progress is unavailable in this environment.",
          }
        : loadingProgress(sessionKey),
  );
  const [visible, setVisible] = useState(
    () =>
      typeof document === "undefined" || document.visibilityState !== "hidden",
  );
  const [refreshGeneration, setRefreshGeneration] = useState(0);
  const [retryView, setRetryView] = useState<{
    readonly ownerKey: string;
    readonly busy: boolean;
    readonly error: string | null;
  }>({ ownerKey: sessionKey, busy: false, error: null });

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      mutationController.current?.abort();
    };
  }, []);

  useEffect(() => () => mutationController.current?.abort(), [sessionKey]);

  useEffect(() => {
    const pending = retryAction.current;
    if (pending && pending.accountId !== accountId) {
      pending.action.clear();
      retryAction.current = null;
    }
  }, [accountId]);

  useEffect(() => {
    const update = () => setVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);

  const applyJob = useCallback(
    (incoming: PublicScoutingJob): boolean => {
      if (incoming.jobId !== jobId) return false;
      const prior = latestAccount.current === accountId ? latest.current : null;
      if (prior && incoming.stateVersion < prior.stateVersion) return false;
      if (
        prior &&
        (!preservesJobIdentityAndChronology(incoming, prior) ||
          (incoming.stateVersion === prior.stateVersion &&
            !sameScoutingJob(incoming, prior)))
      ) {
        setView((current) => ({
          ...current,
          ownerKey: sessionKey,
          refreshError: "The latest scouting update could not be verified.",
        }));
        setRetryView((current) => ({
          ownerKey: sessionKey,
          busy: current.ownerKey === sessionKey && current.busy,
          error: null,
        }));
        return false;
      }
      if (prior && incoming.stateVersion === prior.stateVersion) {
        setView({
          ownerKey: sessionKey,
          loading: false,
          job: incoming,
          fatal: null,
          refreshError: null,
          announcement: "",
        });
        setRetryView((current) => ({
          ownerKey: sessionKey,
          busy: current.ownerKey === sessionKey && current.busy,
          error: null,
        }));
        latestOwner.current = sessionKey;
        return true;
      }
      if (prior && incoming.stateVersion > prior.stateVersion) {
        retryAction.current?.action.clear();
        retryAction.current = null;
      }
      latest.current = incoming;
      latestOwner.current = sessionKey;
      latestAccount.current = accountId;
      setRetryView((current) => ({
        ownerKey: sessionKey,
        busy: current.ownerKey === sessionKey && current.busy,
        error: null,
      }));
      const presentation = jobPresentation(incoming);
      setView({
        ownerKey: sessionKey,
        loading: false,
        job: incoming,
        fatal: null,
        refreshError: null,
        announcement:
          !prior || prior.status !== incoming.status ? presentation.title : "",
      });
      return true;
    },
    [accountId, jobId, sessionKey],
  );

  useEffect(() => {
    if (!isScoutingJobId(jobId) || !client.ok || !client.value.getScoutingJob)
      return;
    let active = true;
    queueMicrotask(() => {
      if (!active) return;
      if (latestAccount.current !== accountId) latest.current = null;
      latestAccount.current = accountId;
      latestOwner.current = sessionKey;
      setRetryView({ ownerKey: sessionKey, busy: false, error: null });
      setView(loadingProgress(sessionKey));
    });
    return () => {
      active = false;
    };
  }, [accountId, client, jobId, sessionKey]);

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
        const current =
          latestOwner.current === sessionKey ? latest.current : null;
        if (
          current &&
          (current.status === "queued" || current.status === "in_progress")
        )
          timer = setTimeout(() => void load(), ACTIVE_POLL_MS);
      } catch (error) {
        if (
          stopped ||
          controller.signal.aborted ||
          isRequestCancellation(error)
        )
          return;
        const known = clientError(error);
        if (
          known?.code === "authentication" ||
          known?.code === "forbidden" ||
          known?.code === "not-found"
        ) {
          latest.current = null;
          latestOwner.current = sessionKey;
          latestAccount.current = accountId;
          setRetryView({ ownerKey: sessionKey, busy: false, error: null });
          setView({
            ...emptyProgress,
            ownerKey: sessionKey,
            loading: false,
            fatal: initialErrorMessage(error),
          });
          return;
        }
        if (latestOwner.current !== sessionKey || !latest.current) {
          setView({
            ...emptyProgress,
            ownerKey: sessionKey,
            loading: false,
            fatal: initialErrorMessage(error),
          });
          return;
        }
        failures += 1;
        setView((current) => ({
          ...current,
          ownerKey: sessionKey,
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
    queueMicrotask(() => {
      if (stopped) return;
      void load();
    });
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      controller?.abort();
    };
  }, [
    accountId,
    applyJob,
    client,
    jobId,
    refreshGeneration,
    sessionKey,
    visible,
  ]);

  const retry = async () => {
    const job = latestOwner.current === sessionKey ? latest.current : null;
    if (
      retryPendingOwner.current === sessionKey ||
      !client.ok ||
      !client.value.retryScoutingJob ||
      !job ||
      job.status !== "failed_retryable" ||
      job.failure?.retryable !== true
    )
      return;
    mutationController.current?.abort();
    retryPendingOwner.current = sessionKey;
    setRetryView({ ownerKey: sessionKey, busy: true, error: null });
    const action =
      retryAction.current?.accountId === accountId
        ? retryAction.current.action
        : persistentScoutingActionKey(
            "retry",
            accountId,
            job.jobId,
            job.stateVersion,
          );
    retryAction.current = { accountId, action };
    if (!action.persisted) {
      setRetryView({
        ownerKey: sessionKey,
        busy: false,
        error:
          "Retry is unavailable while secure session storage is unavailable.",
      });
      if (retryPendingOwner.current === sessionKey)
        retryPendingOwner.current = null;
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
      if (retryAction.current?.action === action) retryAction.current = null;
      heading.current?.focus();
      setRefreshGeneration((value) => value + 1);
    } catch (error) {
      if (
        !mounted.current ||
        controller.signal.aborted ||
        isRequestCancellation(error)
      )
        return;
      const known = clientError(error);
      if (known?.code === "conflict" || known?.code === "retry-limit") {
        setRetryView({
          ownerKey: sessionKey,
          busy: true,
          error: "Checking the latest scouting status before another action.",
        });
        setRefreshGeneration((value) => value + 1);
      } else {
        setRetryView({
          ownerKey: sessionKey,
          busy: true,
          error:
            "The retry outcome is not yet known. Try again to safely reconcile it.",
        });
      }
    } finally {
      const ownsPending = retryPendingOwner.current === sessionKey;
      if (ownsPending) retryPendingOwner.current = null;
      if (mutationController.current === controller)
        mutationController.current = null;
      if (mounted.current && ownsPending)
        setRetryView((current) =>
          current.ownerKey === sessionKey
            ? { ...current, busy: false }
            : current,
        );
    }
  };

  const sessionBoundProgress =
    isScoutingJobId(jobId) && client.ok && !!client.value.getScoutingJob;
  const visibleView =
    !sessionBoundProgress || view.ownerKey === sessionKey
      ? view
      : loadingProgress(sessionKey);
  const visibleRetry =
    retryView.ownerKey === sessionKey
      ? retryView
      : { ownerKey: sessionKey, busy: false, error: null };

  if (visibleView.loading)
    return (
      <section className="scouting-progress-state" role="status">
        <p>Loading scouting progress…</p>
      </section>
    );
  if (visibleView.fatal)
    return (
      <section className="scouting-progress-state error" role="alert">
        <h1>Scouting progress unavailable</h1>
        <p>{visibleView.fatal}</p>
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
  if (!visibleView.job) return null;
  const presentation = jobPresentation(visibleView.job);
  const retryAllowed =
    visibleView.job.status === "failed_retryable" &&
    visibleView.job.failure?.retryable === true;
  return (
    <article className={`scouting-progress ${presentation.tone}`}>
      <span className="sr-only" aria-live="polite" aria-atomic="true">
        {visibleView.announcement}
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
          <strong>{visibleView.job.attemptNumber} of 3</strong>
        </div>
        <div>
          <span>Last update</span>
          <strong>
            <time dateTime={visibleView.job.updatedAt}>
              {new Date(visibleView.job.updatedAt).toLocaleString()}
            </time>
          </strong>
        </div>
      </section>
      {visibleView.refreshError && (
        <section className="scouting-reconnect" role="alert">
          <p>{visibleView.refreshError}</p>
          <button
            type="button"
            onClick={() => setRefreshGeneration((value) => value + 1)}
          >
            Reconnect
          </button>
        </section>
      )}
      {visibleRetry.error && (
        <p className="scouting-retry-error" role="alert">
          {visibleRetry.error}
        </p>
      )}
      <div className="scouting-progress-actions">
        {visibleView.job.status === "completed" && (
          // The progress record does not say whether a report was stored, so
          // the link is always offered and the report screen states the truth.
          <a
            className="detail-link"
            href={`/scout-jobs/${encodeURIComponent(visibleView.job.jobId)}/report`}
          >
            View report
          </a>
        )}
        {retryAllowed && (
          <button
            type="button"
            disabled={visibleRetry.busy}
            onClick={() => void retry()}
          >
            {visibleRetry.busy ? "Retrying…" : "Retry scouting"}
          </button>
        )}
        <a
          className="detail-link"
          href={`/events/${encodeURIComponent(visibleView.job.eventId)}`}
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
