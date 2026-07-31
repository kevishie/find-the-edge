import { describe, expect, it, vi } from "vitest";
import { createSqsHandler } from "./handler";
describe("handler", () => {
  it("isolates each message", async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error("retry"));
    const handler = createSqsHandler({ execute } as never);
    const result = await handler({
      Records: [
        {
          messageId: "bad",
          body: "{",
          attributes: { MessageGroupId: "bad", SequenceNumber: "1" },
        },
        {
          messageId: "ok",
          body: "{}",
          attributes: { MessageGroupId: "ok", SequenceNumber: "1" },
        },
        {
          messageId: "retry",
          body: "{}",
          attributes: { MessageGroupId: "retry", SequenceNumber: "1" },
        },
        {
          messageId: "three",
          body: "{}",
          attributes: { MessageGroupId: "three", SequenceNumber: "1" },
        },
        {
          messageId: "four",
          body: "{}",
          attributes: { MessageGroupId: "four", SequenceNumber: "1" },
        },
        {
          messageId: "five",
          body: "{}",
          attributes: { MessageGroupId: "five", SequenceNumber: "1" },
        },
        {
          messageId: "overflow",
          body: "{}",
          attributes: { MessageGroupId: "overflow", SequenceNumber: "1" },
        },
      ],
    } as never);
    expect(result.batchItemFailures).toEqual([
      { itemIdentifier: "bad" },
      { itemIdentifier: "retry" },
    ]);
    expect(execute).toHaveBeenCalledTimes(6);
  });

  it("rejects FIFO records without MessageGroupId", async () => {
    const execute = vi.fn();
    const result = await createSqsHandler({ execute } as never)({
      Records: [{ messageId: "missing", body: "{}" }],
    } as never);
    expect(result.batchItemFailures).toEqual([{ itemIdentifier: "missing" }]);
    expect(execute).not.toHaveBeenCalled();
  });

  it("rejects an oversized sequence before converting it to BigInt", async () => {
    const execute = vi.fn();
    const result = await createSqsHandler({ execute } as never)({
      Records: [
        {
          messageId: "oversized",
          body: "{}",
          attributes: {
            MessageGroupId: "mlb:mlb",
            SequenceNumber: "1".repeat(129),
          },
        },
      ],
    } as never);
    expect(result.batchItemFailures).toEqual([{ itemIdentifier: "oversized" }]);
    expect(execute).not.toHaveBeenCalled();
  });

  it("fails the entire FIFO tail when one record has malformed sequence metadata", async () => {
    const execute = vi.fn();
    const result = await createSqsHandler({ execute } as never)({
      Records: [
        {
          messageId: "bad-sequence",
          body: "{}",
          attributes: {
            MessageGroupId: "mlb:mlb",
            SequenceNumber: "not-decimal",
          },
        },
        {
          messageId: "later-in-group",
          body: "{}",
          attributes: { MessageGroupId: "mlb:mlb", SequenceNumber: "2" },
        },
      ],
    } as never);
    expect(result.batchItemFailures).toEqual([
      { itemIdentifier: "bad-sequence" },
      { itemIdentifier: "later-in-group" },
    ]);
    expect(execute).not.toHaveBeenCalled();
  });

  it("rejects duplicate FIFO sequence numbers for the complete group", async () => {
    const execute = vi.fn();
    const result = await createSqsHandler({ execute } as never)({
      Records: [
        {
          messageId: "first",
          body: "{}",
          attributes: { MessageGroupId: "mlb:mlb", SequenceNumber: "7" },
        },
        {
          messageId: "duplicate",
          body: "{}",
          attributes: { MessageGroupId: "mlb:mlb", SequenceNumber: "7" },
        },
      ],
    } as never);
    expect(result.batchItemFailures).toEqual([
      { itemIdentifier: "first" },
      { itemIdentifier: "duplicate" },
    ]);
    expect(execute).not.toHaveBeenCalled();
  });

  it("processes every group through a pool of at most five workers", async () => {
    let active = 0;
    let maximumActive = 0;
    const execute = vi.fn(async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await Promise.resolve();
      active -= 1;
    });
    const Records = Array.from({ length: 12 }, (_, index) => ({
      messageId: `message-${index}`,
      body: "{}",
      attributes: {
        MessageGroupId: `group-${index}`,
        SequenceNumber: "1",
      },
    }));
    const result = await createSqsHandler({ execute } as never)({
      Records,
    } as never);
    expect(result.batchItemFailures).toEqual([]);
    expect(execute).toHaveBeenCalledTimes(12);
    expect(maximumActive).toBeLessThanOrEqual(5);
  });

  it("rejects a message group outside the command sport and league", async () => {
    const execute = vi.fn();
    const result = await createSqsHandler({ execute } as never)({
      Records: [
        {
          messageId: "wrong-group",
          body: JSON.stringify({ sportKey: "mlb", leagueKey: "mlb" }),
          attributes: { MessageGroupId: "soccer:mls", SequenceNumber: "1" },
        },
      ],
    } as never);
    expect(result.batchItemFailures).toEqual([
      { itemIdentifier: "wrong-group" },
    ]);
    expect(execute).not.toHaveBeenCalled();
  });

  it("preserves FIFO order and blocks later records after a group failure", async () => {
    const order: string[] = [];
    const execute = vi.fn(async (input: { id: string }) => {
      await Promise.resolve();
      order.push(input.id);
      if (input.id === "a2") throw new Error("failed");
    });
    const handler = createSqsHandler({ execute } as never);
    const record = (messageId: string, group: string, sequence: string) => ({
      messageId,
      body: JSON.stringify({ id: messageId }),
      attributes: { MessageGroupId: group, SequenceNumber: sequence },
    });
    const result = await handler({
      Records: [
        record("a2", "a", "2"),
        record("b1", "b", "1"),
        record("a1", "a", "1"),
        record("a3", "a", "3"),
      ],
    } as never);
    expect(order.indexOf("a1")).toBeLessThan(order.indexOf("a2"));
    expect(order).not.toContain("a3");
    expect(result.batchItemFailures).toEqual([
      { itemIdentifier: "a2" },
      { itemIdentifier: "a3" },
    ]);
  });
});
