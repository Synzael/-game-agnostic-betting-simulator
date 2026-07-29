import { describe, it, expect } from 'vitest';
import {
  createInitialState,
  getCurrentStake,
  getCurrentBankroll,
  canAffordStake,
  exceedsTableMax,
  processBet,
  processOutcome,
  processBridgingDecision,
  getProfitProgress,
  getStopLossProgress,
  getStopReasonText,
  isWinningSession,
  getLadderName,
} from './session';
import { createLadder } from './ladder';
import { createGameSnapshot } from './games';
import {
  BridgingDecision,
  SessionState,
  SessionConfig,
  StrategyConfig,
} from './types';

// Test fixtures
const createTestLadders = () => [
  createLadder('L1', [10, 20, 30, 40, 50]),
  createLadder('L2', [100, 200, 300, 400]),
  createLadder('L3', [1000, 2000, 3000]),
];

const createTestStrategy = (): StrategyConfig => ({
  ladders: createTestLadders(),
  bridgingPolicy: 'carry_over_index_delta',
  recoveryTargetPct: 0.5,
  crossoverOffset: 0,
});

const createTestConfig = (): SessionConfig => ({
  bankroll: 1000,
  profitTarget: 500,
  stopLossAbs: 500,
  maxRounds: 100,
  startingLadder: 0,
});

describe('createInitialState', () => {
  it('creates state at ladder 0, index 0', () => {
    const strategy = createTestStrategy();
    const state = createInitialState(strategy);

    expect(state.currentLadder).toBe(0);
    expect(state.currentIndex).toBe(0);
  });

  it('initializes all performance metrics to 0', () => {
    const strategy = createTestStrategy();
    const state = createInitialState(strategy);

    expect(state.pnl).toBe(0);
    expect(state.rounds).toBe(0);
    expect(state.totalWagered).toBe(0);
    expect(state.maxStake).toBe(0);
    expect(state.maxDrawdown).toBe(0);
    expect(state.peakPnl).toBe(0);
  });

  it('initializes ladder touches for each ladder', () => {
    const strategy = createTestStrategy();
    const state = createInitialState(strategy);

    expect(state.ladderTouches[0]).toBe(0);
    expect(state.ladderTouches[1]).toBe(0);
    expect(state.ladderTouches[2]).toBe(0);
  });

  it('sets session as active and not awaiting decision', () => {
    const strategy = createTestStrategy();
    const state = createInitialState(strategy);

    expect(state.stopped).toBe(false);
    expect(state.stopReason).toBeNull();
    expect(state.awaitingDecision).toBe(false);
    expect(state.pendingDecisionType).toBeNull();
  });

  it('sets recovery mode as inactive', () => {
    const strategy = createTestStrategy();
    const state = createInitialState(strategy);

    expect(state.inRecovery).toBe(false);
    expect(state.recoveryTargetPnl).toBe(0);
  });

  it('starts at specified ladder when startingLadder is provided', () => {
    const strategy = createTestStrategy();
    const state = createInitialState(strategy, 1);

    expect(state.currentLadder).toBe(1);
    expect(state.currentIndex).toBe(0);
  });

  it('clamps negative startingLadder to 0', () => {
    const strategy = createTestStrategy();
    const state = createInitialState(strategy, -5);

    expect(state.currentLadder).toBe(0);
  });

  it('clamps startingLadder beyond max to last ladder', () => {
    const strategy = createTestStrategy(); // 3 ladders (0, 1, 2)
    const state = createInitialState(strategy, 10);

    expect(state.currentLadder).toBe(2);
  });

  it('initializes ladder touches correctly when starting at higher ladder', () => {
    const strategy = createTestStrategy();
    const state = createInitialState(strategy, 2);

    // All ladders should still have 0 touches initially
    expect(state.ladderTouches[0]).toBe(0);
    expect(state.ladderTouches[1]).toBe(0);
    expect(state.ladderTouches[2]).toBe(0);
  });
});

describe('getCurrentStake', () => {
  it('returns stake for current position', () => {
    const strategy = createTestStrategy();
    const state = createInitialState(strategy);

    expect(getCurrentStake(state, strategy)).toBe(10);
  });

  it('returns correct stake after position change', () => {
    const strategy = createTestStrategy();
    const state = { ...createInitialState(strategy), currentIndex: 2 };

    expect(getCurrentStake(state, strategy)).toBe(30);
  });

  it('returns correct stake for different ladders', () => {
    const strategy = createTestStrategy();
    const state = { ...createInitialState(strategy), currentLadder: 1, currentIndex: 1 };

    expect(getCurrentStake(state, strategy)).toBe(200);
  });
});

