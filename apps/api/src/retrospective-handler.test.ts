import { describe, expect, it } from "vitest";
import {
  MemoryRetrospectiveRepository,
  type EventRepository,
} from "@find-the-edge/database";
import {
  createRetrospectiveVersion,
  freezeRetrospectiveEvidence,
} from "@find-the-edge/domain";
import { createEventHandler } from "./handler";
const h = (c: string) => c.repeat(64);
const record = createRetrospectiveVersion({
  cohortId: `cohort:${h("a")}`,
  reportId: `performance-report:${h("b")}`,
  reportRevision: 1,
  version: 1,
  createdAt: "2026-01-03T00:00:00.000Z",
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
const events: EventRepository = {
  list: async () => {
    await Promise.resolve();
    return {
      items: [],
      nextCursor: null,
      projectionState: "ready",
      evaluationState: "complete",
      hasMoreUnknown: false,
      snapshotAt: null,
      freshness: null,
    };
  },
  detail: async () => {
    await Promise.resolve();
    return { projectionState: "ready", item: null };
  },
};
describe("retrospective API", () =>
  it("serves public evidence and gates review mutations", async () => {
    const repo = new MemoryRetrospectiveRepository();
    await repo.putVersion(record);
    const handler = createEventHandler(
      events,
      undefined,
      undefined,
      undefined,
      undefined,
      repo,
    );
    expect(
      (await handler({ route: "retrospective-list", query: {} })).statusCode,
    ).toBe(200);
    expect(
      (
        await handler({
          route: "retrospective-detail",
          eventId: record.versionId,
          query: {},
        })
      ).body,
    ).not.toContain("reviewerId");
    expect(
      (
        await handler({
          route: "retrospective-review",
          eventId: record.versionId,
          method: "POST",
          contentType: "application/json",
          body: "{}",
          query: {},
        })
      ).statusCode,
    ).toBe(401);
    const response = await handler({
      route: "retrospective-review",
      eventId: record.versionId,
      subject: "reviewer",
      scopes: ["retrospectives:approve"],
      reviewerAuthorized: true,
      method: "POST",
      contentType: "application/json",
      query: {},
      body: JSON.stringify({
        reasonCode: "approve",
        idempotencyKey: "key",
        expectedState: "draft",
        expectedStateVersion: 1,
      }),
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain("reviewer");
    expect(
      (
        await handler({
          route: "retrospective-review",
          eventId: record.versionId,
          subject: "reviewer",
          scopes: ["retrospectives:approve"],
          reviewerAuthorized: true,
          method: "POST",
          contentType: "text/plain",
          query: {},
          body: "{}",
        })
      ).statusCode,
    ).toBe(400);
  }));
