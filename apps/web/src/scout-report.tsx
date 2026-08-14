import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  ScoutingReportAssertion,
  ScoutingReportCandidate,
  ScoutingReportChangeSummary,
  ScoutingReportCitedObservation,
  ScoutingReportEvidenceStatus,
  ScoutingReportStatus,
} from "@find-the-edge/domain";

import {
  GamesClientError,
  isRequestCancellation,
  isScoutingJobId,
  type GamesClient,
  type ScoutReportDto,
  type ScoutReportVersionSummaryDto,
} from "./api";
import { useSession, useSessionStore } from "./session";

export type ScoutReportClientResult =
  | {
      readonly ok: true;
      readonly value: Pick<
        GamesClient,
        | "getScoutReportByJob"
        | "getScoutReportVersion"
        | "listScoutReportVersions"
      >;
    }
  | { readonly ok: false; readonly error: { readonly message: string } };

/**
 * Fixed section order for FTE-044. The keys are the report-section identifiers
 * declared by the sport scouting-report contract
 * (`packages/sports/src/soccer/scouting-report.ts`); the verdict block below
 * renders that contract's `nuke-or-pass` section.
 *
 * The persisted payload (FTE-041/FTE-042) is deliberately flat: an assertion
 * carries `text`, `classification`, and `citationIds` and no section
 * identifier. Classification is therefore the only contract-grounded routing
 * signal available, so narrative claims are placed by classification and every
 * assertion appears in exactly one section. Nothing is inferred beyond that.
 */
const NARRATIVE_SECTIONS = [
  {
    key: "market-edge",
    title: "Market Edge",
    // Claims the model asserts as supported: verified facts and inferences.
    classifications: ["factual", "inference"],
  },
  {
    key: "risk-assessment",
    title: "Risk Assessment",
    // Claims whose evidence is degraded; these are the report's risks.
    classifications: ["stale", "conflicting", "unavailable"],
  },
] as const;

const VERDICTS: Readonly<
  Record<
    ScoutingReportStatus,
    { readonly label: string; readonly tone: string; readonly copy: string }
  >
> = {
  complete: {
    label: "NUKE",
    tone: "complete",
    copy: "The analysis completed with full evidence coverage.",
  },
  reduced: {
    label: "REDUCED",
    tone: "reduced",
    copy: "The analysis completed with reduced evidence coverage.",
  },
  abstain: {
    label: "PASS",
    tone: "pass",
    copy: "No bet. The analysis abstained instead of producing a play.",
  },
};

const EVIDENCE_BADGES: Readonly<Record<ScoutingReportEvidenceStatus, string>> =
  {
    verified: "VERIFIED",
    stale: "STALE",
    conflicting: "CONFLICTING",
    unavailable: "UNAVAILABLE",
    inference: "INFERENCE",
  };

const CHANGE_FIELD_LABELS: Readonly<Record<string, string>> = {
  abstentionCodes: "abstention codes",
  assertions: "assertions",
  candidate: "candidate",
  probability: "probability",
  status: "status",
  summary: "summary",
  versions: "versions",
};

const ABSTENTION_KINDS: Readonly<Record<string, string>> = {
  "missing-evidence": "Required evidence was missing",
  "stale-evidence": "Required evidence was too old",
  contraindication: "A contraindication applied",
};

/** Restates an abstention code in plain words; never invents a new reason. */
const explainAbstentionCode = (
  code: string,
): { readonly headline: string; readonly detail: string | null } => {
  const separator = code.indexOf(":");
  if (separator < 1) return { headline: code, detail: null };
  const kind = ABSTENTION_KINDS[code.slice(0, separator)];
  if (!kind) return { headline: code, detail: null };
  return { headline: kind, detail: code.slice(separator + 1) };
};

const percent = (value: number): string => `${(value * 100).toFixed(1)}%`;

