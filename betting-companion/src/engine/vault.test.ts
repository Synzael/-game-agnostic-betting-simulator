import { describe, expect, it } from "vitest";
import { BetRecord, SessionResult } from "./types";
import {
  compactSessionResult,
  evaluateTrophyCandidates,
  shouldReplaceTrophy,
  TROPHY_RULES_VERSION,
} from "./vault";

function bets(...pnls: number[]): BetRecord[] {
  return pnls.map((pnlAfter, index) => ({
    round: index + 1,
    timestamp: 1_000 + index,
    ladder: 0,
    index: 0,
    stake: 10,
    won: pnlAfter >= (pnls[index - 1] ?? 0),
    pnlAfter,
  }));
}

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
    roundsPlayed: 3,
    totalWagered: 30,
    maxStakeSeen: 10,
    maxDrawdown: 999,
    ladderTouches: { 0: 3 },
    topOfLadderTouches: 0,
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
    betHistory: bets(-40, -10, 20),
    events: [],
    ...overrides,
  };
}

describe("Vault trophy metrics", () => {
  it("measures comeback from the minimum observed P&L including zero", () => {
    const candidates = evaluateTrophyCandidates(
      session({
        finalPnl: 80,
        betHistory: bets(-420, -120, 80),
        maxDrawdown: 20,
      })
    );
    const comeback = candidates.find(
      (candidate) => candidate.category === "biggest_comeback"
    );

    expect(comeback?.evidence.metric).toBe(500);
    expect(comeback?.evidence.facts).toMatchObject({
      minimumPnlObserved: -420,
      finalPnl: 80,
      comebackAmount: 500,
    });
    expect(comeback?.evidence.metric).not.toBe(20);
  });

  it("does not qualify a flat or unrecovered session for comeback", () => {
    const candidates = evaluateTrophyCandidates(
      session({ finalPnl: -40, betHistory: bets(-10, -40) })
    );
    expect(
      candidates.some(
        (candidate) => candidate.category === "biggest_comeback"
      )
    ).toBe(false);
  });

  it("uses roundsPlayed as the longest recorded run metric", () => {
    const survival = evaluateTrophyCandidates(
      session({ roundsPlayed: 37 })
    ).find((candidate) => candidate.category === "longest_survival");

    expect(survival?.evidence.metric).toBe(37);
    expect(survival?.evidence.rulesVersion).toBe(TROPHY_RULES_VERSION);
  });

  it.each([
    ["Carry Over", { events: [{ round: 1, timestamp: 1, type: "carry_over" as const, pnlAt: -10, fromLadder: 0, toLadder: 1 }] }],
    ["Write Off", { events: [{ round: 1, timestamp: 1, type: "write_off" as const, pnlAt: -10, fromLadder: 1, toLadder: 0 }] }],
    ["top touch", { topOfLadderTouches: 1 }],
    ["non-target stop", { hitTarget: false, userStopped: true }],
  ])("excludes Perfect Run for %s", (_label, overrides) => {
    const candidate = evaluateTrophyCandidates(
      session({
        hitTarget: true,
        userStopped: false,
        ...overrides,
      })
    );
    expect(
      candidate.some((item) => item.category === "perfect_run")
    ).toBe(false);
  });

  it("qualifies an auditable target session with no bridges or top touches", () => {
    const candidate = evaluateTrophyCandidates(
      session({ hitTarget: true, userStopped: false })
    );
    expect(
      candidate.find((item) => item.category === "perfect_run")?.evidence
        .metric
    ).toBe(true);
  });

  it("uses deterministic end-time and ID tie-breaking", () => {
    const candidateSession = session({
      id: "a-id",
      endTime: 1_500,
      roundsPlayed: 10,
    });
    const candidate = evaluateTrophyCandidates(candidateSession).find(
      (item) => item.category === "longest_survival"
    )!;
    const current = session({
      id: "b-id",
      endTime: 2_000,
      roundsPlayed: 10,
    });
    const currentSlot = {
      category: "longest_survival" as const,
      sessionId: current.id,
      evidence: { ...candidate.evidence },
    };

    expect(
      shouldReplaceTrophy(candidate, candidateSession, currentSlot, {
        [current.id]: { session: current, preservedAt: 2_000 },
      })
    ).toBe(true);

    const laterCandidate = { ...candidateSession, id: "0-id", endTime: 3_000 };
    expect(
      shouldReplaceTrophy(candidate, laterCandidate, currentSlot, {
        [current.id]: { session: current, preservedAt: 2_000 },
      })
    ).toBe(false);
  });

  it("bounds long graph traces while retaining the trough and last point", () => {
    const longBets = bets(
      ...Array.from({ length: 1_000 }, (_, index) =>
        index === 777 ? -9_999 : index
      )
    );
    const compact = compactSessionResult(
      session({
        roundsPlayed: 1_000,
        finalPnl: 999,
        betHistory: longBets,
      })
    );

    expect(compact.betHistory!.length).toBeLessThanOrEqual(240);
    expect(compact.betHistory!.some((bet) => bet.pnlAfter === -9_999)).toBe(
      true
    );
    expect(compact.betHistory!.at(-1)?.round).toBe(1_000);
  });
});
