import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type {
  ScoutingReportInlinePayload,
  ScoutingReportProvenance,
} from "@find-the-edge/domain";

import {
  GamesClientError,
  parseScoutReport,
  type GamesClient,
  type ScoutReportDto,
  type ScoutReportVersionsDto,
} from "./api";
import { ScoutReport, type ScoutReportClientResult } from "./scout-report";

const jobId = `scout-job:${"a".repeat(64)}`;
const reportId = `scout-report:${"b".repeat(64)}`;
const inputHash = "c".repeat(64);

const versions = {
  contractVersion: "soccer-ml-spread@1.0.0",
  promptBundleId: "soccer-analysis",
  promptBundleVersion: "1",
  promptSections: {
    shared: { id: "evidence-safety", version: "1" },
    sport: { id: "soccer", version: "2" },
    strategy: { id: "find-the-edge", version: "1.0.0-experimental" },
    analysis: { id: "moneyline-spread", version: "1" },
  },
  inputSchemaId: "analysis-input/soccer",
  inputSchemaVersion: "1",
  outputSchemaId: "analysis-output/soccer",
  outputSchemaVersion: "1",
  modelId: "mls-v1.0-draft",
  modelVersion: "1.0.0-draft",
} as const;

const provenance = (
  cited: readonly {
    readonly observationId: string;
    readonly category: string;
    readonly status:
      "verified" | "stale" | "conflicting" | "unavailable" | "inference";
    readonly observedAt: string;
  }[],
): ScoutingReportProvenance => ({
  citedSourceObservations: [...cited].sort((left, right) =>
    left.observationId < right.observationId ? -1 : 1,
  ),
  providerObservations: [],
  evidenceReferences: [],
  calculationVersions: [{ id: "fair-value", version: "1" }],
  referenceHashes: [],
  oddsSnapshotIds: ["odds-snapshot:1"],
  inputHash,
  inputSchema: { id: "analysis-input/soccer", version: "1" },
  promptBundle: { id: "soccer-analysis", version: "1" },
  model: { id: "mls-v1.0-draft", version: "1.0.0-draft" },
  sportModule: { id: "soccer", version: "2" },
  strategy: { id: "find-the-edge", version: "1.0.0-experimental" },
  reportSchema: { id: "analysis-output/soccer", version: "1" },
});

const payload = (
  overrides: Partial<ScoutingReportInlinePayload> = {},
): ScoutingReportInlinePayload => ({
  candidate: {
    marketKey: "moneyline",
    outcomeStructure: "three-way",
    selection: { kind: "participant", participantId: "club-fulham" },
  },
  versions,
  probability: { estimate: 0.62, low: 0.55, high: 0.7, uncertainty: 0.08 },
  status: "complete",
  abstentionCodes: [],
  summary: "Fulham convert chances at a higher rate at home.",
  assertions: [
    {
      text: "Fulham convert chances at a higher rate at home.",
      classification: "factual",
      citationIds: ["evidence-form-1"],
    },
  ],
  ...overrides,
});

const dto = (overrides: Partial<ScoutReportDto> = {}): ScoutReportDto =>
  parseScoutReport({
    schemaVersion: "scout-report-v1",
    reportId,
    versionNumber: 1,
    latestVersionNumber: 1,
    jobId,
    eventId: "event:soccer:2026-epl-fulham-arsenal-001",
    eventVersion: 1,
    generatedAt: "2026-08-07T17:00:00.000Z",
    validationOutcome: "complete",
    changeSummary: { kind: "initial", changedFields: [] },
    payload: payload(),
    provenance: provenance([
      {
        observationId: "evidence-form-1",
        category: "form",
        status: "verified",
        observedAt: "2026-08-07T16:30:00.000Z",
      },
    ]),
    ...overrides,
  });

const client = (
  overrides: Partial<
    Pick<
      GamesClient,
      | "getScoutReportByJob"
      | "getScoutReportVersion"
      | "listScoutReportVersions"
    >
  >,
): ScoutReportClientResult => ({
  ok: true,
  value: {
    getScoutReportByJob: vi.fn(() => Promise.resolve(dto())),
    ...overrides,
  },
});

