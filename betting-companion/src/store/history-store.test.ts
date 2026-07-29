import { describe, it, expect, beforeEach } from 'vitest';
import {
  migrateLegacySessionResult,
  useHistoryStore,
} from './history-store';
import { SessionResult, SessionConfig, StrategyConfig } from '@/engine/types';
import { createLadder } from '@/engine/ladder';

// Create a test session result
const createTestSessionResult = (overrides?: Partial<SessionResult>): SessionResult => ({
  id: 'test-id-' + Math.random().toString(36).substr(2, 9),
  startTime: Date.now() - 60000,
  endTime: Date.now(),
  hitTarget: false,
  hitStopLoss: false,
  hitMaxRounds: false,
  hitTableLimit: false,
  bankrollExhausted: false,
  userStopped: false,
  finalPnl: 0,
  roundsPlayed: 10,
  totalWagered: 500,
  maxStakeSeen: 50,
  maxDrawdown: 100,
  ladderTouches: { 0: 10 },
  topOfLadderTouches: 0,
  finalLadder: 0,
  finalIndex: 2,
  config: {
    bankroll: 1000,
    profitTarget: 500,
    stopLossAbs: 500,
    maxRounds: 100,
  } as SessionConfig,
  strategy: {
    ladders: [createLadder('L1', [10, 20, 30])],
    bridgingPolicy: 'carry_over_index_delta',
    recoveryTargetPct: 0.5,
    crossoverOffset: 0,
  } as StrategyConfig,
  ...overrides,
});

