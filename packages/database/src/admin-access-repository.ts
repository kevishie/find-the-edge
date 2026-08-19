import { createHash } from "node:crypto";
import {
  BatchGetCommand,
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  type DynamoDBDocumentClient,
} from "@aws-sdk/lib-dynamodb";
import {
  adminDirectoryId,
  createAdminAuditEvent,
  createAdminDirectoryEntry,
  createIdentityAccount,
  createIdentityAuthorization,
  createManualAccessGrant,
  createOwnerBootstrap,
  isAccountId,
  isAdminAccessIdempotencyKey,
  isAdminDirectoryId,
  normalizeAdminDirectoryEntry,
  normalizeAdminAuditEvent,
  normalizeIdentityAccount,
  normalizeIdentityAuthorization,
  normalizeManualAccessGrant,
  normalizeOwnerBootstrap,
  phoneSuffixHint,
  type AdminDirectoryEntry,
  type IdentityAccount,
  type ManualAccessGrant,
} from "@find-the-edge/domain";
import {
  identityAccountKey,
  type IdentityRepository,
} from "./identity-repository.js";

export const ADMIN_DIRECTORY_INDEX = "admin-directory-v1";
export type AdminBootstrapMode = "fresh" | "verified";

export class AdminAccessConflictError extends Error {
  constructor() {
    super("admin-access-conflict");
  }
}
export class AdminOwnerBootstrapRequiredError extends Error {
  constructor() {
    super("admin-owner-bootstrap-required");
  }
}

export interface AdminDirectoryPage {
  readonly items: readonly {
    readonly directory: AdminDirectoryEntry;
    readonly manualGrant: ManualAccessGrant | null;
  }[];
  readonly cursor: string | null;
}

export interface AdminAccessRepository {
  assertVerifiedLoginAllowed(
    accountId: string,
    ownerAccountId: string,
    bootstrapMode: AdminBootstrapMode,
  ): Promise<void>;
  completeVerifiedLogin(input: {
    readonly accountId: string;
    readonly phoneDigest: string;
    readonly phoneNumber: string;
    readonly now: string;
    readonly ownerAccountId?: string;
    readonly bootstrapMode?: AdminBootstrapMode;
  }): Promise<{
    readonly account: IdentityAccount;
    readonly directory: AdminDirectoryEntry;
  }>;
  getByAccount(accountId: string): Promise<{
    readonly directory: AdminDirectoryEntry;
    readonly manualGrant: ManualAccessGrant | null;
  } | null>;
  get(directoryId: string): Promise<{
    readonly directory: AdminDirectoryEntry;
    readonly manualGrant: ManualAccessGrant | null;
  } | null>;
  list(input: {
    readonly limit: number;
    readonly cursor?: string;
  }): Promise<AdminDirectoryPage>;
  grant(input: {
    readonly phoneDigest: string;
    readonly phoneNumber: string;
    readonly now: string;
    readonly operatorAccountId: string;
    readonly idempotencyKey: string;
    readonly expectedVersion?: number;
  }): Promise<{
    readonly directory: AdminDirectoryEntry;
    readonly manualGrant: ManualAccessGrant;
  }>;
  grantExisting(input: {
    readonly directoryId: string;
    readonly now: string;
    readonly operatorAccountId: string;
    readonly idempotencyKey: string;
    readonly expectedVersion: number;
  }): Promise<{
    readonly directory: AdminDirectoryEntry;
    readonly manualGrant: ManualAccessGrant;
  }>;
  revoke(input: {
    readonly directoryId: string;
    readonly now: string;
    readonly operatorAccountId: string;
    readonly idempotencyKey: string;
    readonly expectedVersion: number;
  }): Promise<{
    readonly directory: AdminDirectoryEntry;
    readonly manualGrant: ManualAccessGrant;
  }>;
}

const directoryKey = (directoryId: string) => {
  if (!isAdminDirectoryId(directoryId))
    throw new Error("admin-directory-id-invalid");
  return {
    pk: `ADMIN_DIRECTORY#${directoryId.slice("directory:".length)}`,
    sk: "RECORD",
  };
};
const grantKey = (directoryId: string) => ({
  ...directoryKey(directoryId),
  sk: "MANUAL_ACCESS",
});
const mappingKey = (accountId: string) => {
  if (!isAccountId(accountId)) throw new Error("admin-account-id-invalid");
  return { pk: `ACCOUNT#${accountId}`, sk: "ADMIN_DIRECTORY" };
};
const auditKey = (idempotencyKey: string) => {
  if (!isAdminAccessIdempotencyKey(idempotencyKey))
    throw new Error("admin-idempotency-key-invalid");
  return {
    pk: `ADMIN_AUDIT#${createHash("sha256").update(idempotencyKey).digest("hex")}`,
    sk: "EVENT",
  };
};
const reconciliationAuditKey = (accountId: string) => {
  if (!isAccountId(accountId)) throw new Error("admin-account-id-invalid");
  return { pk: `ADMIN_AUDIT#login-reconciled#${accountId}`, sk: "EVENT" };
};
const operatorId = (accountId: string): `operator:${string}` =>
  `operator:${createHash("sha256").update(accountId).digest("hex").slice(0, 24)}`;