describe('getCurrentBankroll', () => {
  it('returns initial bankroll when pnl is 0', () => {
    const config = createTestConfig();
    const strategy = createTestStrategy();
    const state = createInitialState(strategy);

    expect(getCurrentBankroll(state, config)).toBe(1000);
  });

  it('returns increased bankroll on positive pnl', () => {
    const config = createTestConfig();
    const strategy = createTestStrategy();
    const state = { ...createInitialState(strategy), pnl: 100 };

    expect(getCurrentBankroll(state, config)).toBe(1100);
  });

  it('returns decreased bankroll on negative pnl', () => {
    const config = createTestConfig();
    const strategy = createTestStrategy();
    const state = { ...createInitialState(strategy), pnl: -200 };

    expect(getCurrentBankroll(state, config)).toBe(800);
  });
});

describe('canAffordStake', () => {
  it('returns true when bankroll exceeds stake', () => {
    const config = createTestConfig();
    const strategy = createTestStrategy();
    const state = createInitialState(strategy);

    expect(canAffordStake(state, config, strategy)).toBe(true);
  });

  it('returns true when bankroll equals stake', () => {
    const config = { ...createTestConfig(), bankroll: 10 };
    const strategy = createTestStrategy();
    const state = createInitialState(strategy);

    expect(canAffordStake(state, config, strategy)).toBe(true);
  });

  it('returns false when bankroll is less than stake', () => {
    const config = { ...createTestConfig(), bankroll: 5 };
    const strategy = createTestStrategy();
    const state = createInitialState(strategy);

    expect(canAffordStake(state, config, strategy)).toBe(false);
  });
});

describe('exceedsTableMax', () => {
  it('returns false when no tableMax configured', () => {
    const config = createTestConfig();
    const strategy = createTestStrategy();
    const state = createInitialState(strategy);

    expect(exceedsTableMax(state, config, strategy)).toBe(false);
  });

  it('returns false when stake is under tableMax', () => {
    const config = { ...createTestConfig(), tableMax: 100 };
    const strategy = createTestStrategy();
    const state = createInitialState(strategy);

    expect(exceedsTableMax(state, config, strategy)).toBe(false);
  });

  it('returns false when stake equals tableMax', () => {
    const config = { ...createTestConfig(), tableMax: 10 };
    const strategy = createTestStrategy();
    const state = createInitialState(strategy);

    expect(exceedsTableMax(state, config, strategy)).toBe(false);
  });

  it('returns true when stake exceeds tableMax', () => {
    const config = { ...createTestConfig(), tableMax: 5 };
    const strategy = createTestStrategy();
    const state = createInitialState(strategy);

    expect(exceedsTableMax(state, config, strategy)).toBe(true);
  });
});

