import { describe, expect, it } from "vitest";
import { createLadder } from "./ladder";
import {
  createDecisionGhostFingerprint,
  createDecisionGhostSeed,
  quantile,
  runDecisionGhostForecast,
} from "./decision-ghosts";
import type {
  DecisionGhostInput,
} from "./decision-ghosts";
import type {
  FrozenGameSnapshot,
  SessionConfig,
  SessionState,
  StrategyConfig,
} from "./types";

function createBinaryGame(pWin: number): FrozenGameSnapshot {
  return {
    gameId: `binary_${pWin}`,
    gameVersion: 1,
    gameDisplayName: `P(win) ${pWin}`,
    gameDescription: "Test fixture",
    assumptions: "Deterministic test distribution",
    fingerprint: `binary:${pWin}`,
    betVariant: {
      id: "binary",
      displayName: "Binary",
      settlementVersion: 1,
      roundingRule: "nearest_cent_half_away_from_zero",
      outcomes: [
        {
          id: "win",
          displayName: "Win",
          probability: pWin,
          netPayoutMultiplier: 1,
          progressionEffect: "win",
        },
        {
          id: "loss",
          displayName: "Loss",
          probability: 1 - pWin,
          netPayoutMultiplier: -1,
          progressionEffect: "loss",
        },
      ],
    },
  };
}

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

function pendingState(overrides: Partial<SessionState> = {}): SessionState {
  return {
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
    ...overrides,
  };
}

function input(pWin: number): DecisionGhostInput {
  return {
    state: pendingState(),
    config,
    strategy,
    game: createBinaryGame(pWin),
  };
}

describe("Decision Ghost forecasts", () => {
  it("summarizes all-win paths from both production decisions", () => {
    const forecast = runDecisionGhostForecast(input(1), {
      sampleCount: 20,
      seed: 123,
    });

    expect(forecast.carryOver.probReachRecoveryMark).toBe(1);
    expect(forecast.carryOver.probHitTarget).toBe(1);
    expect(forecast.writeOff.probHitTarget).toBe(1);
    expect(forecast.carryOver.probTerminalFailure).toBe(0);
    expect(forecast.writeOff.probTerminalFailure).toBe(0);
  });

  it("summarizes all-loss paths and additional drawdown", () => {
    const forecast = runDecisionGhostForecast(input(0), {
      sampleCount: 20,
      seed: 456,
    });

    expect(forecast.carryOver.probReachRecoveryMark).toBe(0);
    expect(forecast.carryOver.probHitTarget).toBe(0);
    expect(forecast.writeOff.probHitTarget).toBe(0);
    expect(forecast.carryOver.probTerminalFailure).toBe(1);
    expect(forecast.writeOff.probTerminalFailure).toBe(1);
    expect(forecast.carryOver.medianAdditionalDrawdown).toBeGreaterThan(0);
    expect(forecast.writeOff.medianAdditionalDrawdown).toBeGreaterThan(0);
  });

  it("is reproducible and leaves the live state untouched", () => {
    const forecastInput = input(0.495);
    const stateSnapshot = structuredClone(forecastInput.state);
    const options = { sampleCount: 100, seed: 789 };

    const first = runDecisionGhostForecast(forecastInput, options);
    const second = runDecisionGhostForecast(forecastInput, options);

    expect(first).toEqual(second);
    expect(forecastInput.state).toEqual(stateSnapshot);
  });

  it("uses canonical state fingerprints and changes seeds with state", () => {
    const first = input(0.495);
    const reordered: DecisionGhostInput = {
      game: { ...first.game },
      strategy: {
        ...first.strategy,
        ladders: first.strategy.ladders.map((ladder) => ({
          stakes: [...ladder.stakes],
          name: ladder.name,
        })),
      },
      config: { ...first.config },
      state: {
        ...first.state,
        ladderTouches: { 1: 0, 0: 2 },
      },
    };
    const changed: DecisionGhostInput = {
      ...first,
      state: { ...first.state, pnl: first.state.pnl - 1 },
    };

    expect(createDecisionGhostFingerprint(reordered)).toBe(
      createDecisionGhostFingerprint(first)
    );
    expect(createDecisionGhostSeed(changed)).not.toBe(
      createDecisionGhostSeed(first)
    );
  });

  it("calculates interpolated quantiles", () => {
    expect(quantile([0, 10, 20, 30], 0.5)).toBe(15);
    expect(quantile([0, 10, 20, 30], 0.9)).toBeCloseTo(27);
  });

  it("rejects states that are not bridging decisions", () => {
    const invalid = input(0.495);
    invalid.state.awaitingDecision = false;

    expect(() =>
      runDecisionGhostForecast(invalid, { sampleCount: 10, seed: 1 })
    ).toThrow("pending bridging decision");
  });
});
