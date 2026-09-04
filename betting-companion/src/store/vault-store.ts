"use client";

/**
 * Versioned, quota-safe persistence for record-setting session trophies.
 * This store is intentionally independent from ordinary history.
 */

import { create } from "zustand";
import {
  SessionResult,
  TrophyCategory,
  TrophySlot,
  VaultSessionSnapshot,
} from "@/engine/types";
import {
  compactSessionResult,
  evaluateTrophyCandidates,
  shouldReplaceTrophy,
  TROPHY_RULES_VERSION,
} from "@/engine/vault";

export const VAULT_STORAGE_KEY = "betting-vault:v1";
/** Unreadable payloads are moved here rather than overwritten. */
export const VAULT_CORRUPT_BACKUP_KEY = "betting-vault:v1:corrupt";
export const VAULT_SCHEMA_VERSION = 1;
export const VAULT_MAX_SERIALIZED_BYTES = 750_000;

const MAX_EVALUATED_SESSION_IDS = 512;
const PERSISTENCE_ERROR =
  "Trophy could not be preserved on this device. Your session history is unchanged.";

type VaultSlots = Partial<Record<TrophyCategory, TrophySlot>>;

export interface VaultPersistedState {
  readonly schemaVersion: number;
  readonly rulesVersion: number;
  readonly sessionsById: Readonly<Record<string, VaultSessionSnapshot>>;
  readonly slots: VaultSlots;
  readonly evaluatedSessionIds: readonly string[];
  readonly pendingRevealsBySessionId: Readonly<
    Record<string, readonly TrophyCategory[]>
  >;
  readonly legacyScanCompleted: boolean;
}

export interface VaultEvaluationResult {
  readonly categories: readonly TrophyCategory[];
  readonly alreadyEvaluated: boolean;
  readonly persisted: boolean;
}

export interface VaultStore extends VaultPersistedState {
  readonly initialized: boolean;
  readonly persistenceError: string | null;
  /**
   * The stored payload could not be read. Trophies preserved on this device are
   * still on disk, so nothing may be written until the user clears the Vault.
   */
  readonly storageCorrupt: boolean;

  initializeFromHistory: (sessions: readonly SessionResult[]) => void;
  evaluateSession: (session: SessionResult) => VaultEvaluationResult;
  consumeReveal: (sessionId: string) => readonly TrophyCategory[];
  clearVault: () => boolean;
  dismissPersistenceError: () => void;
}

type VaultStorage = Pick<Storage, "getItem" | "setItem">;

