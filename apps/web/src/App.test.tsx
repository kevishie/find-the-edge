import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { App } from "./App";

describe("Edge Lab", () => {
  it("shows a qualified value decision for the default fixture", async () => {
    render(<App initialPath="/" />);
    expect(await screen.findByText("QUALIFIED PLAY")).toBeInTheDocument();
    expect(screen.getByText("Qualified positive EV")).toBeInTheDocument();
  });

  it("turns public concentration into an auditable no-bet", async () => {
    render(<App initialPath="/" />);
    await screen.findByText("QUALIFIED PLAY");
    fireEvent.change(screen.getByLabelText("Public ticket %"), {
      target: { value: "84" },
    });
    expect(screen.getByText("NO BET")).toBeInTheDocument();
    expect(
      screen.getByText("80%+ public tickets without overwhelming edge"),
    ).toBeInTheDocument();
  });
});

describe("Event Explorer", () => {
  it("uses registered terminology and withholds planned recommendations", async () => {
    render(<App initialPath="/sports/tennis/events" />);

    expect(
      await screen.findByRole("heading", { name: "Tennis Matches" }),
    ).toBeInTheDocument();
    expect(screen.getAllByText("planned").length).toBeGreaterThan(0);
    expect(screen.getByText("No recommendation published")).toBeInTheDocument();
  });
});