describe('processBet', () => {
  it('returns unchanged state if session stopped', () => {
    const config = createTestConfig();
    const strategy = createTestStrategy();
    const state = { ...createInitialState(strategy), stopped: true };

    const newState = processBet(state, config, strategy, true, 'at_bridging_only');
    expect(newState).toEqual(state);
  });

  it('returns unchanged state if awaiting decision', () => {
    const config = createTestConfig();
    const strategy = createTestStrategy();
    const state = { ...createInitialState(strategy), awaitingDecision: true };

    const newState = processBet(state, config, strategy, true, 'at_bridging_only');
    expect(newState).toEqual(state);
  });

  it('stops session if bankroll exhausted', () => {
    const config = { ...createTestConfig(), bankroll: 5 };
    const strategy = createTestStrategy();
    const state = createInitialState(strategy);

    const newState = processBet(state, config, strategy, true, 'at_bridging_only');
    expect(newState.stopped).toBe(true);
    expect(newState.stopReason).toBe('bankroll_exhausted');
  });

  it('stops session if table max exceeded', () => {
    const config = { ...createTestConfig(), tableMax: 5 };
    const strategy = createTestStrategy();
    const state = createInitialState(strategy);

    const newState = processBet(state, config, strategy, true, 'at_bridging_only');
    expect(newState.stopped).toBe(true);
    expect(newState.stopReason).toBe('table_limit');
  });

  describe('on win', () => {
    it('increases pnl by stake amount', () => {
      const config = createTestConfig();
      const strategy = createTestStrategy();
      const state = createInitialState(strategy);

      const newState = processBet(state, config, strategy, true, 'at_bridging_only');
      expect(newState.pnl).toBe(10); // stake at index 0
    });

    it('increments round counter', () => {
      const config = createTestConfig();
      const strategy = createTestStrategy();
      const state = createInitialState(strategy);

      const newState = processBet(state, config, strategy, true, 'at_bridging_only');
      expect(newState.rounds).toBe(1);
    });

    it('adds stake to totalWagered', () => {
      const config = createTestConfig();
      const strategy = createTestStrategy();
      const state = createInitialState(strategy);

      const newState = processBet(state, config, strategy, true, 'at_bridging_only');
      expect(newState.totalWagered).toBe(10);
    });

    it('moves index down by 2 (clamped to 0)', () => {
      const config = createTestConfig();
      const strategy = createTestStrategy();
      const state = { ...createInitialState(strategy), currentIndex: 3 };

      const newState = processBet(state, config, strategy, true, 'at_bridging_only');
      expect(newState.currentIndex).toBe(1); // 3 - 2 = 1
    });

    it('clamps index to 0 when already at bottom', () => {
      const config = createTestConfig();
      const strategy = createTestStrategy();
      const state = createInitialState(strategy);

      const newState = processBet(state, config, strategy, true, 'at_bridging_only');
      expect(newState.currentIndex).toBe(0); // 0 - 2 = -2, clamped to 0
    });
  });

  describe('on loss', () => {
    it('decreases pnl by stake amount', () => {
      const config = createTestConfig();
      const strategy = createTestStrategy();
      const state = createInitialState(strategy);

      const newState = processBet(state, config, strategy, false, 'at_bridging_only');
      expect(newState.pnl).toBe(-10);
    });

    it('moves index up by 1', () => {
      const config = createTestConfig();
      const strategy = createTestStrategy();
      const state = createInitialState(strategy);

      const newState = processBet(state, config, strategy, false, 'at_bridging_only');
      expect(newState.currentIndex).toBe(1);
    });

    it('tracks ladder touches', () => {
      const config = createTestConfig();
      const strategy = createTestStrategy();
      const state = createInitialState(strategy);

      const newState = processBet(state, config, strategy, false, 'at_bridging_only');
      expect(newState.ladderTouches[0]).toBe(1);
    });
  });

  describe('stop conditions', () => {
    it('stops on profit target reached', () => {
      const config = { ...createTestConfig(), profitTarget: 5 };
      const strategy = createTestStrategy();
      const state = createInitialState(strategy);

      const newState = processBet(state, config, strategy, true, 'at_bridging_only');
      expect(newState.stopped).toBe(true);
      expect(newState.stopReason).toBe('profit_target');
    });

    it('stops on stop loss hit', () => {
      const config = { ...createTestConfig(), stopLossAbs: 5 };
      const strategy = createTestStrategy();
      const state = createInitialState(strategy);

      const newState = processBet(state, config, strategy, false, 'at_bridging_only');
      expect(newState.stopped).toBe(true);
      expect(newState.stopReason).toBe('stop_loss');
    });

    it('stops on max rounds reached', () => {
      const config = { ...createTestConfig(), maxRounds: 1 };
      const strategy = createTestStrategy();
      const state = createInitialState(strategy);

      const newState = processBet(state, config, strategy, true, 'at_bridging_only');
      expect(newState.stopped).toBe(true);
      expect(newState.stopReason).toBe('max_rounds');
    });
  });

  describe('bridging at top of ladder', () => {
    it('triggers bridging decision when losing at top', () => {
      const config = createTestConfig();
      const strategy = createTestStrategy();
      const state = { ...createInitialState(strategy), currentIndex: 4 }; // top of L1

      const newState = processBet(state, config, strategy, false, 'at_bridging_only');
      expect(newState.awaitingDecision).toBe(true);
      expect(newState.pendingDecisionType).toBe('bridging');
      expect(newState.topTouches).toBe(1);
    });

    it('stops at table limit when at last ladder', () => {
      // Higher bankroll and stopLoss to avoid other stop conditions
      const config = { ...createTestConfig(), bankroll: 100000, stopLossAbs: 100000 };
      const strategy = createTestStrategy();
      const state = { ...createInitialState(strategy), currentLadder: 2, currentIndex: 2 }; // top of L3

      const newState = processBet(state, config, strategy, false, 'at_bridging_only');
      expect(newState.stopped).toBe(true);
      expect(newState.stopReason).toBe('table_limit');
    });

    it('stops immediately with stop_at_table_limit policy', () => {
      const config = createTestConfig();
      const strategy = { ...createTestStrategy(), bridgingPolicy: 'stop_at_table_limit' as const };
      const state = { ...createInitialState(strategy), currentIndex: 4 };

      const newState = processBet(state, config, strategy, false, 'at_bridging_only');
      expect(newState.stopped).toBe(true);
      expect(newState.stopReason).toBe('table_limit');
    });
  });

  describe('every_bet decision mode', () => {
    it('sets awaiting decision after each bet', () => {
      const config = createTestConfig();
      const strategy = createTestStrategy();
      const state = createInitialState(strategy);

      const newState = processBet(state, config, strategy, true, 'every_bet');
      expect(newState.awaitingDecision).toBe(true);
      expect(newState.pendingDecisionType).toBe('every_bet');
    });
  });

  describe('drawdown tracking', () => {
    it('tracks peak pnl', () => {
      const config = createTestConfig();
      const strategy = createTestStrategy();
      const state = createInitialState(strategy);

      const newState = processBet(state, config, strategy, true, 'at_bridging_only');
      expect(newState.peakPnl).toBe(10);
    });

    it('tracks max drawdown', () => {
      const config = createTestConfig();
      const strategy = createTestStrategy();
      const state = { ...createInitialState(strategy), pnl: 50, peakPnl: 50 };

      const newState = processBet(state, config, strategy, false, 'at_bridging_only');
      // Lost 10 (stake at index 0), pnl becomes 40, drawdown = 50 - 40 = 10
      expect(newState.maxDrawdown).toBe(10);
    });
  });

  describe('recovery mode', () => {
    it('exits recovery mode when recovery target reached', () => {
      const config = createTestConfig();
      const strategy = createTestStrategy();
      const state: SessionState = {
        ...createInitialState(strategy),
        currentIndex: 2,
        inRecovery: true,
        recoveryTargetPnl: -50,
        pnl: -80,
      };

      // Win should bring pnl to -50 or higher (stake at index 2 is 30)
      const newState = processBet(state, config, strategy, true, 'at_bridging_only');
      expect(newState.pnl).toBe(-50); // -80 + 30
      expect(newState.inRecovery).toBe(false);
      expect(newState.recoveryTargetPnl).toBe(0);
      expect(newState.currentLadder).toBe(0);
      expect(newState.currentIndex).toBe(0);
    });

    it('exits recovery on a push once the target is already met', () => {
      const config = createTestConfig();
      const strategy = createTestStrategy();
      const game = createGameSnapshot('baccarat_standard_8_deck', 'banker_5pct_commission');
      const state: SessionState = {
        ...createInitialState(strategy),
        currentLadder: 1,
        currentIndex: 2,
        inRecovery: true,
        // Already satisfied, as after carrying over while in profit.
        recoveryTargetPnl: -50,
        pnl: -20,
      };

      // A tie settles to zero and holds the ladder, but must not strand the
      // player in recovery when the mark has already been reached.
      const newState = processOutcome(
        state,
        config,
        strategy,
        game,
        'tie',
        'at_bridging_only'
      );

      expect(newState.pnl).toBe(-20);
      expect(newState.rounds).toBe(1);
      expect(newState.inRecovery).toBe(false);
      expect(newState.currentLadder).toBe(0);
      expect(newState.currentIndex).toBe(0);
    });

    it('holds ladder position on a push while recovery is unmet', () => {
      const config = createTestConfig();
      const strategy = createTestStrategy();
      const game = createGameSnapshot('baccarat_standard_8_deck', 'banker_5pct_commission');
      const state: SessionState = {
        ...createInitialState(strategy),
        currentLadder: 1,
        currentIndex: 2,
        inRecovery: true,
        recoveryTargetPnl: -50,
        pnl: -80,
      };

      const newState = processOutcome(
        state,
        config,
        strategy,
        game,
        'tie',
        'at_bridging_only'
      );

      expect(newState.inRecovery).toBe(true);
      expect(newState.currentLadder).toBe(1);
      expect(newState.currentIndex).toBe(2);
    });
  });
});

