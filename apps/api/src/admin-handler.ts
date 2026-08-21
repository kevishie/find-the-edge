import {
  composeProductAccess,
  hasProductAccess,
  identityAuthorizationCapabilities,
  normalizePhoneNumber,
  phoneDigest,
  type AdminDirectoryEntry,
  type ManualAccessGrant,
} from "@find-the-edge/domain";
import {
  AdminAccessConflictError,
  type AdminAccessRepository,
  type EntitlementRepository,
  type IdentityAuthorizationRepository,
} from "@find-the-edge/database";

export type AdminHttpRoute =
  "admin-users-list" | "admin-access-grant" | "admin-access-revoke";

export interface AdminHttpRequest {
  readonly route: AdminHttpRoute;
  readonly method: "GET" | "POST" | "DELETE";
  readonly subject?: string;
  readonly adminAuthorized: boolean;
  readonly directoryId?: string;
  readonly idempotencyKey?: string;
  readonly contentType?: string;
  readonly body?: string;
  readonly query?: Readonly<Record<string, string | undefined>>;
}

const response = (statusCode: number, body: unknown) => ({
  statusCode,
  headers: { "content-type": "application/json", "cache-control": "no-store" },
  body: JSON.stringify(body),
});

const exactObject = (value: unknown, allowed: readonly string[]) =>
  !!value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).sort().join("|") === [...allowed].sort().join("|");

const mapBounded = async <Input, Output>(
  values: readonly Input[],
  concurrency: number,
  mapper: (value: Input) => Promise<Output>,
): Promise<Output[]> => {
  const output: Output[] = [];
  for (let offset = 0; offset < values.length; offset += concurrency)
    output.push(
      ...(await Promise.all(
        values.slice(offset, offset + concurrency).map(mapper),
      )),
    );
  return output;
};

