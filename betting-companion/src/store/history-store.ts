"use client";

/**
 * Session history state management with Zustand.
 * Persists completed sessions to localStorage.
 */

import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { SessionResult } from "@/engine/types";
import {
  createLegacyGameSnapshot,
  migrateLegacyBetRecords,
} from "@/engine/games";

export interface HistoryStats {
  totalSessions: number;
  winCount: number;
  lossCount: number;
  winRate: number;
  totalPnl: number;
  avgPnl: number;
  avgRounds: number;
  bestSession: number;
  worstSession: number;
}

interface HistoryStore {
  sessions: SessionResult[];

  // Actions
  addSession: (result: SessionResult) => void;
  removeSession: (id: string) => void;
  clearHistory: () => void;

  // Queries
  getSession: (id: string) => SessionResult | undefined;
  getRecentSessions: (count: number) => SessionResult[];
  getStats: () => HistoryStats;
}

export const EMPTY_HISTORY_STATS: HistoryStats = {
  totalSessions: 0,
  winCount: 0,
  lossCount: 0,
  winRate: 0,
  totalPnl: 0,
  avgPnl: 0,
  avgRounds: 0,
  bestSession: 0,
  worstSession: 0,
};

export function calculateHistoryStats(sessions: SessionResult[]): HistoryStats {
  if (sessions.length === 0) {
    return EMPTY_HISTORY_STATS;
  }

  const winCount = sessions.filter((s) => s.hitTarget).length;
  const lossCount = sessions.length - winCount;
  const totalPnl = sessions.reduce((sum, s) => sum + s.finalPnl, 0);
  const totalRounds = sessions.reduce((sum, s) => sum + s.roundsPlayed, 0);
  const pnls = sessions.map((s) => s.finalPnl);

  return {
    totalSessions: sessions.length,
    winCount,
    lossCount,
    winRate: (winCount / sessions.length) * 100,
    totalPnl,
    avgPnl: totalPnl / sessions.length,
    avgRounds: totalRounds / sessions.length,
    bestSession: Math.max(...pnls),
    worstSession: Math.min(...pnls),
  };
}

export function migrateLegacySessionResult(
  session: SessionResult
): SessionResult {
  if (session.game) return session;
  const game = createLegacyGameSnapshot();
  return {
    ...session,
    game,
    betHistory: session.betHistory
      ? migrateLegacyBetRecords(session.betHistory, game)
      : session.betHistory,
  };
}

export const useHistoryStore = create<HistoryStore>()(
  persist(
    (set, get) => ({
      sessions: [],

      addSession: (result) => {
        set((state) => {
          const existingIndex = state.sessions.findIndex(
            (session) => session.id === result.id
          );
          if (existingIndex >= 0) {
            const sessions = [...state.sessions];
            sessions[existingIndex] = result;
            return { sessions };
          }
          return {
            // Keep last 100 sessions, newest first
            sessions: [result, ...state.sessions].slice(0, 100),
          };
        });
      },

      removeSession: (id) => {
        set((state) => ({
          sessions: state.sessions.filter((s) => s.id !== id),
        }));
      },

      clearHistory: () => {
        set({ sessions: [] });
      },

      getSession: (id) => {
        return get().sessions.find((s) => s.id === id);
      },

      getRecentSessions: (count) => {
        return get().sessions.slice(0, count);
      },

      getStats: () => {
        return calculateHistoryStats(get().sessions);
      },
    }),
    {
      name: "betting-history:v1",
      version: 2,
      storage: createJSONStorage(() => localStorage),
      migrate: (persistedState, version) => {
        if (version >= 2) return persistedState as HistoryStore;
        const legacy = persistedState as Partial<HistoryStore>;
        return {
          ...legacy,
          sessions: (legacy.sessions ?? []).map(migrateLegacySessionResult),
        } as HistoryStore;
      },
    }
  )
);
