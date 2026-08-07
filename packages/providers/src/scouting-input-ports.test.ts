import { describe, expect, it, vi } from "vitest";
import type { SportKey } from "@find-the-edge/domain";
import type { LoggerPort } from "@find-the-edge/observability";

import {
  createDevelopmentScoutingInputPorts,
  developmentScoutingInputSource,
  DevelopmentScoutingInputStubError,
} from "./scouting-input-development-stub";
import { validateScoutingInputSourceDescriptor } from "./scouting-input-ports";

const request = {
  correlationId: "correlation-1",
  canonicalEventId: "event-1",
  canonicalEventVersion: "v1",
  sportKey: "soccer" as SportKey,
  leagueKey: "mls",
  startsAt: "2026-08-07T23:00:00.000Z",
  participantIds: ["club-a", "club-b"],
  evaluatedAt: "2026-08-07T20:00:00.000Z",
  collectorSequence: 100,
};

describe("scouting input provider ports", () => {
  it("requires production maturity and eligibility to agree", () => {
    expect(() =>
      validateScoutingInputSourceDescriptor({
        ...developmentScoutingInputSource,
        sourceKind: "provider",
        productionEligible: true,
      }),
    ).toThrow("production eligibility must match maturity");
    expect(() =>
      validateScoutingInputSourceDescriptor({
        ...developmentScoutingInputSource,
        maturity: "production",
      }),
    ).toThrow("production eligibility must match maturity");
  });

  it("accepts canonical provider capabilities without a provider-core enum", () => {
    expect(
      validateScoutingInputSourceDescriptor({
        ...developmentScoutingInputSource,
        capabilities: ["future-sport-capability"],
      }).capabilities,
    ).toEqual(["future-sport-capability"]);
  });

  it("requires source-kind-specific bounded evidence reference prefixes", () => {
    expect(developmentScoutingInputSource.evidenceReferencePrefixes).toEqual([
      "synthetic://scouting/",
    ]);
    expect(() =>
      validateScoutingInputSourceDescriptor({
        ...developmentScoutingInputSource,
        evidenceReferencePrefixes: ["synthetic://"],
      }),
    ).toThrow("evidence reference prefix is not source-safe");
    expect(() =>
      validateScoutingInputSourceDescriptor({
        ...developmentScoutingInputSource,
        maturity: "production",
        productionEligible: true,
        sourceKind: "provider",
        evidenceReferencePrefixes: ["s3://"],
      }),
    ).toThrow("evidence reference prefix is not source-safe");
    expect(
      validateScoutingInputSourceDescriptor({
        ...developmentScoutingInputSource,
        maturity: "production",
        productionEligible: true,
        sourceKind: "provider",
        evidenceReferencePrefixes: [
          "s3://trusted-retention/provider-a/",
          "sha256://",
        ],
      }).evidenceReferencePrefixes,
    ).toEqual(["s3://trusted-retention/provider-a/", "sha256://"]);
  });

  it("rejects the development factory in production before logging", () => {
    const logger = { info: vi.fn(), error: vi.fn() };
    expect(() =>
      createDevelopmentScoutingInputPorts("production", logger),
    ).toThrow(
      new DevelopmentScoutingInputStubError(
        "PRODUCTION_FORBIDDEN",
        "fixture unavailable",
      ),
    );
    expect(logger.info).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("exposes independent capability ports with an ineligible descriptor", async () => {
    const ports = createDevelopmentScoutingInputPorts("test");
    expect(ports.descriptor.productionEligible).toBe(false);
    expect(ports.descriptor.capabilities).toEqual([
      "fixture",
      "venue",
      "team-roster-profile",
      "lineup",
      "injury-suspension",
      "statistics",
    ]);
    const fragments = await Promise.all([
      ports.fixture.collectFixture(request),
      ports.teamRoster.collectTeamRoster(request),
      ports.lineup.collectLineup(request),
      ports.injurySuspension.collectInjurySuspension(request),
      ports.statistics.collectStatistics(request),
    ]);
    expect(fragments).toHaveLength(5);
  });

  it.each(["proxy", "accessor", "date"])(
    "turns unsafe %s requests into the stable safe error",
    async (kind) => {
      let unsafe: unknown;
      if (kind === "proxy") {
        unsafe = new Proxy(
          {},
          {
            ownKeys: () => {
              throw new Error("secret");
            },
          },
        );
      } else if (kind === "accessor") {
        unsafe = Object.defineProperty({}, "sportKey", {
          enumerable: true,
          get: () => {
            throw new Error("secret");
          },
        });
      } else {
        unsafe = { ...request, evaluatedAt: "not-a-date" };
      }
      const ports = createDevelopmentScoutingInputPorts("test");
      await expect(
        ports.fixture.collectFixture(unsafe as typeof request),
      ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    },
  );

  it("logs metadata only and isolates logger failures", async () => {
    const infoMock = vi.fn<LoggerPort["info"]>(() => {
      throw new Error("logger unavailable");
    });
    const logger: LoggerPort = {
      info: infoMock,
      error: vi.fn(),
    };
    const ports = createDevelopmentScoutingInputPorts("development", logger);
    await expect(ports.lineup.collectLineup(request)).resolves.toBeDefined();
    expect(infoMock).toHaveBeenCalledWith(
      "Development scouting fixture collected",
      expect.objectContaining({
        correlationId: request.correlationId,
        eventId: request.canonicalEventId,
        capability: "lineup",
      }),
    );
    const context = infoMock.mock.calls[0]?.[1];
    expect(context).not.toHaveProperty("participantIds");
    expect(context).not.toHaveProperty("evaluatedAt");
  });

  it("turns fixture date-limit failures into the stable safe error", async () => {
    const ports = createDevelopmentScoutingInputPorts("test");
    await expect(
      ports.teamRoster.collectTeamRoster({
        ...request,
        evaluatedAt: "-271821-04-20T00:00:00.000Z",
      }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  });

  it("rejects unknown runtimes, collector overflow, and oversized composite ids", async () => {
    expect(() =>
      createDevelopmentScoutingInputPorts("preview" as never),
    ).toThrow("invalid_request");
    const ports = createDevelopmentScoutingInputPorts("test");
    await expect(
      ports.fixture.collectFixture({
        ...request,
        collectorSequence: Number.MAX_SAFE_INTEGER,
      }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(
      ports.fixture.collectFixture({
        ...request,
        canonicalEventId: `event-${"x".repeat(100)}`,
      }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(
      ports.fixture.collectFixture({
        ...request,
        participantIds: ["club", "club.player-1"],
      }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  });
});
