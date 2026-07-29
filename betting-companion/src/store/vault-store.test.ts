import { beforeEach, describe, expect, it } from "vitest";
import { SessionResult } from "@/engine/types";
import { useHistoryStore } from "./history-store";
import {
  createVaultStore,
  migrateVaultState,
  VAULT_CORRUPT_BACKUP_KEY,
  VAULT_SCHEMA_VERSION,
  VAULT_STORAGE_KEY,
} from "./vault-store";

function session(overrides: Partial<SessionResult> = {}): SessionResult {
  return {
    id: "session-a",
    startTime: 1_000,
    endTime: 2_000,
    hitTarget: false,
    hitStopLoss: false,
    hitMaxRounds: false,
    hitTableLimit: false,
    bankrollExhausted: false,
    userStopped: true,
    finalPnl: 20,
    roundsPlayed: 10,
    totalWagered: 100,
    maxStakeSeen: 10,
    maxDrawdown: 50,
    ladderTouches: { 0: 10 },
    topOfLadderTouches: 1,
    finalLadder: 0,
    finalIndex: 0,
    config: {
      bankroll: 1_000,
      profitTarget: 100,
      stopLossAbs: 500,
      maxRounds: 100,
      startingLadder: 0,
    },
    strategy: {
      ladders: [{ name: "L1", stakes: [10] }],
      bridgingPolicy: "carry_over_index_delta",
      recoveryTargetPct: 0.5,
      crossoverOffset: 0,
    },
    betHistory: [
      {
        round: 1,
        timestamp: 1_100,
        ladder: 0,
        index: 0,
        stake: 10,
        won: false,
        pnlAfter: -50,
      },
      {
        round: 2,
        timestamp: 1_200,
        ladder: 0,
        index: 0,
        stake: 10,
        won: true,
        pnlAfter: 20,
      },
    ],
    events: [],
    ...overrides,
  };
}

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    values,
  };
}

