/**
 * Session simulation engine.
 * Ported from Python simulator.py SessionSimulator class.
 *
 * Key differences from Python:
 * - No RNG (real input mode only)
 * - Decision points pause for user input
 * - Immutable state updates
 */

import {
  SessionState,
  SessionConfig,
  StrategyConfig,
  BridgingDecision,
  StopReason,
  FrozenGameSnapshot,
  RecordedOutcome,
  ProgressionEffect,
} from "./types";
import { getStake, getMaxIndex } from "./ladder";
import {
  createDefaultGameSnapshot,
  resolveOutcomeSpec,
  settleOutcome,
} from "./games";
import { addMoney, subtractMoney, toMinorUnits } from "./money";

/**
 * Create initial session state.
 */
export function createInitialState(
  strategy: StrategyConfig,
  startingLadder: number = 0
): SessionState {
  const ladderTouches: Record<number, number> = {};
  strategy.ladders.forEach((_, i) => {
    ladderTouches[i] = 0;
  });

  // Clamp starting ladder to valid range
  const validStartingLadder = Math.max(
    0,
    Math.min(startingLadder, strategy.ladders.length - 1)
  );

  return {
    currentLadder: validStartingLadder,
    currentIndex: 0,
    pnl: 0,
    rounds: 0,
    totalWagered: 0,
    maxStake: 0,
    maxDrawdown: 0,
    peakPnl: 0,
    winCount: 0,
    lossCount: 0,
    pushCount: 0,
    ladderTouches,
    topTouches: 0,
    stopped: false,
    stopReason: null,
    inRecovery: false,
    recoveryTargetPnl: 0,
    awaitingDecision: false,
    pendingDecisionType: null,
  };
}

/**
 * Get current stake based on position.
 */
export function getCurrentStake(
  state: SessionState,
  strategy: StrategyConfig
): number {
  const ladder = strategy.ladders[state.currentLadder];
  return getStake(ladder, state.currentIndex);
}

/**
 * Get current bankroll (initial + pnl).
 */
export function getCurrentBankroll(
  state: SessionState,
  config: SessionConfig
): number {
  return addMoney(config.bankroll, state.pnl);
}

/**
 * Check if bankroll can afford current stake.
 */
export function canAffordStake(
  state: SessionState,
  config: SessionConfig,
  strategy: StrategyConfig
): boolean {
  const currentBankroll = getCurrentBankroll(state, config);
  return currentBankroll >= getCurrentStake(state, strategy);
}

/**
 * Check if session should stop due to table max.
 */
export function exceedsTableMax(
  state: SessionState,
  config: SessionConfig,
  strategy: StrategyConfig
): boolean {
  if (!config.tableMax) return false;
  return getCurrentStake(state, strategy) > config.tableMax;
}

/**
 * Compatibility adapter for v1 boolean inputs.
 * Returns new state - does NOT mutate input.
 */
export function processBet(
  state: SessionState,
  config: SessionConfig,
  strategy: StrategyConfig,
  won: boolean,
  decisionMode: "at_bridging_only" | "every_bet"
): SessionState {
  const game = createDefaultGameSnapshot();
  return processOutcome(
    state,
    config,
    strategy,
    game,
    won ? "win" : "loss",
    decisionMode
  );
}

/**
 * Process a typed outcome resolved against the session's frozen game snapshot.
 */
