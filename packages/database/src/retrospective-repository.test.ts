import { describe, expect, it, vi } from "vitest";
import {
  createRetrospectiveVersion,
  freezeRetrospectiveEvidence,
} from "@find-the-edge/domain";
import {
  MemoryRetrospectiveRepository,
  RetrospectiveConflictError,
} from "./retrospective-repository";
import { DynamoRetrospectiveRepository } from "./dynamodb-retrospective-repository";
const h = (c: string) => c.repeat(64);
const make = (version = 1, predecessorVersionId: null | string = null) =>
  createRetrospectiveVersion({
    cohortId: `cohort:${h("a")}`,
    reportId: `performance-report:${h(version === 1 ? "b" : "c")}`,
    reportRevision: version,
    version,
    predecessorVersionId,
    createdAt: `2026-01-0${version + 2}T00:00:00.000Z`,
    evidence: freezeRetrospectiveEvidence({
      evaluationCutoff: "2026-01-01T00:00:00.000Z",
      refs: [
        {
          id: "eval",
          kind: "evaluation",
          layer: "decision-time",
          decisionCutoff: "2026-01-01T00:00:00.000Z",
          observedAt: "2025-12-31T00:00:00.000Z",
          digest: h("a"),
        },
      ],
    }),
    slices: [],
    observations: [
      {
        id: "fn",
        taxonomyCode: "false-negative",
        layer: "decision-time",
        summary:
          "False-negative review is unavailable without a frozen non-play universe.",
        evidenceRefIds: ["eval"],
        memberIds: [],
        confidence: "not-evaluable",
      },
    ],
    candidates: [],
    memberCount: 1,
  });
describe("retrospective repository", () => {
  it("preserves versions, paginates, and makes review retries atomic", async () => {
    const repo = new MemoryRetrospectiveRepository(),
      one = await repo.putVersion(make());
    const reviewed = await repo.review({
      versionId: one.versionId,
      reviewerId: "reviewer",
      reasonCode: "approve",
      decidedAt: "2026-01-04T00:00:00.000Z",
      idempotencyKey: "key",
      expectedState: "draft",
      expectedStateVersion: 1,
    });
    const replay = await repo.review({
      versionId: one.versionId,
      reviewerId: "reviewer",
      reasonCode: "approve",
      decidedAt: "2026-01-04T00:00:00.000Z",
      idempotencyKey: "key",
      expectedState: "draft",
      expectedStateVersion: 1,
    });
    expect(replay).toEqual(reviewed);
    await expect(
      repo.review({
        versionId: one.versionId,
        reviewerId: "reviewer",
        reasonCode: "reject",
        decidedAt: "2026-01-04T00:00:00.000Z",
        idempotencyKey: "key",
        expectedState: "draft",
        expectedStateVersion: 1,
      }),
    ).rejects.toBeInstanceOf(RetrospectiveConflictError);
    const two = await repo.putVersion(make(2, one.versionId));
    expect(
      (
        await repo.listVersions({
          retrospectiveId: one.retrospectiveId,
          limit: 1,
        })
      ).nextCursor,
    ).toBeTruthy();
    expect((await repo.getVersion(one.versionId))?.state).toBe("approved");
    expect((await repo.getCurrent(one.retrospectiveId))?.versionId).toBe(
      two.versionId,
    );
    expect(
      await repo.listAudit({ versionId: one.versionId, limit: 50 }),
    ).toMatchObject({ items: [{ versionId: one.versionId }] });
  });
  it("rejects invalid correction lineage", async () => {
    const repo = new MemoryRetrospectiveRepository();
    await repo.putVersion(make());
    await expect(
      repo.putVersion(make(2, `retrospective-version:${h("d")}`)),
    ).rejects.toBeInstanceOf(RetrospectiveConflictError);
  });
  it("lists Dynamo current rows newest-first and resumes from a validated cursor", async () => {
    const older = make();
    const newer = createRetrospectiveVersion({
      ...older,
      cohortId: `cohort:${h("d")}`,
      reportId: `performance-report:${h("e")}`,
      createdAt: "2026-02-01T00:00:00.000Z",
    });
    const sk = (value: typeof older) =>
      `${String(8_640_000_000_000_000 - Date.parse(value.createdAt)).padStart(16, "0")}#${value.retrospectiveId}`;
    let query = 0;
    const send = vi.fn((command: { input: Record<string, unknown> }) => {
      const input = command.input;
      if ("KeyConditionExpression" in input) {
        expect(input["ScanIndexForward"]).toBe(true);
        query += 1;
        const value = query === 1 ? newer : older;
        return Promise.resolve({
          Items: [
            {
              sk: sk(value),
              value: {
                retrospectiveId: value.retrospectiveId,
                versionId: value.versionId,
                version: value.version,
                createdAt: value.createdAt,
              },
            },
          ],
          ...(query === 1
            ? { LastEvaluatedKey: { pk: "RETROSPECTIVES", sk: sk(value) } }
            : {}),
        });
      }
      const key = input["Key"] as { pk: string; sk: string };
      if (key.pk === "RETROSPECTIVES")
        return Promise.resolve({ Item: { value: {} } });
      const value =
        key.pk.includes(newer.retrospectiveId) ||
        key.pk.includes(newer.versionId)
          ? newer
          : older;
      return Promise.resolve({
        Item: {
          value: key.sk === "CURRENT" ? { versionId: value.versionId } : value,
        },
      });
    });
    const codec = {
      encode: (_pk: string, lastSk: string) => `cursor:${lastSk}`,
      decode: (cursor: string) => ({ lastSk: cursor.slice(7) }),
    };
    const repo = new DynamoRetrospectiveRepository(
      { send } as never,
      "table",
      codec as never,
    );
    const first = await repo.list({ limit: 1 });
    expect(first.items.map((item) => item.versionId)).toEqual([
      newer.versionId,
    ]);
    expect(first.nextCursor).toBeTruthy();
    const second = await repo.list({ limit: 1, cursor: first.nextCursor! });
    expect(second.items.map((item) => item.versionId)).toEqual([
      older.versionId,
    ]);
  });
});
