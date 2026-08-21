import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import AdminUsers from "./admin-users";
import type { UiGamesClient } from "./App";
import type { AdminUserDirectoryItemDto } from "./api";

afterEach(cleanup);

const user: AdminUserDirectoryItemDto = {
  schemaVersion: "admin-user-v1",
  directoryId: `directory:${"a".repeat(32)}`,
  accountId: null,
  phoneHint: "**21",
  displayReference: "User aaaaaa · **21",
  lifecycle: "pending",
  createdAt: "2026-08-19T12:00:00.000Z",
  updatedAt: "2026-08-19T12:00:00.000Z",
  manualGrant: { active: true, version: 1 },
  access: {
    superAdmin: false,
    stripe: "inactive",
    effective: "granted",
    sources: ["manual"],
  },
};

const client = (overrides: Partial<UiGamesClient> = {}) =>
  ({
    listAdminUsers: vi.fn().mockResolvedValue({
      schemaVersion: "admin-user-directory-page-v1",
      items: [user],
      cursor: null,
    }),
    grantAdminUserAccess: vi.fn().mockResolvedValue(user),
    revokeAdminUserAccess: vi.fn().mockResolvedValue({
      ...user,
      manualGrant: { active: false, version: 2 },
      access: { ...user.access, effective: "denied", sources: [] },
    }),
    ...overrides,
  }) as unknown as UiGamesClient;

describe("admin users", () => {
  it("renders privacy-minimized pending access and source-specific actions", async () => {
    render(<AdminUsers client={client()} />);
    expect(await screen.findByRole("table")).toBeInTheDocument();
    expect(screen.getByText("Phone ending 21")).toBeInTheDocument();
    expect(screen.getByText("Manual override")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /revoke manual access/i }),
    ).toBeEnabled();
  });

  it("validates E.164 before granting and applies authoritative response", async () => {
    const games = client();
    render(<AdminUsers client={games} />);
    await screen.findByRole("table");
    fireEvent.change(screen.getByLabelText(/grant access by phone/i), {
      target: { value: "555-1234" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Grant access" }));
    expect(screen.getByRole("alert")).toHaveTextContent(/E\.164/);
    expect(games.grantAdminUserAccess).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText(/grant access by phone/i), {
      target: { value: "+15557654321" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Grant access" }));
    await waitFor(() => expect(games.grantAdminUserAccess).toHaveBeenCalled());
  });

  it("shows a recoverable load failure", async () => {
    render(
      <AdminUsers
        client={client({
          listAdminUsers: vi.fn().mockRejectedValue(new Error("offline")),
        })}
      />,
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      /could not be loaded/i,
    );
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });

  it("retains the same idempotency key across an ambiguous grant retry", async () => {
    const grant = vi
      .fn()
      .mockRejectedValueOnce(new Error("response-lost"))
      .mockResolvedValueOnce(user);
    const games = client({ grantAdminUserAccess: grant });
    render(<AdminUsers client={games} />);
    await screen.findByRole("table");
    fireEvent.change(screen.getByLabelText(/grant access by phone/i), {
      target: { value: "+15557654321" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Grant access" }));
    await waitFor(() => expect(grant).toHaveBeenCalledTimes(1));
    await screen.findByText(/could not be granted/i);
    fireEvent.click(screen.getByRole("button", { name: "Grant access" }));
    await waitFor(() => expect(grant).toHaveBeenCalledTimes(2));
    expect(grant.mock.calls[0]?.[1]).toBe(grant.mock.calls[1]?.[1]);
  });
});