export function processOutcome(
  state: SessionState,
  config: SessionConfig,
  strategy: StrategyConfig,
  game: FrozenGameSnapshot,
  recordedOutcome: RecordedOutcome | string,
  decisionMode: "at_bridging_only" | "every_bet"
): SessionState {
  // Can't process if stopped or awaiting decision
  if (state.stopped || state.awaitingDecision) {
    return state;
  }

  const stake = getCurrentStake(state, strategy);

  // Check affordability
  if (!canAffordStake(state, config, strategy)) {
    return {
      ...state,
      stopped: true,
      stopReason: "bankroll_exhausted",
    };
  }

  // Check table max
  if (exceedsTableMax(state, config, strategy)) {
    return {
      ...state,
      stopped: true,
      stopReason: "table_limit",
    };
  }

  const outcome = resolveOutcomeSpec(game, recordedOutcome);
  const roundPnl = settleOutcome(stake, game, recordedOutcome);
  const settledPnl = addMoney(state.pnl, roundPnl);

  // Create new state with bet result
  let newState: SessionState = {
    ...state,
    pnl: settledPnl,
    rounds: state.rounds + 1,
    totalWagered: addMoney(state.totalWagered, stake),
    maxStake: Math.max(state.maxStake, stake),
    winCount:
      (state.winCount ?? 0) + Number(outcome.progressionEffect === "win"),
    lossCount:
      (state.lossCount ?? 0) + Number(outcome.progressionEffect === "loss"),
    pushCount:
      (state.pushCount ?? 0) + Number(outcome.progressionEffect === "neutral"),
    ladderTouches: {
      ...state.ladderTouches,
      [state.currentLadder]: state.ladderTouches[state.currentLadder] + 1,
    },
  };

  // Update drawdown tracking
  newState = {
    ...newState,
    peakPnl: Math.max(newState.peakPnl, newState.pnl),
    maxDrawdown: Math.max(
      newState.maxDrawdown,
      subtractMoney(newState.peakPnl, newState.pnl)
    ),
  };

  // Check session stop conditions
  if (toMinorUnits(newState.pnl) >= toMinorUnits(config.profitTarget)) {
    return { ...newState, stopped: true, stopReason: "profit_target" };
  }

  if (-toMinorUnits(newState.pnl) >= toMinorUnits(config.stopLossAbs)) {
    return { ...newState, stopped: true, stopReason: "stop_loss" };
  }

  if (newState.rounds >= config.maxRounds) {
    return { ...newState, stopped: true, stopReason: "max_rounds" };
  }

  // Step the ladder index
  newState = stepIndex(newState, strategy, outcome.progressionEffect);

  // Handle every-bet decision mode
  if (
    decisionMode === "every_bet" &&
    !newState.stopped &&
    !newState.awaitingDecision
  ) {
    newState = {
      ...newState,
      awaitingDecision: true,
      pendingDecisionType: "every_bet",
    };
  }

  return newState;
}

/**
 * Step the ladder index based on win/loss.
 * Handles bridging logic when at top of ladder.
 *
 * Base logic (ported from Python):
 * - Win: index -= 2 (move down 2 steps)
 * - Loss: index += 1 (move up 1 step)
 * - Clamp to [0, max_index] within current ladder
 */
function stepIndex(
  state: SessionState,
  strategy: StrategyConfig,
  progressionEffect: ProgressionEffect
): SessionState {
  if (progressionEffect === "neutral") {
    // A push holds the ladder position, but a recovery target that is already
    // met must still be released — otherwise a run of ties strands the player
    // on the escalated ladder that any win or loss would have exited.
    return completeRecoveryIfReached(state);
  }

  const currentLadder = strategy.ladders[state.currentLadder];
  const maxIndex = getMaxIndex(currentLadder);
  const atTopBeforeStep = state.currentIndex >= maxIndex;

  // Calculate new index
  let newIndex =
    progressionEffect === "win"
      ? state.currentIndex - 2
      : state.currentIndex + 1;

  // Check if bridging is needed (lost at top)
  const needsBridging =
    progressionEffect === "loss" && atTopBeforeStep;

  if (needsBridging) {
    return handleBridging(state, strategy);
  }

  // Normal stepping - clamp to valid range
  newIndex = Math.max(0, Math.min(newIndex, maxIndex));

  return completeRecoveryIfReached({ ...state, currentIndex: newIndex });
}

/** Release recovery once the tracked mark is reached, resetting to ladder 0. */
function completeRecoveryIfReached(state: SessionState): SessionState {
  if (state.inRecovery && state.pnl >= state.recoveryTargetPnl) {
    return {
      ...state,
      inRecovery: false,
      recoveryTargetPnl: 0,
      currentLadder: 0,
      currentIndex: 0,
    };
  }
  return state;
}

/**
 * Handle bridging when losing at top of ladder.
 * Sets awaitingDecision flag for user input.
 */
function handleBridging(
  state: SessionState,
  strategy: StrategyConfig
): SessionState {
  const atLastLadder = state.currentLadder === strategy.ladders.length - 1;

  // Track top touch
  const newState: SessionState = { ...state, topTouches: state.topTouches + 1 };

  // If using stop_at_table_limit policy, just stop
  if (strategy.bridgingPolicy === "stop_at_table_limit") {
    return {
      ...newState,
      stopped: true,
      stopReason: "table_limit",
    };
  }

  // If at last ladder, must stop
  if (atLastLadder) {
    return {
      ...newState,
      stopped: true,
      stopReason: "table_limit",
    };
  }

  // Pause for user decision (roguelike moment!)
  return {
    ...newState,
    awaitingDecision: true,
    pendingDecisionType: "bridging",
  };
}

/**
 * Process user's bridging decision.
 */
