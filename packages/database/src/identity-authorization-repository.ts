import { GetCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import {
  isAccountId,
  normalizeIdentityAuthorization,
  type IdentityAuthorization,
} from "@find-the-edge/domain";

export interface IdentityAuthorizationRepository {
  get(accountId: string): Promise<IdentityAuthorization | null>;
}

/**
 * One authorization record shares the durable account partition but has a
 * separate sort key, so it can be read directly without a Scan or GSI.
 */
export const identityAuthorizationKey = (accountId: string) => {
  if (!isAccountId(accountId))
    throw new Error("identity-authorization-account-id-invalid");
  return { pk: `ACCOUNT#${accountId}`, sk: "AUTHORIZATION" } as const;
};

export class IdentityAuthorizationRepositoryError extends Error {
  override readonly name = "IdentityAuthorizationRepositoryError";
  readonly code = "identity-authorization-record-corrupt" as const;

  constructor() {
    super("identity-authorization-record-corrupt");
  }
}

export class DynamoIdentityAuthorizationRepository implements IdentityAuthorizationRepository {
  constructor(
    private readonly client: DynamoDBDocumentClient,
    private readonly tableName: string,
  ) {}

  async get(accountId: string): Promise<IdentityAuthorization | null> {
    const result = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: identityAuthorizationKey(accountId),
        ConsistentRead: true,
      }),
    );
    if (result.Item === undefined) return null;
    try {
      const authorization = normalizeIdentityAuthorization(
        result.Item["value"],
      );
      if (authorization.accountId !== accountId)
        throw new Error("identity-authorization-account-binding-invalid");
      return authorization;
    } catch {
      // Never forward malformed row contents or the domain parser's details
      // across the repository boundary.
      throw new IdentityAuthorizationRepositoryError();
    }
  }
}
