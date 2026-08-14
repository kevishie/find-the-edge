import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import {
  createIdentityAuthorization,
  deriveAccountId,
} from "@find-the-edge/domain";
import { describe, expect, it } from "vitest";
import {
  DynamoIdentityAuthorizationRepository,
  identityAuthorizationKey,
  IdentityAuthorizationRepositoryError,
} from "./identity-authorization-repository.js";

const ACCOUNT_ID = deriveAccountId(
  "+15557654321",
  "account-pepper-value-0123456789ab",
);
const RECORD = createIdentityAuthorization({
  accountId: ACCOUNT_ID,
  roles: ["retrospective-reviewer", "strategy-promoter"],
  updatedAt: "2026-08-14T12:00:00.000Z",
  operatorId: "operator:access-control-bot",
});

interface CommandLike {
  readonly constructor: { readonly name: string };
  readonly input: Record<string, unknown>;
}

class FakeAuthorizationClient {
  readonly commands: CommandLike[] = [];
  item: Record<string, unknown> | undefined;
  failure: Error | undefined;

  async send(raw: unknown): Promise<Record<string, unknown>> {
    await Promise.resolve();
    const command = raw as CommandLike;
    this.commands.push(command);
    if (this.failure) throw this.failure;
    if (command.constructor.name !== "GetCommand")
      throw new Error(`unexpected-command:${command.constructor.name}`);
    return this.item === undefined ? {} : { Item: structuredClone(this.item) };
  }
}

const harness = () => {
  const client = new FakeAuthorizationClient();
  return {
    client,
    repository: new DynamoIdentityAuthorizationRepository(
      client as unknown as DynamoDBDocumentClient,
      "fte-table",
    ),
  };
};

describe("identity authorization repository", () => {
  it("uses the exact account authorization primary key", () => {
    expect(identityAuthorizationKey(ACCOUNT_ID)).toEqual({
      pk: `ACCOUNT#${ACCOUNT_ID}`,
      sk: "AUTHORIZATION",
    });
    expect(() => identityAuthorizationKey("account:short")).toThrow(
      "identity-authorization-account-id-invalid",
    );
  });

  it("returns null from one strongly consistent primary-key read", async () => {
    const { client, repository } = harness();
    await expect(repository.get(ACCOUNT_ID)).resolves.toBeNull();
    expect(client.commands).toHaveLength(1);
    expect(client.commands[0]?.constructor.name).toBe("GetCommand");
    expect(client.commands[0]?.input).toEqual({
      TableName: "fte-table",
      Key: {
        pk: `ACCOUNT#${ACCOUNT_ID}`,
        sk: "AUTHORIZATION",
      },
      ConsistentRead: true,
    });
  });

  it("normalizes the stored value without a scan or index lookup", async () => {
    const { client, repository } = harness();
    client.item = { ...identityAuthorizationKey(ACCOUNT_ID), value: RECORD };
    await expect(repository.get(ACCOUNT_ID)).resolves.toEqual(RECORD);
    expect(client.commands.map(({ constructor }) => constructor.name)).toEqual([
      "GetCommand",
    ]);
  });

  it("fails closed with a fixed sanitized error for malformed storage", async () => {
    const { client, repository } = harness();
    client.item = {
      ...identityAuthorizationKey(ACCOUNT_ID),
      value: {
        ...RECORD,
        roles: ["admin"],
        privateLeak: "sensitive-row-content",
      },
    };
    const error: unknown = await repository.get(ACCOUNT_ID).then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(IdentityAuthorizationRepositoryError);
    if (!(error instanceof Error)) throw new Error("expected-error");
    expect(error).toMatchObject({
      name: "IdentityAuthorizationRepositoryError",
      code: "identity-authorization-record-corrupt",
      message: "identity-authorization-record-corrupt",
    });
    expect(JSON.stringify(error)).not.toContain("sensitive-row-content");
    expect(error.cause).toBeUndefined();
  });

  it("treats a present row with no value as corruption", async () => {
    const { client, repository } = harness();
    client.item = identityAuthorizationKey(ACCOUNT_ID);
    await expect(repository.get(ACCOUNT_ID)).rejects.toBeInstanceOf(
      IdentityAuthorizationRepositoryError,
    );
  });

  it("rejects a record stored under another account's key", async () => {
    const { client, repository } = harness();
    const otherAccountId = deriveAccountId(
      "+15550009999",
      "account-pepper-value-0123456789ab",
    );
    client.item = {
      ...identityAuthorizationKey(ACCOUNT_ID),
      value: { ...RECORD, accountId: otherAccountId },
    };
    await expect(repository.get(ACCOUNT_ID)).rejects.toMatchObject({
      code: "identity-authorization-record-corrupt",
      message: "identity-authorization-record-corrupt",
    });
  });

  it("does not relabel DynamoDB transport failures as corrupt rows", async () => {
    const { client, repository } = harness();
    const unavailable = new Error("dynamodb-unavailable");
    client.failure = unavailable;
    await expect(repository.get(ACCOUNT_ID)).rejects.toBe(unavailable);
  });
});