describe('processBridgingDecision', () => {
  it('returns unchanged state if not awaiting decision', () => {
    const strategy = createTestStrategy();
    const state = createInitialState(strategy);

    const newState = processBridgingDecision(state, strategy, 'stop_session');
    expect(newState).toEqual(state);
  });

  describe('stop_session decision', () => {
    it('stops session with user_stopped reason', () => {
      const strategy = createTestStrategy();
      const state: SessionState = {
        ...createInitialState(strategy),
        awaitingDecision: true,
        pendingDecisionType: 'bridging',
      };

      const newState = processBridgingDecision(state, strategy, 'stop_session');
      expect(newState.stopped).toBe(true);
      expect(newState.stopReason).toBe('user_stopped');
      expect(newState.awaitingDecision).toBe(false);
    });
  });

  describe('write_off decision', () => {
    it('resets to ladder 0, index 0', () => {
      const strategy = createTestStrategy();
      const state: SessionState = {
        ...createInitialState(strategy),
        currentLadder: 1,
        currentIndex: 3,
        awaitingDecision: true,
        pendingDecisionType: 'bridging',
        inRecovery: true,
        recoveryTargetPnl: -100,
      };

      const newState = processBridgingDecision(state, strategy, 'write_off');
      expect(newState.currentLadder).toBe(0);
      expect(newState.currentIndex).toBe(0);
      expect(newState.inRecovery).toBe(false);
      expect(newState.recoveryTargetPnl).toBe(0);
      expect(newState.awaitingDecision).toBe(false);
    });
  });

  describe('carry_over decision', () => {
    it('advances to next ladder with offset', () => {
      const strategy = createTestStrategy();
      const state: SessionState = {
        ...createInitialState(strategy),
        currentIndex: 4, // top of L1
        awaitingDecision: true,
        pendingDecisionType: 'bridging',
        pnl: -100,
      };

      const newState = processBridgingDecision(state, strategy, 'carry_over');
      expect(newState.currentLadder).toBe(1);
      expect(newState.currentIndex).toBe(0); // crossoverOffset is 0
      expect(newState.awaitingDecision).toBe(false);
    });

    it('enters recovery mode with correct target', () => {
      const strategy = createTestStrategy();
      const state: SessionState = {
        ...createInitialState(strategy),
        currentIndex: 4,
        awaitingDecision: true,
        pendingDecisionType: 'bridging',
        pnl: -100,
      };

      const newState = processBridgingDecision(state, strategy, 'carry_over');
      expect(newState.inRecovery).toBe(true);
      expect(newState.recoveryTargetPnl).toBe(-50); // -100 + (100 * 0.5)
    });

    it('respects crossover offset', () => {
      const strategy = { ...createTestStrategy(), crossoverOffset: 2 };
      const state: SessionState = {
        ...createInitialState(strategy),
        currentIndex: 4,
        awaitingDecision: true,
        pendingDecisionType: 'bridging',
        pnl: -100,
      };

      const newState = processBridgingDecision(state, strategy, 'carry_over');
      expect(newState.currentIndex).toBe(2);
    });

    it('clamps offset to max index of next ladder', () => {
      const strategy = { ...createTestStrategy(), crossoverOffset: 10 }; // higher than L2 max index
      const state: SessionState = {
        ...createInitialState(strategy),
        currentIndex: 4,
        awaitingDecision: true,
        pendingDecisionType: 'bridging',
        pnl: -100,
      };

      const newState = processBridgingDecision(state, strategy, 'carry_over');
      expect(newState.currentIndex).toBe(3); // L2 max index is 3
    });

    it('handles positive pnl edge case', () => {
      const strategy = createTestStrategy();
      const state: SessionState = {
        ...createInitialState(strategy),
        currentIndex: 4,
        awaitingDecision: true,
        pendingDecisionType: 'bridging',
        pnl: 50, // positive pnl
      };

      const newState = processBridgingDecision(state, strategy, 'carry_over');
      expect(newState.inRecovery).toBe(true);
      expect(newState.recoveryTargetPnl).toBe(50); // same as pnl
    });
  });

  describe('every_bet decision handling', () => {
    it('continues playing when not stop_session', () => {
      const strategy = createTestStrategy();
      const state: SessionState = {
        ...createInitialState(strategy),
        awaitingDecision: true,
        pendingDecisionType: 'every_bet',
      };

      const newState = processBridgingDecision(state, strategy, 'carry_over');
      expect(newState.awaitingDecision).toBe(false);
      expect(newState.stopped).toBe(false);
    });

    it('stops on stop_session', () => {
      const strategy = createTestStrategy();
      const state: SessionState = {
        ...createInitialState(strategy),
        awaitingDecision: true,
        pendingDecisionType: 'every_bet',
      };

      const newState = processBridgingDecision(state, strategy, 'stop_session');
      expect(newState.stopped).toBe(true);
      expect(newState.stopReason).toBe('user_stopped');
    });
  });

  describe('invalid decision', () => {
    it('returns unchanged state for unknown decision type', () => {
      const strategy = createTestStrategy();
      const state: SessionState = {
        ...createInitialState(strategy),
        awaitingDecision: true,
        pendingDecisionType: 'bridging',
      };

      // Force an invalid decision type to test default case
      const newState = processBridgingDecision(
        state,
        strategy,
        'invalid' as BridgingDecision
      );
      expect(newState).toEqual(state);
    });
  });
});

