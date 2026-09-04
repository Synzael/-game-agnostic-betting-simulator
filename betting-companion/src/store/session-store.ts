"use client";

/**
 * Session state management with Zustand.
 * Persists active session to localStorage for recovery.
 */

import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import {
  SessionState,
  SessionConfig,
  StrategyConfig,
  BridgingDecision,
  BetRecord,
  SessionEvent,
  SessionResult,
  DecisionMode,
  FrozenGameSnapshot,
  RecordedOutcome,
  VarianceForecast,
} from "@/engine/types";
import {
  createInitialState,
  processOutcome,
  processBridgingDecision,
  getCurrentStake as getStake,
  canAffordStake,
} from "@/engine/session";
import {
  createDefaultGameSnapshot,
  createLegacyGameSnapshot,
  migrateLegacyBetRecords,
  createRecordedOutcome,
  resolveOutcomeSpec,
  settleOutcome,
} from "@/engine/games";

export type ForecastStatus = "idle" | "modeling" | "ready" | "error";

interface SessionStore {
  // Configuration
  config: SessionConfig | null;
  strategy: StrategyConfig | null;
  game: FrozenGameSnapshot | null;
  decisionMode: DecisionMode;

  // Active session state
  state: SessionState | null;
  betHistory: BetRecord[];
  sessionEvents: SessionEvent[];
  startTime: number | null;
  completedResult: SessionResult | null;
  varianceForecast: VarianceForecast | null;
  forecastStatus: ForecastStatus;

  // Actions
  startSession: (
    config: SessionConfig,
    strategy: StrategyConfig,
    game?: FrozenGameSnapshot
  ) => void;
  recordOutcome: (outcome: RecordedOutcome | string) => void;
  recordBet: (won: boolean) => void;
  makeDecision: (decision: BridgingDecision) => void;
  endSession: () => SessionResult | null;
  resetSession: () => void;
  setDecisionMode: (mode: DecisionMode) => void;
  setVarianceForecast: (forecast: VarianceForecast) => void;
  setForecastStatus: (status: ForecastStatus) => void;

  // Computed helpers
  getCurrentStake: () => number;
  isDecisionPending: () => boolean;
  isSessionActive: () => boolean;
  canContinue: () => boolean;
}