function emptyPersistedState(
  legacyScanCompleted = false
): VaultPersistedState {
  return {
    schemaVersion: VAULT_SCHEMA_VERSION,
    rulesVersion: TROPHY_RULES_VERSION,
    sessionsById: {},
    slots: {},
    evaluatedSessionIds: [],
    pendingRevealsBySessionId: {},
    legacyScanCompleted,
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Schema upgrades never re-evaluate trophies. A rules migration must be an
 * explicit, separately authored path.
 */
export function migrateVaultState(raw: unknown): VaultPersistedState {
  const record = asRecord(raw);
  if (!record) return emptyPersistedState();

  const sessionsById = asRecord(record.sessionsById) ?? {};
  const rawSlots = asRecord(record.slots) ?? {};
  const slots: VaultSlots = {};

  for (const category of [
    "biggest_comeback",
    "longest_survival",
    "perfect_run",
  ] as const) {
    const slot = asRecord(rawSlots[category]);
    const evidence = slot ? asRecord(slot.evidence) : null;
    // A slot without a finite metric can never be beaten (every comparison
    // against undefined is false), so drop it rather than freeze the category.
    if (
      slot &&
      slot.category === category &&
      typeof slot.sessionId === "string" &&
      evidence &&
      (typeof evidence.metric === "boolean" ||
        Number.isFinite(evidence.metric))
    ) {
      slots[category] = slot as unknown as TrophySlot;
    }
  }

  const validSnapshots = Object.fromEntries(
    Object.entries(sessionsById).filter(([, snapshot]) => {
      const snapshotRecord = asRecord(snapshot);
      return asRecord(snapshotRecord?.session) !== null;
    })
  ) as Record<string, VaultSessionSnapshot>;

  // Drop references whose preserved snapshot is missing.
  for (const category of Object.keys(slots) as TrophyCategory[]) {
    const slot = slots[category];
    if (!slot || !validSnapshots[slot.sessionId]) delete slots[category];
  }

  const evaluatedSessionIds = Array.isArray(record.evaluatedSessionIds)
    ? record.evaluatedSessionIds
        .filter((id): id is string => typeof id === "string")
        .slice(-MAX_EVALUATED_SESSION_IDS)
    : [];

  const rawReveals = asRecord(record.pendingRevealsBySessionId) ?? {};
  const pendingRevealsBySessionId = Object.fromEntries(
    Object.entries(rawReveals)
      .filter(([, categories]) => Array.isArray(categories))
      .map(([id, categories]) => [
        id,
        (categories as unknown[]).filter(
          (category): category is TrophyCategory =>
            category === "biggest_comeback" ||
            category === "longest_survival" ||
            category === "perfect_run"
        ),
      ])
  );

  return {
    schemaVersion: VAULT_SCHEMA_VERSION,
    // Preserve the prior rules version; changing it does not silently re-score.
    rulesVersion:
      typeof record.rulesVersion === "number"
        ? record.rulesVersion
        : TROPHY_RULES_VERSION,
    sessionsById: validSnapshots,
    slots,
    evaluatedSessionIds,
    pendingRevealsBySessionId,
    legacyScanCompleted: record.legacyScanCompleted === true,
  };
}

function getBrowserStorage(override?: VaultStorage): VaultStorage | null {
  if (override) return override;
  return typeof localStorage === "undefined" ? null : localStorage;
}

function serializedSize(value: string): number {
  // localStorage is UTF-16 in browsers.
  return value.length * 2;
}

function persist(
  state: VaultPersistedState,
  storageOverride?: VaultStorage
): boolean {
  const storage = getBrowserStorage(storageOverride);
  if (!storage) return false;

  const serialized = JSON.stringify(state);
  if (serializedSize(serialized) > VAULT_MAX_SERIALIZED_BYTES) return false;

  try {
    storage.setItem(VAULT_STORAGE_KEY, serialized);
    return true;
  } catch {
    return false;
  }
}

function withEvaluatedId(
  ids: readonly string[],
  sessionId: string
): readonly string[] {
  return [...ids.filter((id) => id !== sessionId), sessionId].slice(
    -MAX_EVALUATED_SESSION_IDS
  );
}

function applySessionEvaluation(
  state: VaultPersistedState,
  session: SessionResult,
  recordReveal: boolean,
  now: number
): {
  readonly state: VaultPersistedState;
  readonly categories: readonly TrophyCategory[];
  readonly alreadyEvaluated: boolean;
} {
  if (state.evaluatedSessionIds.includes(session.id)) {
    return { state, categories: [], alreadyEvaluated: true };
  }

  const candidates = evaluateTrophyCandidates(session);
  const nextSlots: VaultSlots = { ...state.slots };
  const winningCategories: TrophyCategory[] = [];

  for (const candidate of candidates) {
    if (
      shouldReplaceTrophy(
        candidate,
        session,
        nextSlots[candidate.category],
        state.sessionsById
      )
    ) {
      nextSlots[candidate.category] = {
        category: candidate.category,
        sessionId: session.id,
        evidence: candidate.evidence,
      };
      winningCategories.push(candidate.category);
    }
  }

  let sessionsById: Record<string, VaultSessionSnapshot> = {
    ...state.sessionsById,
  };
  if (winningCategories.length > 0) {
    sessionsById[session.id] = {
      session: compactSessionResult(session),
      preservedAt: now,
    };
  }

  const referencedIds = new Set(
    Object.values(nextSlots)
      .filter((slot): slot is TrophySlot => Boolean(slot))
      .map((slot) => slot.sessionId)
  );
  sessionsById = Object.fromEntries(
    Object.entries(sessionsById).filter(([id]) => referencedIds.has(id))
  );

  const pendingRevealsBySessionId = {
    ...state.pendingRevealsBySessionId,
  };
  if (recordReveal && winningCategories.length > 0) {
    pendingRevealsBySessionId[session.id] = winningCategories;
  }

  return {
    state: {
      ...state,
      sessionsById,
      slots: nextSlots,
      evaluatedSessionIds: withEvaluatedId(
        state.evaluatedSessionIds,
        session.id
      ),
      pendingRevealsBySessionId,
    },
    categories: winningCategories,
    alreadyEvaluated: false,
  };
}

function persistedSlice(state: VaultStore): VaultPersistedState {
  return {
    schemaVersion: state.schemaVersion,
    rulesVersion: state.rulesVersion,
    sessionsById: state.sessionsById,
    slots: state.slots,
    evaluatedSessionIds: state.evaluatedSessionIds,
    pendingRevealsBySessionId: state.pendingRevealsBySessionId,
    legacyScanCompleted: state.legacyScanCompleted,
  };
}

export function createVaultStore(storageOverride?: VaultStorage) {
  return create<VaultStore>()((set, get) => {
    /**
     * Load and migrate the persisted payload. Never runs the legacy scan and
     * never completes it, so a caller without real history (see
     * `evaluateSession`) cannot permanently skip importing existing sessions.
     */
    const ensureLoaded = (): {
      readonly loaded: VaultPersistedState;
      readonly needsMigrationPersistence: boolean;
      readonly corrupt: boolean;
    } => {
      const storage = getBrowserStorage(storageOverride);
      let loaded = emptyPersistedState();
      let needsMigrationPersistence = false;

      if (storage) {
        let serialized: string | null = null;
        try {
          serialized = storage.getItem(VAULT_STORAGE_KEY);
          if (serialized) {
            const raw = JSON.parse(serialized);
            needsMigrationPersistence =
              asRecord(raw)?.schemaVersion !== VAULT_SCHEMA_VERSION;
            loaded = migrateVaultState(raw);
          }
        } catch {
          // The stored payload may still hold trophies for sessions that have
          // rolled off history. Back it up and refuse to write over it.
          if (serialized !== null) {
            try {
              storage.setItem(VAULT_CORRUPT_BACKUP_KEY, serialized);
            } catch {
              // A backup is best effort; the primary key stays untouched.
            }
          }
          return {
            loaded: emptyPersistedState(),
            needsMigrationPersistence: false,
            corrupt: true,
          };
        }
      }

      return { loaded, needsMigrationPersistence, corrupt: false };
    };

    return {
    ...emptyPersistedState(),
    initialized: false,
    persistenceError: null,
    storageCorrupt: false,

    initializeFromHistory: (sessions) => {
      if (get().initialized) return;

      const { loaded, needsMigrationPersistence, corrupt } = ensureLoaded();
      if (corrupt) {
        set({
          ...emptyPersistedState(),
          initialized: true,
          storageCorrupt: true,
          persistenceError: PERSISTENCE_ERROR,
        });
        return;
      }

      let next = loaded;
      const changed =
        !loaded.legacyScanCompleted || needsMigrationPersistence;
      if (!loaded.legacyScanCompleted) {
        // Sorting is not required for correctness, but makes preservedAt stable
        // and the one-time import easy to inspect.
        const chronological = [...sessions].sort(
          (left, right) =>
            left.endTime - right.endTime || left.id.localeCompare(right.id)
        );
        for (const session of chronological) {
          next = applySessionEvaluation(
            next,
            session,
            false,
            Date.now()
          ).state;
        }
        next = { ...next, legacyScanCompleted: true };
      }

      // Commit only what reached disk: a scan that could not be written must
      // retry on the next load rather than look preserved in memory.
      const didPersist = !changed || persist(next, storageOverride);
      set(
        didPersist
          ? { ...next, initialized: true, persistenceError: null }
          : {
              ...loaded,
              initialized: true,
              persistenceError: PERSISTENCE_ERROR,
            }
      );
    },

    evaluateSession: (session) => {
      if (!get().initialized) {
        const { loaded, corrupt } = ensureLoaded();
        if (corrupt) {
          set({
            ...emptyPersistedState(),
            initialized: true,
            storageCorrupt: true,
            persistenceError: PERSISTENCE_ERROR,
          });
          return {
            categories: [],
            alreadyEvaluated: false,
            persisted: false,
          };
        }
        // Deliberately does not complete the legacy scan: only a caller with
        // real history may do that.
        set({ ...loaded, initialized: true });
      }

      if (get().storageCorrupt) {
        set({ persistenceError: PERSISTENCE_ERROR });
        return {
          categories: [],
          alreadyEvaluated: false,
          persisted: false,
        };
      }

      const current = persistedSlice(get());
      const evaluation = applySessionEvaluation(
        current,
        session,
        true,
        Date.now()
      );

      if (evaluation.alreadyEvaluated) {
        return {
          categories: [],
          alreadyEvaluated: true,
          persisted: true,
        };
      }

      if (!persist(evaluation.state, storageOverride)) {
        set({ persistenceError: PERSISTENCE_ERROR });
        return {
          categories: [],
          alreadyEvaluated: false,
          persisted: false,
        };
      }

      set({ ...evaluation.state, persistenceError: null });
      return {
        categories: evaluation.categories,
        alreadyEvaluated: false,
        persisted: true,
      };
    },

    consumeReveal: (sessionId) => {
      const state = get();
      const categories = state.pendingRevealsBySessionId[sessionId] ?? [];
      if (categories.length === 0) return [];

      const pendingRevealsBySessionId = {
        ...state.pendingRevealsBySessionId,
      };
      delete pendingRevealsBySessionId[sessionId];
      const next = {
        ...persistedSlice(state),
        pendingRevealsBySessionId,
      };

      // Clear the reveal in memory regardless: announcing it twice in one
      // session is worse than losing the record of having announced it.
      if (state.storageCorrupt || !persist(next, storageOverride)) {
        set({ pendingRevealsBySessionId, persistenceError: PERSISTENCE_ERROR });
      } else {
        set({ pendingRevealsBySessionId });
      }
      return categories;
    },

    clearVault: () => {
      // Allowed even when the stored payload is unreadable: it is the user's
      // explicit recovery action, and the original blob is already backed up.
      const next = emptyPersistedState(true);
      if (!persist(next, storageOverride)) {
        set({ persistenceError: PERSISTENCE_ERROR });
        return false;
      }
      set({
        ...next,
        initialized: true,
        storageCorrupt: false,
        persistenceError: null,
      });
      return true;
    },

    dismissPersistenceError: () => set({ persistenceError: null }),
    };
  });
}

export const useVaultStore = createVaultStore();
