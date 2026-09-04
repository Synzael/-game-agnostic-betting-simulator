import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useCustomPresetStore, useSessionStore } from "@/store";
import { createLabPresetFixture } from "@/engine/optimizer-preset.fixture";
import SetupPage from "./page";

const push = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
}));

describe("SetupPage effective plan", () => {
  beforeEach(() => {
    push.mockClear();
    useSessionStore.getState().resetSession();
    useCustomPresetStore.setState({ presets: [createLabPresetFixture()] });
  });

  it("previews the selected custom preset's ladders instead of the defaults", () => {
    render(<SetupPage />);

    expect(screen.getByText("L1")).toBeInTheDocument();
    expect(screen.getByText("Default (built-in)")).toBeInTheDocument();

    fireEvent.click(screen.getByText("Lab Test"));

    expect(screen.queryByText("L1")).not.toBeInTheDocument();
    expect(screen.getAllByText("Lab 1").length).toBeGreaterThan(0);
    expect(screen.getByText("Lab 2")).toBeInTheDocument();
    expect(screen.getByText("Lab Test (Ladder Lab v1)")).toBeInTheDocument();
    expect(screen.getByText(/Lab 2:/).closest("li")).toHaveTextContent(
      "Lab 2: $25 · $50 · $100"
    );
  });

  it("explains provenance mismatches and aligns settings on request", () => {
    render(<SetupPage />);
    fireEvent.click(screen.getByText("Lab Test"));

    expect(screen.getByText("Confirmed for other settings")).toBeInTheDocument();
    expect(screen.getByText(/^Game: confirmed/)).toBeInTheDocument();
    expect(screen.getByText(/^Bankroll: confirmed \$5,000, now \$10,000/)).toBeInTheDocument();
    expect(screen.getByText(/^Max rounds: confirmed 300, now 5000/)).toBeInTheDocument();
    expect(screen.getByText(/^Table max: confirmed \$500, now none/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Use confirmed settings" }));

    expect(screen.getByText("Confirmed for these settings")).toBeInTheDocument();
    expect(screen.queryByText(/^Bankroll: confirmed/)).not.toBeInTheDocument();
    expect(screen.getByText("$5,000 / $250 / $1,000")).toBeInTheDocument();
    expect(screen.getByText("Baccarat · Banker (5% commission)")).toBeInTheDocument();
  });

  it("freezes the previewed custom strategy and settings into the session", () => {
    const preset = createLabPresetFixture();
    render(<SetupPage />);
    fireEvent.click(screen.getByText("Lab Test"));
    fireEvent.click(screen.getByRole("button", { name: "Use confirmed settings" }));
    fireEvent.click(screen.getByRole("button", { name: "Start Session" }));
    fireEvent.click(screen.getByRole("button", { name: "I Understand" }));

    const store = useSessionStore.getState();
    expect(store.strategy).toEqual(preset.strategy);
    expect(store.game?.fingerprint).toBe(preset.provenance.gameFingerprint);
    expect(store.config).toEqual({
      bankroll: 5_000,
      profitTarget: 250,
      stopLossAbs: 1_000,
      maxRounds: 300,
      tableMax: 500,
      startingLadder: 0,
    });
    expect(store.getCurrentStake()).toBe(5);
    expect(push).toHaveBeenCalledWith("/session");
  });

  it("refuses to start when the selected preset disappears", () => {
    render(<SetupPage />);
    fireEvent.click(screen.getByText("Lab Test"));

    act(() => {
      useCustomPresetStore.setState({ presets: [] });
    });

    expect(screen.getByRole("alert")).toHaveTextContent(/no longer available/);
    fireEvent.click(screen.getByRole("button", { name: "Start Session" }));
    expect(screen.queryByRole("button", { name: "I Understand" })).not.toBeInTheDocument();
    expect(useSessionStore.getState().strategy).toBeNull();
  });
});
