import { describe, expect, it, vi } from "vitest";
import {
  createIdentityAuthorization,
  createIdentityAccount,
  createSessionToken,
  type SessionKeyRing,
  type SessionSigningKey,
} from "@find-the-edge/domain";
import type {
  IdentityAuthorizationRepository,
  IdentityRepository,
} from "@find-the-edge/database";
import {
  MemoryScoutingJobRepository,
  MemoryScoutingReportRepository,
  MemoryWatchlistRepository,
  type EventRepository,
} from "@find-the-edge/database";
import {
  authorizationContextFromLambdaRequest,
  authorizationContextFromGateway,
  handlerAuthorizationFields,
  isOwnedSessionAuthorization,
  memoizeIdentityAccountLookup,
  ORDINARY_OWNED_ROUTE_KEYS,
  OWNED_SESSION_SCOPES,
  resolveOwnedSessionAuthorization,
} from "./authorization-context";
import { withEventApiLambdaBoundary } from "./lambda-boundary";
import { createEventHandler } from "./handler";
import { createScoutingHttpHandler } from "./scouting-handler";

const NOW = new Date("2026-08-13T21:00:00.000Z");
const ACCOUNT_ID = `account:${"ab12cd34".repeat(8)}`;
const CURRENT_KEY: SessionSigningKey = {
  keyId: "current",
  secret: "0123456789abcdef0123456789abcdef0123456789abcdef",
};
const RING: SessionKeyRing = { current: CURRENT_KEY };
const ACCOUNT = createIdentityAccount({
  accountId: ACCOUNT_ID,
  tokenVersion: 3,
  createdAt: "2026-08-01T00:00:00.000Z",
  lastSignedInAt: NOW.toISOString(),
});

const session = (
  input: {
    readonly key?: SessionSigningKey;
    readonly tokenVersion?: number;
    readonly now?: string;
    readonly ttlMs?: number;
  } = {},
) =>
  createSessionToken({
    accountId: ACCOUNT_ID,
    tokenVersion: input.tokenVersion ?? ACCOUNT.tokenVersion,
    now: input.now ?? NOW.toISOString(),
    key: input.key ?? CURRENT_KEY,
    ...(input.ttlMs === undefined ? {} : { ttlMs: input.ttlMs }),
  }).token;

const identityOf = (
  account: Awaited<ReturnType<IdentityRepository["getAccount"]>>,
): Pick<IdentityRepository, "getAccount"> => ({
  getAccount: vi.fn().mockResolvedValue(account),
});

const resolve = (
  authorization: string,
  identity: Pick<IdentityRepository, "getAccount"> = identityOf(ACCOUNT),
  signingKeys: SessionKeyRing = RING,
  elevated: {
    readonly include?: boolean;
    readonly repository?: Pick<IdentityAuthorizationRepository, "get">;
  } = {},
) =>
  resolveOwnedSessionAuthorization({
    authorization,
    signingKeys,
    identity,
    ...(elevated.include
      ? { includeElevatedAuthorization: true as const }
      : {}),
    ...(elevated.repository
      ? { identityAuthorization: elevated.repository }
      : {}),
    now: NOW,
  });

