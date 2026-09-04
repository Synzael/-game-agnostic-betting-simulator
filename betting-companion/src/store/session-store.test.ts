import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useSessionStore } from './session-store';
import { SessionConfig, StrategyConfig } from '@/engine/types';
import { createLadder } from '@/engine/ladder';
import { createGameSnapshot } from '@/engine/games';

// Test fixtures
const createTestConfig = (): SessionConfig => ({
  bankroll: 1000,
  profitTarget: 500,
  stopLossAbs: 500,
  maxRounds: 100,
  startingLadder: 0,
});

const createTestStrategy = (): StrategyConfig => ({
  ladders: [
    createLadder('L1', [10, 20, 30, 40, 50]),
    createLadder('L2', [100, 200, 300, 400]),
  ],
  bridgingPolicy: 'carry_over_index_delta',
  recoveryTargetPct: 0.5,
  crossoverOffset: 0,
});

describe('useSessionStore', () => {
  beforeEach(() => {
    // Reset store state before each test
    useSessionStore.setState({
      config: null,
      strategy: null,
      decisionMode: 'at_bridging_only',
      state: null,
      betHistory: [],
      sessionEvents: [],
      startTime: null,
    });
  });

  describe('initial state', () => {
    it('starts with null config and strategy', () => {
      const { config, strategy } = useSessionStore.getState();
      expect(config).toBeNull();
      expect(strategy).toBeNull();
    });

    it('starts with no active session', () => {
      const { state, betHistory, startTime } = useSessionStore.getState();
      expect(state).toBeNull();
      expect(betHistory).toEqual([]);
      expect(startTime).toBeNull();
    });

    it('starts with at_bridging_only decision mode', () => {
      const { decisionMode } = useSessionStore.getState();
      expect(decisionMode).toBe('at_bridging_only');
    });
  });

  describe('startSession', () => {
    it('initializes session with config and strategy', () => {
      const config = createTestConfig();
      const strategy = createTestStrategy();

      useSessionStore.getState().startSession(config, strategy);

      const state = useSessionStore.getState();
      expect(state.config).toEqual(config);
      expect(state.strategy).toEqual(strategy);
      expect(state.state).not.toBeNull();
      expect(state.betHistory).toEqual([]);
      expect(state.startTime).not.toBeNull();
    });

    it('creates initial state at ladder 0, index 0', () => {
      const config = createTestConfig();
      const strategy = createTestStrategy();

      useSessionStore.getState().startSession(config, strategy);

      const { state } = useSessionStore.getState();
      expect(state?.currentLadder).toBe(0);
      expect(state?.currentIndex).toBe(0);
      expect(state?.pnl).toBe(0);
      expect(state?.rounds).toBe(0);
    });

    it('starts session at specified starting ladder from config', () => {
      const config = { ...createTestConfig(), startingLadder: 1 };
      const strategy = createTestStrategy();

      useSessionStore.getState().startSession(config, strategy);

      const { state } = useSessionStore.getState();
      expect(state?.currentLadder).toBe(1);
      expect(state?.currentIndex).toBe(0);
    });
  });

  describe('rounds the engine refuses', () => {
    it('records no bet when the stake exceeds the table maximum', () => {
      // Ladder starts at 10 with a table max of 5: the engine refuses the
      // round outright, so no settled bet may enter betHistory.
      const config = { ...createTestConfig(), tableMax: 5 };
      useSessionStore.getState().startSession(config, createTestStrategy());

      useSessionStore.getState().recordOutcome('win');

      const { state, betHistory } = useSessionStore.getState();
      expect(state?.stopped).toBe(true);
      expect(state?.stopReason).toBe('table_limit');
      expect(state?.rounds).toBe(0);
      expect(state?.pnl).toBe(0);
      expect(betHistory).toHaveLength(0);
    });

    it('records no bet when the session is awaiting a decision', () => {
      useSessionStore
        .getState()
        .startSession(createTestConfig(), createTestStrategy());
      useSessionStore.setState((prev) => ({
        ...prev,
        state: prev.state
          ? {
              ...prev.state,
              awaitingDecision: true,
              pendingDecisionType: 'bridging',
            }
          : null,
      }));
      const before = useSessionStore.getState().state;

      useSessionStore.getState().recordOutcome('win');

      const { state, betHistory } = useSessionStore.getState();
      expect(betHistory).toHaveLength(0);
      expect(state?.rounds).toBe(before?.rounds);
      expect(state?.pnl).toBe(before?.pnl);
    });

    it('records no bet when the bankroll cannot cover the stake', () => {
      const config = { ...createTestConfig(), bankroll: 1 };
      useSessionStore.getState().startSession(config, createTestStrategy());

      useSessionStore.getState().recordOutcome('loss');

      const { state, betHistory } = useSessionStore.getState();
      expect(state?.stopped).toBe(true);
      expect(state?.stopReason).toBe('bankroll_exhausted');
      expect(betHistory).toHaveLength(0);
    });
  });

  describe('recordBet', () => {
    beforeEach(() => {
      const config = createTestConfig();
      const strategy = createTestStrategy();
      useSessionStore.getState().startSession(config, strategy);
    });

    it('records a winning bet', () => {
      useSessionStore.getState().recordBet(true);

      const { state, betHistory } = useSessionStore.getState();
      expect(state?.pnl).toBe(10); // stake at index 0 is 10
      expect(state?.rounds).toBe(1);
      expect(betHistory.length).toBe(1);
      expect(betHistory[0].progressionEffect).toBe('win');
      expect(betHistory[0].outcome?.outcomeId).toBe('win');
      expect(betHistory[0].stake).toBe(10);
    });

    it('records a losing bet', () => {
      useSessionStore.getState().recordBet(false);

      const { state, betHistory } = useSessionStore.getState();
      expect(state?.pnl).toBe(-10);
      expect(state?.rounds).toBe(1);
      expect(betHistory.length).toBe(1);
      expect(betHistory[0].progressionEffect).toBe('loss');
      expect(betHistory[0].outcome?.outcomeId).toBe('loss');
    });

    it('does nothing if session stopped', () => {
      // Stop the session first
      useSessionStore.setState((prev) => ({
        ...prev,
        state: prev.state ? { ...prev.state, stopped: true } : null,
      }));

      useSessionStore.getState().recordBet(true);

      const { state, betHistory } = useSessionStore.getState();
      expect(state?.rounds).toBe(0);
      expect(betHistory.length).toBe(0);
    });

    it('does nothing if no active session', () => {
      useSessionStore.setState({ config: null, strategy: null, state: null });
      useSessionStore.getState().recordBet(true);

      const { betHistory } = useSessionStore.getState();
      expect(betHistory.length).toBe(0);
    });

    it('stops session when bankroll exhausted', () => {
      // Set config with very low bankroll
      useSessionStore.setState((prev) => ({
        ...prev,
        config: prev.config ? { ...prev.config, bankroll: 5 } : null,
      }));

      useSessionStore.getState().recordBet(true);

      const { state } = useSessionStore.getState();
      expect(state?.stopped).toBe(true);
      expect(state?.stopReason).toBe('bankroll_exhausted');
    });

    it('accumulates bet history', () => {
      useSessionStore.getState().recordBet(true);
      useSessionStore.getState().recordBet(false);
      useSessionStore.getState().recordBet(true);

      const { betHistory } = useSessionStore.getState();
      expect(betHistory.length).toBe(3);
      expect(betHistory[0].round).toBe(1);
      expect(betHistory[1].round).toBe(2);
      expect(betHistory[2].round).toBe(3);
    });
  });

  describe('typed multi-game outcomes', () => {
    it('records Banker commission and tie without boolean production fields', () => {
      const game = createGameSnapshot(
        'baccarat_standard_8_deck',
        'banker_5pct_commission'
      );
      useSessionStore
        .getState()
        .startSession(createTestConfig(), createTestStrategy(), game);
      useSessionStore.getState().recordOutcome('banker_win');
      useSessionStore.getState().recordOutcome('tie');

      const { state, betHistory } = useSessionStore.getState();
      expect(state?.pnl).toBe(9.5);
      expect(state?.rounds).toBe(2);
      expect(state?.winCount).toBe(1);
      expect(state?.pushCount).toBe(1);
      expect(betHistory[0].settledPnl).toBe(9.5);
      expect(betHistory[1].settledPnl).toBe(0);
      expect(betHistory[1].progressionEffect).toBe('neutral');
      expect(betHistory[1].won).toBeUndefined();
    });
  });

  describe('makeDecision', () => {
    beforeEach(() => {
      const config = createTestConfig();
      const strategy = createTestStrategy();
      useSessionStore.getState().startSession(config, strategy);
    });

    it('does nothing if not awaiting decision', () => {
      const initialState = useSessionStore.getState().state;
      useSessionStore.getState().makeDecision('stop_session');

      const { state } = useSessionStore.getState();
      expect(state?.stopped).toBe(false);
      expect(state?.awaitingDecision).toBe(initialState?.awaitingDecision);
    });

    it('processes stop_session decision', () => {
      // Set awaiting decision state
      useSessionStore.setState((prev) => ({
        ...prev,
        state: prev.state
          ? { ...prev.state, awaitingDecision: true, pendingDecisionType: 'bridging' }
          : null,
      }));

      useSessionStore.getState().makeDecision('stop_session');

      const { state } = useSessionStore.getState();
      expect(state?.stopped).toBe(true);
      expect(state?.stopReason).toBe('user_stopped');
    });

    it('processes write_off decision', () => {
      // Set up state at ladder 1 awaiting decision
      useSessionStore.setState((prev) => ({
        ...prev,
        state: prev.state
          ? {
              ...prev.state,
              currentLadder: 1,
              currentIndex: 3,
              awaitingDecision: true,
              pendingDecisionType: 'bridging',
            }
          : null,
      }));

      useSessionStore.getState().makeDecision('write_off');

      const { state } = useSessionStore.getState();
      expect(state?.currentLadder).toBe(0);
      expect(state?.currentIndex).toBe(0);
      expect(state?.awaitingDecision).toBe(false);
    });
  });

  describe('sessionEvents', () => {
    const awaitBridgingDecision = (overrides: Record<string, unknown> = {}) => {
      useSessionStore.setState((prev) => ({
        ...prev,
        state: prev.state
          ? {
              ...prev.state,
              awaitingDecision: true,
              pendingDecisionType: 'bridging' as const,
              ...overrides,
            }
          : null,
      }));
    };

    beforeEach(() => {
      const config = createTestConfig();
      const strategy = createTestStrategy();
      useSessionStore.getState().startSession(config, strategy);
    });

    it('starts with no events', () => {
      expect(useSessionStore.getState().sessionEvents).toEqual([]);
    });

    it('records a carry_over event with round, pnl, and ladder transition', () => {
      awaitBridgingDecision({
        currentLadder: 0,
        currentIndex: 4,
        rounds: 7,
        pnl: -150,
      });

      useSessionStore.getState().makeDecision('carry_over');

      const { sessionEvents, state } = useSessionStore.getState();
      expect(sessionEvents.length).toBe(1);
      expect(sessionEvents[0].type).toBe('carry_over');
      expect(sessionEvents[0].round).toBe(7);
      expect(sessionEvents[0].pnlAt).toBe(-150);
      expect(sessionEvents[0].fromLadder).toBe(0);
      expect(sessionEvents[0].toLadder).toBe(state?.currentLadder);
      expect(sessionEvents[0].timestamp).toBeDefined();
    });

    it('records a write_off event resetting to ladder 0', () => {
      awaitBridgingDecision({
        currentLadder: 1,
        currentIndex: 3,
        rounds: 12,
        pnl: -400,
      });

      useSessionStore.getState().makeDecision('write_off');

      const { sessionEvents } = useSessionStore.getState();
      expect(sessionEvents.length).toBe(1);
      expect(sessionEvents[0].type).toBe('write_off');
      expect(sessionEvents[0].round).toBe(12);
      expect(sessionEvents[0].pnlAt).toBe(-400);
      expect(sessionEvents[0].fromLadder).toBe(1);
      expect(sessionEvents[0].toLadder).toBe(0);
    });

    it('does not record an event for stop_session', () => {
      awaitBridgingDecision();
      useSessionStore.getState().makeDecision('stop_session');
      expect(useSessionStore.getState().sessionEvents).toEqual([]);
    });

    it('does not record an event for every_bet continue decisions', () => {
      useSessionStore.setState((prev) => ({
        ...prev,
        state: prev.state
          ? {
              ...prev.state,
              awaitingDecision: true,
              pendingDecisionType: 'every_bet' as const,
            }
          : null,
      }));

      useSessionStore.getState().makeDecision('carry_over');

      expect(useSessionStore.getState().sessionEvents).toEqual([]);
    });

    it('accumulates multiple events', () => {
      awaitBridgingDecision({ currentLadder: 0, currentIndex: 4 });
      useSessionStore.getState().makeDecision('carry_over');

      awaitBridgingDecision({ currentLadder: 1, currentIndex: 3 });
      useSessionStore.getState().makeDecision('write_off');

      const { sessionEvents } = useSessionStore.getState();
      expect(sessionEvents.map((event) => event.type)).toEqual([
        'carry_over',
        'write_off',
      ]);
    });

    it('clears events on startSession', () => {
      awaitBridgingDecision({ currentLadder: 1, currentIndex: 3 });
      useSessionStore.getState().makeDecision('write_off');
      expect(useSessionStore.getState().sessionEvents.length).toBe(1);

      useSessionStore.getState().startSession(createTestConfig(), createTestStrategy());
      expect(useSessionStore.getState().sessionEvents).toEqual([]);
    });

    it('clears events on resetSession', () => {
      awaitBridgingDecision({ currentLadder: 1, currentIndex: 3 });
      useSessionStore.getState().makeDecision('write_off');

      useSessionStore.getState().resetSession();
      expect(useSessionStore.getState().sessionEvents).toEqual([]);
    });

    it('includes events in endSession result', () => {
      awaitBridgingDecision({ currentLadder: 1, currentIndex: 3 });
      useSessionStore.getState().makeDecision('write_off');

      const result = useSessionStore.getState().endSession();
      expect(result?.events?.length).toBe(1);
      expect(result?.events?.[0].type).toBe('write_off');
    });
  });

  describe('endSession', () => {
    beforeEach(() => {
      const config = createTestConfig();
      const strategy = createTestStrategy();
      useSessionStore.getState().startSession(config, strategy);
    });

    it('returns null if no active session', () => {
      useSessionStore.setState({ config: null, strategy: null, state: null });
      const result = useSessionStore.getState().endSession();
      expect(result).toBeNull();
    });

    it('returns session result with all properties', () => {
      // Make some bets first
      useSessionStore.getState().recordBet(true);
      useSessionStore.getState().recordBet(false);
      useSessionStore.getState().recordBet(true);

      const result = useSessionStore.getState().endSession();

      expect(result).not.toBeNull();
      expect(result?.id).toBeDefined();
      expect(result?.startTime).toBeDefined();
      expect(result?.endTime).toBeDefined();
      // Win at stake=10 (pnl=+10), loss at stake=10 (pnl=0), win at stake=20 (pnl=+20)
      // Stakes change because wins move index down and losses move index up
      expect(result?.finalPnl).toBe(20);
      expect(result?.roundsPlayed).toBe(3);
      expect(result?.betHistory?.length).toBe(3);
    });

    it('includes correct stop reason flags', () => {
      // Set state with profit target hit
      useSessionStore.setState((prev) => ({
        ...prev,
        state: prev.state
          ? { ...prev.state, stopped: true, stopReason: 'profit_target', pnl: 500 }
          : null,
      }));

      const result = useSessionStore.getState().endSession();

      expect(result?.hitTarget).toBe(true);
      expect(result?.hitStopLoss).toBe(false);
      expect(result?.hitMaxRounds).toBe(false);
    });
  });

  describe('resetSession', () => {
    it('clears all session data', () => {
      const config = createTestConfig();
      const strategy = createTestStrategy();
      useSessionStore.getState().startSession(config, strategy);
      useSessionStore.getState().recordBet(true);

      useSessionStore.getState().resetSession();

      const state = useSessionStore.getState();
      expect(state.config).toBeNull();
      expect(state.strategy).toBeNull();
      expect(state.state).toBeNull();
      expect(state.betHistory).toEqual([]);
      expect(state.startTime).toBeNull();
    });
  });

  describe('setDecisionMode', () => {
    it('updates decision mode', () => {
      useSessionStore.getState().setDecisionMode('every_bet');
      expect(useSessionStore.getState().decisionMode).toBe('every_bet');

      useSessionStore.getState().setDecisionMode('at_bridging_only');
      expect(useSessionStore.getState().decisionMode).toBe('at_bridging_only');
    });
  });

  describe('getCurrentStake', () => {
    it('returns 0 when no session', () => {
      expect(useSessionStore.getState().getCurrentStake()).toBe(0);
    });

    it('returns current stake amount', () => {
      const config = createTestConfig();
      const strategy = createTestStrategy();
      useSessionStore.getState().startSession(config, strategy);

      expect(useSessionStore.getState().getCurrentStake()).toBe(10); // L1[0]
    });

    it('returns correct stake after position change', () => {
      const config = createTestConfig();
      const strategy = createTestStrategy();
      useSessionStore.getState().startSession(config, strategy);

      // Lose to move up
      useSessionStore.getState().recordBet(false);

      expect(useSessionStore.getState().getCurrentStake()).toBe(20); // L1[1]
    });
  });

  describe('isDecisionPending', () => {
    it('returns false when no session', () => {
      expect(useSessionStore.getState().isDecisionPending()).toBe(false);
    });

    it('returns false when not awaiting decision', () => {
      const config = createTestConfig();
      const strategy = createTestStrategy();
      useSessionStore.getState().startSession(config, strategy);

      expect(useSessionStore.getState().isDecisionPending()).toBe(false);
    });

    it('returns true when awaiting decision', () => {
      const config = createTestConfig();
      const strategy = createTestStrategy();
      useSessionStore.getState().startSession(config, strategy);

      useSessionStore.setState((prev) => ({
        ...prev,
        state: prev.state ? { ...prev.state, awaitingDecision: true } : null,
      }));

      expect(useSessionStore.getState().isDecisionPending()).toBe(true);
    });
  });

  describe('isSessionActive', () => {
    it('returns false when no session', () => {
      expect(useSessionStore.getState().isSessionActive()).toBe(false);
    });

    it('returns true for active session', () => {
      const config = createTestConfig();
      const strategy = createTestStrategy();
      useSessionStore.getState().startSession(config, strategy);

      expect(useSessionStore.getState().isSessionActive()).toBe(true);
    });

    it('returns false when session stopped', () => {
      const config = createTestConfig();
      const strategy = createTestStrategy();
      useSessionStore.getState().startSession(config, strategy);

      useSessionStore.setState((prev) => ({
        ...prev,
        state: prev.state ? { ...prev.state, stopped: true } : null,
      }));

      expect(useSessionStore.getState().isSessionActive()).toBe(false);
    });
  });

  describe('canContinue', () => {
    it('returns false when no session', () => {
      expect(useSessionStore.getState().canContinue()).toBe(false);
    });

    it('returns true when can afford stake', () => {
      const config = createTestConfig();
      const strategy = createTestStrategy();
      useSessionStore.getState().startSession(config, strategy);

      expect(useSessionStore.getState().canContinue()).toBe(true);
    });

    it('returns false when session stopped', () => {
      const config = createTestConfig();
      const strategy = createTestStrategy();
      useSessionStore.getState().startSession(config, strategy);

      useSessionStore.setState((prev) => ({
        ...prev,
        state: prev.state ? { ...prev.state, stopped: true } : null,
      }));

      expect(useSessionStore.getState().canContinue()).toBe(false);
    });

    it('returns false when cannot afford stake', () => {
      const config = createTestConfig();
      const strategy = createTestStrategy();
      useSessionStore.getState().startSession(config, strategy);

      // Set pnl to -995 so bankroll is only 5 (can't afford 10 stake)
      useSessionStore.setState((prev) => ({
        ...prev,
        state: prev.state ? { ...prev.state, pnl: -995 } : null,
      }));

      expect(useSessionStore.getState().canContinue()).toBe(false);
    });
  });
});
