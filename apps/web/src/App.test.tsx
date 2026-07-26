import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { App } from "./App";

describe("Edge Lab", () => {
  it("shows a qualified value decision for the default fixture", () => {
    render(<App />);
    expect(screen.getByText("QUALIFIED PLAY")).toBeInTheDocument();
    expect(screen.getByText("Qualified positive EV")).toBeInTheDocument();
  });

  it("turns public concentration into an auditable no-bet", () => {
    render(<App />);
    fireEvent.change(screen.getByLabelText("Public ticket %"), {
      target: { value: "84" },
    });
    expect(screen.getByText("NO BET")).toBeInTheDocument();
    expect(
      screen.getByText("80%+ public tickets without overwhelming edge"),
    ).toBeInTheDocument();
  });
});
