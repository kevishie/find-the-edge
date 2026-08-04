import { describe, expect, it, vi } from "vitest";
import {
  freezeCohort,
  freezeRetrospectiveEvidence,
  type FrozenCohort,
  type RetrospectiveEvidenceRef,
} from "@find-the-edge/domain";
import {
  MemoryRetrospectiveRepository,
  type StoredPerformanceReport,
} from "@find-the-edge/database";
import type { PerformanceReportMetrics } from "@find-the-edge/odds";
import { RetrospectiveBuilder } from "./retrospective-builder";
const h = (c: string) => c.repeat(64),
  cohort = freezeCohort({
    definition: {
      window: {
        from: "2025-12-01T00:00:00.000Z",
        to: "2026-01-01T00:00:00.000Z",
      },
      filters: { wagerMode: "paper" },
      policyVersions: {
        cohort: "cohort-v1",
        performance: "performance-v1",
        oddsBand: "odds-band-v1",
        calibration: "calibration-deciles-v1",
        clv: "clv-same-book-15m-v1",
      },
    },
    cutoff: "2026-01-02T00:00:00.000Z",
    members: [
      {
        paperBetId: `paper-bet:${h("a")}`,
        evaluationId: `evaluation:${h("b")}`,
        gradeId: `paper-grade:${h("c")}`,
        resultObservationId: `result:${h("d")}`,
        openingSnapshotId: h("e"),
        closingSnapshotId: null,
      },
    ],
  });
const report = {
  reportId: `performance-report:${h("f")}`,
  cohortId: cohort.cohortId,
  cutoff: cohort.cutoff,
  evidenceDigest: h("a"),
  revision: 1,
  createdAt: "2026-01-03T00:00:00.000Z",
  facets: {
    sports: [],
    leagues: [],
    markets: [],
    oddsBands: [],
    strategyVersions: [],
    modelVersions: [],
  },
  metrics: { units: -1, roi: -1 },
} as unknown as StoredPerformanceReport<PerformanceReportMetrics>;
describe("retrospective builder", () => {
  it("replays exact reports and creates correction-linked revisions", async () => {
    const repo = new MemoryRetrospectiveRepository(),
      ref: RetrospectiveEvidenceRef = {
        id: "evaluation",
        kind: "evaluation",
        layer: "decision-time",
        decisionCutoff: "2026-01-01T00:00:00.000Z",
        observedAt: "2026-01-01T00:00:00.000Z",
        digest: h("a"),
      },
      source = {
        resolve: vi.fn(async () => {
          await Promise.resolve();
          return {
            member: {
              memberId: "member",
              sport: "baseball",
              league: "mlb",
              market: "spread",
              outcome: "lost" as const,
              profit: -1,
              evidenceRefIds: ["evaluation"],
            },
            refs: [ref],
          };
        }),
      },
      emitted: Record<string, string | number>[] = [],
      builder = new RetrospectiveBuilder(source, repo, {
        emit: (metrics) => emitted.push({ ...metrics }),
      });
    const one = await builder.build({
      cohort,
      report,
      createdAt: "2026-01-03T00:00:00.000Z",
    });
    expect(
      await builder.build({
        cohort,
        report,
        createdAt: "2026-01-04T00:00:00.000Z",
      }),
    ).toEqual(one);
    expect(emitted).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ RetrospectivesBuilt: 1 }),
        expect.objectContaining({ RetrospectiveReplays: 1 }),
      ]),
    );
    const two = await builder.build({
      cohort,
      report: {
        ...report,
        reportId: `performance-report:${h("1")}`,
        revision: 2,
      },
      createdAt: "2026-01-05T00:00:00.000Z",
    });
    expect(two.predecessorVersionId).toBe(one.versionId);
    expect(two.version).toBe(2);
    expect(
      freezeRetrospectiveEvidence({
        evaluationCutoff: cohort.cutoff,
        refs: [ref],
      }).manifestDigest,
    ).toBe(one.evidence.manifestDigest);
  });

  it("rejects conflicting material that reuses an evidence ID", async () => {
    const members = [
      cohort.members[0]!,
      { ...cohort.members[0]!, paperBetId: "paper-bet-2" },
    ];
    const builder = new RetrospectiveBuilder(
      {
        resolve: vi.fn((member: FrozenCohort["members"][number]) =>
          Promise.resolve({
            member: {
              memberId: member.paperBetId,
              sport: "baseball",
              league: "mlb",
              market: "spread",
              outcome: "lost" as const,
              profit: -1,
              evidenceRefIds: ["shared"],
            },
            refs: [
              {
                id: "shared",
                kind: "evaluation",
                layer: "decision-time" as const,
                decisionCutoff: "2026-01-01T00:00:00.000Z",
                observedAt: "2026-01-01T00:00:00.000Z",
                digest:
                  member.paperBetId === members[0]!.paperBetId
                    ? h("a")
                    : h("b"),
              },
            ],
          }),
        ),
      },
      new MemoryRetrospectiveRepository(),
    );
    await expect(
      builder.build({
        cohort: { ...cohort, members },
        report,
        createdAt: "2026-01-03T00:00:00.000Z",
      }),
    ).rejects.toThrow("retrospective-evidence-id-conflict");
  });
  it("retries only the failed member and checkpoints successful evidence", async () => {
    const members = [
      cohort.members[0]!,
      { ...cohort.members[0]!, paperBetId: "paper-bet-2" },
    ];
    const calls = new Map<string, number>();
    const builder = new RetrospectiveBuilder(
      {
        resolve: vi.fn((member: FrozenCohort["members"][number]) => {
          const count = (calls.get(member.paperBetId) ?? 0) + 1;
          calls.set(member.paperBetId, count);
          if (member.paperBetId === members[1]!.paperBetId && count === 1)
            return Promise.reject(new Error("temporary-evidence-read"));
          return Promise.resolve({
            member: {
              memberId: member.paperBetId,
              sport: "baseball",
              league: "mlb",
              market: "spread",
              outcome: "lost" as const,
              profit: -1,
              evidenceRefIds: [`eval-${member.paperBetId}`],
            },
            refs: [
              {
                id: `eval-${member.paperBetId}`,
                kind: "evaluation",
                layer: "decision-time" as const,
                decisionCutoff: "2026-01-01T00:00:00.000Z",
                observedAt: "2026-01-01T00:00:00.000Z",
                digest: h(
                  member.paperBetId === members[0]!.paperBetId ? "a" : "b",
                ),
              },
            ],
          });
        }),
      },
      new MemoryRetrospectiveRepository(),
    );
    await builder.build({
      cohort: { ...cohort, members },
      report,
      createdAt: "2026-01-03T00:00:00.000Z",
    });
    expect(calls.get(members[0]!.paperBetId)).toBe(1);
    expect(calls.get(members[1]!.paperBetId)).toBe(2);
  });
});
