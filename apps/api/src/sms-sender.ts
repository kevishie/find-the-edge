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

const HOST_LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
const BINDABLE_HOST = new RegExp(
  `^${HOST_LABEL}(?:\\.${HOST_LABEL})*(?::\\d{1,5})?$`,
  "i",
);

/**
 * The only text we ever send. No link, no account detail, no branding that
 * would help a phisher reuse it.
 *
 * The trailing `@host #code` line is the origin-bound format WebOTP defines.
 * Android Chrome's `navigator.credentials.get({ otp })` will not resolve
 * without it — the phone refuses to hand a code to a site the message never
 * named. iOS Safari already offered the code heuristically from
 * `autocomplete="one-time-code"`, and reads this form as a domain check on
 * top of that. So the line buys Android autofill and hardens iOS.
 *
 * The code appears twice, which is inherent to the format. That is the whole
 * cost: it is not a clickable link and it names only the host the reader is
 * already looking at.
 *
 * `host` must come from the stage's own configuration and never from a
 * request header. A host the caller chose is a code bound to the caller's
 * origin, which is precisely a site that could then autofill it.
 */
export const otpMessageBody = (code: string, host?: string): string => {
  const message = `${code} is your Find The Edge sign-in code. It expires in 5 minutes. We will never ask you for it.`;
  // A malformed or absent host degrades to the message we sent before rather
  // than to a line that binds the code to the wrong origin.
  return host && host.length <= 253 && BINDABLE_HOST.test(host)
    ? `${message}\n\n@${host} #${code}`
    : message;
};

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
