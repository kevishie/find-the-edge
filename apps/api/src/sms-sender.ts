import { PublishCommand, type SNSClient } from "@aws-sdk/client-sns";

export interface SmsMessage {
  /** E.164, already normalized by the domain before it reaches here. */
  readonly phone: string;
  readonly body: string;
}

/**
 * Delivery classes, never delivery detail: "rejected" is the transport
 * refusing this destination (unreachable, opted out, not a mobile), "failed"
 * is our side or the service being unavailable. Neither carries the number,
 * the code, or the provider's message text.
 */
export type SmsDeliveryOutcome = "delivered" | "rejected" | "failed";

export type SmsFailureClass =
  | "throttled"
  | "invalid-destination"
  | "opted-out"
  | "unauthorized"
  | "service-unavailable"
  | "unknown";

export interface SmsSendResult {
  readonly outcome: SmsDeliveryOutcome;
  readonly failureClass?: SmsFailureClass;
}

export interface SmsSender {
  send(message: SmsMessage): Promise<SmsSendResult>;
}

/** The only text we ever send. No link, no account detail, no branding that
 * would help a phisher reuse it, and the code appears exactly once. */
export const otpMessageBody = (code: string): string =>
  `${code} is your Find The Edge sign-in code. It expires in 5 minutes. We will never ask you for it.`;

const failureClassOf = (error: unknown): SmsFailureClass => {
  const name = error instanceof Error ? error.name : "";
  if (name === "ThrottledException" || name === "TooManyRequestsException")
    return "throttled";
  if (name === "InvalidParameterException" || name === "InvalidParameterValue")
    return "invalid-destination";
  if (name === "OptedOutException") return "opted-out";
  if (
    name === "AuthorizationErrorException" ||
    name === "AccessDeniedException"
  )
    return "unauthorized";
  if (name === "InternalErrorException" || name === "ServiceUnavailable")
    return "service-unavailable";
  return "unknown";
};

/**
 * SNS direct-to-phone publish. The account already has SMS origination
 * configured at the account and region level, so there is no origination
 * identity, pool, or topic to reference here: the destination number is the
 * whole address. Messages are Transactional because a sign-in code must not
 * be dropped in favour of promotional traffic.
 */
export const createSnsSmsSender = (client: SNSClient): SmsSender => ({
  async send(message: SmsMessage): Promise<SmsSendResult> {
    try {
      await client.send(
        new PublishCommand({
          PhoneNumber: message.phone,
          Message: message.body,
          MessageAttributes: {
            "AWS.SNS.SMS.SMSType": {
              DataType: "String",
              StringValue: "Transactional",
            },
          },
        }),
      );
      return { outcome: "delivered" };
    } catch (error) {
      const failureClass = failureClassOf(error);
      return {
        outcome:
          failureClass === "invalid-destination" || failureClass === "opted-out"
            ? "rejected"
            : "failed",
        failureClass,
      };
    }
  },
});