export function processBridgingDecision(
  state: SessionState,
  strategy: StrategyConfig,
  decision: BridgingDecision
): SessionState {
  if (!state.awaitingDecision) {
    return state;
  }

  // Handle every-bet continue decision
  if (state.pendingDecisionType === "every_bet") {
    if (decision === "stop_session") {
      return {
        ...state,
        stopped: true,
        stopReason: "user_stopped",
        awaitingDecision: false,
        pendingDecisionType: null,
      };
    }
    // Continue playing
    return {
      ...state,
      awaitingDecision: false,
      pendingDecisionType: null,
    };
  }

  // Handle bridging decisions
  switch (decision) {
    case "stop_session":
      return {
        ...state,
        stopped: true,
        stopReason: "user_stopped",
        awaitingDecision: false,
        pendingDecisionType: null,
      };

    case "write_off":
      // Reset to ladder 0, index 0 - accept the loss
      return {
        ...state,
        currentLadder: 0,
        currentIndex: 0,
        inRecovery: false,
        recoveryTargetPnl: 0,
        awaitingDecision: false,
        pendingDecisionType: null,
      };

    case "carry_over":
      return executeCarryOver(state, strategy);

    default:
      return state;
  }
}

/**
 * Resolve a simulation bridge from the configured policy without pausing for
 * human input. Production live sessions continue to use explicit decisions.
 */
export function processAutomatedBridge(
  state: SessionState,
  strategy: StrategyConfig
): SessionState {
  if (
    !state.awaitingDecision ||
    state.pendingDecisionType !== "bridging"
  ) {
    return state;
  }

  if (strategy.bridgingPolicy === "stop_at_table_limit") {
    return {
      ...state,
      stopped: true,
      stopReason: "table_limit",
      awaitingDecision: false,
      pendingDecisionType: null,
    };
  }

  const atLastLadder =
    state.currentLadder === strategy.ladders.length - 1;
  if (atLastLadder) {
    return {
      ...state,
      stopped: true,
      stopReason: "table_limit",
      awaitingDecision: false,
      pendingDecisionType: null,
    };
  }

  if (strategy.bridgingPolicy === "advance_to_next_ladder_start") {
    return {
      ...state,
      currentLadder: state.currentLadder + 1,
      currentIndex: 0,
      awaitingDecision: false,
      pendingDecisionType: null,
    };
  }

  return executeCarryOver(state, strategy);
}

/**
 * Execute carry over bridging logic.
 */
function executeCarryOver(
  state: SessionState,
  strategy: StrategyConfig
): SessionState {
  const newState = { ...state };

  // Enter recovery mode if not already in it
  if (!newState.inRecovery) {
    newState.inRecovery = true;

    if (newState.pnl < 0) {
      const recoveryAmount = Math.abs(newState.pnl) * strategy.recoveryTargetPct;
      newState.recoveryTargetPnl = addMoney(newState.pnl, recoveryAmount);
    } else {
      // Edge case: in profit, no recovery needed
      newState.recoveryTargetPnl = newState.pnl;
    }
  }

  // Advance to next ladder with offset
  const nextLadder = strategy.ladders[newState.currentLadder + 1];
  const maxNextIndex = getMaxIndex(nextLadder);
  const clampedOffset = Math.min(strategy.crossoverOffset, maxNextIndex);

  return {
    ...newState,
    currentLadder: newState.currentLadder + 1,
    currentIndex: clampedOffset,
    awaitingDecision: false,
    pendingDecisionType: null,
  };
}

/**
 * Calculate progress towards profit target (0-100%).
 */
export function getProfitProgress(
  state: SessionState,
  config: SessionConfig
): number {
  if (state.pnl <= 0) return 0;
  return Math.min(100, (state.pnl / config.profitTarget) * 100);
}

/**
 * Calculate progress towards stop loss (0-100%).
 */
export function getStopLossProgress(
  state: SessionState,
  config: SessionConfig
): number {
  if (state.pnl >= 0) return 0;
  return Math.min(100, (Math.abs(state.pnl) / config.stopLossAbs) * 100);
}

/**
 * Get human-readable stop reason.
 */
export function getStopReasonText(reason: StopReason): string {
  switch (reason) {
    case "profit_target":
      return "Target Reached!";
    case "stop_loss":
      return "Stop Loss Hit";
    case "max_rounds":
      return "Max Rounds Reached";
    case "table_limit":
      return "Table Limit Hit";
    case "bankroll_exhausted":
      return "Bankroll Exhausted";
    case "user_stopped":
      return "Session Ended";
    default:
      return "Session Active";
  }
}

/**
 * Check if session ended successfully (hit profit target).
 */
export function isWinningSession(state: SessionState): boolean {
  return state.stopped && state.stopReason === "profit_target";
}

/**
 * Get ladder name for display.
 */
export function getLadderName(
  state: SessionState,
  strategy: StrategyConfig
): string {
  return strategy.ladders[state.currentLadder].name;
}