describe('getProfitProgress', () => {
  it('returns 0 when pnl is 0', () => {
    const config = createTestConfig();
    const state = createInitialState(createTestStrategy());

    expect(getProfitProgress(state, config)).toBe(0);
  });

  it('returns 0 when pnl is negative', () => {
    const config = createTestConfig();
    const state = { ...createInitialState(createTestStrategy()), pnl: -100 };

    expect(getProfitProgress(state, config)).toBe(0);
  });

  it('returns correct percentage when positive', () => {
    const config = createTestConfig(); // profitTarget: 500
    const state = { ...createInitialState(createTestStrategy()), pnl: 250 };

    expect(getProfitProgress(state, config)).toBe(50);
  });

  it('caps at 100%', () => {
    const config = createTestConfig();
    const state = { ...createInitialState(createTestStrategy()), pnl: 1000 };

    expect(getProfitProgress(state, config)).toBe(100);
  });
});

describe('getStopLossProgress', () => {
  it('returns 0 when pnl is 0', () => {
    const config = createTestConfig();
    const state = createInitialState(createTestStrategy());

    expect(getStopLossProgress(state, config)).toBe(0);
  });

  it('returns 0 when pnl is positive', () => {
    const config = createTestConfig();
    const state = { ...createInitialState(createTestStrategy()), pnl: 100 };

    expect(getStopLossProgress(state, config)).toBe(0);
  });

  it('returns correct percentage when negative', () => {
    const config = createTestConfig(); // stopLossAbs: 500
    const state = { ...createInitialState(createTestStrategy()), pnl: -250 };

    expect(getStopLossProgress(state, config)).toBe(50);
  });

  it('caps at 100%', () => {
    const config = createTestConfig();
    const state = { ...createInitialState(createTestStrategy()), pnl: -1000 };

    expect(getStopLossProgress(state, config)).toBe(100);
  });
});