describe("Vault store", () => {
  beforeEach(() => {
    useHistoryStore.setState({ sessions: [] });
  });

  it("stores one normalized snapshot when a session wins multiple slots", () => {
    const storage = memoryStorage();
    const store = createVaultStore(storage);
    store.getState().initializeFromHistory([]);

    const result = session({
      hitTarget: true,
      userStopped: false,
      topOfLadderTouches: 0,
    });
    const evaluation = store.getState().evaluateSession(result);

    expect(evaluation.categories).toEqual([
      "biggest_comeback",
      "longest_survival",
      "perfect_run",
    ]);
    expect(Object.keys(store.getState().sessionsById)).toEqual([result.id]);
  });

  it("garbage-collects only snapshots with no remaining slot references", () => {
    const store = createVaultStore(memoryStorage());
    store.getState().initializeFromHistory([]);
    const first = session({ id: "first", roundsPlayed: 10 });
    store.getState().evaluateSession(first);

    store.getState().evaluateSession(
      session({
        id: "survival",
        endTime: 3_000,
        roundsPlayed: 20,
        finalPnl: -10,
        betHistory: [
          {
            round: 1,
            timestamp: 1,
            ladder: 0,
            index: 0,
            stake: 10,
            won: false,
            pnlAfter: -10,
          },
        ],
      })
    );
    expect(store.getState().sessionsById.first).toBeDefined();

    store.getState().evaluateSession(
      session({
        id: "comeback",
        endTime: 4_000,
        roundsPlayed: 5,
        finalPnl: 100,
        betHistory: [
          {
            round: 1,
            timestamp: 1,
            ladder: 0,
            index: 0,
            stake: 10,
            won: false,
            pnlAfter: -200,
          },
        ],
      })
    );
    expect(store.getState().sessionsById.first).toBeUndefined();
    expect(store.getState().sessionsById.survival).toBeDefined();
    expect(store.getState().sessionsById.comeback).toBeDefined();
  });

  it("treats duplicate evaluation as a no-op", () => {
    const store = createVaultStore(memoryStorage());
    store.getState().initializeFromHistory([]);
    const result = session();

    store.getState().evaluateSession(result);
    const before = store.getState().sessionsById;
    const duplicate = store.getState().evaluateSession(result);

    expect(duplicate).toMatchObject({
      categories: [],
      alreadyEvaluated: true,
      persisted: true,
    });
    expect(store.getState().sessionsById).toBe(before);
  });

  it("keeps Vault and History clearing independent", () => {
    const store = createVaultStore(memoryStorage());
    store.getState().initializeFromHistory([]);
    const result = session();
    useHistoryStore.getState().addSession(result);
    store.getState().evaluateSession(result);

    useHistoryStore.getState().clearHistory();
    expect(store.getState().slots.biggest_comeback).toBeDefined();

    useHistoryStore.getState().addSession(result);
    store.getState().clearVault();
    expect(useHistoryStore.getState().sessions).toHaveLength(1);
    expect(store.getState().slots).toEqual({});
  });

  it("seeds legacy history once and skips an unprovable perfect run", () => {
    const storage = memoryStorage();
    const store = createVaultStore(storage);
    const legacy = session({
      id: "legacy",
      hitTarget: true,
      userStopped: false,
      events: undefined,
    });
    delete (legacy as unknown as Record<string, unknown>).topOfLadderTouches;

    store.getState().initializeFromHistory([legacy]);

    expect(store.getState().slots.longest_survival?.sessionId).toBe("legacy");
    expect(store.getState().slots.perfect_run).toBeUndefined();
    expect(store.getState().pendingRevealsBySessionId).toEqual({});

    const parsed = JSON.parse(storage.values.get(VAULT_STORAGE_KEY)!);
    expect(parsed.legacyScanCompleted).toBe(true);
  });

  it("leaves persisted trophies unchanged when localStorage quota fails", () => {
    let shouldThrow = false;
    const storage = memoryStorage();
    const quotaStorage = {
      getItem: storage.getItem,
      setItem: (key: string, value: string) => {
        if (shouldThrow) throw new DOMException("Quota", "QuotaExceededError");
        storage.setItem(key, value);
      },
    };
    const store = createVaultStore(quotaStorage);
    store.getState().initializeFromHistory([]);
    shouldThrow = true;

    const result = store.getState().evaluateSession(session());

    expect(result.persisted).toBe(false);
    expect(store.getState().slots).toEqual({});
    expect(store.getState().persistenceError).toContain(
      "could not be preserved"
    );
  });

  it("never overwrites an unreadable payload, and backs it up instead", () => {
    const storage = memoryStorage();
    // Trophies here may belong to sessions that already rolled off history.
    storage.setItem(VAULT_STORAGE_KEY, "{not json");
    const store = createVaultStore(storage);

    store.getState().initializeFromHistory([session({ id: "current" })]);

    expect(store.getState().storageCorrupt).toBe(true);
    expect(storage.values.get(VAULT_STORAGE_KEY)).toBe("{not json");
    expect(storage.values.get(VAULT_CORRUPT_BACKUP_KEY)).toBe("{not json");
    expect(store.getState().slots).toEqual({});

    const result = store.getState().evaluateSession(session({ id: "later" }));
    expect(result.persisted).toBe(false);
    expect(storage.values.get(VAULT_STORAGE_KEY)).toBe("{not json");

    // Clearing is the explicit recovery path and is still allowed.
    expect(store.getState().clearVault()).toBe(true);
    expect(store.getState().storageCorrupt).toBe(false);
  });

  it("keeps the legacy scan pending when a scan cannot be persisted", () => {
    const storage = memoryStorage();
    const quotaStorage = {
      getItem: storage.getItem,
      setItem: () => {
        throw new DOMException("Quota", "QuotaExceededError");
      },
    };
    const store = createVaultStore(quotaStorage);

    store.getState().initializeFromHistory([
      session({ id: "legacy", roundsPlayed: 40 }),
    ]);

    // Nothing reached disk, so nothing may look preserved in memory.
    expect(store.getState().slots).toEqual({});
    expect(store.getState().legacyScanCompleted).toBe(false);
    expect(storage.values.has(VAULT_STORAGE_KEY)).toBe(false);
    expect(store.getState().persistenceError).toContain(
      "could not be preserved"
    );
  });

  it("does not complete the legacy scan when evaluateSession initializes", () => {
    const storage = memoryStorage();
    const store = createVaultStore(storage);

    // No page has provided history yet; this must not mark the scan done.
    store.getState().evaluateSession(session({ id: "live" }));

    const stored = storage.values.get(VAULT_STORAGE_KEY);
    expect(stored && JSON.parse(stored).legacyScanCompleted).toBe(false);

    // A later caller with real history still imports the older session.
    const fresh = createVaultStore(storage);
    fresh
      .getState()
      .initializeFromHistory([session({ id: "legacy", roundsPlayed: 99 })]);
    expect(fresh.getState().slots.longest_survival?.sessionId).toBe("legacy");
  });

  it("drops a trophy slot whose metric cannot be compared", () => {
    const migrated = migrateVaultState({
      schemaVersion: VAULT_SCHEMA_VERSION,
      sessionsById: {
        broken: { session: session({ id: "broken" }), preservedAt: 1 },
      },
      slots: {
        longest_survival: {
          category: "longest_survival",
          sessionId: "broken",
          evidence: {},
        },
      },
      evaluatedSessionIds: [],
      legacyScanCompleted: true,
    });

    expect(migrated.slots.longest_survival).toBeUndefined();
  });

  it("migrates schema metadata without silently re-evaluating rules", () => {
    const migrated = migrateVaultState({
      schemaVersion: 0,
      rulesVersion: 7,
      sessionsById: {},
      slots: {},
      evaluatedSessionIds: ["old"],
      legacyScanCompleted: true,
    });

    expect(migrated.schemaVersion).toBe(VAULT_SCHEMA_VERSION);
    expect(migrated.rulesVersion).toBe(7);
    expect(migrated.evaluatedSessionIds).toEqual(["old"]);
    expect(migrated.slots).toEqual({});
  });

  it("writes a schema-only migration back to storage", () => {
    const storage = memoryStorage();
    storage.setItem(
      VAULT_STORAGE_KEY,
      JSON.stringify({
        schemaVersion: 0,
        rulesVersion: 1,
        sessionsById: {},
        slots: {},
        evaluatedSessionIds: ["already-scored"],
        legacyScanCompleted: true,
      })
    );
    const store = createVaultStore(storage);

    store.getState().initializeFromHistory([]);

    const saved = JSON.parse(storage.values.get(VAULT_STORAGE_KEY)!);
    expect(saved.schemaVersion).toBe(VAULT_SCHEMA_VERSION);
    expect(saved.evaluatedSessionIds).toEqual(["already-scored"]);
  });
});
