/**
 * Pure record calculations for the local trophy Vault.
 */

import {
  BetRecord,
  SessionResult,
  TrophyCategory,
  TrophyEvidence,
  TrophySlot,
  VaultSessionSnapshot,
} from "./types";

export const TROPHY_RULES_VERSION = 1;

export const TROPHY_CATEGORIES: readonly TrophyCategory[] = [
  "biggest_comeback",
  "longest_survival",
  "perfect_run",
];

export interface TrophyCandidate {
  readonly category: TrophyCategory;
  readonly evidence: TrophyEvidence;
}

const STOP_FLAGS: readonly (keyof Pick<
  SessionResult,
  | "hitTarget"
  | "hitStopLoss"
  | "hitMaxRounds"
  | "hitTableLimit"
  | "bankrollExhausted"
  | "userStopped"
>)[] = [
  "hitTarget",
  "hitStopLoss",
  "hitMaxRounds",
  "hitTableLimit",
  "bankrollExhausted",
  "userStopped",
];

export function isValidCompletedSession(
  session: SessionResult
): boolean {
  if (
    !session ||
    typeof session.id !== "string" ||
    session.id.length === 0 ||
    !Number.isFinite(session.startTime) ||
    !Number.isFinite(session.endTime) ||
    session.endTime < session.startTime ||
    !Number.isFinite(session.finalPnl) ||
    !Number.isInteger(session.roundsPlayed) ||
    session.roundsPlayed < 0 ||
    !Number.isFinite(session.totalWagered) ||
    session.totalWagered < 0
  ) {
    return false;
  }

  if (
    Object.prototype.hasOwnProperty.call(session, "topOfLadderTouches") &&
    (!Number.isFinite(session.topOfLadderTouches) ||
      session.topOfLadderTouches < 0)
  ) {
    return false;
  }

  return STOP_FLAGS.some((flag) => session[flag] === true);
}

function hasAuditableBetHistory(
  session: SessionResult
): session is SessionResult & { readonly betHistory: readonly BetRecord[] } {
  return (
    Array.isArray(session.betHistory) &&
    session.betHistory.every(
      (bet) =>
        Number.isInteger(bet.round) &&
        bet.round > 0 &&
        Number.isFinite(bet.pnlAfter)
    )
  );
}

function canProveNoBridges(session: SessionResult): boolean {
  if (Array.isArray(session.events)) {
    return !session.events.some(
      (event) =>
        event.type === "carry_over" || event.type === "write_off"
    );
  }

  // Legacy results did not always retain events. A present, trusted aggregate
  // of zero top touches is enough because bridging can only occur at the top.
  return (
    Object.prototype.hasOwnProperty.call(session, "topOfLadderTouches") &&
    session.topOfLadderTouches === 0
  );
}

export function evaluateTrophyCandidates(
  session: SessionResult
): readonly TrophyCandidate[] {
  if (!isValidCompletedSession(session)) return [];

  const candidates: TrophyCandidate[] = [];

  if (hasAuditableBetHistory(session) && session.betHistory.length > 0) {
    const minimumPnlObserved = Math.min(
      0,
      ...session.betHistory.map((bet) => bet.pnlAfter)
    );
    const comebackAmount = session.finalPnl - minimumPnlObserved;

    if (comebackAmount > 0) {
      candidates.push({
        category: "biggest_comeback",
        evidence: {
          metric: comebackAmount,
          facts: {
            minimumPnlObserved,
            finalPnl: session.finalPnl,
            comebackAmount,
          },
          rulesVersion: TROPHY_RULES_VERSION,
        },
      });
    }
  }

  if (session.roundsPlayed > 0) {
    candidates.push({
      category: "longest_survival",
      evidence: {
        metric: session.roundsPlayed,
        facts: {
          roundsPlayed: session.roundsPlayed,
          finalPnl: session.finalPnl,
        },
        rulesVersion: TROPHY_RULES_VERSION,
      },
    });
  }

  if (
    session.hitTarget === true &&
    session.topOfLadderTouches === 0 &&
    canProveNoBridges(session)
  ) {
    candidates.push({
      category: "perfect_run",
      evidence: {
        metric: true,
        facts: {
          hitTarget: true,
          topOfLadderTouches: 0,
          bridgeEvents: 0,
          finalPnl: session.finalPnl,
        },
        rulesVersion: TROPHY_RULES_VERSION,
      },
    });
  }

  return candidates;
}

function numericMetric(evidence: TrophyEvidence): number {
  return typeof evidence.metric === "boolean"
    ? Number(evidence.metric)
    : evidence.metric;
}

/**
 * Higher scores win. Equal scores stay with the earliest result, then the
 * lexicographically smaller ID.
 */
export function shouldReplaceTrophy(
  candidate: TrophyCandidate,
  candidateSession: SessionResult,
  currentSlot: TrophySlot | undefined,
  sessionsById: Readonly<Record<string, VaultSessionSnapshot>>
): boolean {
  if (!currentSlot) return true;

  const candidateMetric = numericMetric(candidate.evidence);
  const currentMetric = numericMetric(currentSlot.evidence);
  // A slot holding an unusable metric must never block the category forever.
  if (!Number.isFinite(currentMetric)) return true;
  if (candidateMetric !== currentMetric) {
    return candidateMetric > currentMetric;
  }

  const currentSession = sessionsById[currentSlot.sessionId]?.session;
  if (!currentSession) return true;

  if (candidateSession.endTime !== currentSession.endTime) {
    return candidateSession.endTime < currentSession.endTime;
  }

  return candidateSession.id.localeCompare(currentSession.id) < 0;
}

const MAX_GRAPH_POINTS = 240;

/**
 * Retain exact trophy evidence separately while bounding the graph trace.
 * First, last, trough, event rounds, and an even trace are always preferred.
 */
export function compactSessionResult(session: SessionResult): SessionResult {
  const bets = session.betHistory;
  if (!bets || bets.length <= MAX_GRAPH_POINTS) {
    return {
      ...session,
      betHistory: bets ? [...bets] : undefined,
      events: session.events ? [...session.events] : undefined,
    };
  }

  const selectedIndexes = new Set<number>([0, bets.length - 1]);
  let troughIndex = 0;
  for (let index = 1; index < bets.length; index += 1) {
    if (bets[index].pnlAfter < bets[troughIndex].pnlAfter) {
      troughIndex = index;
    }
  }
  selectedIndexes.add(troughIndex);

  const eventRounds = new Set((session.events ?? []).map((event) => event.round));
  for (let index = 0; index < bets.length; index += 1) {
    if (
      selectedIndexes.size < MAX_GRAPH_POINTS &&
      eventRounds.has(bets[index].round)
    ) {
      selectedIndexes.add(index);
    }
  }

  const remaining = Math.max(0, MAX_GRAPH_POINTS - selectedIndexes.size);
  if (remaining > 0) {
    const step = (bets.length - 1) / Math.max(1, remaining - 1);
    for (let point = 0; point < remaining; point += 1) {
      selectedIndexes.add(Math.round(point * step));
    }
  }

  const sampled = [...selectedIndexes]
    .sort((left, right) => left - right)
    .map((index) => bets[index]);

  return {
    ...session,
    betHistory: sampled,
    // Bridge events are audit evidence and are never sampled.
    events: session.events ? [...session.events] : undefined,
  };
}
