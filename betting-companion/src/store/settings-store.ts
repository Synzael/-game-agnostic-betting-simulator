"use client";

/**
 * App-wide display settings, persisted to localStorage.
 */

import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

interface SettingsStore {
  showBetNumbers: boolean;
  showVarianceFan: boolean;
  setShowBetNumbers: (show: boolean) => void;
  setShowVarianceFan: (show: boolean) => void;
}

export const useSettingsStore = create<SettingsStore>()(
  persist(
    (set) => ({
      showBetNumbers: true,
      showVarianceFan: true,

      setShowBetNumbers: (show) => set({ showBetNumbers: show }),
      setShowVarianceFan: (show) => set({ showVarianceFan: show }),
    }),
    {
      name: "app-settings:v1",
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        showBetNumbers: state.showBetNumbers,
        showVarianceFan: state.showVarianceFan,
      }),
    }
  )
);
