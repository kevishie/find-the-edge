import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { stableDigest } from "@find-the-edge/database";
import type { UpcomingEventIngestionCommand } from "@find-the-edge/domain";
import type { ContinuationPublisher } from "./upcoming-event-orchestrator";

export class SqsContinuationPublisher implements ContinuationPublisher {
  constructor(
    readonly client: SQSClient,
    readonly queueUrl: string,
  ) {}

  async publish(command: UpcomingEventIngestionCommand): Promise<void> {
    const digest = stableDigest(JSON.stringify(command));
    const result = await this.client.send(
      new SendMessageCommand({
        QueueUrl: this.queueUrl,
        MessageBody: JSON.stringify(command),
        MessageGroupId: `${command.sportKey}:${command.leagueKey}`,
        MessageDeduplicationId: digest,
      }),
    );
    if (!result.MessageId) throw new Error("continuation-publish-incomplete");
  }
}
