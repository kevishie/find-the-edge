import { isAccountId } from "./identity.js";

export const ADMIN_DIRECTORY_SCHEMA_VERSION = "admin-directory-v1" as const;
export const MANUAL_ACCESS_GRANT_SCHEMA_VERSION =
  "manual-access-grant-v1" as const;
export const ADMIN_ACCESS_AUDIT_SCHEMA_VERSION =
  "admin-access-audit-v1" as const;
export const OWNER_BOOTSTRAP_SCHEMA_VERSION = "owner-bootstrap-v1" as const;

const DIRECTORY_ID = /^directory:[a-f0-9]{32}$/;
const DIGEST = /^[a-f0-9]{32}$/;
const HINT = /^\*\*[0-9]{2}$/;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const OPERATOR_ID = /^operator:[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;

export interface OwnerBootstrap {
  readonly schemaVersion: typeof OWNER_BOOTSTRAP_SCHEMA_VERSION;
  readonly accountId: string;
  readonly directoryId: string;
  readonly auditKey: string;
  readonly createdAt: string;
}

const OWNER_AUDIT_KEY =
  /^ADMIN_AUDIT#owner-(?:bootstrap|migrate|recover)(?:#[a-f0-9]{64})?$/;

export function createOwnerBootstrap(input: {
  readonly accountId: string;
  readonly directoryId: string;
  readonly auditKey: string;
  readonly createdAt: string;
}): OwnerBootstrap {
  if (!isAccountId(input.accountId))
    throw new Error("owner-bootstrap-account-invalid");
  if (!isAdminDirectoryId(input.directoryId))
    throw new Error("owner-bootstrap-directory-invalid");
  if (!OWNER_AUDIT_KEY.test(input.auditKey))
    throw new Error("owner-bootstrap-audit-key-invalid");
  return Object.freeze({
    schemaVersion: OWNER_BOOTSTRAP_SCHEMA_VERSION,
    accountId: input.accountId,
    directoryId: input.directoryId,
    auditKey: input.auditKey,
    createdAt: instant(input.createdAt, "owner-bootstrap-created-at-invalid"),
  });
}

export function normalizeOwnerBootstrap(stored: unknown): OwnerBootstrap {
  if (
    !stored ||
    typeof stored !== "object" ||
    Array.isArray(stored) ||
    Object.keys(stored).sort().join("|") !==
      "accountId|auditKey|createdAt|directoryId|schemaVersion"
  )
    throw new Error("stored-owner-bootstrap-invalid");
  const value = stored as Partial<OwnerBootstrap>;
  try {
    const normalized = createOwnerBootstrap({
      accountId: value.accountId ?? "",
      directoryId: value.directoryId ?? "",
      auditKey: value.auditKey ?? "",
      createdAt: value.createdAt ?? "",
    });
    if (value.schemaVersion !== normalized.schemaVersion) throw new Error();
    return normalized;
  } catch {
    throw new Error("stored-owner-bootstrap-invalid");
  }
}

export const ADMIN_AUDIT_ACTIONS = [
  "owner-bootstrap",
  "owner-migrate",
  "owner-recover",
  "login-reconciled",
  "manual-grant",
  "manual-revoke",
] as const;
export type AdminAuditAction = (typeof ADMIN_AUDIT_ACTIONS)[number];
export type AdminAuditActor = "system" | `operator:${string}`;

export interface AdminAuditEvent {
  readonly schemaVersion: typeof ADMIN_ACCESS_AUDIT_SCHEMA_VERSION;
  readonly action: AdminAuditAction;
  readonly actor: AdminAuditActor;
  readonly directoryId: string;
  readonly grantVersion: number | null;
  readonly occurredAt: string;
}

export function createAdminAuditEvent(input: {
  readonly action: AdminAuditAction;
  readonly actor: AdminAuditActor;
  readonly directoryId: string;
  readonly grantVersion?: number | null;
  readonly occurredAt: string;
}): AdminAuditEvent {
  if (!ADMIN_AUDIT_ACTIONS.includes(input.action))
    throw new Error("admin-audit-action-invalid");
  if (!isAdminDirectoryId(input.directoryId))
    throw new Error("admin-audit-directory-invalid");
  const manual = input.action.startsWith("manual-");
  if (
    (manual && !OPERATOR_ID.test(input.actor)) ||
    (!manual && input.actor !== "system")
  )
    throw new Error("admin-audit-actor-invalid");
  const grantVersion = input.grantVersion ?? null;
  if (
    (manual &&
      (!Number.isSafeInteger(grantVersion) || Number(grantVersion) < 1)) ||
    (!manual && grantVersion !== null)
  )
    throw new Error("admin-audit-version-invalid");
  return Object.freeze({
    schemaVersion: ADMIN_ACCESS_AUDIT_SCHEMA_VERSION,
    action: input.action,
    actor: input.actor,
    directoryId: input.directoryId,
    grantVersion,
    occurredAt: instant(input.occurredAt, "admin-audit-occurred-at-invalid"),
  });
}

export function normalizeAdminAuditEvent(stored: unknown): AdminAuditEvent {
  if (
    !stored ||
    typeof stored !== "object" ||
    Array.isArray(stored) ||
    Object.keys(stored).sort().join("|") !==
      "action|actor|directoryId|grantVersion|occurredAt|schemaVersion"
  )
    throw new Error("stored-admin-audit-invalid");
  const value = stored as Partial<AdminAuditEvent>;
  try {
    const normalized = createAdminAuditEvent({
      action: value.action as AdminAuditAction,
      actor: (value.actor ?? "") as AdminAuditActor,
      directoryId: value.directoryId ?? "",
      ...(value.grantVersion === undefined
        ? {}
        : { grantVersion: value.grantVersion }),
      occurredAt: value.occurredAt ?? "",
    });
    if (value.schemaVersion !== normalized.schemaVersion) throw new Error();
    return normalized;
  } catch {
    throw new Error("stored-admin-audit-invalid");
  }
}

const instant = (value: unknown, code: string): string => {
  if (
    typeof value !== "string" ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  )
    throw new Error(code);
  return value;
};

export const adminDirectoryId = (phoneDigest: string): string => {
  if (!DIGEST.test(phoneDigest)) throw new Error("admin-phone-digest-invalid");
  return `directory:${phoneDigest}`;
};

export const isAdminDirectoryId = (value: unknown): value is string =>
  typeof value === "string" && DIRECTORY_ID.test(value);

export const isAdminAccessIdempotencyKey = (value: unknown): value is string =>
  typeof value === "string" && IDEMPOTENCY_KEY.test(value);

export interface AdminDirectoryEntry {
  readonly schemaVersion: typeof ADMIN_DIRECTORY_SCHEMA_VERSION;
  readonly directoryId: string;
  readonly phoneDigest: string;
  readonly phoneHint: string;
  readonly displayReference: string;
  readonly lifecycle: "pending" | "active";
  readonly accountId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export function createAdminDirectoryEntry(input: {
  readonly phoneDigest: string;
  readonly phoneHint: string;
  readonly accountId?: string | null;
  readonly createdAt: string;
  readonly updatedAt?: string;
}): AdminDirectoryEntry {
  const directoryId = adminDirectoryId(input.phoneDigest);
  if (!HINT.test(input.phoneHint)) throw new Error("admin-phone-hint-invalid");
  const createdAt = instant(input.createdAt, "admin-created-at-invalid");
  const updatedAt = instant(
    input.updatedAt ?? input.createdAt,
    "admin-updated-at-invalid",
  );
  if (Date.parse(updatedAt) < Date.parse(createdAt))
    throw new Error("admin-updated-at-invalid");
  const accountId = input.accountId ?? null;
  if (accountId !== null && !isAccountId(accountId))
    throw new Error("admin-account-id-invalid");
  return Object.freeze({
    schemaVersion: ADMIN_DIRECTORY_SCHEMA_VERSION,
    directoryId,
    phoneDigest: input.phoneDigest,
    phoneHint: input.phoneHint,
    displayReference: `User ${input.phoneDigest.slice(0, 6)} · ${input.phoneHint}`,
    lifecycle: accountId === null ? "pending" : "active",
    accountId,
    createdAt,
    updatedAt,
  });
}

export function normalizeAdminDirectoryEntry(
  stored: unknown,
): AdminDirectoryEntry {
  if (!stored || typeof stored !== "object" || Array.isArray(stored))
    throw new Error("stored-admin-directory-invalid");
  const value = stored as Partial<AdminDirectoryEntry>;
  const keys = Object.keys(stored).sort().join("|");
  if (
    keys !==
    "accountId|createdAt|directoryId|displayReference|lifecycle|phoneDigest|phoneHint|schemaVersion|updatedAt"
  )
    throw new Error("stored-admin-directory-invalid");
  try {
    const result = createAdminDirectoryEntry({
      phoneDigest: value.phoneDigest ?? "",
      phoneHint: value.phoneHint ?? "",
      accountId: value.accountId ?? null,
      createdAt: value.createdAt ?? "",
      updatedAt: value.updatedAt ?? "",
    });
    if (
      value.schemaVersion !== result.schemaVersion ||
      value.directoryId !== result.directoryId ||
      value.displayReference !== result.displayReference ||
      value.lifecycle !== result.lifecycle
    )
      throw new Error("stored-admin-directory-invalid");
    return result;
  } catch {
    throw new Error("stored-admin-directory-invalid");
  }
}

export interface ManualAccessGrant {
  readonly schemaVersion: typeof MANUAL_ACCESS_GRANT_SCHEMA_VERSION;
  readonly directoryId: string;
  readonly active: boolean;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly operatorId: string;
}

export function createManualAccessGrant(input: {
  readonly directoryId: string;
  readonly active: boolean;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt?: string;
  readonly operatorId: string;
}): ManualAccessGrant {
  if (!isAdminDirectoryId(input.directoryId))
    throw new Error("manual-access-directory-id-invalid");
  if (typeof input.active !== "boolean")
    throw new Error("manual-access-active-invalid");
  if (!Number.isSafeInteger(input.version) || input.version < 1)
    throw new Error("manual-access-version-invalid");
  if (!OPERATOR_ID.test(input.operatorId))
    throw new Error("manual-access-operator-invalid");
  const createdAt = instant(
    input.createdAt,
    "manual-access-created-at-invalid",
  );
  const updatedAt = instant(
    input.updatedAt ?? input.createdAt,
    "manual-access-updated-at-invalid",
  );
  if (Date.parse(updatedAt) < Date.parse(createdAt))
    throw new Error("manual-access-updated-at-invalid");
  return Object.freeze({
    schemaVersion: MANUAL_ACCESS_GRANT_SCHEMA_VERSION,
    directoryId: input.directoryId,
    active: input.active,
    version: input.version,
    createdAt,
    updatedAt,
    operatorId: input.operatorId,
  });
}

export function normalizeManualAccessGrant(stored: unknown): ManualAccessGrant {
  if (!stored || typeof stored !== "object" || Array.isArray(stored))
    throw new Error("stored-manual-access-invalid");
  const value = stored as Partial<ManualAccessGrant>;
  if (
    Object.keys(stored).sort().join("|") !==
    "active|createdAt|directoryId|operatorId|schemaVersion|updatedAt|version"
  )
    throw new Error("stored-manual-access-invalid");
  try {
    const result = createManualAccessGrant({
      directoryId: value.directoryId ?? "",
      active: value.active ?? false,
      version: value.version ?? 0,
      createdAt: value.createdAt ?? "",
      updatedAt: value.updatedAt ?? "",
      operatorId: value.operatorId ?? "",
    });
    if (value.schemaVersion !== result.schemaVersion)
      throw new Error("stored-manual-access-invalid");
    return result;
  } catch {
    throw new Error("stored-manual-access-invalid");
  }
}

export const PRODUCT_ACCESS_SOURCES = [
  "super_admin",
  "stripe",
  "manual",
] as const;
export type ProductAccessSource = (typeof PRODUCT_ACCESS_SOURCES)[number];
export type AccessSourceState = "active" | "inactive" | "unavailable";

export interface ComposedProductAccess {
  readonly outcome: "granted" | "denied" | "unavailable";
  readonly sources: readonly ProductAccessSource[];
  readonly superAdmin: boolean;
  readonly stripe: AccessSourceState;
  readonly manual: boolean;
}

export function composeProductAccess(input: {
  readonly superAdmin: boolean;
  readonly stripe: AccessSourceState;
  readonly manual: boolean;
}): ComposedProductAccess {
  const sources = PRODUCT_ACCESS_SOURCES.filter((source) =>
    source === "super_admin"
      ? input.superAdmin
      : source === "stripe"
        ? input.stripe === "active"
        : input.manual,
  );
  return Object.freeze({
    outcome:
      sources.length > 0
        ? "granted"
        : input.stripe === "unavailable"
          ? "unavailable"
          : "denied",
    sources: Object.freeze(sources),
    superAdmin: input.superAdmin,
    stripe: input.stripe,
    manual: input.manual,
  });
}