describe('useHistoryStore', () => {
  beforeEach(() => {
    // Reset store state before each test
    useHistoryStore.setState({ sessions: [] });
  });

  describe('initial state', () => {
    it('starts with empty sessions array', () => {
      const { sessions } = useHistoryStore.getState();
      expect(sessions).toEqual([]);
    });
  });

  describe('addSession', () => {
    it('adds a session to the store', () => {
      const session = createTestSessionResult();
      useHistoryStore.getState().addSession(session);

      const { sessions } = useHistoryStore.getState();
      expect(sessions.length).toBe(1);
      expect(sessions[0]).toEqual(session);
    });

    it('adds newest sessions first', () => {
      const session1 = createTestSessionResult({ id: 'first' });
      const session2 = createTestSessionResult({ id: 'second' });

      useHistoryStore.getState().addSession(session1);
      useHistoryStore.getState().addSession(session2);

      const { sessions } = useHistoryStore.getState();
      expect(sessions[0].id).toBe('second');
      expect(sessions[1].id).toBe('first');
    });

    it('limits to 100 sessions', () => {
      // Add 105 sessions
      for (let i = 0; i < 105; i++) {
        useHistoryStore.getState().addSession(
          createTestSessionResult({ id: `session-${i}` })
        );
      }

      const { sessions } = useHistoryStore.getState();
      expect(sessions.length).toBe(100);
      // Most recent should be first
      expect(sessions[0].id).toBe('session-104');
    });

    it('replaces the same result id when a late forecast snapshot arrives', () => {
      const session = createTestSessionResult({ id: 'same' });
      useHistoryStore.getState().addSession(session);
      useHistoryStore.getState().addSession({
        ...session,
        forecastSnapshot: {
          points: [],
          sampleCount: 10,
          seed: 1,
          engineVersion: 'test',
          inputFingerprint: 'input',
          anchorScheduleVersion: 1,
          terminalHandling: 'absorbing_final_pnl',
          quantileEstimator: 'r7_linear',
          gameFingerprint: 'game',
          generatedAt: 1,
          quality: 'full',
        },
      });
      expect(useHistoryStore.getState().sessions).toHaveLength(1);
      expect(
        useHistoryStore.getState().sessions[0].forecastSnapshot?.sampleCount
      ).toBe(10);
    });
  });

  describe('removeSession', () => {
    it('removes a session by id', () => {
      const session1 = createTestSessionResult({ id: 'keep' });
      const session2 = createTestSessionResult({ id: 'remove' });

      useHistoryStore.getState().addSession(session1);
      useHistoryStore.getState().addSession(session2);
      useHistoryStore.getState().removeSession('remove');

      const { sessions } = useHistoryStore.getState();
      expect(sessions.length).toBe(1);
      expect(sessions[0].id).toBe('keep');
    });

    it('does nothing if id not found', () => {
      const session = createTestSessionResult({ id: 'exists' });
      useHistoryStore.getState().addSession(session);
      useHistoryStore.getState().removeSession('nonexistent');

      const { sessions } = useHistoryStore.getState();
      expect(sessions.length).toBe(1);
    });
  });

  describe('clearHistory', () => {
    it('removes all sessions', () => {
      useHistoryStore.getState().addSession(createTestSessionResult());
      useHistoryStore.getState().addSession(createTestSessionResult());
      useHistoryStore.getState().addSession(createTestSessionResult());

      useHistoryStore.getState().clearHistory();

      const { sessions } = useHistoryStore.getState();
      expect(sessions).toEqual([]);
    });
  });

  describe('getSession', () => {
    it('returns session by id', () => {
      const session = createTestSessionResult({ id: 'find-me' });
      useHistoryStore.getState().addSession(session);

      const found = useHistoryStore.getState().getSession('find-me');
      expect(found).toEqual(session);
    });

    it('returns undefined if not found', () => {
      const found = useHistoryStore.getState().getSession('nonexistent');
      expect(found).toBeUndefined();
    });
  });

  describe('getRecentSessions', () => {
    it('returns specified number of recent sessions', () => {
      for (let i = 0; i < 5; i++) {
        useHistoryStore.getState().addSession(
          createTestSessionResult({ id: `session-${i}` })
        );
      }

      const recent = useHistoryStore.getState().getRecentSessions(3);
      expect(recent.length).toBe(3);
      expect(recent[0].id).toBe('session-4');
      expect(recent[1].id).toBe('session-3');
      expect(recent[2].id).toBe('session-2');
    });

    it('returns all sessions if count exceeds available', () => {
      useHistoryStore.getState().addSession(createTestSessionResult());
      useHistoryStore.getState().addSession(createTestSessionResult());

      const recent = useHistoryStore.getState().getRecentSessions(10);
      expect(recent.length).toBe(2);
    });

    it('returns empty array if no sessions', () => {
      const recent = useHistoryStore.getState().getRecentSessions(5);
      expect(recent).toEqual([]);
    });
  });

  describe('getStats', () => {
    it('returns empty stats when no sessions', () => {
      const stats = useHistoryStore.getState().getStats();

      expect(stats.totalSessions).toBe(0);
      expect(stats.winCount).toBe(0);
      expect(stats.lossCount).toBe(0);
      expect(stats.winRate).toBe(0);
      expect(stats.totalPnl).toBe(0);
      expect(stats.avgPnl).toBe(0);
      expect(stats.avgRounds).toBe(0);
      expect(stats.bestSession).toBe(0);
      expect(stats.worstSession).toBe(0);
    });

    it('calculates correct stats for winning sessions', () => {
      useHistoryStore.getState().addSession(
        createTestSessionResult({
          hitTarget: true,
          finalPnl: 500,
          roundsPlayed: 20,
        })
      );
      useHistoryStore.getState().addSession(
        createTestSessionResult({
          hitTarget: true,
          finalPnl: 300,
          roundsPlayed: 30,
        })
      );

      const stats = useHistoryStore.getState().getStats();

      expect(stats.totalSessions).toBe(2);
      expect(stats.winCount).toBe(2);
      expect(stats.lossCount).toBe(0);
      expect(stats.winRate).toBe(100);
      expect(stats.totalPnl).toBe(800);
      expect(stats.avgPnl).toBe(400);
      expect(stats.avgRounds).toBe(25);
      expect(stats.bestSession).toBe(500);
      expect(stats.worstSession).toBe(300);
    });

    it('calculates correct stats for losing sessions', () => {
      useHistoryStore.getState().addSession(
        createTestSessionResult({
          hitTarget: false,
          hitStopLoss: true,
          finalPnl: -500,
          roundsPlayed: 40,
        })
      );

      const stats = useHistoryStore.getState().getStats();

      expect(stats.totalSessions).toBe(1);
      expect(stats.winCount).toBe(0);
      expect(stats.lossCount).toBe(1);
      expect(stats.winRate).toBe(0);
      expect(stats.totalPnl).toBe(-500);
      expect(stats.bestSession).toBe(-500);
      expect(stats.worstSession).toBe(-500);
    });

    it('calculates correct mixed stats', () => {
      useHistoryStore.getState().addSession(
        createTestSessionResult({
          hitTarget: true,
          finalPnl: 500,
          roundsPlayed: 20,
        })
      );
      useHistoryStore.getState().addSession(
        createTestSessionResult({
          hitStopLoss: true,
          finalPnl: -300,
          roundsPlayed: 30,
        })
      );
      useHistoryStore.getState().addSession(
        createTestSessionResult({
          hitTarget: true,
          finalPnl: 200,
          roundsPlayed: 10,
        })
      );
      useHistoryStore.getState().addSession(
        createTestSessionResult({
          hitStopLoss: true,
          finalPnl: -400,
          roundsPlayed: 40,
        })
      );

      const stats = useHistoryStore.getState().getStats();

      expect(stats.totalSessions).toBe(4);
      expect(stats.winCount).toBe(2);
      expect(stats.lossCount).toBe(2);
      expect(stats.winRate).toBe(50);
      expect(stats.totalPnl).toBe(0); // 500 - 300 + 200 - 400 = 0
      expect(stats.avgPnl).toBe(0);
      expect(stats.avgRounds).toBe(25); // (20 + 30 + 10 + 40) / 4
      expect(stats.bestSession).toBe(500);
      expect(stats.worstSession).toBe(-400);
    });
  });
});

describe('legacy history migration', () => {
  it('freezes a legacy game and preserves the exact recorded pnl deltas', () => {
    const migrated = migrateLegacySessionResult(
      createTestSessionResult({
        finalPnl: 2.5,
        betHistory: [
          {
            round: 1,
            timestamp: 1,
            ladder: 0,
            index: 0,
            stake: 5,
            won: true,
            pnlAfter: 5,
          },
          {
            round: 2,
            timestamp: 2,
            ladder: 0,
            index: 0,
            stake: 5,
            won: false,
            pnlAfter: 2.5,
          },
        ],
      })
    );
    expect(migrated.game?.gameId).toBe('legacy_even_money');
    expect(migrated.betHistory?.map((bet) => bet.settledPnl)).toEqual([
      5,
      -2.5,
    ]);
    expect(migrated.finalPnl).toBe(2.5);
  });
});
