import { describe, expect, it } from "vitest";

import {
  AnalysisContractError,
  normalizeAnalysisRequest,
  plannedAnalysisAbstention,
  validateAnalysisOutput,
} from "./analysis-contract";
import {
  completeOutput,
  completeRequest,
  completeSoccerRequest,
  fixturePolicy,
  fixtureSoccerPolicy,
} from "./fixtures/analysis";

function code(callback: () => unknown): string | undefined {
  try {
    callback();
  } catch (error) {
    return error instanceof AnalysisContractError ? error.code : undefined;
  }
  return undefined;
}

describe("analysis request contract", () => {
  it("normalizes complete MLB and soccer fixtures deterministically", () => {
    expect(
      normalizeAnalysisRequest(completeRequest, fixturePolicy),
    ).toMatchObject({ sportKey: "mlb", derivedStatus: "complete" });
    expect(
      normalizeAnalysisRequest(completeSoccerRequest, fixtureSoccerPolicy),
    ).toMatchObject({
      sportKey: "soccer",
      derivedStatus: "complete",
      candidate: {
        marketKey: "moneyline",
        outcomeStructure: "three-way",
        selection: { kind: "draw" },
      },
    });
  });

  it("binds contract, prompt, schema, and model references into input identity", () => {
    const first = normalizeAnalysisRequest(completeRequest, fixturePolicy);
    const second = normalizeAnalysisRequest(completeRequest, {
      ...fixturePolicy,
      versions: { ...fixturePolicy.versions, contractVersion: "fixture@2" },
    });
    expect(first.versions).toEqual(fixturePolicy.versions);
    expect(second.inputHash).not.toBe(first.inputHash);
  });

  it("binds the policy to its sport and league", () => {
    expect(
      code(() =>
        normalizeAnalysisRequest(
          { ...completeRequest, sportKey: "soccer" },
          fixturePolicy,
        ),
      ),
    ).toBe("SPORT_POLICY_MISMATCH");
    expect(
      code(() =>
        normalizeAnalysisRequest(
          { ...completeRequest, leagueKey: "other" },
          fixturePolicy,
        ),
      ),
    ).toBe("LEAGUE_POLICY_MISMATCH");
  });

  it("does not let empty or stale verified evidence satisfy completeness", () => {
    const empty = normalizeAnalysisRequest(
      {
        ...completeRequest,
        evidence: [
          { ...completeRequest.evidence[0], facts: {} },
          completeRequest.evidence[1],
        ],
      },
      fixturePolicy,
    );
    expect(empty).toMatchObject({
      derivedStatus: "abstain",
      missingEvidenceCodes: ["missing-evidence:form"],
    });
    const stale = normalizeAnalysisRequest(
      {
        ...completeRequest,
        evidence: [
          {
            ...completeRequest.evidence[0],
            observedAt: "2026-08-03T20:00:00.000Z",
          },
          completeRequest.evidence[1],
        ],
      },
      fixturePolicy,
    );
    expect(stale.derivedReasonCodes).toEqual([
      "missing-evidence:form",
      "stale-evidence:form",
    ]);
  });

  it("enforces spread point range, increment, and precision", () => {
    const candidate = {
      marketKey: "spread",
      outcomeStructure: "two-way",
      selection: { kind: "participant", participantId: "home" },
    } as const;
    expect(
      normalizeAnalysisRequest(
        { ...completeRequest, candidate: { ...candidate, point: -1.5 } },
        fixturePolicy,
      ).candidate.point,
    ).toBe(-1.5);
    expect(
      code(() =>
        normalizeAnalysisRequest(
          { ...completeRequest, candidate: { ...candidate, point: -1.3 } },
          fixturePolicy,
        ),
      ),
    ).toBe("INVALID_SPREAD_POINT");
  });

  it("executes contraindication and strategy prohibition rules", () => {
    const contraindicated = normalizeAnalysisRequest(
      {
        ...completeRequest,
        evidence: [
          ...completeRequest.evidence,
          {
            id: "weather-stale",
            category: "weather",
            status: "stale",
            observedAt: "2026-08-03T21:00:00.000Z",
            facts: { wind: 20 },
          },
        ],
      },
      {
        ...fixturePolicy,
        contraindications: [
          {
            code: "contraindication:unsafe-weather",
            evidenceCategory: "weather",
            statuses: ["stale"],
          },
        ],
      },
    );
    expect(contraindicated).toMatchObject({
      derivedStatus: "abstain",
      derivedReasonCodes: ["contraindication:unsafe-weather"],
    });
    const strategy = normalizeAnalysisRequest(
      {
        ...completeRequest,
        candidate: {
          marketKey: "run_line",
          outcomeStructure: "two-way",
          selection: { kind: "participant", participantId: "home" },
          point: -1.5,
        },
      },
      fixturePolicy,
      { id: "find-the-edge", version: "1", prohibitedMarketKeys: ["spread"] },
    );
    expect(strategy.derivedReasonCodes).toEqual([
      "strategy-prohibited-market:spread",
    ]);
  });

  it("rejects undeclared evidence categories and cyclic input deterministically", () => {
    expect(
      code(() =>
        normalizeAnalysisRequest(
          {
            ...completeRequest,
            evidence: [
              ...completeRequest.evidence,
              {
                id: "unknown-1",
                category: "unknown",
                status: "verified",
                observedAt: completeRequest.asOf,
                facts: { value: true },
              },
            ],
          },
          fixturePolicy,
        ),
      ),
    ).toBe("UNKNOWN_EVIDENCE_CATEGORY");
    const cyclic: Record<string, unknown> = { ...completeRequest };
    cyclic["cycle"] = cyclic;
    expect(code(() => normalizeAnalysisRequest(cyclic, fixturePolicy))).toBe(
      "CYCLIC_INPUT",
    );
  });

  it("normalizes complete evidence and legacy run line to canonical spread", () => {
    const request = normalizeAnalysisRequest(
      {
        ...completeRequest,
        candidate: {
          marketKey: "run_line",
          outcomeStructure: "two-way",
          selection: { kind: "participant", participantId: "home" },
          point: -1.5,
        },
      },
      fixturePolicy,
    );
    expect(request.candidate).toMatchObject({
      marketKey: "spread",
      point: -1.5,
    });
    expect(request.derivedStatus).toBe("complete");
    expect(request.inputHash).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("supports a legal three-way draw and rejects illegal or incomplete selections", () => {
    const draw = normalizeAnalysisRequest(
      {
        ...completeSoccerRequest,
        candidate: {
          marketKey: "moneyline",
          outcomeStructure: "three-way",
          selection: { kind: "draw" },
        },
      },
      fixtureSoccerPolicy,
    );
    expect(draw.candidate).toEqual({
      marketKey: "moneyline",
      outcomeStructure: "three-way",
      selection: { kind: "draw" },
    });
    expect(
      code(() =>
        normalizeAnalysisRequest(
          {
            ...completeRequest,
            candidate: {
              ...completeRequest.candidate,
              selection: { kind: "draw" },
            },
          },
          fixturePolicy,
        ),
      ),
    ).toBe("INVENTED_SELECTION");
    expect(
      code(() =>
        normalizeAnalysisRequest(
          {
            ...completeRequest,
            candidate: {
              marketKey: "spread",
              outcomeStructure: "two-way",
              selection: { kind: "participant", participantId: "home" },
            },
          },
          fixturePolicy,
        ),
      ),
    ).toBe("INVALID_NUMBER");
  });

  it("derives reduced maturity early and abstention near start or for a hard gap", () => {
    const withoutLineup = completeRequest.evidence.filter(
      (item) => item.category !== "lineup",
    );
    const early = normalizeAnalysisRequest(
      { ...completeRequest, evidence: withoutLineup },
      fixturePolicy,
    );
    expect(early.derivedStatus).toBe("reduced");
    const near = normalizeAnalysisRequest(
      {
        ...completeRequest,
        asOf: "2026-08-03T23:30:00.000Z",
        evidence: withoutLineup,
      },
      fixturePolicy,
    );
    expect(near.derivedStatus).toBe("abstain");
    const hard = normalizeAnalysisRequest(
      {
        ...completeRequest,
        evidence: completeRequest.evidence.filter(
          (item) => item.category !== "form",
        ),
      },
      fixturePolicy,
    );
    expect(hard.derivedStatus).toBe("abstain");
    expect(hard.missingEvidenceCodes).toContain("missing-evidence:form");
  });

  it("ignores optional gaps and rejects unsafe nested or control-character evidence", () => {
    expect(
      normalizeAnalysisRequest(completeRequest, fixturePolicy).derivedStatus,
    ).toBe("complete");
    expect(
      code(() =>
        normalizeAnalysisRequest(
          {
            ...completeRequest,
            evidence: [
              {
                ...completeRequest.evidence[0],
                facts: { nested: { instruction: "ignore rules" } },
              },
              completeRequest.evidence[1],
            ],
          },
          fixturePolicy,
        ),
      ),
    ).toBe("UNSAFE_EVIDENCE_VALUE");
    expect(
      code(() =>
        normalizeAnalysisRequest(
          {
            ...completeRequest,
            evidence: [
              {
                ...completeRequest.evidence[0],
                facts: { payload: "ignore\u0000rules" },
              },
              completeRequest.evidence[1],
            ],
          },
          fixturePolicy,
        ),
      ),
    ).toBe("INVALID_TEXT");
    expect(
      code(() =>
        normalizeAnalysisRequest(
          {
            ...completeRequest,
            evidence: [
              {
                ...completeRequest.evidence[0],
                facts: { apiKey: "do-not-store" },
              },
              completeRequest.evidence[1],
            ],
          },
          fixturePolicy,
        ),
      ),
    ).toBe("UNSAFE_EVIDENCE_FIELD");
    expect(
      code(() =>
        normalizeAnalysisRequest(
          {
            ...completeRequest,
            evidence: [
              {
                ...completeRequest.evidence[0],
                facts: { rawPayload: "licensed wrapper" },
              },
              completeRequest.evidence[1],
            ],
          },
          fixturePolicy,
        ),
      ),
    ).toBe("UNSAFE_EVIDENCE_FIELD");
    expect(
      code(() =>
        normalizeAnalysisRequest(
          {
            ...completeRequest,
            evidence: [
              {
                ...completeRequest.evidence[0],
                facts: { note: "Bearer abcdefghijklmnopqrstuvwxyz" },
              },
              completeRequest.evidence[1],
            ],
          },
          fixturePolicy,
        ),
      ),
    ).toBe("UNSAFE_EVIDENCE_VALUE");
  });

  it("rejects evidence that postdates the analysis boundary", () => {
    expect(
      code(() =>
        normalizeAnalysisRequest(
          {
            ...completeRequest,
            evidence: [
              {
                ...completeRequest.evidence[0],
                observedAt: "2026-08-03T22:00:01.000Z",
              },
              completeRequest.evidence[1],
            ],
          },
          fixturePolicy,
        ),
      ),
    ).toBe("EVIDENCE_FROM_FUTURE");
  });

  it("rejects live or completed-event analysis boundaries", () => {
    for (const asOf of [completeRequest.startsAt, "2026-08-04T00:00:01.000Z"]) {
      expect(
        code(() =>
          normalizeAnalysisRequest({ ...completeRequest, asOf }, fixturePolicy),
        ),
      ).toBe("ANALYSIS_NOT_PREGAME");
    }
  });

  it("fails a category closed when unresolved evidence conflicts", () => {
    const request = normalizeAnalysisRequest(
      {
        ...completeRequest,
        evidence: [
          ...completeRequest.evidence,
          {
            id: "form-conflict",
            category: "form",
            status: "conflicting",
            observedAt: completeRequest.asOf,
            facts: { rating: 0.2 },
          },
        ],
      },
      fixturePolicy,
    );
    expect(request.derivedStatus).toBe("abstain");
    expect(request.missingEvidenceCodes).toContain("missing-evidence:form");
  });

  it("normalizes legacy soccer three-way identity to canonical moneyline", () => {
    const request = normalizeAnalysisRequest(
      {
        ...completeSoccerRequest,
        candidate: {
          ...completeSoccerRequest.candidate,
          marketKey: "three_way_moneyline",
        },
      },
      fixtureSoccerPolicy,
    );
    expect(request.candidate.marketKey).toBe("moneyline");
  });
});

describe("analysis output contract", () => {
  const request = normalizeAnalysisRequest(completeRequest, fixturePolicy);

  it("accepts bounded, cited output and freezes the result", () => {
    const result = validateAnalysisOutput(
      completeOutput,
      request,
      fixturePolicy,
    );
    expect(result.status).toBe("complete");
    expect(Object.isFrozen(result.assertions[0])).toBe(true);
  });

  it("binds output and request to exact policy versions", () => {
    expect(
      code(() =>
        validateAnalysisOutput(
          {
            ...completeOutput,
            versions: {
              ...completeOutput.versions,
              outputSchemaVersion: "2",
            },
          },
          request,
          fixturePolicy,
        ),
      ),
    ).toBe("OUTPUT_VERSION_MISMATCH");
    expect(
      code(() =>
        validateAnalysisOutput(completeOutput, request, {
          ...fixturePolicy,
          versions: { ...fixturePolicy.versions, contractVersion: "changed" },
        }),
      ),
    ).toBe("POLICY_VERSION_MISMATCH");
  });

  it("requires coherent uncertainty and canonical assertion-derived summary", () => {
    expect(
      code(() =>
        validateAnalysisOutput(
          {
            ...completeOutput,
            probability: { ...completeOutput.probability, uncertainty: 0.1 },
          },
          request,
          fixturePolicy,
        ),
      ),
    ).toBe("UNCERTAINTY_INCOHERENT");
    expect(
      code(() =>
        validateAnalysisOutput(
          { ...completeOutput, summary: "Uncited extra factual sentence." },
          request,
          fixturePolicy,
        ),
      ),
    ).toBe("SUMMARY_ASSERTION_MISMATCH");
  });

  it("requires every derived reason code on abstention", () => {
    const missing = normalizeAnalysisRequest(
      { ...completeRequest, evidence: [] },
      fixturePolicy,
    );
    expect(missing.missingEvidenceCodes).toEqual([
      "missing-evidence:form",
      "missing-evidence:lineup",
    ]);
    expect(
      code(() =>
        validateAnalysisOutput(
          {
            ...completeOutput,
            status: "abstain",
            abstentionCodes: ["missing-evidence:form"],
            assertions: [
              {
                text: "Required evidence is unavailable.",
                classification: "unavailable",
                citationIds: [],
              },
            ],
            summary: "Required evidence is unavailable.",
          },
          missing,
          fixturePolicy,
        ),
      ),
    ).toBe("INCOMPLETE_ABSTENTION_CODES");
    expect(
      code(() =>
        validateAnalysisOutput(
          {
            ...completeOutput,
            status: "abstain",
            abstentionCodes: [...missing.derivedReasonCodes, "model-invented"],
            assertions: [
              {
                text: "Required evidence is unavailable.",
                classification: "unavailable",
                citationIds: [],
              },
            ],
            summary: "Required evidence is unavailable.",
          },
          missing,
          fixturePolicy,
        ),
      ),
    ).toBe("INVENTED_ABSTENTION_CODE");
  });

  it("applies category freshness and unresolved conflicts to citations", () => {
    const stale = normalizeAnalysisRequest(
      {
        ...completeRequest,
        evidence: [
          {
            ...completeRequest.evidence[0],
            observedAt: "2026-08-03T20:00:00.000Z",
          },
          completeRequest.evidence[1],
        ],
      },
      fixturePolicy,
    );
    expect(
      code(() =>
        validateAnalysisOutput(
          {
            ...completeOutput,
            status: "abstain",
            abstentionCodes: stale.derivedReasonCodes,
          },
          stale,
          fixturePolicy,
        ),
      ),
    ).toBe("UNVERIFIED_FACTUAL_ASSERTION");

    const conflicting = normalizeAnalysisRequest(
      {
        ...completeRequest,
        evidence: [
          ...completeRequest.evidence,
          {
            id: "form-conflict",
            category: "form",
            status: "conflicting",
            observedAt: completeRequest.asOf,
            facts: { rating: 0.2 },
          },
        ],
      },
      fixturePolicy,
    );
    expect(
      code(() =>
        validateAnalysisOutput(
          {
            ...completeOutput,
            status: "abstain",
            abstentionCodes: conflicting.derivedReasonCodes,
          },
          conflicting,
          fixturePolicy,
        ),
      ),
    ).toBe("UNVERIFIED_FACTUAL_ASSERTION");
  });

  it("rejects guarantee equivalents without false-positive unlock", () => {
    const inference = (statement: string) => ({
      ...completeOutput,
      summary: statement,
      assertions: [
        { text: statement, classification: "inference", citationIds: [] },
      ],
    });
    expect(
      validateAnalysisOutput(
        inference("This could unlock a matchup edge."),
        request,
        fixturePolicy,
      ).summary,
    ).toContain("unlock");
    expect(
      code(() =>
        validateAnalysisOutput(
          inference("This is a sure thing."),
          request,
          fixturePolicy,
        ),
      ),
    ).toBe("PROHIBITED_CLAIM");
  });

  it.each([
    [
      "CANDIDATE_MISMATCH",
      {
        ...completeOutput,
        candidate: {
          ...completeOutput.candidate,
          selection: { kind: "participant", participantId: "away" },
        },
      },
    ],
    [
      "PROBABILITY_OUT_OF_BOUNDS",
      {
        ...completeOutput,
        probability: {
          ...completeOutput.probability,
          estimate: 1.2,
          high: 1.2,
        },
      },
    ],
    [
      "UNCERTAINTY_OUT_OF_BOUNDS",
      {
        ...completeOutput,
        probability: { estimate: 0.57, low: 0.4, high: 0.7, uncertainty: 0.3 },
      },
    ],
    [
      "UNKNOWN_CITATION",
      {
        ...completeOutput,
        assertions: [
          { ...completeOutput.assertions[0], citationIds: ["invented"] },
        ],
      },
    ],
    [
      "UNVERIFIED_FACTUAL_ASSERTION",
      {
        ...completeOutput,
        assertions: [{ ...completeOutput.assertions[0], citationIds: [] }],
      },
    ],
    [
      "PROHIBITED_CLAIM",
      {
        ...completeOutput,
        summary: "This is a lock.",
        assertions: [
          {
            text: "This is a lock.",
            classification: "inference",
            citationIds: [],
          },
        ],
      },
    ],
    ["UNKNOWN_FIELD", { ...completeOutput, ev: 0.1 }],
  ])("rejects violations with stable %s", (expected, output) => {
    expect(
      code(() => validateAnalysisOutput(output, request, fixturePolicy)),
    ).toBe(expected);
  });

  it("permits explicitly classified inference and validates stale classification", () => {
    expect(
      validateAnalysisOutput(
        {
          ...completeOutput,
          summary: "This may improve the matchup.",
          assertions: [
            {
              text: "This may improve the matchup.",
              classification: "inference",
              citationIds: [],
            },
          ],
        },
        request,
        fixturePolicy,
      ).assertions[0]?.classification,
    ).toBe("inference");
    const staleRequest = normalizeAnalysisRequest(
      {
        ...completeRequest,
        evidence: [
          ...completeRequest.evidence,
          {
            id: "weather-old",
            category: "weather",
            status: "stale",
            observedAt: "2026-08-03T18:00:00.000Z",
            facts: { wind: 12 },
          },
        ],
      },
      fixturePolicy,
    );
    expect(
      validateAnalysisOutput(
        {
          ...completeOutput,
          summary: "Weather evidence is stale.",
          assertions: [
            {
              text: "Weather evidence is stale.",
              classification: "stale",
              citationIds: ["weather-old"],
            },
          ],
        },
        staleRequest,
        fixturePolicy,
      ).assertions[0]?.classification,
    ).toBe("stale");
  });

  it("cannot claim completeness across derived evidence gaps", () => {
    const early = normalizeAnalysisRequest(
      {
        ...completeRequest,
        evidence: completeRequest.evidence.filter(
          (item) => item.category !== "lineup",
        ),
      },
      fixturePolicy,
    );
    expect(
      code(() => validateAnalysisOutput(completeOutput, early, fixturePolicy)),
    ).toBe("EVIDENCE_REQUIRES_REDUCED_MATURITY");
  });

  it("fails planned modules closed without model invocation", () => {
    const planned = {
      ...fixturePolicy,
      enabled: false,
      plannedReason: "planned-module-disabled" as const,
      markets: [],
    };
    expect(plannedAnalysisAbstention(planned)).toEqual({
      status: "abstain",
      reasonCode: "planned-module-disabled",
      invokeModel: false,
    });
    expect(code(() => normalizeAnalysisRequest(completeRequest, planned))).toBe(
      "PLANNED_MODULE_DISABLED",
    );
  });
});
