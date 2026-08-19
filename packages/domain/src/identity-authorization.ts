import { isAccountId } from "./identity.js";

export const IDENTITY_AUTHORIZATION_SCHEMA_VERSION =
  "identity-authorization-v1" as const;

/**
 * Elevated product roles are deliberately closed. Adding a role is a domain
 * and authorization-policy change, never an arbitrary string stored by an
 * operator or supplied by a client.
 */
export const IDENTITY_AUTHORIZATION_ROLES = [
  "retrospective-reviewer",
  "strategy-promoter",
  "super-admin",
] as const;

export type IdentityAuthorizationRole =
  (typeof IDENTITY_AUTHORIZATION_ROLES)[number];

export const IDENTITY_AUTHORIZATION_CAPABILITIES = [
  "events/retrospectives:approve",
  "events/strategies:promote",
  "accounts/access:manage",
] as const;

export type IdentityAuthorizationCapability =
  (typeof IDENTITY_AUTHORIZATION_CAPABILITIES)[number];

const CAPABILITY_BY_ROLE: Readonly<
  Record<IdentityAuthorizationRole, IdentityAuthorizationCapability>
> = Object.freeze({
  "retrospective-reviewer": "events/retrospectives:approve",
  "strategy-promoter": "events/strategies:promote",
  "super-admin": "accounts/access:manage",
});

const OPERATOR_ID = /^operator:[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;

export const isIdentityAuthorizationRole = (
  value: unknown,
): value is IdentityAuthorizationRole =>
  typeof value === "string" &&
  (IDENTITY_AUTHORIZATION_ROLES as readonly string[]).includes(value);

/**
 * An audit handle, not a name, phone number, or email address. The prefix
 * makes the field self-describing and the closed ASCII grammar keeps it safe
 * for logs while bounding the full value to 73 characters.
 */
export const isIdentityAuthorizationOperatorId = (
  value: unknown,
): value is string => typeof value === "string" && OPERATOR_ID.test(value);

const canonicalInstant = (value: unknown): string => {
  if (
    typeof value !== "string" ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  )
    throw new Error("identity-authorization-updated-at-invalid");
  return value;
};

const canonicalRoles = (
  value: unknown,
): readonly IdentityAuthorizationRole[] => {
  if (
    !Array.isArray(value) ||
    value.length > IDENTITY_AUTHORIZATION_ROLES.length
  )
    throw new Error("identity-authorization-roles-invalid");
  if (!value.every(isIdentityAuthorizationRole))
    throw new Error("identity-authorization-roles-invalid");
  const roles = value;
  if (new Set(roles).size !== roles.length)
    throw new Error("identity-authorization-roles-invalid");
  return Object.freeze(
    IDENTITY_AUTHORIZATION_ROLES.filter((role) => roles.includes(role)),
  );
};

/**
 * The only role-to-capability projection. API handlers consume full scope
 * names from here rather than translating roles or legacy group names.
 */
export const identityAuthorizationCapabilities = (
  roles: readonly IdentityAuthorizationRole[],
): readonly IdentityAuthorizationCapability[] =>
  Object.freeze(canonicalRoles(roles).map((role) => CAPABILITY_BY_ROLE[role]));

export interface IdentityAuthorization {
  readonly schemaVersion: typeof IDENTITY_AUTHORIZATION_SCHEMA_VERSION;
  readonly accountId: string;
  readonly roles: readonly IdentityAuthorizationRole[];
  readonly updatedAt: string;
  readonly operatorId: string;
}

export interface IdentityAuthorizationInput {
  readonly accountId: string;
  readonly roles: readonly unknown[];
  readonly updatedAt: string;
  readonly operatorId: string;
}

const IDENTITY_AUTHORIZATION_KEYS = Object.freeze([
  "accountId",
  "operatorId",
  "roles",
  "schemaVersion",
  "updatedAt",
]);

export function createIdentityAuthorization(
  input: IdentityAuthorizationInput,
): IdentityAuthorization {
  if (!isAccountId(input.accountId))
    throw new Error("identity-authorization-account-id-invalid");
  if (!isIdentityAuthorizationOperatorId(input.operatorId))
    throw new Error("identity-authorization-operator-id-invalid");
  return Object.freeze({
    schemaVersion: IDENTITY_AUTHORIZATION_SCHEMA_VERSION,
    accountId: input.accountId,
    roles: canonicalRoles(input.roles),
    updatedAt: canonicalInstant(input.updatedAt),
    operatorId: input.operatorId,
  });
}

/** Stored authorization is always rebuilt through the domain constructor. */
export function normalizeIdentityAuthorization(
  stored: unknown,
): IdentityAuthorization {
  if (
    !stored ||
    typeof stored !== "object" ||
    Array.isArray(stored) ||
    (stored as { schemaVersion?: unknown }).schemaVersion !==
      IDENTITY_AUTHORIZATION_SCHEMA_VERSION
  )
    throw new Error("stored-identity-authorization-invalid");
  const keys = Object.keys(stored).sort();
  if (
    keys.length !== IDENTITY_AUTHORIZATION_KEYS.length ||
    !keys.every((key, index) => key === IDENTITY_AUTHORIZATION_KEYS[index])
  )
    throw new Error("stored-identity-authorization-invalid");
  const value = stored as Partial<IdentityAuthorization>;
  try {
    const normalized = createIdentityAuthorization({
      accountId: value.accountId ?? "",
      roles: value.roles ?? [],
      updatedAt: value.updatedAt ?? "",
      operatorId: value.operatorId ?? "",
    });
    // Operator input is canonicalized by the constructor, but stored
    // authority must already be canonical. Silently repairing a malformed
    // role order would turn invalid storage into trusted capabilities.
    if (
      !Array.isArray(value.roles) ||
      value.roles.length !== normalized.roles.length ||
      value.roles.some((role, index) => role !== normalized.roles[index])
    )
      throw new Error("stored-identity-authorization-roles-noncanonical");
    return normalized;
  } catch {
    throw new Error("stored-identity-authorization-invalid");
  }
}