export const createAdminHttpHandler = (
  adminAccess: AdminAccessRepository,
  entitlements: Pick<EntitlementRepository, "get">,
  authorization: Pick<IdentityAuthorizationRepository, "get">,
  accountPepper: string,
  now: () => Date = () => new Date(),
) => {
  const toDto = async (
    directory: AdminDirectoryEntry,
    manualGrant: ManualAccessGrant | null,
  ) => {
    const [stripeResult, authorizationResult] = await Promise.allSettled([
      directory.accountId
        ? entitlements.get(directory.accountId)
        : Promise.resolve(null),
      directory.accountId
        ? authorization.get(directory.accountId)
        : Promise.resolve(null),
    ]);
    if (authorizationResult.status === "rejected")
      throw new Error("admin-authorization-unavailable");
    const superAdmin = identityAuthorizationCapabilities(
      authorizationResult.value?.roles ?? [],
    ).includes("accounts/access:manage");
    const stripe =
      stripeResult.status === "rejected"
        ? "unavailable"
        : hasProductAccess(stripeResult.value, now().toISOString())
          ? "active"
          : "inactive";
    const composed = composeProductAccess({
      superAdmin,
      stripe,
      manual: manualGrant?.active === true,
    });
    return {
      schemaVersion: "admin-user-v1" as const,
      directoryId: directory.directoryId,
      accountId: directory.accountId,
      phoneHint: directory.phoneHint,
      displayReference: directory.displayReference,
      lifecycle: directory.lifecycle,
      createdAt: directory.createdAt,
      updatedAt: directory.updatedAt,
      manualGrant: {
        active: manualGrant?.active ?? false,
        version: manualGrant?.version ?? 0,
      },
      access: {
        superAdmin,
        stripe,
        effective: composed.outcome,
        sources: composed.sources,
      },
    };
  };

  return async (request: AdminHttpRequest) => {
    if (!request.subject) return response(401, { error: "unauthorized" });
    if (!request.adminAuthorized) return response(403, { error: "forbidden" });
    try {
      if (request.route === "admin-users-list") {
        if (request.method !== "GET" || request.body !== undefined)
          return response(400, { error: "invalid-request" });
        const query = request.query ?? {};
        if (
          Object.keys(query).some((key) => !["limit", "cursor"].includes(key))
        )
          return response(400, { error: "invalid-request" });
        const limitText = query["limit"] ?? "25";
        if (!/^(?:[1-9]|[1-9][0-9]|100)$/.test(limitText))
          return response(400, { error: "invalid-request" });
        const page = await adminAccess.list({
          limit: Number(limitText),
          ...(query["cursor"] ? { cursor: query["cursor"] } : {}),
        });
        return response(200, {
          schemaVersion: "admin-user-directory-page-v1",
          items: await mapBounded(
            page.items,
            10,
            ({ directory, manualGrant }) => toDto(directory, manualGrant),
          ),
          cursor: page.cursor,
        });
      }
      if (!request.idempotencyKey)
        return response(400, { error: "idempotency-key-required" });
      const at = now().toISOString();
      if (request.route === "admin-access-grant") {
        if (
          request.method !== "POST" ||
          request.contentType?.split(";", 1)[0]?.trim().toLowerCase() !==
            "application/json" ||
          !request.body
        )
          return response(400, { error: "invalid-request" });
        let body: unknown;
        try {
          body = JSON.parse(request.body);
        } catch {
          return response(400, { error: "invalid-request" });
        }
        let result;
        if (exactObject(body, ["phoneNumber"])) {
          const phoneNumber = normalizePhoneNumber(
            (body as { phoneNumber?: unknown }).phoneNumber,
          );
          result = await adminAccess.grant({
            phoneDigest: phoneDigest(phoneNumber, accountPepper),
            phoneNumber,
            now: at,
            operatorAccountId: request.subject,
            idempotencyKey: request.idempotencyKey,
          });
        } else if (exactObject(body, ["directoryId", "expectedVersion"])) {
          const value = body as {
            directoryId?: unknown;
            expectedVersion?: unknown;
          };
          if (
            typeof value.directoryId !== "string" ||
            !Number.isSafeInteger(value.expectedVersion) ||
            (value.expectedVersion as number) < 0
          )
            return response(400, { error: "invalid-request" });
          result = await adminAccess.grantExisting({
            directoryId: value.directoryId,
            expectedVersion: value.expectedVersion as number,
            now: at,
            operatorAccountId: request.subject,
            idempotencyKey: request.idempotencyKey,
          });
        } else return response(400, { error: "invalid-request" });
        return response(200, {
          schemaVersion: "admin-manual-access-result-v1",
          user: await toDto(result.directory, result.manualGrant),
        });
      }
      if (request.method !== "DELETE" || request.body !== undefined)
        return response(400, { error: "invalid-request" });
      const query = request.query ?? {};
      const versionText = query["version"] ?? "";
      const expectedVersion = Number(versionText);
      if (
        Object.keys(query).join("|") !== "version" ||
        !/^\d+$/.test(versionText) ||
        !Number.isSafeInteger(expectedVersion) ||
        expectedVersion < 1
      )
        return response(400, { error: "invalid-request" });
      const result = await adminAccess.revoke({
        directoryId: request.directoryId ?? "",
        expectedVersion,
        now: at,
        operatorAccountId: request.subject,
        idempotencyKey: request.idempotencyKey,
      });
      return response(200, {
        schemaVersion: "admin-manual-access-result-v1",
        user: await toDto(result.directory, result.manualGrant),
      });
    } catch (error) {
      if (error instanceof AdminAccessConflictError)
        return response(409, { error: "conflict" });
      if (
        error instanceof Error &&
        [
          "identity-phone-invalid",
          "admin-cursor-invalid",
          "admin-directory-id-invalid",
          "admin-idempotency-key-invalid",
        ].includes(error.message)
      )
        return response(400, { error: "invalid-request" });
      return response(500, { error: "admin-access-unavailable" });
    }
  };
};
