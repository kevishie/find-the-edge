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
  // This state measures how long ago the PROVIDER last revised the schedule
  // listing — `canonicalFreshness`, the canonical row's `updatedAt`. It says
  // nothing about the age of the prices on the same screen, and the old copy
  // ("Metadata stale · Evidence <date>") read as though it did: on 2026-08-13
  // every MLB row showed a two-day-old "Evidence" date beside prices observed
  // minutes earlier. An uncorrected listing is normal, so this is not a
  // defect to shout about — it is a fact about the listing, named as such.
  current: {
    label: "Listing confirmed",
    tone: "positive",
    icon: "✓",
    ariaLabel: "Provider confirmed this listing recently",
  },
  stale: {
    label: "Listing unchanged",
    tone: "neutral",
    icon: "·",
    ariaLabel: "Provider has not revised this listing recently",
  },
  unavailable: {
    label: "Listing age unknown",
    tone: "caution",
    icon: "?",
    ariaLabel: "Provider listing revision time is unavailable",
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
  // Reasons describe the LISTING, never the prices. Price age is shown
  // separately and computed from each selection's own `retrievedAt`.
  ...(assessment.freshness.state === "current"
    ? ["The provider confirmed this listing within the last two hours."]
    : assessment.freshness.state === "stale"
      ? [
          "The provider has not revised this listing in over two hours. This is normal for a fixture that has not changed and does not describe the odds below.",
        ]
      : assessment.freshness.missingReason === "missing-evidence-time"
        ? ["The provider gave no revision time for this listing."]
        : assessment.freshness.missingReason === "malformed-evidence-time"
          ? ["The provider's revision time for this listing is malformed."]
          : [
              "The provider's revision time for this listing is in the future.",
            ]),
];
