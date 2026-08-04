import type {
  EventLifecycleState,
  EventMetadataFreshnessState,
  EventMetadataAssessment,
} from "@find-the-edge/domain";

export type EventMetadataTone = "positive" | "neutral" | "caution" | "danger";
export interface EventMetadataPresentation {
  readonly label: string;
  readonly tone: EventMetadataTone;
  readonly icon: string;
  readonly ariaLabel: string;
}

const lifecycle: Record<EventLifecycleState, EventMetadataPresentation> = {
  scheduled: {
    label: "Scheduled",
    tone: "neutral",
    icon: "◷",
    ariaLabel: "Lifecycle: scheduled",
  },
  postponed: {
    label: "Postponed",
    tone: "caution",
    icon: "↷",
    ariaLabel: "Lifecycle: postponed",
  },
  cancelled: {
    label: "Cancelled",
    tone: "danger",
    icon: "×",
    ariaLabel: "Lifecycle: cancelled",
  },
  started: {
    label: "In progress",
    tone: "positive",
    icon: "▶",
    ariaLabel: "Lifecycle: in progress",
  },
  completed: {
    label: "Completed",
    tone: "neutral",
    icon: "✓",
    ariaLabel: "Lifecycle: completed",
  },
  unknown: {
    label: "Status unavailable",
    tone: "caution",
    icon: "?",
    ariaLabel: "Lifecycle status unavailable",
  },
};
const freshness: Record<
  EventMetadataFreshnessState,
  EventMetadataPresentation
> = {
  current: {
    label: "Metadata current",
    tone: "positive",
    icon: "✓",
    ariaLabel: "Event metadata is current",
  },
  stale: {
    label: "Metadata stale",
    tone: "caution",
    icon: "!",
    ariaLabel: "Event metadata is stale",
  },
  unavailable: {
    label: "Freshness unavailable",
    tone: "danger",
    icon: "?",
    ariaLabel: "Event metadata freshness is unavailable",
  },
};

export const eventLifecyclePresentation = (state: EventLifecycleState) =>
  lifecycle[state];
export const eventFreshnessPresentation = (
  state: EventMetadataFreshnessState,
) => freshness[state];

export const eventMetadataReasonText = (
  assessment: EventMetadataAssessment,
): readonly string[] => [
  ...(assessment.lifecycle.known
    ? []
    : ["Provider lifecycle status is unavailable."]),
  ...(assessment.freshness.state === "current"
    ? ["Evidence is within the two-hour freshness window."]
    : assessment.freshness.state === "stale"
      ? ["Evidence is older than the two-hour freshness window."]
      : assessment.freshness.missingReason === "missing-evidence-time"
        ? ["Evidence time is missing."]
        : assessment.freshness.missingReason === "malformed-evidence-time"
          ? ["Evidence time is malformed."]
          : ["Evidence time is in the future and cannot establish freshness."]),
];
