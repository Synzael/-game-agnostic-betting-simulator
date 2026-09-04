import { describe, expect, it } from "vitest";
import { createLadder } from "./ladder";
import {
  cloneSessionState,
  createSeededRandom,
  simulateOneSession,
} from "./monte-carlo";
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
    gameDisplayName: `Binary ${pWin}`,
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
    createLadder("L2", [30, 40]),
  ],
  bridgingPolicy: "carry_over_index_delta",
  recoveryTargetPct: 0.5,
  crossoverOffset: 0,
};

const config: SessionConfig = {
  bankroll: 1_000,
  profitTarget: 25,
  stopLossAbs: 100,
  maxRounds: 30,
  startingLadder: 0,
};

function createState(overrides: Partial<SessionState> = {}): SessionState {
  return {
    currentLadder: 0,
    currentIndex: 0,
    pnl: 0,
    rounds: 0,
    totalWagered: 0,
    maxStake: 0,
    maxDrawdown: 0,
    peakPnl: 0,
    winCount: 0,
    lossCount: 0,
    pushCount: 0,
    ladderTouches: { 0: 0, 1: 0 },
    topTouches: 0,
    stopped: false,
    stopReason: null,
    inRecovery: false,
    recoveryTargetPnl: 0,
    awaitingDecision: false,
    pendingDecisionType: null,
    ...overrides,
  };
}

describe("browser Monte Carlo", () => {
  it("creates a reproducible random stream", () => {
    const first = createSeededRandom(123);
    const second = createSeededRandom(123);

    expect([first(), first(), first()]).toEqual([
      second(),
      second(),
      second(),
    ]);
  });

  it("clones the nested ladder touch record", () => {
    const original = createState();
    const cloned = cloneSessionState(original);

    cloned.ladderTouches[0] = 10;

    expect(original.ladderTouches[0]).toBe(0);
  });

  it("starts from the supplied mid-session state", () => {
    const state = createState({
      pnl: 15,
      rounds: 7,
      totalWagered: 90,
      maxStake: 20,
      peakPnl: 15,
      ladderTouches: { 0: 7, 1: 0 },
    });
    const snapshot = structuredClone(state);

    const result = simulateOneSession(
      { state, config, strategy },
      {
        seed: 1,
        game: createBinaryGame(1),
      }
    );

    expect(result.hitTarget).toBe(true);
    expect(result.finalState.pnl).toBe(25);
    expect(result.finalState.rounds).toBe(8);
    expect(result.additionalRounds).toBe(1);
    expect(state).toEqual(snapshot);
  });

  it("automatically resolves later bridges without mutating the start", () => {
    const state = createState({
      currentIndex: 1,
      pnl: 0,
      rounds: 4,
      ladderTouches: { 0: 4, 1: 0 },
    });

    const result = simulateOneSession(
      {
        state,
        config: { ...config, stopLossAbs: 45 },
        strategy,
      },
      {
        seed: 2,
        game: createBinaryGame(0),
      }
    );

    expect(result.stopReason).toBe("stop_loss");
    expect(result.finalState.currentLadder).toBe(1);
    expect(result.finalState.topTouches).toBe(1);
    expect(result.additionalDrawdown).toBe(50);
    expect(state.awaitingDecision).toBe(false);
    expect(state.topTouches).toBe(0);
  });

  it("returns identical results for identical seeds and state", () => {
    const start = {
      state: createState({ pnl: -10, rounds: 3 }),
      config,
      strategy,
    };
    const options = {
      seed: 987_654,
      game: createBinaryGame(0.5),
    };

    expect(simulateOneSession(start, options)).toEqual(
      simulateOneSession(start, options)
    );
  });

  it("tracks attainment of a supplied recovery mark", () => {
    const result = simulateOneSession(
      {
        state: createState({
          pnl: -30,
          inRecovery: true,
          recoveryTargetPnl: -15,
        }),
        config,
        strategy,
      },
      {
        seed: 3,
        recoveryTargetPnl: -15,
        game: createBinaryGame(1),
      }
    );

    expect(result.reachedRecoveryTarget).toBe(true);
  });

  it("settles commission payouts and samples neutral pushes", () => {
    const commissionGame: FrozenGameSnapshot = {
      ...createBinaryGame(1),
      gameId: "commission",
      fingerprint: "commission",
      betVariant: {
        ...createBinaryGame(1).betVariant,
        outcomes: [
          {
            id: "commission_win",
            displayName: "Commission Win",
            probability: 1,
            netPayoutMultiplier: 0.95,
            progressionEffect: "win",
          },
        ],
      },
    };
    const commissionResult = simulateOneSession(
      {
        state: createState(),
        config: { ...config, profitTarget: 9.5 },
        strategy,
      },
      { seed: 4, game: commissionGame }
    );

    expect(commissionResult.finalState.pnl).toBe(9.5);
    expect(commissionResult.stopReason).toBe("profit_target");

    const pushGame: FrozenGameSnapshot = {
      ...commissionGame,
      gameId: "push",
      fingerprint: "push",
      betVariant: {
        ...commissionGame.betVariant,
        outcomes: [
          {
            id: "push",
            displayName: "Push",
            probability: 1,
            netPayoutMultiplier: 0,
            progressionEffect: "neutral",
          },
        ],
      },
    };
    const pushResult = simulateOneSession(
      {
        state: createState({ currentIndex: 1 }),
        config: { ...config, maxRounds: 3 },
        strategy,
      },
      { seed: 5, game: pushGame }
    );

    expect(pushResult.stopReason).toBe("max_rounds");
    expect(pushResult.finalState.pnl).toBe(0);
    expect(pushResult.finalState.currentIndex).toBe(1);
    expect(pushResult.finalState.pushCount).toBe(3);
  });
});