describe('getStopReasonText', () => {
  it('returns correct text for each stop reason', () => {
    expect(getStopReasonText('profit_target')).toBe('Target Reached!');
    expect(getStopReasonText('stop_loss')).toBe('Stop Loss Hit');
    expect(getStopReasonText('max_rounds')).toBe('Max Rounds Reached');
    expect(getStopReasonText('table_limit')).toBe('Table Limit Hit');
    expect(getStopReasonText('bankroll_exhausted')).toBe('Bankroll Exhausted');
    expect(getStopReasonText('user_stopped')).toBe('Session Ended');
    expect(getStopReasonText(null)).toBe('Session Active');
  });
});

describe('isWinningSession', () => {
  it('returns true when stopped with profit_target', () => {
    const state: SessionState = {
      ...createInitialState(createTestStrategy()),
      stopped: true,
      stopReason: 'profit_target',
    };

    expect(isWinningSession(state)).toBe(true);
  });

  it('returns false when stopped with other reasons', () => {
    const stopReasons = ['stop_loss', 'max_rounds', 'table_limit', 'bankroll_exhausted', 'user_stopped'] as const;

    stopReasons.forEach((reason) => {
      const state: SessionState = {
        ...createInitialState(createTestStrategy()),
        stopped: true,
        stopReason: reason,
      };
      expect(isWinningSession(state)).toBe(false);
    });
  });

  it('returns false when not stopped', () => {
    const state = createInitialState(createTestStrategy());
    expect(isWinningSession(state)).toBe(false);
  });
});

describe('getLadderName', () => {
  it('returns current ladder name', () => {
    const strategy = createTestStrategy();
    const state = createInitialState(strategy);

    expect(getLadderName(state, strategy)).toBe('L1');
  });

  it('returns correct name for different ladders', () => {
    const strategy = createTestStrategy();
    const state = { ...createInitialState(strategy), currentLadder: 1 };

    expect(getLadderName(state, strategy)).toBe('L2');
  });
});