describe("Lambda request authorization adapter", () => {
  const adapter = (
    routeKey: (typeof ORDINARY_OWNED_ROUTE_KEYS)[number],
    authorization: string | undefined,
    identity: Pick<IdentityRepository, "getAccount">,
  ) =>
    authorizationContextFromLambdaRequest({
      routeKey,
      ...(authorization ? { headers: { AUTHORIZATION: authorization } } : {}),
      // A stale synthetic gateway context must never authorize a detached
      // ordinary route.
      gatewayJwt: {
        claims: { sub: "legacy-cognito-user" },
        scopes: ["events/events:read"],
      },
      productRoute: true,
      capabilitiesRoute: false,
      includeElevatedAuthorization: false,
      ownedRuntime: { signingKeys: RING, identity, now: NOW },
    });

  it.each(ORDINARY_OWNED_ROUTE_KEYS)(
    "projects raw owned authority into the handler input for %s",
    async (routeKey) => {
      const identity = identityOf(ACCOUNT);
      const context = await adapter(routeKey, `Bearer ${session()}`, identity);
      expect(handlerAuthorizationFields(context)).toEqual({
        subject: ACCOUNT_ID,
        scopes: OWNED_SESSION_SCOPES,
        reviewerAuthorized: false,
        strategyPromoterAuthorized: false,
      });
      expect(identity.getAccount).toHaveBeenCalledOnce();
    },
  );

  const otherAccountId = `account:${"cd34ef56".repeat(8)}`;
  const foreignAccountToken = createSessionToken({
    accountId: otherAccountId,
    tokenVersion: 1,
    now: NOW.toISOString(),
    key: CURRENT_KEY,
  }).token;

  const invokeActualProtectedHandler = async (
    routeKey: (typeof ORDINARY_OWNED_ROUTE_KEYS)[number],
    fields: ReturnType<typeof handlerAuthorizationFields>,
  ) => {
    const listEvents = vi.fn(() =>
      Promise.resolve({
        items: [],
        nextCursor: null,
        projectionState: "ready" as const,
        evaluationState: "complete" as const,
        hasMoreUnknown: false,
        snapshotAt: NOW.toISOString(),
        freshness: null,
        unavailableReason: null,
      }),
    );
    const detailEvent = vi.fn(() =>
      Promise.resolve({
        projectionState: "ready" as const,
        item: null,
        unavailableReason: null,
      }),
    );
    const events: EventRepository = {
      list: listEvents,
      detail: detailEvent,
    };
    const calls: ReturnType<typeof vi.fn>[] = [listEvents, detailEvent];
    if (routeKey === "GET /events") {
      const log: (entry: Readonly<Record<string, unknown>>) => void = () =>
        undefined;
      const response = await createEventHandler(
        events,
        log,
      )({
        route: "list",
        method: "GET",
        ...fields,
      });
      return { response, calls };
    }
    if (
      routeKey === "POST /events/{eventId}/scout" ||
      routeKey === "GET /scout-jobs/{jobId}" ||
      routeKey === "POST /scout-jobs/{jobId}/retry"
    ) {
      const jobs = new MemoryScoutingJobRepository();
      calls.push(
        vi.spyOn(jobs, "getCreateReplay"),
        vi.spyOn(jobs, "createJob"),
        vi.spyOn(jobs, "getJobForRequester"),
        vi.spyOn(jobs, "retryJob"),
      );
      const request =
        routeKey === "POST /events/{eventId}/scout"
          ? {
              route: "scout-create" as const,
              method: "POST" as const,
              eventId: "event:mlb:fixture-1",
              idempotencyKey: "request-1",
              contentType: "application/json",
              body: "{}",
            }
          : routeKey === "GET /scout-jobs/{jobId}"
            ? {
                route: "scout-status" as const,
                method: "GET" as const,
                jobId: `scout-job:${"a".repeat(64)}`,
              }
            : {
                route: "scout-retry" as const,
                method: "POST" as const,
                jobId: `scout-job:${"a".repeat(64)}`,
                idempotencyKey: "request-1",
                contentType: "application/json",
                body: JSON.stringify({ expectedStateVersion: 1 }),
              };
      const response = await createScoutingHttpHandler(
        events,
        jobs,
      )({
        ...request,
        ...fields,
      });
      return { response, calls };
    }
    if (routeKey.startsWith("GET /scout-")) {
      const reports = new MemoryScoutingReportRepository();
      calls.push(
        vi.spyOn(reports, "getByJobBinding"),
        vi.spyOn(reports, "getHead"),
        vi.spyOn(reports, "getVersion"),
        vi.spyOn(reports, "listVersions"),
      );
      const handler = createEventHandler(
        events,
        undefined,
        vi.fn(),
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        reports,
      );
      const request =
        routeKey === "GET /scout-jobs/{jobId}/report"
          ? {
              route: "scout-report-by-job" as const,
              method: "GET" as const,
              jobId: `scout-job:${"a".repeat(64)}`,
            }
          : routeKey === "GET /scout-reports/{reportId}/versions"
            ? {
                route: "scout-report-versions" as const,
                method: "GET" as const,
                reportId: `scout-report:${"b".repeat(64)}`,
              }
            : {
                route: "scout-report-version" as const,
                method: "GET" as const,
                reportId: `scout-report:${"b".repeat(64)}`,
                versionNumber: "1",
              };
      const response = await handler({ ...request, ...fields });
      return { response, calls };
    }
    const watchlist = new MemoryWatchlistRepository();
    calls.push(
      vi.spyOn(watchlist, "list"),
      vi.spyOn(watchlist, "add"),
      vi.spyOn(watchlist, "remove"),
    );
    const handler = createEventHandler(
      events,
      undefined,
      vi.fn(),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      watchlist,
    );
    const request =
      routeKey === "GET /watchlist"
        ? { route: "watchlist-list" as const, method: "GET" as const }
        : routeKey === "POST /watchlist"
          ? {
              route: "watchlist-add" as const,
              method: "POST" as const,
              contentType: "application/json",
              body: JSON.stringify({ eventId: "event:mlb:fixture-1" }),
            }
          : {
              route: "watchlist-remove" as const,
              method: "DELETE" as const,
              eventId: "event:mlb:fixture-1",
            };
    const response = await handler({ ...request, ...fields });
    return { response, calls };
  };
  const invalidRequests = [
    {
      label: "absent",
      authorization: undefined,
      account: ACCOUNT,
      identityRead: false,
    },
    {
      label: "malformed",
      authorization: "Bearer fte1.invalid",
      account: ACCOUNT,
      identityRead: false,
    },
    {
      label: "revoked",
      authorization: `Bearer ${session({ tokenVersion: 2 })}`,
      account: ACCOUNT,
      identityRead: true,
    },
    {
      label: "foreign",
      authorization: `Bearer ${foreignAccountToken}`,
      account: null,
      identityRead: true,
    },
  ] as const;

  it.each(
    ORDINARY_OWNED_ROUTE_KEYS.flatMap((routeKey) =>
      invalidRequests.map((request) => ({ routeKey, ...request })),
    ),
  )(
    "keeps $label authority out of $routeKey handler and protected storage",
    async ({ routeKey, authorization, account, identityRead }) => {
      const identity = identityOf(account);
      const context = await adapter(routeKey, authorization, identity);
      const handlerInput = handlerAuthorizationFields(context);
      expect(handlerInput).toEqual({
        reviewerAuthorized: false,
        strategyPromoterAuthorized: false,
      });
      const { response, calls } = await invokeActualProtectedHandler(
        routeKey,
        handlerInput,
      );
      expect(response.statusCode).toBe(401);
      for (const repositoryCall of calls)
        expect(repositoryCall).not.toHaveBeenCalled();
      expect(identity.getAccount).toHaveBeenCalledTimes(identityRead ? 1 : 0);
    },
  );
});