const isConditional = (error: unknown) =>
  !!error &&
  typeof error === "object" &&
  ["ConditionalCheckFailedException", "TransactionCanceledException"].includes(
    (error as { name?: string }).name ?? "",
  );
const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
const ownerAuditAction = (key: string) =>
  key === "ADMIN_AUDIT#owner-bootstrap"
    ? "owner-bootstrap"
    : key === "ADMIN_AUDIT#owner-migrate"
      ? "owner-migrate"
      : /^ADMIN_AUDIT#owner-recover#[a-f0-9]{64}$/.test(key)
        ? "owner-recover"
        : null;

const normalizeCursorKey = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("admin-cursor-invalid");
  const cursor = value as Record<string, unknown>;
  if (
    Object.keys(cursor).sort().join("|") !== "directoryPk|directorySk|pk|sk" ||
    typeof cursor["pk"] !== "string" ||
    typeof cursor["sk"] !== "string" ||
    typeof cursor["directoryPk"] !== "string" ||
    typeof cursor["directorySk"] !== "string"
  )
    throw new Error("admin-cursor-invalid");
  const match = /^ADMIN_DIRECTORY#([a-f0-9]{32})$/.exec(cursor["pk"]);
  if (
    !match ||
    cursor["sk"] !== "RECORD" ||
    cursor["directoryPk"] !== "ADMIN_DIRECTORY" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z#directory:[a-f0-9]{32}$/.test(
      cursor["directorySk"],
    ) ||
    !cursor["directorySk"].endsWith(`#directory:${match[1]}`)
  )
    throw new Error("admin-cursor-invalid");
  return cursor;
};
const encodeCursor = (
  key: Record<string, unknown> | undefined,
): string | null =>
  key
    ? Buffer.from(JSON.stringify(normalizeCursorKey(key)), "utf8").toString(
        "base64url",
      )
    : null;
const decodeCursor = (
  cursor: string | undefined,
): Record<string, unknown> | undefined => {
  if (cursor === undefined) return undefined;
  if (
    cursor.length < 1 ||
    cursor.length > 2048 ||
    !/^[A-Za-z0-9_-]+$/.test(cursor)
  )
    throw new Error("admin-cursor-invalid");
  try {
    const decoded = Buffer.from(cursor, "base64url");
    if (decoded.toString("base64url") !== cursor) throw new Error();
    const value: unknown = JSON.parse(decoded.toString("utf8"));
    return normalizeCursorKey(value);
  } catch {
    throw new Error("admin-cursor-invalid");
  }
};

export class DynamoAdminAccessRepository implements AdminAccessRepository {
  constructor(
    private readonly client: DynamoDBDocumentClient,
    private readonly tableName: string,
  ) {}