export const useSessionStore = create<SessionStore>()(
  persist(
    (set, get) => ({
      config: null,
      strategy: null,
      game: null,
      decisionMode: "at_bridging_only",
      state: null,
      betHistory: [],
      sessionEvents: [],
      startTime: null,
      completedResult: null,
      varianceForecast: null,
      forecastStatus: "idle",

      startSession: (config, strategy, game = createDefaultGameSnapshot()) => {
        set({
          config,
          strategy,
          game,
          state: createInitialState(strategy, config.startingLadder),
          betHistory: [],
          sessionEvents: [],
          startTime: Date.now(),
          completedResult: null,
          varianceForecast: null,
          forecastStatus: "idle",
        });
      },

      recordOutcome: (outcomeInput) => {
        const {
          state,
          config,
          strategy,
          game,
          betHistory,
          decisionMode,
        } = get();
        if (!state || !config || !strategy || !game || state.stopped) return;

        const stake = getStake(state, strategy);
        const outcome =
          typeof outcomeInput === "string"
            ? createRecordedOutcome(game, outcomeInput)
            : outcomeInput;
        const newState = processOutcome(
          state,
          config,
          strategy,
          game,
          outcome,
          decisionMode
        );

        // The engine refuses rounds it cannot settle (awaiting a decision,
        // table limit, bankroll exhausted) and leaves `rounds` untouched.
        // Committing a bet record for those would desync betHistory from state.
        if (newState.rounds === state.rounds) {
          if (newState !== state) set({ state: newState, completedResult: null });
          return;
        }

        const outcomeSpec = resolveOutcomeSpec(game, outcome);
        const settledPnl = settleOutcome(stake, game, outcome);

        // Record bet history
        const newRecord: BetRecord = {
          round: state.rounds + 1,
          timestamp: Date.now(),
          ladder: state.currentLadder,
          index: state.currentIndex,
          stake,
          outcome,
          outcomeDisplayName: outcomeSpec.displayName,
          progressionEffect: outcomeSpec.progressionEffect,
          settledPnl,
          pnlAfter: newState.pnl,
        };

        set({
          state: newState,
          betHistory: [...betHistory, newRecord],
          completedResult: null,
        });
      },

      /** Compatibility adapter for boolean callers; production uses recordOutcome. */
      recordBet: (won) => {
        const game = get().game ?? createDefaultGameSnapshot();
        const outcomeId = game.betVariant.outcomes.find(
          (outcome) =>
            outcome.progressionEffect === (won ? "win" : "loss")
        )?.id;
        if (!outcomeId) return;
        get().recordOutcome(outcomeId);
      },

      makeDecision: (decision) => {
        const { state, strategy, sessionEvents } = get();
        if (!state || !strategy || !state.awaitingDecision) return;

        const newState = processBridgingDecision(state, strategy, decision);

        // Log roguelike adventure events for the graph. Only bridging
        // carry_over/write_off are recorded — stop/terminal outcomes are
        // derivable from stopReason.
        const isBridgingEvent =
          state.pendingDecisionType === "bridging" &&
          (decision === "carry_over" || decision === "write_off");

        const newEvent: SessionEvent | null = isBridgingEvent
          ? {
              round: state.rounds,
              timestamp: Date.now(),
              type: decision as "carry_over" | "write_off",
              pnlAt: state.pnl,
              fromLadder: state.currentLadder,
              toLadder: newState.currentLadder,
            }
          : null;

        set({
          state: newState,
          sessionEvents: newEvent ? [...sessionEvents, newEvent] : sessionEvents,
          completedResult: null,
        });
      },

      endSession: () => {
        const {
          state,
          config,
          strategy,
          betHistory,
          sessionEvents,
          startTime,
          completedResult,
          game,
          varianceForecast,
        } = get();
        if (!state || !config || !strategy || !game) return null;
        if (completedResult) {
          return completedResult.game
            ? completedResult
            : { ...completedResult, game };
        }

        const result: SessionResult = {
          id: crypto.randomUUID(),
          startTime: startTime ?? Date.now(),
          endTime: Date.now(),
          hitTarget: state.stopReason === "profit_target",
          hitStopLoss: state.stopReason === "stop_loss",
          hitMaxRounds: state.stopReason === "max_rounds",
          hitTableLimit: state.stopReason === "table_limit",
          bankrollExhausted: state.stopReason === "bankroll_exhausted",
          userStopped: state.stopReason === "user_stopped",
          finalPnl: state.pnl,
          roundsPlayed: state.rounds,
          totalWagered: state.totalWagered,
          maxStakeSeen: state.maxStake,
          maxDrawdown: state.maxDrawdown,
          ladderTouches: { ...state.ladderTouches },
          topOfLadderTouches: state.topTouches,
          finalLadder: state.currentLadder,
          finalIndex: state.currentIndex,
          config,
          strategy,
          game,
          betHistory,
          events: sessionEvents,
          forecastSnapshot: varianceForecast ?? undefined,
        };

        set({ completedResult: result });
        return result;
      },

      resetSession: () => {
        set({
          config: null,
          strategy: null,
          game: null,
          state: null,
          betHistory: [],
          sessionEvents: [],
          startTime: null,
          completedResult: null,
          varianceForecast: null,
          forecastStatus: "idle",
        });
      },

      setDecisionMode: (mode) => {
        set({ decisionMode: mode });
      },

      setVarianceForecast: (forecast) => {
        set((current) => ({
          varianceForecast: forecast,
          forecastStatus:
            forecast.quality === "full" ? "ready" : "modeling",
          completedResult: current.completedResult
            ? {
                ...current.completedResult,
                forecastSnapshot: forecast,
              }
            : null,
        }));
      },

      setForecastStatus: (status) => {
        set({ forecastStatus: status });
      },

      getCurrentStake: () => {
        const { state, strategy } = get();
        if (!state || !strategy) return 0;
        return getStake(state, strategy);
      },

      isDecisionPending: () => {
        const { state } = get();
        return state?.awaitingDecision ?? false;
      },

      isSessionActive: () => {
        const { state } = get();
        return state !== null && !state.stopped;
      },

      canContinue: () => {
        const { state, config, strategy } = get();
        if (!state || !config || !strategy) return false;
        if (state.stopped) return false;
        return canAffordStake(state, config, strategy);
      },
    }),
    {
      name: "betting-session:v1",
      version: 2,
      storage: createJSONStorage(() => localStorage),
      migrate: (persistedState, version) => {
        if (version >= 2) return persistedState as SessionStore;
        return migrateLegacySessionStore(
          persistedState as Partial<SessionStore>
        ) as SessionStore;
      },
      partialize: (state) => ({
        config: state.config,
        strategy: state.strategy,
        game: state.game,
        state: state.state,
        betHistory: state.betHistory,
        sessionEvents: state.sessionEvents,
        startTime: state.startTime,
        completedResult: state.completedResult,
        decisionMode: state.decisionMode,
        // The forecast is a large blob of band points and is deterministically
        // recomputable, so it is not written on every recorded bet. A stopped
        // session can no longer recompute it, so that one is kept.
        varianceForecast: state.state?.stopped
          ? state.varianceForecast
          : null,
        forecastStatus: state.forecastStatus,
      }),
    }
  )
);

function migrateLegacySessionStore(
  persisted: Partial<SessionStore>
): Partial<SessionStore> {
  const game = persisted.game ?? createLegacyGameSnapshot();
  const betHistory = migrateLegacyBetRecords(persisted.betHistory ?? [], game);

  const state = persisted.state
    ? {
        ...persisted.state,
        winCount:
          persisted.state.winCount ??
          betHistory.filter((bet) => bet.progressionEffect === "win").length,
        lossCount:
          persisted.state.lossCount ??
          betHistory.filter((bet) => bet.progressionEffect === "loss").length,
        pushCount:
          persisted.state.pushCount ??
          betHistory.filter((bet) => bet.progressionEffect === "neutral").length,
      }
    : null;

  return {
    ...persisted,
    game,
    state,
    betHistory,
    varianceForecast: persisted.varianceForecast ?? null,
    forecastStatus: persisted.varianceForecast ? "ready" : "idle",
  };
}