describe("owned session authorization", () => {
  it("projects a live stored account into ordinary product permissions", async () => {
    const identity = identityOf(ACCOUNT);
    await expect(resolve(`Bearer ${session()}`, identity)).resolves.toEqual({
      subject: ACCOUNT_ID,
      scopes: OWNED_SESSION_SCOPES,
      reviewerAuthorized: false,
      strategyPromoterAuthorized: false,
    });
    expect(identity.getAccount).toHaveBeenCalledWith(ACCOUNT_ID);
    expect(OWNED_SESSION_SCOPES).toEqual([
      "events/events:read",
      "events/scouting:read",
      "events/scouting:write",
    ]);
    expect(OWNED_SESSION_SCOPES).not.toContain("events/retrospectives:approve");
    expect(OWNED_SESSION_SCOPES).not.toContain("events/strategies:promote");
  });

  it("rejects malformed, tampered, expired, and foreign-key tokens before storage", async () => {
    const foreignKey: SessionSigningKey = {
      keyId: "foreign",
      secret: "abcdef0123456789abcdef0123456789abcdef0123456789",
    };
    const expired = session({
      now: new Date(NOW.getTime() - 60_000).toISOString(),
      ttlMs: 60_000,
    });
    for (const authorization of [
      "Bearer fte1.not-a-token",
      `Bearer ${session()}x`,
      `Bearer ${expired}`,
      `Bearer ${session({ key: foreignKey })}`,
      `Bearer ${session()} trailing-data`,
      `Bearer fte1.${"x".repeat(1100)}`,
    ]) {
      const identity = identityOf(ACCOUNT);
      await expect(resolve(authorization, identity)).resolves.toBeNull();
      expect(identity.getAccount).not.toHaveBeenCalled();
    }
  });

  it("rejects a missing account and a stale revocation version", async () => {
    await expect(
      resolve(`Bearer ${session()}`, identityOf(null)),
    ).resolves.toBe(null);
    await expect(
      resolve(`Bearer ${session({ tokenVersion: 2 })}`, identityOf(ACCOUNT)),
    ).resolves.toBeNull();
  });

  it("never reads roles for an invalid or revoked owned session", async () => {
    const get = vi.fn();
    await expect(
      resolve("Bearer fte1.invalid", identityOf(ACCOUNT), RING, {
        include: true,
        repository: { get },
      }),
    ).resolves.toBeNull();
    await expect(
      resolve(
        `Bearer ${session({ tokenVersion: ACCOUNT.tokenVersion - 1 })}`,
        identityOf(ACCOUNT),
        RING,
        { include: true, repository: { get } },
      ),
    ).resolves.toBeNull();
    expect(get).not.toHaveBeenCalled();
  });

  it("rejects a mismatched stored account id", async () => {
    const other = createIdentityAccount({
      accountId: `account:${"cd34ef56".repeat(8)}`,
      tokenVersion: ACCOUNT.tokenVersion,
      createdAt: ACCOUNT.createdAt,
      lastSignedInAt: ACCOUNT.lastSignedInAt,
    });
    await expect(
      resolve(`Bearer ${session()}`, identityOf(other)),
    ).resolves.toBeNull();
  });

  it("propagates account storage failures without exposing credentials", async () => {
    const token = session();
    const outage = new Error(`failed ${ACCOUNT_ID} ${token}`);
    const identity: Pick<IdentityRepository, "getAccount"> = {
      getAccount: vi.fn().mockRejectedValue(outage),
    };
    const failure = await resolve(`Bearer ${token}`, identity).catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe(
      "owned-session-authorization-unavailable",
    );
    expect((failure as Error).message).not.toContain(ACCOUNT_ID);
    expect((failure as Error).message).not.toContain(token);
    expect((failure as Error & { cause?: unknown }).cause).toBeUndefined();
  });

  it("accepts case-insensitive bearer schemes consistently", async () => {
    for (const scheme of ["bearer", "BEARER", "BeArEr"])
      await expect(resolve(`${scheme} ${session()}`)).resolves.toMatchObject({
        subject: ACCOUNT_ID,
      });
  });

  it("memoizes the account authority only within one request wrapper", async () => {
    const identity = identityOf(ACCOUNT);
    const requestIdentity = memoizeIdentityAccountLookup(identity);
    await expect(
      Promise.all([
        resolve(`Bearer ${session()}`, requestIdentity),
        resolve(`Bearer ${session()}`, requestIdentity),
      ]),
    ).resolves.toHaveLength(2);
    expect(identity.getAccount).toHaveBeenCalledTimes(1);
  });

  it("does not read elevated authority for an ordinary product route", async () => {
    const get = vi.fn();
    await expect(
      resolve(`Bearer ${session()}`, identityOf(ACCOUNT), RING, {
        repository: { get },
      }),
    ).resolves.toMatchObject({
      scopes: OWNED_SESSION_SCOPES,
      reviewerAuthorized: false,
      strategyPromoterAuthorized: false,
    });
    expect(get).not.toHaveBeenCalled();
  });

  it("defaults a missing server-owned authorization row to no elevated capability", async () => {
    const get = vi.fn().mockResolvedValue(null);
    await expect(
      resolve(`Bearer ${session()}`, identityOf(ACCOUNT), RING, {
        include: true,
        repository: { get },
      }),
    ).resolves.toEqual({
      subject: ACCOUNT_ID,
      scopes: OWNED_SESSION_SCOPES,
      reviewerAuthorized: false,
      strategyPromoterAuthorized: false,
    });
    expect(get).toHaveBeenCalledWith(ACCOUNT_ID);
  });

  it("projects canonical full capabilities from server-owned roles", async () => {
    const record = createIdentityAuthorization({
      accountId: ACCOUNT_ID,
      // Deliberately reverse input order: the domain owns canonical order.
      roles: ["strategy-promoter", "retrospective-reviewer"],
      updatedAt: NOW.toISOString(),
      operatorId: "operator:release",
    });
    await expect(
      resolve(`Bearer ${session()}`, identityOf(ACCOUNT), RING, {
        include: true,
        repository: { get: vi.fn().mockResolvedValue(record) },
      }),
    ).resolves.toEqual({
      subject: ACCOUNT_ID,
      scopes: [
        ...OWNED_SESSION_SCOPES,
        "events/retrospectives:approve",
        "events/strategies:promote",
      ],
      reviewerAuthorized: true,
      strategyPromoterAuthorized: true,
    });
  });

  it("sanitizes missing, failed, mismatched, and malformed elevated authority", async () => {
    await expect(
      resolve(`Bearer ${session()}`, identityOf(ACCOUNT), RING, {
        include: true,
      }),
    ).rejects.toThrow("owned-session-authorization-unavailable");
    const cases: readonly Pick<IdentityAuthorizationRepository, "get">[] = [
      { get: vi.fn().mockRejectedValue(new Error(`failed ${ACCOUNT_ID}`)) },
      {
        get: vi.fn().mockResolvedValue({
          ...createIdentityAuthorization({
            accountId: ACCOUNT_ID,
            roles: [],
            updatedAt: NOW.toISOString(),
            operatorId: "operator:release",
          }),
          accountId: `account:${"ef90ab12".repeat(8)}`,
        }),
      },
      {
        get: vi.fn().mockResolvedValue({
          accountId: ACCOUNT_ID,
          roles: ["client-supplied-admin"],
        }),
      },
    ];
    for (const repository of cases) {
      const failure = await resolve(
        `Bearer ${session()}`,
        identityOf(ACCOUNT),
        RING,
        { include: true, repository },
      ).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toBe(
        "owned-session-authorization-unavailable",
      );
      expect((failure as Error).message).not.toContain(ACCOUNT_ID);
      expect((failure as Error & { cause?: unknown }).cause).toBeUndefined();
    }
  });

  it("maps an unreadable elevated record to the safe no-store adapter response", async () => {
    const token = session();
    const log = vi.fn();
    const result = await withEventApiLambdaBoundary(async () => {
      await resolve(`Bearer ${token}`, identityOf(ACCOUNT), RING, {
        include: true,
        repository: {
          get: vi
            .fn()
            .mockRejectedValue(new Error(`storage ${ACCOUNT_ID} ${token}`)),
        },
      });
      throw new Error("unreachable");
    }, log);
    expect(result).toEqual({
      statusCode: 500,
      headers: {
        "content-type": "application/json",
        "cache-control": "no-store",
      },
      body: JSON.stringify({ error: "internal-error" }),
    });
    expect(JSON.stringify(log.mock.calls)).not.toContain(ACCOUNT_ID);
    expect(JSON.stringify(log.mock.calls)).not.toContain(token);
  });

  it("classifies malformed fte1 credentials so they fail closed", () => {
    for (const authorization of [
      "Bearer fte1",
      "Bearer fte1.bad",
      " bearer   fte1.bad trailing ",
    ])
      expect(isOwnedSessionAuthorization(authorization)).toBe(true);
    expect(isOwnedSessionAuthorization("Bearer cognito.jwt.token")).toBe(false);
    expect(isOwnedSessionAuthorization(undefined)).toBe(false);
  });
});