const settle = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};

const sectionOrder = () =>
  screen
    .getAllByRole("heading", { level: 2 })
    .map((heading) => heading.textContent);

describe("ScoutReport", () => {
  it("renders every required section in the fixed order with calculated values labelled apart from narrative", async () => {
    render(
      <ScoutReport
        jobId={jobId}
        client={client({
          getScoutReportByJob: vi.fn(() =>
            Promise.resolve(
              dto({
                payload: payload({
                  assertions: [
                    {
                      text: "Fulham convert chances at a higher rate at home.",
                      classification: "factual",
                      citationIds: ["evidence-form-1"],
                    },
                    {
                      text: "The visiting keeper's availability is unresolved.",
                      classification: "unavailable",
                      citationIds: ["evidence-injuries-1"],
                    },
                  ],
                  summary:
                    "Fulham convert chances at a higher rate at home. The visiting keeper's availability is unresolved.",
                }),
                provenance: provenance([
                  {
                    observationId: "evidence-form-1",
                    category: "form",
                    status: "verified",
                    observedAt: "2026-08-07T16:30:00.000Z",
                  },
                  {
                    observationId: "evidence-injuries-1",
                    category: "injuries",
                    status: "unavailable",
                    observedAt: "2026-08-07T15:00:00.000Z",
                  },
                ]),
              }),
            ),
          ),
        })}
      />,
    );
    expect(
      await screen.findByRole("heading", { name: "Market Edge" }),
    ).toBeVisible();
    expect(sectionOrder()).toEqual([
      "Market Edge",
      "Risk Assessment",
      "Final Plays",
      "Nuke or Pass",
      "Summary",
    ]);
    // Deterministic values carry their own label and never sit inside the
    // narrative block.
    const calculated = screen.getAllByText("CALCULATED VALUES");
    expect(calculated.length).toBeGreaterThan(0);
    expect(
      screen.getAllByText("62.0%", { selector: ".scout-report-calculated dd" }),
    ).toHaveLength(2);
    expect(screen.getByText("55.0% – 70.0%")).toBeVisible();
    expect(screen.getAllByText("NARRATIVE").length).toBeGreaterThan(0);
    expect(
      screen.getByText("Fulham convert chances at a higher rate at home.", {
        selector: ".scout-report-assertions p",
      }),
    ).toBeVisible();
    // Sources resolve to their observation with a verification badge.
    expect(screen.getByText("evidence-form-1")).toBeVisible();
    expect(screen.getByText("VERIFIED")).toBeVisible();
    expect(
      screen.getByText("NUKE", { selector: ".scout-report-verdict-label" }),
    ).toBeVisible();
  });

  it("keeps an unpopulated section visible instead of dropping it", async () => {
    render(<ScoutReport jobId={jobId} client={client({})} />);
    expect(
      await screen.findByRole("heading", { name: "Risk Assessment" }),
    ).toBeVisible();
    expect(sectionOrder()).toContain("Risk Assessment");
    expect(
      screen.getByText("No content in this version for Risk Assessment."),
    ).toBeVisible();
  });

  it("renders a PASS verdict with explained abstention codes and no play", async () => {
    render(
      <ScoutReport
        jobId={jobId}
        client={client({
          getScoutReportByJob: vi.fn(() =>
            Promise.resolve(
              dto({
                validationOutcome: "abstain",
                payload: payload({
                  status: "abstain",
                  abstentionCodes: [
                    "contraindication:stale-offered-price",
                    "missing-evidence:injuries",
                  ],
                }),
              }),
            ),
          ),
        })}
      />,
    );
    expect(
      await screen.findByText("PASS", {
        selector: ".scout-report-verdict-label",
      }),
    ).toBeVisible();
    expect(screen.getByText("Required evidence was missing")).toBeVisible();
    expect(screen.getByText("A contraindication applied")).toBeVisible();
    expect(
      screen.getByText("missing-evidence:injuries", { selector: "code" }),
    ).toBeVisible();
    expect(
      screen.getByText("No content in this version for Final Plays."),
    ).toBeVisible();
    expect(sectionOrder()).toContain("Nuke or Pass");
  });

  it("labels a stale source with its badge and age", async () => {
    render(
      <ScoutReport
        jobId={jobId}
        client={client({
          getScoutReportByJob: vi.fn(() =>
            Promise.resolve(
              dto({
                payload: payload({
                  assertions: [
                    {
                      text: "The offered price is older than the strategy allows.",
                      classification: "stale",
                      citationIds: ["evidence-market-1"],
                    },
                  ],
                  summary:
                    "The offered price is older than the strategy allows.",
                }),
                provenance: provenance([
                  {
                    observationId: "evidence-market-1",
                    category: "market-intelligence",
                    status: "stale",
                    observedAt: "2026-07-30T09:00:00.000Z",
                  },
                ]),
              }),
            ),
          ),
        })}
      />,
    );
    expect(
      await screen.findByText("STALE", { selector: ".scout-report-evidence" }),
    ).toBeVisible();
    expect(screen.getByText(/\d+ d old/)).toBeVisible();
    // A degraded claim belongs to Risk Assessment, leaving Market Edge
    // narrative empty but present.
    expect(
      screen.getByText("No content in this version for Market Edge narrative."),
    ).toBeVisible();
  });

  it("loads the version list on demand and navigates between versions", async () => {
    const two = dto({
      versionNumber: 2,
      latestVersionNumber: 2,
      changeSummary: { kind: "changed", changedFields: ["probability"] },
      payload: payload({
        probability: {
          estimate: 0.41,
          low: 0.35,
          high: 0.48,
          uncertainty: 0.07,
        },
      }),
    });
    const one = dto({ latestVersionNumber: 2 });
    const listVersions: ScoutReportVersionsDto = {
      schemaVersion: "scout-report-versions-v1",
      reportId,
      eventId: "event:soccer:2026-epl-fulham-arsenal-001",
      latestVersionNumber: 2,
      updatedAt: "2026-08-07T17:00:00.000Z",
      items: [
        {
          versionNumber: 1,
          generatedAt: "2026-08-07T16:00:00.000Z",
          validationOutcome: "complete",
          changeSummary: { kind: "initial", changedFields: [] },
          jobId,
        },
        {
          versionNumber: 2,
          generatedAt: "2026-08-07T17:00:00.000Z",
          validationOutcome: "complete",
          changeSummary: { kind: "changed", changedFields: ["probability"] },
          jobId,
        },
      ],
    };
    const list = vi.fn(() => Promise.resolve(listVersions));
    const byVersion = vi.fn(() => Promise.resolve(one));
    const onSelectVersion = vi.fn();
    const scoutClient = client({
      getScoutReportByJob: vi.fn(() => Promise.resolve(two)),
      getScoutReportVersion: byVersion,
      listScoutReportVersions: list,
    });
    const { rerender } = render(
      <ScoutReport
        jobId={jobId}
        client={scoutClient}
        onSelectVersion={onSelectVersion}
      />,
    );
    expect((await screen.findAllByText("41.0%")).length).toBeGreaterThan(0);
    expect(
      screen.getByText("Changed from version 1: probability."),
    ).toBeVisible();
    expect(list).not.toHaveBeenCalled();

    fireEvent.click(
      screen.getByRole("button", { name: "Show version history" }),
    );
    await settle();
    expect(list).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "View version 1" }));
    expect(onSelectVersion).toHaveBeenCalledWith(1);

    rerender(
      <ScoutReport
        jobId={jobId}
        versionNumber={1}
        client={scoutClient}
        onSelectVersion={onSelectVersion}
      />,
    );
    expect((await screen.findAllByText("62.0%")).length).toBeGreaterThan(0);
    expect(byVersion).toHaveBeenCalledWith(
      reportId,
      1,
      expect.any(AbortSignal),
    );
    expect(
      screen.getByText("Initial version of this report.", {
        selector: "p.scout-report-change",
      }),
    ).toBeVisible();
  });

  it("states a missing report neutrally without offering a retry", async () => {
    render(
      <ScoutReport
        jobId={jobId}
        client={client({
          getScoutReportByJob: vi.fn(() =>
            Promise.reject(
              new GamesClientError("not-found", "raw foreign report"),
            ),
          ),
        })}
      />,
    );
    expect(
      await screen.findByRole("heading", {
        name: "No report exists for this job",
      }),
    ).toBeVisible();
    expect(screen.queryByText("raw foreign report")).toBeNull();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    expect(
      screen.getByRole("link", { name: "View scouting progress" }),
    ).toBeVisible();
  });

  it("shows the scouting auth prompt when the session cannot read reports", async () => {
    render(
      <ScoutReport
        jobId={jobId}
        client={client({
          getScoutReportByJob: vi.fn(() =>
            Promise.reject(new GamesClientError("forbidden", "raw scope list")),
          ),
        })}
      />,
    );
    expect(
      await screen.findByRole("heading", { name: "Scouting access required" }),
    ).toBeVisible();
    expect(
      screen.getByText("This account does not have scouting access."),
    ).toBeVisible();
    expect(screen.queryByText("raw scope list")).toBeNull();
  });

  it("fails closed on a corrupt report instead of rendering part of it", async () => {
    render(
      <ScoutReport
        jobId={jobId}
        client={client({
          getScoutReportByJob: vi.fn(() =>
            Promise.reject(
              new GamesClientError("invalid-response", "half a report"),
            ),
          ),
        })}
      />,
    );
    expect(
      await screen.findByRole("heading", {
        name: "Report could not be verified",
      }),
    ).toBeVisible();
    expect(screen.queryByRole("heading", { name: "Market Edge" })).toBeNull();
    expect(screen.queryByText("half a report")).toBeNull();
    expect(screen.getByRole("button", { name: "Try again" })).toBeVisible();
  });

  it("never requests a malformed job address", async () => {
    const get = vi.fn(() => Promise.resolve(dto()));
    render(
      <ScoutReport jobId="bad" client={client({ getScoutReportByJob: get })} />,
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This scouting job address is invalid.",
    );
    expect(get).not.toHaveBeenCalled();
  });
});

