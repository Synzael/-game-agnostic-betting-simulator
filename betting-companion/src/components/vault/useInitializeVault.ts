"use client";

import { useEffect } from "react";
import { useHistoryStore, useVaultStore } from "@/store";

/**
 * Loads the Vault and runs its one-time legacy scan against real history.
 *
 * Every surface that reads trophies must call this. The store's own lazy
 * initialization deliberately never completes the legacy scan, because doing so
 * without history would permanently exclude existing sessions from trophies.
 */
export function useInitializeVault(): void {
  const sessions = useHistoryStore((state) => state.sessions);
  const initializeFromHistory = useVaultStore(
    (state) => state.initializeFromHistory
  );

  useEffect(() => {
    initializeFromHistory(sessions);
  }, [initializeFromHistory, sessions]);
}
