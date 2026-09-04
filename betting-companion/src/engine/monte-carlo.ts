/**
 * Browser-side Monte Carlo primitives.
 *
 * The live engine accepts real win/loss input. This module supplies a seeded
 * outcome source and runs that same engine from an arbitrary SessionState.
 * It deliberately has no browser APIs so it can run in a Web Worker and in
 * deterministic unit tests.
 */

import {
  FrozenGameSnapshot,
  SessionConfig,
  SessionState,
  StopReason,
  StrategyConfig,
} from "./types";
import {
  processAutomatedBridge,
  processBridgingDecision,
  processOutcome,
} from "./session";
import { createDefaultGameSnapshot } from "./games";
import { subtractMoney, toMinorUnits } from "./money";

export type SimulationGameSpec = FrozenGameSnapshot;

export const DEFAULT_SIMULATION_GAME: SimulationGameSpec =
  createDefaultGameSnapshot();

export interface SessionSimulationStart {
  readonly state: SessionState;
  readonly config: SessionConfig;
  readonly strategy: StrategyConfig;
}

export interface SimulateOneSessionOptions {
  readonly seed: number;
  readonly game?: SimulationGameSpec;
  /**
   * Optional mark whose first attainment should be tracked. Decision Ghosts
   * uses this for the recovery target created by Carry Over.
   */
  readonly recoveryTargetPnl?: number;
}

export interface SimulatedSessionResult {
  readonly finalState: SessionState;
  readonly stopReason: StopReason;
  readonly hitTarget: boolean;
  readonly reachedRecoveryTarget: boolean;
  readonly additionalDrawdown: number;
  readonly additionalRounds: number;
}

/**
 * Small deterministic PRNG with a stable, explicitly versioned algorithm.
 * Mulberry32 is sufficient here because the simulator needs reproducibility,
 * not cryptographic randomness.
 */
export function createSeededRandom(seed: number): () => number {
  let value = seed >>> 0;

  return () => {
    value = (value + 0x6d2b79f5) >>> 0;
    let mixed = value;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Derive independent numbered paths from one base seed.
 *
 * Callers that compare branches (Decision Ghosts) pass the same sample index to
 * each branch so both see identical outcome streams.
 */
export function deriveSampleSeed(
  baseSeed: number,
  sampleIndex: number
): number {
  let value =
    (baseSeed ^ Math.imul((sampleIndex + 1) >>> 0, 0x9e3779b1)) >>> 0;
  value ^= value >>> 16;
  value = Math.imul(value, 0x85ebca6b);
  value ^= value >>> 13;
  value = Math.imul(value, 0xc2b2ae35);
  value ^= value >>> 16;
  return value >>> 0;
}

/**
 * Clone the mutable session state boundary. Engine transitions are immutable,
 * but a defensive clone guarantees a simulation can never share the live
 * ladder-touch record.
 */
export function cloneSessionState(state: SessionState): SessionState {
  return {
    ...state,
    ladderTouches: { ...state.ladderTouches },
  };
}

function validateSimulationStart(start: SessionSimulationStart): void {
  const { state, config, strategy } = start;

  if (strategy.ladders.length === 0) {
    throw new Error("Simulation requires at least one ladder.");
  }
  if (
    state.currentLadder < 0 ||
    state.currentLadder >= strategy.ladders.length
  ) {
    throw new Error("Simulation state has an invalid ladder.");
  }
  const currentLadder = strategy.ladders[state.currentLadder];
  if (
    state.currentIndex < 0 ||
    state.currentIndex >= currentLadder.stakes.length
  ) {
    throw new Error("Simulation state has an invalid ladder index.");
  }
  if (!Number.isFinite(state.pnl) || !Number.isFinite(state.rounds)) {
    throw new Error("Simulation state contains non-finite values.");
  }
  if (config.maxRounds <= 0 || config.bankroll <= 0) {
    throw new Error("Simulation config is invalid.");
  }

  strategy.ladders.forEach((_, index) => {
    if (!Number.isFinite(state.ladderTouches[index] ?? Number.NaN)) {
      throw new Error(`Simulation state is missing ladder touch ${index}.`);
    }
  });
}

function validateGame(game: SimulationGameSpec): void {
  if (game.betVariant.outcomes.length === 0) {
    throw new Error("Simulation game requires at least one outcome.");
  }

  const probabilitySum = game.betVariant.outcomes.reduce(
    (sum, outcome) => sum + outcome.probability,
    0
  );
  if (
    game.betVariant.outcomes.some(
      (outcome) =>
        !Number.isFinite(outcome.probability) ||
        outcome.probability < 0 ||
        outcome.probability > 1
    ) ||
    Math.abs(probabilitySum - 1) > 1e-9
  ) {
    throw new Error("Simulation outcome probabilities are invalid.");
  }
}

export function sampleOutcomeId(
  game: SimulationGameSpec,
  randomValue: number
): string {
  let cumulativeProbability = 0;
  const outcomes = game.betVariant.outcomes;

  for (const outcome of outcomes) {
    cumulativeProbability += outcome.probability;
    if (randomValue < cumulativeProbability) {
      return outcome.id;
    }
  }

  // Floating-point sums can end infinitesimally below one.
  return outcomes[outcomes.length - 1].id;
}

/**
 * Simulate one terminal session from the supplied current state.
 *
 * Any later interactive bridge is resolved by carrying over when possible,
 * matching the current presets' non-interactive continuation policy. This
 * function never calls createInitialState and never mutates its input.
 */
export function simulateOneSession(
  start: SessionSimulationStart,
  options: SimulateOneSessionOptions
): SimulatedSessionResult {
  validateSimulationStart(start);

  const game = options.game ?? DEFAULT_SIMULATION_GAME;
  validateGame(game);

  const random = createSeededRandom(options.seed);
  const startingPnl = start.state.pnl;
  const startingRounds = start.state.rounds;
  const recoveryTarget =
    options.recoveryTargetPnl ??
    (start.state.inRecovery ? start.state.recoveryTargetPnl : undefined);

  let state = cloneSessionState(start.state);
  let minimumPnl = state.pnl;
  let reachedRecoveryTarget =
    recoveryTarget !== undefined &&
    toMinorUnits(state.pnl) >= toMinorUnits(recoveryTarget);

  while (!state.stopped) {
    if (state.awaitingDecision) {
      state =
        state.pendingDecisionType === "every_bet"
          ? processBridgingDecision(state, start.strategy, "carry_over")
          : processAutomatedBridge(state, start.strategy);
      if (state.awaitingDecision) {
        throw new Error("Simulation could not resolve a pending decision.");
      }
      if (state.stopped) break;
    }

    const roundsBefore = state.rounds;
    const outcomeId = sampleOutcomeId(game, random());
    state = processOutcome(
      state,
      start.config,
      start.strategy,
      game,
      outcomeId,
      "at_bridging_only"
    );

    minimumPnl = Math.min(minimumPnl, state.pnl);
    if (
      recoveryTarget !== undefined &&
      toMinorUnits(state.pnl) >= toMinorUnits(recoveryTarget)
    ) {
      reachedRecoveryTarget = true;
    }

    if (!state.stopped && state.rounds === roundsBefore) {
      throw new Error("Simulation did not advance or stop.");
    }
  }

  return {
    finalState: state,
    stopReason: state.stopReason,
    hitTarget: state.stopReason === "profit_target",
    reachedRecoveryTarget,
    additionalDrawdown: Math.max(
      0,
      subtractMoney(startingPnl, minimumPnl)
    ),
    additionalRounds: Math.max(0, state.rounds - startingRounds),
  };
}
