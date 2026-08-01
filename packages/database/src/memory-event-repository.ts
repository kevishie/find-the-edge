import { DynamoEventRepository } from "./dynamodb-event-repository";
import type { DynamoItem } from "./dynamodb-event-ingestion";
import type { EventCursorCodec } from "./event-repository";
import type { MemoryEventIngestionStore } from "./memory-event-ingestion";
export class MemoryEventRepository extends DynamoEventRepository {
  constructor(
    store: MemoryEventIngestionStore,
    cursor: EventCursorCodec,
    now: () => Date = () => new Date(),
  ) {
    super(
      {
        queryPage: async (
          pk: string,
          startSk: string | undefined,
          limit: number,
        ) => {
          await Promise.resolve();
          const all = [...store.eventReadItems.values()]
              .filter(
                (item) => item.pk === pk && (!startSk || item.sk > startSk),
              )
              .sort((a, b) => a.sk.localeCompare(b.sk)),
            items = all.slice(0, limit);
          return {
            items,
            ...(all.length > limit && items.length
              ? { lastEvaluatedSk: items.at(-1)!.sk }
              : {}),
          };
        },
        transactGet: async (
          keys: readonly { readonly pk: string; readonly sk: string }[],
        ): Promise<readonly (DynamoItem | null)[]> =>
          (await Promise.resolve(keys)).map(
            (key) => store.eventReadItems.get(`${key.pk}\0${key.sk}`) ?? null,
          ),
      },
      cursor,
      async () => {
        await Promise.resolve();
        return store.eventReadInitialized;
      },
      now,
    );
  }
}
