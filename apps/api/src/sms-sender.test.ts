import { describe, expect, it } from "vitest";
import type { SNSClient } from "@aws-sdk/client-sns";
import { createSnsSmsSender, otpMessageBody } from "./sms-sender";

interface CommandLike {
  readonly constructor: { readonly name: string };
  readonly input: Record<string, unknown>;
}

const clientThat = (
  behaviour: (command: CommandLike) => unknown,
): { client: SNSClient; commands: CommandLike[] } => {
  const commands: CommandLike[] = [];
  return {
    commands,
    client: {
      send: async (raw: unknown) => {
        await Promise.resolve();
        const command = raw as CommandLike;
        commands.push(command);
        return behaviour(command);
      },
    } as unknown as SNSClient,
  };
};

describe("sms sender", () => {
  it("publishes a transactional message straight to the number", async () => {
    const { client, commands } = clientThat(() => ({ MessageId: "m-1" }));
    const result = await createSnsSmsSender(client).send({
      phone: "+15557654321",
      body: otpMessageBody("907531"),
    });
    expect(result).toEqual({ outcome: "delivered" });
    expect(commands).toHaveLength(1);
    expect(commands[0]?.constructor.name).toBe("PublishCommand");
    expect(commands[0]?.input).toEqual({
      PhoneNumber: "+15557654321",
      Message: expect.stringContaining("907531") as string,
      MessageAttributes: {
        "AWS.SNS.SMS.SMSType": {
          DataType: "String",
          StringValue: "Transactional",
        },
      },
    });
    // No topic, no origination identity, no destination list: SMS publish
    // addresses the handset directly.
    expect(commands[0]?.input["TopicArn"]).toBeUndefined();
  });

  it("says nothing about the recipient in the message body", () => {
    const body = otpMessageBody("907531");
    expect(body).toContain("907531");
    expect(body).not.toContain("http");
    expect(body.length).toBeLessThan(160);
  });

  it("binds the code to the configured host in the WebOTP format", () => {
    const body = otpMessageBody("907531", "staging.kevishie.com");
    // The format is exact and the binding line must be last: a phone parses
    // the final line and nothing else.
    expect(body.split("\n").at(-1)).toBe("@staging.kevishie.com #907531");
    expect(body).toContain(
      "907531 is your Find The Edge sign-in code. It expires in 5 minutes. We will never ask you for it.",
    );
    // Still no link, and still one SMS segment with the line attached.
    expect(body).not.toContain("http");
    expect(body.length).toBeLessThan(160);
  });

  it("keeps a non-default port, which is part of the origin", () => {
    expect(otpMessageBody("907531", "localhost:5173").split("\n").at(-1)).toBe(
      "@localhost:5173 #907531",
    );
  });

  it("sends the unbound text rather than bind to a host we cannot trust", () => {
    const plain = otpMessageBody("907531");
    for (const host of [
      "",
      " ",
      "kevishie.com evil.com",
      "https://kevishie.com",
      "kevishie.com/path",
      "kevishie..com",
      "-kevishie.com",
      "kevishie.com-",
      "kevishie.com\n@evil.com",
      "kevishie.com #000000\n@evil.com",
      `${"a".repeat(250)}.com`,
    ])
      expect(otpMessageBody("907531", host)).toBe(plain);
  });

  it("classifies failures without leaking the provider's message", async () => {
    for (const [name, outcome, failureClass] of [
      ["ThrottledException", "failed", "throttled"],
      ["TooManyRequestsException", "failed", "throttled"],
      ["InvalidParameterException", "rejected", "invalid-destination"],
      ["OptedOutException", "rejected", "opted-out"],
      ["AuthorizationErrorException", "failed", "unauthorized"],
      ["InternalErrorException", "failed", "service-unavailable"],
      ["SomethingNew", "failed", "unknown"],
    ] as const) {
      const { client } = clientThat(() => {
        throw Object.assign(new Error("+15557654321 is not reachable"), {
          name,
        });
      });
      const result = await createSnsSmsSender(client).send({
        phone: "+15557654321",
        body: otpMessageBody("907531"),
      });
      expect(result).toEqual({ outcome, failureClass });
      expect(JSON.stringify(result)).not.toContain("15557654321");
    }
  });
});