  private async mutationReplay(
    idempotencyKey: string,
    action: "manual-grant" | "manual-revoke",
    directoryId: string,
    operatorAccountId: string,
  ) {
    const audit = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: auditKey(idempotencyKey),
        ConsistentRead: true,
      }),
    );
    if (!audit.Item) return null;
    try {
      const evidence = normalizeAdminAuditEvent(audit.Item["value"]);
      if (
        evidence.action !== action ||
        evidence.directoryId !== directoryId ||
        evidence.actor !== operatorId(operatorAccountId)
      )
        throw new Error();
      const current = await this.item(directoryId);
      if (
        !current?.manualGrant ||
        current.manualGrant.version !== evidence.grantVersion ||
        current.manualGrant.active !== (action === "manual-grant")
      )
        throw new Error();
      return {
        directory: current.directory,
        manualGrant: current.manualGrant,
      };
    } catch {
      throw new AdminAccessConflictError();
    }
  }

  private async ownerBootstrapComplete(ownerValue: unknown) {
    let owner: ReturnType<typeof normalizeOwnerBootstrap>;
    try {
      owner = normalizeOwnerBootstrap(ownerValue);
    } catch {
      return false;
    }
    const action = ownerAuditAction(owner.auditKey);
    if (!action) return false;
    const accountId = owner.accountId;
    const directoryId = owner.directoryId;
    const [directory, mapping, account, authorization, audit] =
      await Promise.all([
        this.client.send(
          new GetCommand({
            TableName: this.tableName,
            Key: directoryKey(directoryId),
            ConsistentRead: true,
          }),
        ),
        this.client.send(
          new GetCommand({
            TableName: this.tableName,
            Key: mappingKey(accountId),
            ConsistentRead: true,
          }),
        ),
        this.client.send(
          new GetCommand({
            TableName: this.tableName,
            Key: identityAccountKey(accountId),
            ConsistentRead: true,
          }),
        ),
        this.client.send(
          new GetCommand({
            TableName: this.tableName,
            Key: { pk: `ACCOUNT#${accountId}`, sk: "AUTHORIZATION" },
            ConsistentRead: true,
          }),
        ),
        this.client.send(
          new GetCommand({
            TableName: this.tableName,
            Key: { pk: owner.auditKey, sk: "EVENT" },
            ConsistentRead: true,
          }),
        ),
      ]);
    try {
      const normalizedAccount = normalizeIdentityAccount(
        account.Item?.["value"],
      );
      const normalized = normalizeIdentityAuthorization(
        authorization.Item?.["value"],
      );
      const normalizedDirectory = normalizeAdminDirectoryEntry(
        directory.Item?.["value"],
      );
      return (
        normalizedAccount.accountId === accountId &&
        normalized.accountId === accountId &&
        normalized.roles.includes("super-admin") &&
        normalizedDirectory.accountId === accountId &&
        normalizedDirectory.directoryId === directoryId &&
        Object.keys(record(mapping.Item) ?? {})
          .sort()
          .join("|") === "directoryId|pk|sk" &&
        record(mapping.Item)?.["directoryId"] === directoryId &&
        (() => {
          const evidence = normalizeAdminAuditEvent(audit.Item?.["value"]);
          return (
            evidence.action === action &&
            evidence.actor === "system" &&
            evidence.directoryId === directoryId &&
            evidence.occurredAt === owner.createdAt
          );
        })()
      );
    } catch {
      return false;
    }
  }

  private async item(directoryId: string) {
    const [directoryResult, grantResult] = await Promise.all([
      this.client.send(
        new GetCommand({
          TableName: this.tableName,
          Key: directoryKey(directoryId),
          ConsistentRead: true,
        }),
      ),
      this.client.send(
        new GetCommand({
          TableName: this.tableName,
          Key: grantKey(directoryId),
          ConsistentRead: true,
        }),
      ),
    ]);
    if (!directoryResult.Item) return null;
    return {
      directory: normalizeAdminDirectoryEntry(directoryResult.Item["value"]),
      manualGrant: grantResult.Item
        ? normalizeManualAccessGrant(grantResult.Item["value"])
        : null,
    };
  }

  async assertVerifiedLoginAllowed(
    accountId: string,
    ownerAccountId: string,
    bootstrapMode: AdminBootstrapMode,
  ) {
    if (!isAccountId(accountId) || !isAccountId(ownerAccountId))
      throw new Error("admin-account-id-invalid");
    const owner = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { pk: "ADMIN_OWNER", sk: "RECORD" },
        ConsistentRead: true,
      }),
    );
    if (!owner.Item) {
      if (bootstrapMode !== "fresh")
        throw new Error("stored-admin-owner-invalid");
      if (accountId !== ownerAccountId)
        throw new AdminOwnerBootstrapRequiredError();
    }
    if (owner.Item) {
      let normalized: ReturnType<typeof normalizeOwnerBootstrap>;
      try {
        normalized = normalizeOwnerBootstrap(owner.Item["value"]);
      } catch {
        throw new Error("stored-admin-owner-invalid");
      }
      if (
        normalized.accountId !== ownerAccountId ||
        !(await this.ownerBootstrapComplete(owner.Item["value"]))
      )
        throw new Error("stored-admin-owner-invalid");
    }
  }

  async get(directoryId: string) {
    return this.item(directoryId);
  }

  async getByAccount(accountId: string) {
    const result = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: mappingKey(accountId),
        ConsistentRead: true,
      }),
    );
    const directoryId = record(result.Item)?.["directoryId"];
    if (typeof directoryId !== "string" || !isAdminDirectoryId(directoryId))
      return result.Item
        ? Promise.reject(new Error("stored-admin-mapping-invalid"))
        : null;
    return this.item(directoryId);
  }

  async completeVerifiedLogin(input: {
    readonly accountId: string;
    readonly phoneDigest: string;
    readonly phoneNumber: string;
    readonly now: string;
    readonly ownerAccountId?: string;
    readonly bootstrapMode?: AdminBootstrapMode;
  }) {
    if (!isAccountId(input.accountId))
      throw new Error("admin-account-id-invalid");
    const id = adminDirectoryId(input.phoneDigest);
    const [current, accountResult, ownerResult] = await Promise.all([
      this.item(id),
      this.client.send(
        new GetCommand({
          TableName: this.tableName,
          Key: identityAccountKey(input.accountId),
          ConsistentRead: true,
        }),
      ),
      this.client.send(
        new GetCommand({
          TableName: this.tableName,
          Key: { pk: "ADMIN_OWNER", sk: "RECORD" },
          ConsistentRead: true,
        }),
      ),
    ]);
    const existingAccount = accountResult.Item
      ? normalizeIdentityAccount(accountResult.Item["value"])
      : null;
    let owner: ReturnType<typeof normalizeOwnerBootstrap> | null = null;
    if (ownerResult.Item) {
      try {
        owner = normalizeOwnerBootstrap(ownerResult.Item["value"]);
      } catch {
        throw new Error("stored-admin-owner-invalid");
      }
      if (
        !input.ownerAccountId ||
        owner.accountId !== input.ownerAccountId ||
        !(await this.ownerBootstrapComplete(ownerResult.Item["value"]))
      )
        throw new Error("stored-admin-owner-invalid");
    }
    if (!owner && input.ownerAccountId) {
      if (input.bootstrapMode !== "fresh")
        throw new Error("stored-admin-owner-invalid");
      if (input.accountId !== input.ownerAccountId)
        throw new AdminOwnerBootstrapRequiredError();
    }

    if (existingAccount) {
      if (
        !current ||
        current.directory.lifecycle !== "active" ||
        current.directory.accountId !== input.accountId
      )
        throw new Error("stored-admin-login-reconciliation-invalid");
      const mapping = await this.getByAccount(input.accountId);
      if (mapping?.directory.directoryId !== id)
        throw new Error("stored-admin-mapping-invalid");
      const account = createIdentityAccount({
        accountId: existingAccount.accountId,
        tokenVersion: existingAccount.tokenVersion,
        createdAt: existingAccount.createdAt,
        lastSignedInAt: input.now,
      });
      try {
        await this.client.send(
          new TransactWriteCommand({
            TransactItems: [
              {
                Put: {
                  TableName: this.tableName,
                  Item: {
                    ...identityAccountKey(input.accountId),
                    value: account,
                  },
                  ConditionExpression: "#value.#tokenVersion = :version",
                  ExpressionAttributeNames: {
                    "#value": "value",
                    "#tokenVersion": "tokenVersion",
                  },
                  ExpressionAttributeValues: {
                    ":version": existingAccount.tokenVersion,
                  },
                },
              },
            ],
          }),
        );
      } catch (error) {
        if (isConditional(error)) throw new AdminAccessConflictError();
        throw error;
      }
      return { account, directory: current.directory };
    }

    const account = createIdentityAccount({
      accountId: input.accountId,
      createdAt: input.now,
    });
    const directory = createAdminDirectoryEntry({
      phoneDigest: input.phoneDigest,
      phoneHint: phoneSuffixHint(input.phoneNumber),
      accountId: input.accountId,
      createdAt: current?.directory.createdAt ?? input.now,
      updatedAt: input.now,
    });
    const ownerBootstrap =
      !owner && input.ownerAccountId === input.accountId
        ? createOwnerBootstrap({
            accountId: input.accountId,
            directoryId: id,
            auditKey: "ADMIN_AUDIT#owner-bootstrap",
            createdAt: input.now,
          })
        : null;
    const items: ConstructorParameters<
      typeof TransactWriteCommand
    >[0]["TransactItems"] = [
      {
        Put: {
          TableName: this.tableName,
          Item: { ...identityAccountKey(input.accountId), value: account },
          ConditionExpression: "attribute_not_exists(pk)",
        },
      },
      {
        Put: {
          TableName: this.tableName,
          Item: {
            ...directoryKey(id),
            directoryPk: "ADMIN_DIRECTORY",
            directorySk: `${directory.createdAt}#${id}`,
            value: directory,
          },
          ConditionExpression: current
            ? "#value.#lifecycle = :pending AND #value.#accountId = :none"
            : "attribute_not_exists(pk)",
          ...(current
            ? {
                ExpressionAttributeNames: {
                  "#value": "value",
                  "#lifecycle": "lifecycle",
                  "#accountId": "accountId",
                },
                ExpressionAttributeValues: {
                  ":pending": "pending",
                  ":none": null,
                },
              }
            : {}),
        },
      },
      {
        Put: {
          TableName: this.tableName,
          Item: { ...mappingKey(input.accountId), directoryId: id },
          ConditionExpression: "attribute_not_exists(pk)",
        },
      },
    ];
    if (ownerBootstrap) {
      const authorization = createIdentityAuthorization({
        accountId: input.accountId,
        roles: ["super-admin"],
        updatedAt: input.now,
        operatorId: operatorId(input.accountId),
      });
      items.push(
        {
          Put: {
            TableName: this.tableName,
            Item: { pk: "ADMIN_OWNER", sk: "RECORD", value: ownerBootstrap },
            ConditionExpression: "attribute_not_exists(pk)",
          },
        },
        {
          Put: {
            TableName: this.tableName,
            Item: {
              pk: `ACCOUNT#${input.accountId}`,
              sk: "AUTHORIZATION",
              value: authorization,
            },
            ConditionExpression: "attribute_not_exists(pk)",
          },
        },
        {
          Put: {
            TableName: this.tableName,
            Item: {
              pk: "ADMIN_AUDIT#owner-bootstrap",
              sk: "EVENT",
              value: createAdminAuditEvent({
                action: "owner-bootstrap",
                directoryId: id,
                actor: "system",
                occurredAt: input.now,
              }),
            },
            ConditionExpression: "attribute_not_exists(pk)",
          },
        },
      );
    } else {
      items.push({
        Put: {
          TableName: this.tableName,
          Item: {
            ...reconciliationAuditKey(input.accountId),
            value: createAdminAuditEvent({
              action: "login-reconciled",
              actor: "system",
              directoryId: id,
              occurredAt: input.now,
            }),
          },
          ConditionExpression: "attribute_not_exists(pk)",
        },
      });
    }
    try {
      await this.client.send(
        new TransactWriteCommand({ TransactItems: items }),
      );
    } catch (error) {
      if (isConditional(error)) {
        const [replay, replayAccount, replayAudit] = await Promise.all([
          this.item(id),
          this.client.send(
            new GetCommand({
              TableName: this.tableName,
              Key: identityAccountKey(input.accountId),
              ConsistentRead: true,
            }),
          ),
          ownerBootstrap
            ? this.ownerBootstrapComplete({
                ...ownerBootstrap,
              })
            : this.client.send(
                new GetCommand({
                  TableName: this.tableName,
                  Key: reconciliationAuditKey(input.accountId),
                  ConsistentRead: true,
                }),
              ),
        ]);
        try {
          const storedAccount = normalizeIdentityAccount(
            replayAccount.Item?.["value"],
          );
          const auditComplete = ownerBootstrap
            ? replayAudit === true
            : (() => {
                const audit = normalizeAdminAuditEvent(
                  (replayAudit as { Item?: Record<string, unknown> }).Item?.[
                    "value"
                  ],
                );
                return (
                  audit.action === "login-reconciled" &&
                  audit.directoryId === id
                );
              })();
          if (
            replay?.directory.accountId === input.accountId &&
            storedAccount.accountId === input.accountId &&
            auditComplete
          )
            return { account: storedAccount, directory: replay.directory };
        } catch {
          // A conditional failure only replays a fully valid aggregate.
        }
        throw new AdminAccessConflictError();
      }
      throw error;
    }
    return { account, directory };
  }

  async list(input: {
    readonly limit: number;
    readonly cursor?: string;
  }): Promise<AdminDirectoryPage> {
    if (
      !Number.isSafeInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > 100
    )
      throw new Error("admin-limit-invalid");
    const result = await this.client.send(
      new QueryCommand({
        TableName: this.tableName,
        IndexName: ADMIN_DIRECTORY_INDEX,
        KeyConditionExpression: "directoryPk = :pk",
        ExpressionAttributeValues: { ":pk": "ADMIN_DIRECTORY" },
        Limit: input.limit,
        ...(input.cursor
          ? { ExclusiveStartKey: decodeCursor(input.cursor) }
          : {}),
      }),
    );
    const directories = (result.Items ?? []).map((item) =>
      normalizeAdminDirectoryEntry(item["value"]),
    );
    const grants = new Map<string, ManualAccessGrant>();
    if (directories.length > 0) {
      const batch = await this.client.send(
        new BatchGetCommand({
          RequestItems: {
            [this.tableName]: {
              Keys: directories.map(({ directoryId }) => grantKey(directoryId)),
              ConsistentRead: true,
            },
          },
        }),
      );
      if ((batch.UnprocessedKeys?.[this.tableName]?.Keys?.length ?? 0) > 0)
        throw new Error("admin-directory-read-incomplete");
      for (const item of batch.Responses?.[this.tableName] ?? []) {
        const grant = normalizeManualAccessGrant(item["value"]);
        grants.set(grant.directoryId, grant);
      }
    }
    const items = directories.map((directory) => ({
      directory,
      manualGrant: grants.get(directory.directoryId) ?? null,
    }));
    return { items, cursor: encodeCursor(result.LastEvaluatedKey) };
  }

  async grant(input: {
    readonly phoneDigest: string;
    readonly phoneNumber: string;
    readonly now: string;
    readonly operatorAccountId: string;
    readonly idempotencyKey: string;
    readonly expectedVersion?: number;
  }) {
    const id = adminDirectoryId(input.phoneDigest);
    const replay = await this.mutationReplay(
      input.idempotencyKey,
      "manual-grant",
      id,
      input.operatorAccountId,
    );
    if (replay) return replay;
    const current = await this.item(id);
    const version = (current?.manualGrant?.version ?? 0) + 1;
    if (
      input.expectedVersion !== undefined &&
      input.expectedVersion !== (current?.manualGrant?.version ?? 0)
    )
      throw new AdminAccessConflictError();
    const directory =
      current?.directory ??
      createAdminDirectoryEntry({
        phoneDigest: input.phoneDigest,
        phoneHint: phoneSuffixHint(input.phoneNumber),
        createdAt: input.now,
      });
    const grant = createManualAccessGrant({
      directoryId: id,
      active: true,
      version,
      createdAt: current?.manualGrant?.createdAt ?? input.now,
      updatedAt: input.now,
      operatorId: operatorId(input.operatorAccountId),
    });
    try {
      await this.client.send(
        new TransactWriteCommand({
          TransactItems: [
            ...(current
              ? []
              : [
                  {
                    Put: {
                      TableName: this.tableName,
                      Item: {
                        ...directoryKey(id),
                        directoryPk: "ADMIN_DIRECTORY",
                        directorySk: `${directory.createdAt}#${id}`,
                        value: directory,
                      },
                      ConditionExpression: "attribute_not_exists(pk)",
                    },
                  },
                ]),
            {
              Put: {
                TableName: this.tableName,
                Item: { ...grantKey(id), value: grant },
                ConditionExpression: current?.manualGrant
                  ? "#value.#version = :expected"
                  : "attribute_not_exists(pk)",
                ...(current?.manualGrant
                  ? {
                      ExpressionAttributeNames: {
                        "#value": "value",
                        "#version": "version",
                      },
                      ExpressionAttributeValues: {
                        ":expected": current.manualGrant.version,
                      },
                    }
                  : {}),
              },
            },
            {
              Put: {
                TableName: this.tableName,
                Item: {
                  ...auditKey(input.idempotencyKey),
                  value: createAdminAuditEvent({
                    action: "manual-grant",
                    directoryId: id,
                    grantVersion: version,
                    actor: operatorId(input.operatorAccountId),
                    occurredAt: input.now,
                  }),
                },
                ConditionExpression: "attribute_not_exists(pk)",
              },
            },
          ],
        }),
      );
    } catch (error) {
      if (isConditional(error)) {
        const concurrent = await this.mutationReplay(
          input.idempotencyKey,
          "manual-grant",
          id,
          input.operatorAccountId,
        );
        if (concurrent) return concurrent;
        throw new AdminAccessConflictError();
      }
      throw error;
    }
    return { directory, manualGrant: grant };
  }

  async grantExisting(input: {
    readonly directoryId: string;
    readonly now: string;
    readonly operatorAccountId: string;
    readonly idempotencyKey: string;
    readonly expectedVersion: number;
  }) {
    const current = await this.item(input.directoryId);
    if (!current) throw new AdminAccessConflictError();
    const replay = await this.mutationReplay(
      input.idempotencyKey,
      "manual-grant",
      input.directoryId,
      input.operatorAccountId,
    );
    if (replay) return replay;
    if ((current.manualGrant?.version ?? 0) !== input.expectedVersion)
      throw new AdminAccessConflictError();
    const grant = createManualAccessGrant({
      directoryId: input.directoryId,
      active: true,
      version: input.expectedVersion + 1,
      createdAt: current.manualGrant?.createdAt ?? input.now,
      updatedAt: input.now,
      operatorId: operatorId(input.operatorAccountId),
    });
    try {
      await this.client.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Put: {
                TableName: this.tableName,
                Item: { ...grantKey(input.directoryId), value: grant },
                ConditionExpression: current.manualGrant
                  ? "#value.#version = :expected"
                  : "attribute_not_exists(pk)",
                ...(current.manualGrant
                  ? {
                      ExpressionAttributeNames: {
                        "#value": "value",
                        "#version": "version",
                      },
                      ExpressionAttributeValues: {
                        ":expected": input.expectedVersion,
                      },
                    }
                  : {}),
              },
            },
            {
              Put: {
                TableName: this.tableName,
                Item: {
                  ...auditKey(input.idempotencyKey),
                  value: createAdminAuditEvent({
                    action: "manual-grant",
                    directoryId: input.directoryId,
                    grantVersion: grant.version,
                    actor: operatorId(input.operatorAccountId),
                    occurredAt: input.now,
                  }),
                },
                ConditionExpression: "attribute_not_exists(pk)",
              },
            },
          ],
        }),
      );
    } catch (error) {
      if (isConditional(error)) {
        const concurrent = await this.mutationReplay(
          input.idempotencyKey,
          "manual-grant",
          input.directoryId,
          input.operatorAccountId,
        );
        if (concurrent) return concurrent;
        throw new AdminAccessConflictError();
      }
      throw error;
    }
    return { directory: current.directory, manualGrant: grant };
  }

  async revoke(input: {
    readonly directoryId: string;
    readonly now: string;
    readonly operatorAccountId: string;
    readonly idempotencyKey: string;
    readonly expectedVersion: number;
  }) {
    const current = await this.item(input.directoryId);
    if (!current?.manualGrant) throw new AdminAccessConflictError();
    const replay = await this.mutationReplay(
      input.idempotencyKey,
      "manual-revoke",
      input.directoryId,
      input.operatorAccountId,
    );
    if (replay) return replay;
    if (current.manualGrant.version !== input.expectedVersion)
      throw new AdminAccessConflictError();
    const grant = createManualAccessGrant({
      ...current.manualGrant,
      active: false,
      version: current.manualGrant.version + 1,
      updatedAt: input.now,
      operatorId: operatorId(input.operatorAccountId),
    });
    try {
      await this.client.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Put: {
                TableName: this.tableName,
                Item: { ...grantKey(input.directoryId), value: grant },
                ConditionExpression: "#value.#version = :expected",
                ExpressionAttributeNames: {
                  "#value": "value",
                  "#version": "version",
                },
                ExpressionAttributeValues: {
                  ":expected": input.expectedVersion,
                },
              },
            },
            {
              Put: {
                TableName: this.tableName,
                Item: {
                  ...auditKey(input.idempotencyKey),
                  value: createAdminAuditEvent({
                    action: "manual-revoke",
                    directoryId: input.directoryId,
                    grantVersion: grant.version,
                    actor: operatorId(input.operatorAccountId),
                    occurredAt: input.now,
                  }),
                },
                ConditionExpression: "attribute_not_exists(pk)",
              },
            },
          ],
        }),
      );
    } catch (error) {
      if (isConditional(error)) {
        const concurrent = await this.mutationReplay(
          input.idempotencyKey,
          "manual-revoke",
          input.directoryId,
          input.operatorAccountId,
        );
        if (concurrent) return concurrent;
        throw new AdminAccessConflictError();
      }
      throw error;
    }
    return { directory: current.directory, manualGrant: grant };
  }
}