describe("parseScoutReport", () => {
  const envelope = {
    schemaVersion: "scout-report-v1",
    reportId,
    versionNumber: 1,
    latestVersionNumber: 1,
    jobId,
    eventId: "event:soccer:2026-epl-fulham-arsenal-001",
    eventVersion: 1,
    generatedAt: "2026-08-07T17:00:00.000Z",
    validationOutcome: "complete",
    changeSummary: { kind: "initial", changedFields: [] },
    payload: payload(),
    provenance: provenance([
      {
        observationId: "evidence-form-1",
        category: "form",
        status: "verified",
        observedAt: "2026-08-07T16:30:00.000Z",
      },
    ]),
  };

  it("accepts exactly the published envelope", () => {
    expect(parseScoutReport(envelope).versionNumber).toBe(1);
  });

  it.each([
    ["a foreign schema", { schemaVersion: "scout-report-v2" }],
    ["a head behind the viewed version", { latestVersionNumber: 0 }],
    ["a status the envelope disagrees with", { validationOutcome: "abstain" }],
    [
      "an initial version with change fields",
      { changeSummary: { kind: "changed", changedFields: ["status"] } },
    ],
    ["an unknown extra field", { extra: 1 }],
  ])("rejects %s", (_label, overrides) => {
    expect(() => parseScoutReport({ ...envelope, ...overrides })).toThrow(
      GamesClientError,
    );
  });

  it("rejects a citation that no stored observation backs", () => {
    expect(() =>
      parseScoutReport({
        ...envelope,
        payload: payload({
          assertions: [
            {
              text: "Unbacked claim.",
              classification: "inference",
              citationIds: ["evidence-missing-1"],
            },
          ],
          summary: "Unbacked claim.",
        }),
      }),
    ).toThrow(GamesClientError);
  });
});
