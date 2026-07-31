import type { SQSBatchResponse, SQSEvent } from "aws-lambda";
import type { UpcomingEventIngestionOrchestrator } from "./upcoming-event-orchestrator";

export function createSqsHandler(
  orchestrator: UpcomingEventIngestionOrchestrator,
  recordFailedRecords: (count: number) => void = () => undefined,
) {
  return async (event: SQSEvent): Promise<SQSBatchResponse> => {
    const MAX_SEQUENCE_NUMBER_DIGITS = 128;
    const MAX_GROUP_CONCURRENCY = 5;
    const groups = new Map<string, typeof event.Records>();
    const missingGroup: string[] = [];
    const invalidGroups = new Set<string>();
    for (const record of event.Records) {
      const group = record.attributes?.MessageGroupId;
      const sequence = record.attributes?.SequenceNumber;
      if (!group) {
        missingGroup.push(record.messageId);
        continue;
      }
      groups.set(group, [...(groups.get(group) ?? []), record]);
      if (
        !sequence ||
        sequence.length > MAX_SEQUENCE_NUMBER_DIGITS ||
        !/^(0|[1-9][0-9]*)$/.test(sequence)
      )
        invalidGroups.add(group);
    }
    for (const [group, records] of groups) {
      const sequences = records.map(
        (record) => record.attributes?.SequenceNumber,
      );
      if (new Set(sequences).size !== sequences.length)
        invalidGroups.add(group);
    }
    for (const group of invalidGroups) {
      const records = groups.get(group) ?? [];
      missingGroup.push(...records.map((record) => record.messageId));
      groups.delete(group);
    }
    const pendingGroups = [...groups.values()];
    const failures: string[][] = [];
    let nextGroup = 0;
    const processGroups = async () => {
      while (nextGroup < pendingGroups.length) {
        const records = pendingGroups[nextGroup++];
        if (!records) return;
        records.sort((left, right) => {
          const a = BigInt(left.attributes.SequenceNumber!);
          const b = BigInt(right.attributes.SequenceNumber!);
          return a < b ? -1 : a > b ? 1 : 0;
        });
        const failed: string[] = [];
        let blocked = false;
        for (const record of records) {
          if (blocked) {
            failed.push(record.messageId);
            continue;
          }
          try {
            const body = JSON.parse(record.body) as unknown;
            const bodyRecord =
              body && typeof body === "object"
                ? (body as Record<string, unknown>)
                : undefined;
            const sportKey = bodyRecord?.["sportKey"];
            const leagueKey = bodyRecord?.["leagueKey"];
            if (
              typeof sportKey === "string" &&
              typeof leagueKey === "string" &&
              record.attributes?.MessageGroupId !== `${sportKey}:${leagueKey}`
            )
              throw new Error("message-group-scope-mismatch");
            await orchestrator.execute(body);
          } catch {
            blocked = true;
            failed.push(record.messageId);
          }
        }
        failures.push(failed);
      }
    };
    await Promise.all(
      Array.from(
        { length: Math.min(MAX_GROUP_CONCURRENCY, pendingGroups.length) },
        processGroups,
      ),
    );
    const batchItemFailures = [...missingGroup, ...failures.flat()].map(
      (itemIdentifier) => ({ itemIdentifier }),
    );
    if (batchItemFailures.length > 0)
      recordFailedRecords(batchItemFailures.length);
    return { batchItemFailures };
  };
}