export class MemoryAdminAccessRepository implements AdminAccessRepository {
  private readonly directories = new Map<string, AdminDirectoryEntry>();
  private readonly grants = new Map<string, ManualAccessGrant>();
  private readonly mappings = new Map<string, string>();
  private readonly mutations = new Map<
    string,
    {
      readonly action: "grant" | "revoke";
      readonly directoryId: string;
      readonly version: number;
      readonly operatorId: string;
    }
  >();
  private readonly accounts = new Map<string, IdentityAccount>();
  private owner: ReturnType<typeof createOwnerBootstrap> | null = null;
  private readonly reconciliationAudits = new Set<string>();

  constructor(
    private readonly identity?: Pick<
      IdentityRepository,
      "upsertAccount" | "getAccount"
    >,
  ) {}

  async assertVerifiedLoginAllowed(
    accountId: string,
    ownerAccountId: string,
    bootstrapMode: AdminBootstrapMode,
  ) {
    await Promise.resolve();
    if (!this.owner) {
      if (bootstrapMode !== "fresh")
        throw new Error("stored-admin-owner-invalid");
      if (accountId !== ownerAccountId)
        throw new AdminOwnerBootstrapRequiredError();
    }
    if (this.owner && this.owner.accountId !== ownerAccountId)
      throw new Error("stored-admin-owner-invalid");
  }
  async completeVerifiedLogin(input: {
    readonly accountId: string;
    readonly phoneDigest: string;
    readonly phoneNumber: string;
    readonly now: string;
    readonly ownerAccountId?: string;
    readonly bootstrapMode?: AdminBootstrapMode;
  }) {
    await Promise.resolve();
    if (!this.owner && input.ownerAccountId) {
      if (input.bootstrapMode !== "fresh")
        throw new Error("stored-admin-owner-invalid");
      if (input.accountId !== input.ownerAccountId)
        throw new AdminOwnerBootstrapRequiredError();
    }
    const id = adminDirectoryId(input.phoneDigest);
    const old = this.directories.get(id);
    const existingAccount = this.identity
      ? await this.identity.getAccount(input.accountId)
      : (this.accounts.get(input.accountId) ?? null);
    if (
      existingAccount &&
      (!old || old.lifecycle !== "active" || old.accountId !== input.accountId)
    )
      throw new Error("stored-admin-login-reconciliation-invalid");
    const account = this.identity
      ? await this.identity.upsertAccount({
          accountId: input.accountId,
          now: input.now,
        })
      : createIdentityAccount({
          accountId: input.accountId,
          ...(existingAccount
            ? { tokenVersion: existingAccount.tokenVersion }
            : {}),
          createdAt: existingAccount?.createdAt ?? input.now,
          lastSignedInAt: input.now,
        });
    this.accounts.set(input.accountId, account);
    const entry = createAdminDirectoryEntry({
      phoneDigest: input.phoneDigest,
      phoneHint: phoneSuffixHint(input.phoneNumber),
      accountId: input.accountId,
      createdAt: old?.createdAt ?? input.now,
      updatedAt: input.now,
    });
    this.directories.set(id, entry);
    this.mappings.set(input.accountId, id);
    if (!existingAccount) {
      if (!this.owner && input.ownerAccountId === input.accountId)
        this.owner = createOwnerBootstrap({
          accountId: input.accountId,
          directoryId: id,
          auditKey: "ADMIN_AUDIT#owner-bootstrap",
          createdAt: input.now,
        });
      else this.reconciliationAudits.add(input.accountId);
    }
    return { account, directory: entry };
  }
  async getByAccount(accountId: string) {
    await Promise.resolve();
    const id = this.mappings.get(accountId);
    return id ? this.get(id) : null;
  }
  async get(directoryId: string) {
    await Promise.resolve();
    const directory = this.directories.get(directoryId);
    return directory
      ? { directory, manualGrant: this.grants.get(directoryId) ?? null }
      : null;
  }
  async list(input: { readonly limit: number; readonly cursor?: string }) {
    await Promise.resolve();
    if (input.limit < 1 || input.limit > 100)
      throw new Error("admin-limit-invalid");
    const start = input.cursor ? Number(input.cursor) : 0;
    if (!Number.isSafeInteger(start) || start < 0)
      throw new Error("admin-cursor-invalid");
    const all = [...this.directories.values()].sort((a, b) =>
      `${a.createdAt}#${a.directoryId}`.localeCompare(
        `${b.createdAt}#${b.directoryId}`,
      ),
    );
    const selected = all.slice(start, start + input.limit);
    return {
      items: selected.map((directory) => ({
        directory,
        manualGrant: this.grants.get(directory.directoryId) ?? null,
      })),
      cursor:
        start + selected.length < all.length
          ? String(start + selected.length)
          : null,
    };
  }
  async grant(input: {
    readonly phoneDigest: string;
    readonly phoneNumber: string;
    readonly now: string;
    readonly operatorAccountId: string;
    readonly idempotencyKey: string;
    readonly expectedVersion?: number;
  }) {
    await Promise.resolve();
    const id = adminDirectoryId(input.phoneDigest);
    const replay = this.mutations.get(input.idempotencyKey);
    if (replay) {
      if (replay.action !== "grant" || replay.directoryId !== id)
        throw new AdminAccessConflictError();
      const value = await this.get(replay.directoryId);
      if (
        !value?.manualGrant ||
        value.manualGrant.version !== replay.version ||
        !value.manualGrant.active ||
        replay.operatorId !== operatorId(input.operatorAccountId)
      )
        throw new AdminAccessConflictError();
      return { directory: value.directory, manualGrant: value.manualGrant };
    }
    const current = await this.get(id);
    if (
      input.expectedVersion !== undefined &&
      input.expectedVersion !== (current?.manualGrant?.version ?? 0)
    )
      throw new AdminAccessConflictError();
    const directory =
      current?.directory ??
      createAdminDirectoryEntry({
        phoneDigest: input.phoneDigest,
        phoneHint: phoneSuffixHint(input.phoneNumber),
        createdAt: input.now,
      });
    const manualGrant = createManualAccessGrant({
      directoryId: id,
      active: true,
      version: (current?.manualGrant?.version ?? 0) + 1,
      createdAt: current?.manualGrant?.createdAt ?? input.now,
      updatedAt: input.now,
      operatorId: operatorId(input.operatorAccountId),
    });
    this.directories.set(id, directory);
    this.grants.set(id, manualGrant);
    this.mutations.set(input.idempotencyKey, {
      action: "grant",
      directoryId: id,
      version: manualGrant.version,
      operatorId: operatorId(input.operatorAccountId),
    });
    return { directory, manualGrant };
  }
  async grantExisting(input: {
    readonly directoryId: string;
    readonly now: string;
    readonly operatorAccountId: string;
    readonly idempotencyKey: string;
    readonly expectedVersion: number;
  }) {
    await Promise.resolve();
    const current = await this.get(input.directoryId);
    if (!current) throw new AdminAccessConflictError();
    const replay = this.mutations.get(input.idempotencyKey);
    if (replay) {
      if (
        replay.action !== "grant" ||
        replay.directoryId !== input.directoryId ||
        !current.manualGrant ||
        current.manualGrant.version !== replay.version ||
        !current.manualGrant.active ||
        replay.operatorId !== operatorId(input.operatorAccountId)
      )
        throw new AdminAccessConflictError();
      return { directory: current.directory, manualGrant: current.manualGrant };
    }
    if ((current.manualGrant?.version ?? 0) !== input.expectedVersion)
      throw new AdminAccessConflictError();
    const manualGrant = createManualAccessGrant({
      directoryId: input.directoryId,
      active: true,
      version: input.expectedVersion + 1,
      createdAt: current.manualGrant?.createdAt ?? input.now,
      updatedAt: input.now,
      operatorId: operatorId(input.operatorAccountId),
    });
    this.grants.set(input.directoryId, manualGrant);
    this.mutations.set(input.idempotencyKey, {
      action: "grant",
      directoryId: input.directoryId,
      version: manualGrant.version,
      operatorId: operatorId(input.operatorAccountId),
    });
    return { directory: current.directory, manualGrant };
  }
  async revoke(input: {
    readonly directoryId: string;
    readonly now: string;
    readonly operatorAccountId: string;
    readonly idempotencyKey: string;
    readonly expectedVersion: number;
  }) {
    await Promise.resolve();
    const current = await this.get(input.directoryId);
    if (!current?.manualGrant) throw new AdminAccessConflictError();
    const replay = this.mutations.get(input.idempotencyKey);
    if (replay) {
      if (
        replay.action !== "revoke" ||
        replay.directoryId !== input.directoryId ||
        current.manualGrant.version !== replay.version ||
        current.manualGrant.active ||
        replay.operatorId !== operatorId(input.operatorAccountId)
      )
        throw new AdminAccessConflictError();
      return { directory: current.directory, manualGrant: current.manualGrant };
    }
    if (current.manualGrant.version !== input.expectedVersion)
      throw new AdminAccessConflictError();
    const manualGrant = createManualAccessGrant({
      ...current.manualGrant,
      active: false,
      version: current.manualGrant.version + 1,
      updatedAt: input.now,
      operatorId: operatorId(input.operatorAccountId),
    });
    this.grants.set(input.directoryId, manualGrant);
    this.mutations.set(input.idempotencyKey, {
      action: "revoke",
      directoryId: input.directoryId,
      version: manualGrant.version,
      operatorId: operatorId(input.operatorAccountId),
    });
    return { directory: current.directory, manualGrant };
  }
}
