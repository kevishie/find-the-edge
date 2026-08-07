import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PublicScoutingJob } from "@find-the-edge/domain";

import { GamesClientError, type GamesClient } from "./api";
import {
  ScoutingProgress,
  persistentScoutingActionKey,
  type ScoutingClientResult,
} from "./scouting";

const id = `scout-job:${"a".repeat(64)}`;
const base: PublicScoutingJob = {
  schemaVersion: 1,
  jobId: id,
  eventId: "event:mlb:fixture-1",
  eventVersion: 1,
  workflowIntent: "fixture-v1",
  status: "queued",
  stateVersion: 1,
  attemptNumber: 1,
  createdAt: "2026-08-07T13:00:00.000Z",
  updatedAt: "2026-08-07T13:00:00.000Z",
};

const client = (
  getScoutingJob: NonNullable<GamesClient["getScoutingJob"]>,
  retryScoutingJob?: NonNullable<GamesClient["retryScoutingJob"]>,
): ScoutingClientResult => ({
  ok: true,
  value: {
    getScoutingJob,
    ...(retryScoutingJob ? { retryScoutingJob } : {}),
  },
});

afterEach(() => {
  vi.useRealTimers();
  sessionStorage.clear();
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value: "visible",
  });
});

describe("ScoutingProgress", () => {
  it.each([
    [base, "Scouting is queued", "The request is saved"],
    [
      { ...base, status: "in_progress", stateVersion: 2 },
      "Scouting is in progress",
      "This page will update automatically",
    ],
    [
      { ...base, status: "completed", stateVersion: 3 },
      "Scouting is complete",
      "A report is not available yet",
    ],
    [
      {
        ...base,
        status: "failed_retryable",
        stateVersion: 2,
        failure: { code: "workflow-timeout", retryable: true },
      },
      "Scouting could not finish",
      "interrupted before it could finish",
    ],
    [
      {
        ...base,
        status: "failed_terminal",
        stateVersion: 2,
        failure: { code: "event-no-longer-scheduled", retryable: false },
      },
      "Scouting could not finish",
      "no longer scheduled",
    ],
    [
      { ...base, status: "cancelled", stateVersion: 2 },
      "Scouting was stopped",
      "cannot be retried",
    ],
  ] as const)(
    "renders only a real server state",
    async (job, heading, copy) => {
      const get = vi.fn(() => Promise.resolve(job));
      render(<ScoutingProgress jobId={id} client={client(get)} />);
      expect(
        await screen.findByRole("heading", { name: heading }),
      ).toBeVisible();
      expect(screen.getByText(new RegExp(copy))).toBeVisible();
      expect(
        screen.queryByText(/collecting|generating|calculating/i),
      ).toBeNull();
      expect(screen.queryByText(/workflow|fixture-v1/i)).toBeNull();
    },
  );

  it("does not request malformed direct links", async () => {
    const get = vi.fn();
    render(<ScoutingProgress jobId="bad" client={client(get)} />);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This scouting job address is invalid.",
    );
    expect(get).not.toHaveBeenCalled();
  });

  it("retains confirmed progress through refresh failure and reconnects", async () => {
    vi.useFakeTimers();
    const get = vi
      .fn()
      .mockResolvedValueOnce(base)
      .mockRejectedValueOnce(
        new GamesClientError("request-failed", "raw provider secret"),
      )
      .mockResolvedValueOnce({
        ...base,
        status: "in_progress",
        stateVersion: 2,
      });
    render(<ScoutingProgress jobId={id} client={client(get)} />);
    await act(async () => Promise.resolve());
    expect(
      screen.getByRole("heading", { name: "Scouting is queued" }),
    ).toBeVisible();
    await act(async () => vi.advanceTimersByTimeAsync(2_500));
    expect(
      screen.getByRole("heading", { name: "Scouting is queued" }),
    ).toBeVisible();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Confirmed progress is still shown",
    );
    expect(screen.queryByText("raw provider secret")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Reconnect" }));
    await act(async () => Promise.resolve());
    expect(
      screen.getByRole("heading", { name: "Scouting is in progress" }),
    ).toBeVisible();
  });

  it("clears a transient refresh error when reconnect confirms the same state", async () => {
    vi.useFakeTimers();
    const reordered = {
      jobId: base.jobId,
      schemaVersion: base.schemaVersion,
      eventId: base.eventId,
      workflowIntent: base.workflowIntent,
      eventVersion: base.eventVersion,
      stateVersion: base.stateVersion,
      status: base.status,
      attemptNumber: base.attemptNumber,
      updatedAt: base.updatedAt,
      createdAt: base.createdAt,
    } as PublicScoutingJob;
    const get = vi
      .fn()
      .mockResolvedValueOnce(base)
      .mockRejectedValueOnce(new GamesClientError("request-failed", "raw"))
      .mockResolvedValueOnce(reordered);
    render(<ScoutingProgress jobId={id} client={client(get)} />);
    await act(async () => Promise.resolve());
    await act(async () => vi.advanceTimersByTimeAsync(2_500));
    expect(screen.getByRole("button", { name: "Reconnect" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Reconnect" }));
    await act(async () => Promise.resolve());
    expect(screen.queryByRole("button", { name: "Reconnect" })).toBeNull();
    expect(
      screen.getByRole("heading", { name: "Scouting is queued" }),
    ).toBeVisible();
  });

  it("rejects higher-version updates that mutate immutable job evidence", async () => {
    vi.useFakeTimers();
    const get = vi
      .fn()
      .mockResolvedValueOnce(base)
      .mockResolvedValueOnce({
        ...base,
        eventId: "event:mlb:different-fixture",
        status: "in_progress",
        stateVersion: 2,
        updatedAt: "2026-08-07T13:01:00.000Z",
      });
    render(<ScoutingProgress jobId={id} client={client(get)} />);
    await act(async () => Promise.resolve());
    await act(async () => vi.advanceTimersByTimeAsync(2_500));
    expect(
      screen.getByRole("heading", { name: "Scouting is queued" }),
    ).toBeVisible();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "latest scouting update could not be verified",
    );
  });

  it("stops polling terminal jobs and pauses active work while hidden", async () => {
    vi.useFakeTimers();
    const completed = {
      ...base,
      status: "completed" as const,
      stateVersion: 3,
    };
    const terminalGet = vi.fn(() => Promise.resolve(completed));
    const { unmount } = render(
      <ScoutingProgress jobId={id} client={client(terminalGet)} />,
    );
    await act(async () => Promise.resolve());
    await act(async () => vi.advanceTimersByTimeAsync(30_000));
    expect(terminalGet).toHaveBeenCalledTimes(1);
    unmount();

    const activeGet = vi.fn(() => Promise.resolve(base));
    render(<ScoutingProgress jobId={id} client={client(activeGet)} />);
    await act(async () => Promise.resolve());
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      await Promise.resolve();
    });
    await act(async () => vi.advanceTimersByTimeAsync(30_000));
    expect(activeGet).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/Updates pause/)).toBeVisible();
  });

  it("clears previously confirmed job details when authority returns not found", async () => {
    vi.useFakeTimers();
    const get = vi
      .fn()
      .mockResolvedValueOnce(base)
      .mockRejectedValueOnce(
        new GamesClientError("not-found", "raw foreign job details"),
      );
    render(<ScoutingProgress jobId={id} client={client(get)} />);
    await act(async () => Promise.resolve());
    expect(
      screen.getByRole("heading", { name: "Scouting is queued" }),
    ).toBeVisible();
    await act(async () => vi.advanceTimersByTimeAsync(2_500));
    expect(
      screen.getByRole("heading", { name: "Scouting progress unavailable" }),
    ).toBeVisible();
    expect(screen.getByText("This scouting job is unavailable.")).toBeVisible();
    expect(screen.queryByText("raw foreign job details")).toBeNull();
    expect(screen.queryByRole("link", { name: "View game" })).toBeNull();
  });

  it("retries only a server-authorized latest failure with a stable fenced key", async () => {
    const failed: PublicScoutingJob = {
      ...base,
      status: "failed_retryable",
      stateVersion: 2,
      failure: { code: "workflow-timeout", retryable: true },
    };
    const retried: PublicScoutingJob = {
      ...base,
      status: "queued",
      stateVersion: 3,
      attemptNumber: 2,
    };
    const get = vi.fn(() => Promise.resolve(failed));
    const retry = vi.fn(() => Promise.resolve(retried));
    render(<ScoutingProgress jobId={id} client={client(get, retry)} />);
    await screen.findByRole("button", { name: "Retry scouting" });
    fireEvent.click(screen.getByRole("button", { name: "Retry scouting" }));
    expect(
      await screen.findByRole("heading", { name: "Scouting is queued" }),
    ).toBeVisible();
    expect(retry).toHaveBeenCalledWith(
      id,
      2,
      expect.stringMatching(/^[\w.-]+$/),
      expect.any(AbortSignal),
    );
    expect(screen.queryByRole("button", { name: "Retry scouting" })).toBeNull();
  });

  it("re-reads authority after a retry conflict", async () => {
    const failed: PublicScoutingJob = {
      ...base,
      status: "failed_retryable",
      stateVersion: 2,
      failure: { code: "workflow-timeout", retryable: true },
    };
    const advanced: PublicScoutingJob = {
      ...base,
      status: "queued",
      stateVersion: 3,
      attemptNumber: 2,
    };
    const get = vi
      .fn()
      .mockResolvedValueOnce(failed)
      .mockResolvedValueOnce(advanced);
    const retry = vi.fn(() =>
      Promise.reject(new GamesClientError("conflict", "raw")),
    );
    render(<ScoutingProgress jobId={id} client={client(get, retry)} />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Retry scouting" }),
    );
    expect(
      await screen.findByRole("heading", { name: "Scouting is queued" }),
    ).toBeVisible();
    expect(get).toHaveBeenCalledTimes(2);
    expect(
      screen.queryByText("Checking the latest scouting status."),
    ).toBeNull();
  });

  it("does not back off-poll a terminal job after reconciliation fails", async () => {
    vi.useFakeTimers();
    const failed: PublicScoutingJob = {
      ...base,
      status: "failed_retryable",
      stateVersion: 2,
      failure: { code: "workflow-timeout", retryable: true },
    };
    const get = vi
      .fn()
      .mockResolvedValueOnce(failed)
      .mockRejectedValueOnce(
        new GamesClientError("request-failed", "temporary"),
      );
    const retry = vi.fn(() =>
      Promise.reject(new GamesClientError("conflict", "raw")),
    );
    render(<ScoutingProgress jobId={id} client={client(get, retry)} />);
    await act(async () => Promise.resolve());
    fireEvent.click(screen.getByRole("button", { name: "Retry scouting" }));
    await act(async () => Promise.resolve());
    expect(get).toHaveBeenCalledTimes(2);
    await act(async () => vi.advanceTimersByTimeAsync(30_000));
    expect(get).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("button", { name: "Reconnect" })).toBeVisible();
  });

  it("aborts an in-flight retry when the route unmounts", async () => {
    const failed: PublicScoutingJob = {
      ...base,
      status: "failed_retryable",
      stateVersion: 2,
      failure: { code: "workflow-timeout", retryable: true },
    };
    let retrySignal: AbortSignal | undefined;
    const retry = vi.fn(
      (_jobId, _version, _key, signal: AbortSignal) =>
        new Promise<PublicScoutingJob>(() => {
          retrySignal = signal;
        }),
    );
    const { unmount } = render(
      <ScoutingProgress
        jobId={id}
        client={client(
          vi.fn(() => Promise.resolve(failed)),
          retry,
        )}
      />,
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Retry scouting" }),
    );
    expect(retrySignal?.aborted).toBe(false);
    unmount();
    expect(retrySignal?.aborted).toBe(true);
  });

  it("reuses pending action keys across uncertain outcomes until explicitly cleared", () => {
    const first = persistentScoutingActionKey("create", base.eventId);
    const second = persistentScoutingActionKey("create", base.eventId);
    expect(second.key).toBe(first.key);
    first.clear();
    expect(persistentScoutingActionKey("create", base.eventId).key).not.toBe(
      first.key,
    );
  });

  it("reports when a logical mutation key cannot be persisted", () => {
    const write = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new DOMException("blocked", "SecurityError");
      });
    expect(persistentScoutingActionKey("create", base.eventId).persisted).toBe(
      false,
    );
    write.mockRestore();
  });
});
