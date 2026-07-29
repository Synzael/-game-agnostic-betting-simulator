import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { createLadder } from "@/engine/ladder";
import { createDefaultGameSnapshot } from "@/engine/games";
import type {
  DecisionGhostForecast,
} from "@/engine/decision-ghosts";
import type {
  SessionConfig,
  SessionState,
  StrategyConfig,
} from "@/engine/types";
import { useSessionStore } from "@/store";
import { DecisionScreen } from "./DecisionScreen";

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  useDecisionGhosts: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mocks.push }),
}));

vi.mock("./useDecisionGhosts", () => ({
  useDecisionGhosts: mocks.useDecisionGhosts,
}));

const strategy: StrategyConfig = {
  ladders: [
    createLadder("L1", [10, 20]),
    createLadder("L2", [20, 40]),
  ],
  bridgingPolicy: "carry_over_index_delta",
  recoveryTargetPct: 0.5,
  crossoverOffset: 0,
};

const config: SessionConfig = {
  bankroll: 1_000,
  profitTarget: 30,
  stopLossAbs: 100,
  maxRounds: 30,
  startingLadder: 0,
};

const state: SessionState = {
  currentLadder: 0,
  currentIndex: 1,
  pnl: -30,
  rounds: 2,
  totalWagered: 30,
  maxStake: 20,
  maxDrawdown: 30,
  peakPnl: 0,
  winCount: 0,
  lossCount: 2,
  pushCount: 0,
  ladderTouches: { 0: 2, 1: 0 },
  topTouches: 1,
  stopped: false,
  stopReason: null,
  inRecovery: false,
  recoveryTargetPnl: 0,
  awaitingDecision: true,
  pendingDecisionType: "bridging",
};

const forecast: DecisionGhostForecast = {
  engineVersion: 1,
  sampleCount: 10_000,
  seed: 123,
  decisionRound: 2,
  decisionPnl: -30,
  game: createDefaultGameSnapshot(),
  futureBridgePolicy: "carry_over_index_delta",
  carryOver: {
    probHitTarget: 0.38,
    probReachRecoveryMark: 0.41,
    probTerminalFailure: 0.62,
    stopProbabilities: {
      stopLoss: 0.5,
      maxRounds: 0.02,
      tableLimit: 0.1,
      bankrollExhausted: 0,
      userStopped: 0,
    },
    medianAdditionalDrawdown: 310,
    p90AdditionalDrawdown: 500,
    medianRoundsRemaining: 18,
  },
  writeOff: {
    probHitTarget: 0.55,
    probReachRecoveryMark: null,
    probTerminalFailure: 0.45,
    stopProbabilities: {
      stopLoss: 0.4,
      maxRounds: 0.02,
      tableLimit: 0.03,
      bankrollExhausted: 0,
      userStopped: 0,
    },
    medianAdditionalDrawdown: 180,
    p90AdditionalDrawdown: 400,
    medianRoundsRemaining: 25,
  },
};

describe("DecisionScreen Decision Ghosts", () => {
  beforeEach(() => {
    mocks.push.mockReset();
    useSessionStore.setState({
      config,
      strategy,
      game: createDefaultGameSnapshot(),
      state: structuredClone(state),
      decisionMode: "at_bridging_only",
      betHistory: [],
      sessionEvents: [],
      startTime: 1,
    });
  });

  it("shows choice-specific preview metrics and an exact stop", () => {
    mocks.useDecisionGhosts.mockReturnValue({
      status: "ready",
      forecast,
      completedSamples: 10_000,
      totalSamples: 10_000,
      error: null,
    });

    render(<DecisionScreen />);

    expect(screen.getByTestId("carry-over-ghost")).toHaveTextContent(
      "41% recover"
    );
    expect(screen.getByTestId("carry-over-ghost")).toHaveTextContent(
      "Median further drop $310"
    );
    expect(screen.getByTestId("write-off-ghost")).toHaveTextContent(
      "55% reach the session target"
    );
    expect(screen.getByTestId("write-off-ghost")).toHaveTextContent(
      "Current P&L stays -$30"
    );
    expect(screen.getByText("Exact outcome")).toBeInTheDocument();
    expect(screen.getByText("Ends now at -$30")).toBeInTheDocument();
  });

  it("keeps decisions usable while the forecast is loading", () => {
    mocks.useDecisionGhosts.mockReturnValue({
      status: "loading",
      forecast: null,
      completedSamples: 500,
      totalSamples: 10_000,
      error: null,
    });

    render(<DecisionScreen />);
    fireEvent.click(screen.getByRole("button", { name: /Carry Over/i }));

    const nextState = useSessionStore.getState().state;
    expect(nextState?.awaitingDecision).toBe(false);
    expect(nextState?.currentLadder).toBe(1);
    expect(mocks.push).toHaveBeenCalledWith("/session");
  });

  it("keeps all choices visible when forecasting fails", () => {
    mocks.useDecisionGhosts.mockReturnValue({
      status: "error",
      forecast: null,
      completedSamples: 0,
      totalSamples: 10_000,
      error: "worker failed",
    });

    render(<DecisionScreen />);

    expect(
      screen.getByText("Forecast unavailable — choices still work")
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Carry Over/i })
    ).toBeEnabled();
    expect(
      screen.getByRole("button", { name: /Write Off/i })
    ).toBeEnabled();
    expect(
      screen.getByRole("button", { name: /Stop Session/i })
    ).toBeEnabled();
  });
});