describe("legacy gateway authorization", () => {
  it("preserves authorizer scopes and string-group permissions", () => {
    const scopes = ["events/events:read", "events/retrospectives:approve"];
    expect(
      authorizationContextFromGateway({
        scopes,
        claims: {
          sub: "cognito-user",
          scope: "ignored:because-authorizer-scopes-win",
          "cognito:groups":
            "fte-retrospective-reviewers,fte-strategy-promoters",
        },
      }),
    ).toEqual({
      subject: "cognito-user",
      scopes,
      reviewerAuthorized: true,
      strategyPromoterAuthorized: true,
    });
  });

  it("preserves claim-scope fallback and array-group permissions", () => {
    expect(
      authorizationContextFromGateway({
        claims: {
          sub: "cognito-user",
          scope: "events/events:read events/scouting:read",
          "cognito:groups": ["fte-retrospective-reviewers"],
        },
      }),
    ).toEqual({
      subject: "cognito-user",
      scopes: ["events/events:read", "events/scouting:read"],
      reviewerAuthorized: true,
      strategyPromoterAuthorized: false,
    });
  });

  it("defaults missing legacy authorization to no privileges", () => {
    expect(authorizationContextFromGateway(undefined)).toEqual({
      reviewerAuthorized: false,
      strategyPromoterAuthorized: false,
    });
  });
});