/** Ages are measured against the timestamp the response was received. */
const relativeAge = (observedAt: string, reference: string): string => {
  const delta = Date.parse(reference) - Date.parse(observedAt);
  if (!Number.isFinite(delta)) return "age unknown";
  const minutes = Math.floor(delta / 60_000);
  if (minutes < 0) return "just now";
  if (minutes < 1) return "under a minute old";
  if (minutes < 60) return `${minutes} min old`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h old`;
  return `${Math.floor(hours / 24)} d old`;
};

const candidateLabel = (candidate: ScoutingReportCandidate): string => {
  const market = candidate.marketKey === "moneyline" ? "Moneyline" : "Spread";
  const point =
    candidate.point === undefined
      ? ""
      : ` ${candidate.point > 0 ? "+" : ""}${String(candidate.point)}`;
  const selection =
    candidate.selection.kind === "draw"
      ? "Draw"
      : (candidate.selection.participantId ?? "Selection");
  return `${market}${point} · ${selection}`;
};

const changeSummaryText = (
  summary: ScoutingReportChangeSummary,
  versionNumber: number,
): string => {
  if (summary.kind === "initial") return "Initial version of this report.";
  if (summary.kind === "unchanged")
    return `No change from version ${String(versionNumber - 1)}.`;
  return `Changed from version ${String(versionNumber - 1)}: ${summary.changedFields
    .map((field) => CHANGE_FIELD_LABELS[field] ?? field)
    .join(", ")}.`;
};

type ReportErrorKind =
  "missing" | "auth" | "forbidden" | "invalid" | "unavailable";

interface ReportError {
  readonly kind: ReportErrorKind;
  readonly title: string;
  readonly message: string;
}

const reportError = (error: unknown): ReportError => {
  const code = error instanceof GamesClientError ? error.code : null;
  if (code === "not-found")
    return {
      kind: "missing",
      title: "No report exists for this job",
      message:
        "Nothing has been stored for this scouting job. A job can finish without a stored report, and a report belonging to another account is not shown here.",
    };
  if (code === "authentication")
    return {
      kind: "auth",
      title: "Sign in required",
      message: "Sign in is required to view this scouting report.",
    };
  if (code === "forbidden")
    return {
      kind: "forbidden",
      title: "Scouting access required",
      message: "This account does not have scouting access.",
    };
  if (code === "invalid-response")
    return {
      kind: "invalid",
      title: "Report could not be verified",
      message:
        "The stored report did not match its published contract, so none of it is shown.",
    };
  return {
    kind: "unavailable",
    title: "Report unavailable",
    message: "This report is temporarily unavailable.",
  };
};

function EvidenceBadge({
  status,
}: {
  readonly status: ScoutingReportEvidenceStatus;
}) {
  return (
    <span className={`scout-report-evidence ${status}`}>
      {EVIDENCE_BADGES[status]}
    </span>
  );
}

function Citation({
  observation,
  citationId,
  reference,
}: {
  readonly observation: ScoutingReportCitedObservation | undefined;
  readonly citationId: string;
  readonly reference: string;
}) {
  if (!observation)
    return (
      <li className="scout-report-citation">
        <code>{citationId}</code>
        <span className="scout-report-citation-note">
          Source detail is not stored in this version.
        </span>
      </li>
    );
  return (
    <li className="scout-report-citation">
      <code>{observation.observationId}</code>
      <span className="scout-report-citation-category">
        {observation.category}
      </span>
      <EvidenceBadge status={observation.status} />
      <time dateTime={observation.observedAt}>
        {relativeAge(observation.observedAt, reference)}
      </time>
    </li>
  );
}

function Assertions({
  assertions,
  observations,
  reference,
}: {
  readonly assertions: readonly ScoutingReportAssertion[];
  readonly observations: ReadonlyMap<string, ScoutingReportCitedObservation>;
  readonly reference: string;
}) {
  return (
    <div className="scout-report-narrative">
      <p className="eyebrow">NARRATIVE</p>
      <ul className="scout-report-assertions">
        {assertions.map((assertion, index) => (
          <li key={`${String(index)}-${assertion.text.slice(0, 24)}`}>
            <p>{assertion.text}</p>
            <span
              className={`scout-report-classification ${assertion.classification}`}
            >
              {assertion.classification.toUpperCase()}
            </span>
            {assertion.citationIds.length > 0 ? (
              <ul className="scout-report-citations">
                {assertion.citationIds.map((citationId) => (
                  <Citation
                    key={citationId}
                    citationId={citationId}
                    observation={observations.get(citationId)}
                    reference={reference}
                  />
                ))}
              </ul>
            ) : (
              <p className="scout-report-citation-note">
                No source is cited for this claim.
              </p>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function EmptySection({ title }: { readonly title: string }) {
  return (
    <p className="scout-report-empty">
      No content in this version for {title}.
    </p>
  );
}

function VersionSelector({
  report,
  ownerKey,
  requestedVersion,
  client,
  onSelectVersion,
}: {
  readonly report: ScoutReportDto;
  readonly ownerKey: string;
  readonly requestedVersion: number | undefined;
  readonly client: ScoutReportClientResult;
  readonly onSelectVersion: ((versionNumber: number) => void) | undefined;
}) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<
    readonly ScoutReportVersionSummaryDto[] | null
  >(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const controllerRef = useRef<AbortController | null>(null);
  const list =
    client.ok && client.value.listScoutReportVersions
      ? client.value.listScoutReportVersions
      : null;

  useEffect(
    () => () => {
      controllerRef.current?.abort();
      controllerRef.current = null;
    },
    [ownerKey, report.reportId],
  );

  const load = useCallback(() => {
    setOpen(true);
    if (!list || items || loading) return;
    setLoading(true);
    setError(null);
    const controller = new AbortController();
    controllerRef.current = controller;
    list(report.reportId, controller.signal)
      .then((page) => {
        if (controller.signal.aborted || controllerRef.current !== controller)
          return;
        setItems(page.items);
        setLoading(false);
        controllerRef.current = null;
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || controllerRef.current !== controller)
          return;
        controllerRef.current = null;
        if (isRequestCancellation(error)) {
          setLoading(false);
          return;
        }
        setError("The version history could not be loaded.");
        setLoading(false);
      });
  }, [items, list, loading, report.reportId]);

  return (
    <section className="scout-report-versions" aria-label="Report versions">
      <p className="eyebrow">VERSION HISTORY</p>
      <p>
        Viewing version {report.versionNumber} of {report.latestVersionNumber}.
      </p>
      <p className="scout-report-change">
        {changeSummaryText(report.changeSummary, report.versionNumber)}
      </p>
      {requestedVersion !== undefined &&
        requestedVersion !== report.versionNumber && (
          <p className="scout-report-version-notice" role="status">
            Version {requestedVersion} is not part of this report. Version{" "}
            {report.versionNumber} is shown instead.
          </p>
        )}
      {!open && (
        <button type="button" onClick={load}>
          Show version history
        </button>
      )}
      {open && loading && <p role="status">Loading version history…</p>}
      {open && error && (
        <p className="scout-report-version-error" role="alert">
          {error}
        </p>
      )}
      {open && !list && (
        <p className="scout-report-version-error" role="alert">
          Version history is unavailable in this environment.
        </p>
      )}
      {open && items && (
        <ul className="scout-report-version-list">
          {items.map((item) => (
            <li key={item.versionNumber}>
              <span className="scout-report-version-number">
                Version {item.versionNumber}
              </span>
              <time dateTime={item.generatedAt}>{item.generatedAt}</time>
              <span
                className={`scout-report-outcome ${item.validationOutcome}`}
              >
                {VERDICTS[item.validationOutcome].label}
              </span>
              <span className="scout-report-change">
                {changeSummaryText(item.changeSummary, item.versionNumber)}
              </span>
              {item.versionNumber === report.versionNumber ? (
                <span className="scout-report-version-current">
                  Currently viewing
                </span>
              ) : (
                <button
                  type="button"
                  disabled={!onSelectVersion}
                  onClick={() => onSelectVersion?.(item.versionNumber)}
                >
                  View version {item.versionNumber}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

interface ReportView {
  readonly ownerKey: string;
  readonly loading: boolean;
  readonly report: ScoutReportDto | null;
  readonly loadedAt: string | null;
  readonly error: ReportError | null;
}

const LOADING_VIEW = {
  loading: true,
  report: null,
  loadedAt: null,
  error: null,
} as const;

const loadingReport = (ownerKey: string): ReportView => ({
  ...LOADING_VIEW,
  ownerKey,
});

export function ScoutReport({
  jobId,
  versionNumber,
  client,
  onSelectVersion,
}: {
  readonly jobId: string;
  readonly versionNumber?: number | undefined;
  readonly client: ScoutReportClientResult;
  readonly onSelectVersion?: ((versionNumber: number) => void) | undefined;
}) {
  const sessionStore = useSessionStore();
  const session = useSession(sessionStore);
  const sessionKey = session
    ? `${session.accountId}\u0000${session.token}`
    : "signed-out";
  const usable = client.ok && client.value.getScoutReportByJob !== undefined;
  const [view, setView] = useState<ReportView>(() =>
    !isScoutingJobId(jobId)
      ? {
          ...LOADING_VIEW,
          ownerKey: sessionKey,
          loading: false,
          error: {
            kind: "missing",
            title: "No report exists for this job",
            message: "This scouting job address is invalid.",
          },
        }
      : !usable
        ? {
            ...LOADING_VIEW,
            ownerKey: sessionKey,
            loading: false,
            error: {
              kind: "unavailable",
              title: "Report unavailable",
              message: "Scouting reports are unavailable in this environment.",
            },
          }
        : loadingReport(sessionKey),
  );
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    if (!usable || !isScoutingJobId(jobId)) return;
    let active = true;
    queueMicrotask(() => {
      if (active) setView(loadingReport(sessionKey));
    });
    return () => {
      active = false;
    };
  }, [jobId, sessionKey, usable]);

  useEffect(() => {
    const byJob = client.ok ? client.value.getScoutReportByJob : undefined;
    const byVersion = client.ok
      ? client.value.getScoutReportVersion
      : undefined;
    if (!isScoutingJobId(jobId) || !byJob) return;
    const controller = new AbortController();
    // The confirmed version stays on screen while another one loads; only an
    // authoritative response replaces it.
    const load = async () => {
      const bound = await byJob(jobId, controller.signal);
      if (
        versionNumber === undefined ||
        versionNumber === bound.versionNumber ||
        versionNumber < 1 ||
        versionNumber > bound.latestVersionNumber ||
        !byVersion
      )
        return bound;
      return byVersion(bound.reportId, versionNumber, controller.signal);
    };
    load()
      .then((report) => {
        if (controller.signal.aborted) return;
        setView({
          ownerKey: sessionKey,
          loading: false,
          report,
          loadedAt: new Date().toISOString(),
          error: null,
        });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || isRequestCancellation(error)) return;
        setView({
          ...LOADING_VIEW,
          ownerKey: sessionKey,
          loading: false,
          error: reportError(error),
        });
      });
    return () => controller.abort();
  }, [client, generation, jobId, sessionKey, versionNumber]);

  const visibleView =
    !usable || !isScoutingJobId(jobId) || view.ownerKey === sessionKey
      ? view
      : loadingReport(sessionKey);
  const report = visibleView.report;
  const observations = useMemo(
    () =>
      new Map(
        (report?.provenance.citedSourceObservations ?? []).map(
          (observation) => [observation.observationId, observation],
        ),
      ),
    [report],
  );
  const progressHref = isScoutingJobId(jobId)
    ? `/scout-jobs/${encodeURIComponent(jobId)}`
    : "/events";

  if (visibleView.loading)
    return (
      <section className="scout-report-state" role="status">
        <p>Loading scouting report…</p>
        <div className="dashboard-skeleton" aria-hidden="true">
          <div />
          <div />
        </div>
      </section>
    );
  if (visibleView.error || !report)
    return (
      <section className="scout-report-state error" role="alert">
        <h1>{visibleView.error?.title ?? "Report unavailable"}</h1>
        <p>
          {visibleView.error?.message ??
            "This report is temporarily unavailable."}
        </p>
        <div className="scout-report-actions">
          {(visibleView.error?.kind === "unavailable" ||
            visibleView.error?.kind === "invalid") &&
            usable && (
              <button
                type="button"
                onClick={() => {
                  setView(loadingReport(sessionKey));
                  setGeneration((value) => value + 1);
                }}
              >
                Try again
              </button>
            )}
          <a className="detail-link" href={progressHref}>
            View scouting progress
          </a>
        </div>
      </section>
    );

  const payload = report.payload;
  const verdict = VERDICTS[payload.status];
  const reference = visibleView.loadedAt ?? report.generatedAt;
  const routed = NARRATIVE_SECTIONS.map((section) => ({
    ...section,
    assertions: payload.assertions.filter((assertion) =>
      (section.classifications as readonly string[]).includes(
        assertion.classification,
      ),
    ),
  }));

  return (
    <article className={`scout-report ${payload.status}`}>
      <header className="scout-report-header">
        <div>
          <p className="eyebrow">SCOUTING REPORT</p>
          <h1>{candidateLabel(payload.candidate)}</h1>
          <p className="lede">
            {payload.candidate.outcomeStructure === "three-way"
              ? "Three-way market"
              : "Two-way market"}
          </p>
        </div>
        <span className={`scout-report-outcome ${report.validationOutcome}`}>
          {verdict.label}
        </span>
      </header>
      <dl className="scout-report-meta">
        <div>
          <dt>Event</dt>
          <dd>
            <code>{report.eventId}</code>
          </dd>
        </div>
        <div>
          <dt>Event version</dt>
          <dd>{report.eventVersion}</dd>
        </div>
        <div>
          <dt>Generated</dt>
          <dd>
            <time dateTime={report.generatedAt}>{report.generatedAt}</time>
          </dd>
        </div>
        <div>
          <dt>Version</dt>
          <dd>
            {report.versionNumber} of {report.latestVersionNumber}
          </dd>
        </div>
      </dl>
      {report.latestVersionNumber > 1 && (
        <VersionSelector
          report={report}
          ownerKey={sessionKey}
          requestedVersion={versionNumber}
          client={client}
          onSelectVersion={onSelectVersion}
        />
      )}

      <section
        className="scout-report-section"
        aria-labelledby="scout-report-market-edge"
      >
        <h2 id="scout-report-market-edge">Market Edge</h2>
        <div className="scout-report-calculated">
          <p className="eyebrow">CALCULATED VALUES</p>
          <dl>
            <div>
              <dt>Probability estimate</dt>
              <dd>{percent(payload.probability.estimate)}</dd>
            </div>
            <div>
              <dt>Probability range</dt>
              <dd>
                {percent(payload.probability.low)} –{" "}
                {percent(payload.probability.high)}
              </dd>
            </div>
            <div>
              <dt>Uncertainty</dt>
              <dd>{percent(payload.probability.uncertainty)}</dd>
            </div>
          </dl>
        </div>
        {routed[0] && routed[0].assertions.length > 0 ? (
          <Assertions
            assertions={routed[0].assertions}
            observations={observations}
            reference={reference}
          />
        ) : (
          <EmptySection title="Market Edge narrative" />
        )}
      </section>

      <section
        className="scout-report-section"
        aria-labelledby="scout-report-risk-assessment"
      >
        <h2 id="scout-report-risk-assessment">Risk Assessment</h2>
        {routed[1] && routed[1].assertions.length > 0 ? (
          <Assertions
            assertions={routed[1].assertions}
            observations={observations}
            reference={reference}
          />
        ) : (
          <EmptySection title="Risk Assessment" />
        )}
      </section>

      <section
        className="scout-report-section"
        aria-labelledby="scout-report-final-plays"
      >
        <h2 id="scout-report-final-plays">Final Plays</h2>
        {payload.status === "abstain" ? (
          <EmptySection title="Final Plays" />
        ) : (
          <div className="scout-report-calculated">
            <p className="eyebrow">CALCULATED VALUES</p>
            <dl>
              <div>
                <dt>Play</dt>
                <dd>{candidateLabel(payload.candidate)}</dd>
              </div>
              <div>
                <dt>Modelled probability</dt>
                <dd>{percent(payload.probability.estimate)}</dd>
              </div>
              <div>
                <dt>Analysis outcome</dt>
                <dd>{payload.status}</dd>
              </div>
            </dl>
          </div>
        )}
      </section>

      <section
        className={`scout-report-verdict ${verdict.tone}`}
        aria-labelledby="scout-report-nuke-or-pass"
      >
        <h2 id="scout-report-nuke-or-pass">Nuke or Pass</h2>
        <p className="scout-report-verdict-label">{verdict.label}</p>
        <p>{verdict.copy}</p>
        {payload.status === "abstain" && (
          <ul className="scout-report-abstentions">
            {payload.abstentionCodes.map((code) => {
              const explained = explainAbstentionCode(code);
              return (
                <li key={code}>
                  <strong>{explained.headline}</strong>
                  {explained.detail !== null && <span>{explained.detail}</span>}
                  <code>{code}</code>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="scout-report-section" aria-label="Report summary">
        <h2>Summary</h2>
        <div className="scout-report-narrative">
          <p className="eyebrow">NARRATIVE</p>
          <p>{payload.summary}</p>
        </div>
      </section>

      <footer className="scout-report-footer">
        <dl>
          <div>
            <dt>Model</dt>
            <dd>
              <code>
                {payload.versions.modelId}@{payload.versions.modelVersion}
              </code>
            </dd>
          </div>
          <div>
            <dt>Report contract</dt>
            <dd>
              <code>
                {payload.versions.outputSchemaId}@
                {payload.versions.outputSchemaVersion}
              </code>
            </dd>
          </div>
          <div>
            <dt>Odds snapshots</dt>
            <dd>{report.provenance.oddsSnapshotIds.length}</dd>
          </div>
        </dl>
        <a className="detail-link" href={progressHref}>
          View scouting progress
        </a>
      </footer>
    </article>
  );
}
