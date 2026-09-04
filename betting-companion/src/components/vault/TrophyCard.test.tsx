import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SessionResult, TrophySlot } from "@/engine/types";
import { NewVaultRecord } from "./NewVaultRecord";
import { TrophyCard } from "./TrophyCard";

function session(): SessionResult {
  return {
    id: "one-session",
    startTime: 1_000,
    endTime: 2_000,
    hitTarget: false,
    hitStopLoss: false,
    hitMaxRounds: false,
    hitTableLimit: false,
    bankrollExhausted: false,
    userStopped: true,
    finalPnl: 80,
    roundsPlayed: 12,
    totalWagered: 120,
    maxStakeSeen: 10,
    maxDrawdown: 420,
    ladderTouches: { 0: 12 },
    topOfLadderTouches: 1,
    finalLadder: 0,
    finalIndex: 0,
    config: {
      bankroll: 1_000,
      profitTarget: 100,
      stopLossAbs: 500,
      maxRounds: 100,
      startingLadder: 0,
    },
    strategy: {
      ladders: [{ name: "L1", stakes: [10] }],
      bridgingPolicy: "carry_over_index_delta",
      recoveryTargetPct: 0.5,
      crossoverOffset: 0,
    },
    // No recap field exists yet; the filled card remains complete without one.
    betHistory: [],
    events: [],
  };
}

const slot: TrophySlot = {
  category: "biggest_comeback",
  sessionId: "one-session",
  evidence: {
    metric: 500,
    facts: {
      minimumPnlObserved: -420,
      finalPnl: 80,
      comebackAmount: 500,
    },
    rulesVersion: 1,
  },
};

describe("TrophyCard", () => {
  it("renders a neutral empty state", () => {
    render(
      <TrophyCard
        category="perfect_run"
        onOpen={vi.fn()}
      />
    );

    expect(screen.getByText("Perfect Run")).toBeInTheDocument();
    expect(screen.getByText("Awaiting a record")).toBeInTheDocument();
    expect(screen.getByRole("button")).toBeDisabled();
  });

  it("renders a filled auditable card and opens it", () => {
    const onOpen = vi.fn();
    render(
      <TrophyCard
        category="biggest_comeback"
        slot={slot}
        snapshot={{ session: session(), preservedAt: 3_000 }}
        onOpen={onOpen}
      />
    );

    expect(screen.getByText("$500")).toBeInTheDocument();
    expect(screen.getByText("+$80")).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Open Biggest Comeback evidence" })
    );
    expect(onOpen).toHaveBeenCalledWith("biggest_comeback");
  });

  it("labels a session that owns multiple trophies", () => {
    render(
      <TrophyCard
        category="biggest_comeback"
        slot={slot}
        snapshot={{ session: session(), preservedAt: 3_000 }}
        ownerSlotCount={3}
        onOpen={vi.fn()}
      />
    );
    expect(
      screen.getByText("This session holds 3 Vault records")
    ).toBeInTheDocument();
  });
});

describe("NewVaultRecord", () => {
  it("renders a restrained multi-record summary reveal", () => {
    render(
      <NewVaultRecord
        categories={["biggest_comeback", "perfect_run"]}
      />
    );
    expect(screen.getByTestId("new-vault-record")).toHaveTextContent(
      "Biggest Comeback · Perfect Run"
    );
    expect(
      screen.getByRole("link", { name: "Open the Vault" })
    ).toHaveAttribute("href", "/vault");
  });

  it("renders nothing without a new record", () => {
    const { container } = render(<NewVaultRecord categories={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});
