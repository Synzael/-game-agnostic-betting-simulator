/**
 * Decision Ghost forecast aggregation.
 *
 * Each numbered sample applies the first candidate decision to the exact live
 * state, then runs both futures with the same seeded outcome stream. Matched
 * streams make branch comparisons less noisy without touching live state.
 */

import {
  BridgingPolicy,
  SessionConfig,
  SessionState,
  StopReason,
  StrategyConfig,
} from "./types";
import { processBridgingDecision } from "./session";
import {
  cloneSessionState,
  DEFAULT_SIMULATION_GAME,
  SessionSimulationStart,
  SimulatedSessionResult,
  SimulationGameSpec,
  simulateOneSession,
  deriveSampleSeed,
} from "./monte-carlo";

export const DECISION_GHOSTS_ENGINE_VERSION = 1;
export const DECISION_GHOSTS_PREVIEW_SAMPLES = 1_000;
export const DECISION_GHOSTS_TOTAL_SAMPLES = 10_000;

export interface DecisionGhostInput {
  readonly state: SessionState;
  readonly config: SessionConfig;
  readonly strategy: StrategyConfig;
  readonly game: SimulationGameSpec;
}

export interface DecisionGhostStopProbabilities {
  readonly stopLoss: number;
  readonly maxRounds: number;
  readonly tableLimit: number;
  readonly bankrollExhausted: number;
  readonly userStopped: number;
}

export interface DecisionGhostBranchForecast {
  readonly probHitTarget: number;
  readonly probReachRecoveryMark: number | null;
  readonly probTerminalFailure: number;
  readonly stopProbabilities: DecisionGhostStopProbabilities;
  readonly medianAdditionalDrawdown: number;
  readonly p90AdditionalDrawdown: number;
  readonly medianRoundsRemaining: number;
}

export interface DecisionGhostForecast {
  readonly engineVersion: number;
  readonly sampleCount: number;
  readonly seed: number;
  readonly decisionRound: number;
  readonly decisionPnl: number;
  readonly game: SimulationGameSpec;
  readonly futureBridgePolicy: BridgingPolicy;
  readonly carryOver: DecisionGhostBranchForecast;
  readonly writeOff: DecisionGhostBranchForecast;
}

interface MutableBranchAggregate {
  hitTargetCount: number;
  reachedRecoveryCount: number;
  terminalFailureCount: number;
  stopReasonCounts: Record<Exclude<StopReason, null>, number>;
  additionalDrawdowns: number[];
  additionalRounds: number[];
}

export interface DecisionGhostAccumulator {
  readonly carryStart: SessionSimulationStart;
  readonly writeOffStart: SessionSimulationStart;
  readonly recoveryTargetPnl: number;
  readonly decisionRound: number;
  readonly decisionPnl: number;
  sampleCount: number;
  readonly carryOver: MutableBranchAggregate;
  readonly writeOff: MutableBranchAggregate;
}

export interface RunDecisionGhostForecastOptions {
  readonly sampleCount: number;
  readonly seed: number;
}

function createBranchAggregate(): MutableBranchAggregate {
  return {
    hitTargetCount: 0,
    reachedRecoveryCount: 0,
    terminalFailureCount: 0,
    stopReasonCounts: {
      profit_target: 0,
      stop_loss: 0,
      max_rounds: 0,
      table_limit: 0,
      bankroll_exhausted: 0,
      user_stopped: 0,
    },
    additionalDrawdowns: [],
    additionalRounds: [],
  };
}

function validateDecisionInput(input: DecisionGhostInput): void {
  const { state, strategy, game } = input;

  if (
    state.stopped ||
    !state.awaitingDecision ||
    state.pendingDecisionType !== "bridging"
  ) {
    throw new Error("Decision Ghosts requires a pending bridging decision.");
  }
  if (state.currentLadder >= strategy.ladders.length - 1) {
    throw new Error("Carry Over requires another ladder.");
  }
  const probabilitySum = game.betVariant.outcomes.reduce(
    (sum, outcome) => sum + outcome.probability,
    0
  );
  if (
    game.betVariant.outcomes.length === 0 ||
    game.betVariant.outcomes.some(
      (outcome) =>
        !Number.isFinite(outcome.probability) ||
        outcome.probability < 0 ||
        outcome.probability > 1
    ) ||
    Math.abs(probabilitySum - 1) > 1e-9
  ) {
    throw new Error("Decision Ghosts requires valid outcome probabilities.");
  }
}

export function createDecisionGhostAccumulator(
  input: DecisionGhostInput
): DecisionGhostAccumulator {
  validateDecisionInput(input);

  const carryState = processBridgingDecision(
    cloneSessionState(input.state),
    input.strategy,
    "carry_over"
  );
  const writeOffState = processBridgingDecision(
    cloneSessionState(input.state),
    input.strategy,
    "write_off"
  );

  if (
    carryState.awaitingDecision ||
    writeOffState.awaitingDecision ||
    !carryState.inRecovery
  ) {
    throw new Error("Decision branches could not be initialized.");
  }

  return {
    carryStart: {
      state: carryState,
      config: input.config,
      strategy: input.strategy,
    },
    writeOffStart: {
      state: writeOffState,
      config: input.config,
      strategy: input.strategy,
    },
    recoveryTargetPnl: carryState.recoveryTargetPnl,
    decisionRound: input.state.rounds,
    decisionPnl: input.state.pnl,
    sampleCount: 0,
    carryOver: createBranchAggregate(),
    writeOff: createBranchAggregate(),
  };
}

/**
 * Derive independent numbered paths from one request seed. Both candidate
 * branches receive the same returned seed for a given sample index.
 *
 * @see deriveSampleSeed - the shared implementation.
 */
export const deriveDecisionSampleSeed = deriveSampleSeed;

function isTerminalFailure(reason: StopReason): boolean {
  return (
    reason === "stop_loss" ||
    reason === "max_rounds" ||
    reason === "table_limit" ||
    reason === "bankroll_exhausted" ||
    reason === "user_stopped"
  );
}

function addResult(
  aggregate: MutableBranchAggregate,
  result: SimulatedSessionResult
): void {
  if (result.hitTarget) aggregate.hitTargetCount += 1;
  if (result.reachedRecoveryTarget) aggregate.reachedRecoveryCount += 1;
  if (isTerminalFailure(result.stopReason)) {
    aggregate.terminalFailureCount += 1;
  }
  if (result.stopReason) {
    aggregate.stopReasonCounts[result.stopReason] += 1;
  }
  aggregate.additionalDrawdowns.push(result.additionalDrawdown);
  aggregate.additionalRounds.push(result.additionalRounds);
}

export function addDecisionGhostSample(
  accumulator: DecisionGhostAccumulator,
  input: DecisionGhostInput,
  baseSeed: number
): void {
  const sampleSeed = deriveDecisionSampleSeed(
    baseSeed,
    accumulator.sampleCount
  );

  const carryResult = simulateOneSession(accumulator.carryStart, {
    seed: sampleSeed,
    game: input.game,
    recoveryTargetPnl: accumulator.recoveryTargetPnl,
  });
  const writeOffResult = simulateOneSession(accumulator.writeOffStart, {
    seed: sampleSeed,
    game: input.game,
  });

  addResult(accumulator.carryOver, carryResult);
  addResult(accumulator.writeOff, writeOffResult);
  accumulator.sampleCount += 1;
}

export function quantile(values: readonly number[], probability: number): number {
  if (values.length === 0) return 0;
  if (probability < 0 || probability > 1) {
    throw new Error("Quantile probability must be between 0 and 1.");
  }

  const sorted = [...values].sort((left, right) => left - right);
  const position = (sorted.length - 1) * probability;
  const lowerIndex = Math.floor(position);
  const upperIndex = Math.ceil(position);

  if (lowerIndex === upperIndex) return sorted[lowerIndex];

  const weight = position - lowerIndex;
  return (
    sorted[lowerIndex] * (1 - weight) +
    sorted[upperIndex] * weight
  );
}

function summarizeBranch(
  aggregate: MutableBranchAggregate,
  sampleCount: number,
  includeRecovery: boolean
): DecisionGhostBranchForecast {
  const probability = (count: number): number =>
    sampleCount === 0 ? 0 : count / sampleCount;

  return {
    probHitTarget: probability(aggregate.hitTargetCount),
    probReachRecoveryMark: includeRecovery
      ? probability(aggregate.reachedRecoveryCount)
      : null,
    probTerminalFailure: probability(aggregate.terminalFailureCount),
    stopProbabilities: {
      stopLoss: probability(aggregate.stopReasonCounts.stop_loss),
      maxRounds: probability(aggregate.stopReasonCounts.max_rounds),
      tableLimit: probability(aggregate.stopReasonCounts.table_limit),
      bankrollExhausted: probability(
        aggregate.stopReasonCounts.bankroll_exhausted
      ),
      userStopped: probability(aggregate.stopReasonCounts.user_stopped),
    },
    medianAdditionalDrawdown: quantile(
      aggregate.additionalDrawdowns,
      0.5
    ),
    p90AdditionalDrawdown: quantile(aggregate.additionalDrawdowns, 0.9),
    medianRoundsRemaining: quantile(aggregate.additionalRounds, 0.5),
  };
}

export function summarizeDecisionGhostForecast(
  accumulator: DecisionGhostAccumulator,
  input: DecisionGhostInput,
  seed: number
): DecisionGhostForecast {
  return {
    engineVersion: DECISION_GHOSTS_ENGINE_VERSION,
    sampleCount: accumulator.sampleCount,
    seed: seed >>> 0,
    decisionRound: accumulator.decisionRound,
    decisionPnl: accumulator.decisionPnl,
    game: input.game,
    futureBridgePolicy: input.strategy.bridgingPolicy,
    carryOver: summarizeBranch(
      accumulator.carryOver,
      accumulator.sampleCount,
      true
    ),
    writeOff: summarizeBranch(
      accumulator.writeOff,
      accumulator.sampleCount,
      false
    ),
  };
}

export function runDecisionGhostForecast(
  input: DecisionGhostInput,
  options: RunDecisionGhostForecastOptions
): DecisionGhostForecast {
  if (
    !Number.isInteger(options.sampleCount) ||
    options.sampleCount <= 0 ||
    options.sampleCount > 100_000
  ) {
    throw new Error("Decision Ghost sample count is invalid.");
  }

  const accumulator = createDecisionGhostAccumulator(input);
  while (accumulator.sampleCount < options.sampleCount) {
    addDecisionGhostSample(accumulator, input, options.seed);
  }

  return summarizeDecisionGhostForecast(accumulator, input, options.seed);
}

function canonicalSerialize(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) {
    return `[${value.map(canonicalSerialize).join(",")}]`;
  }

  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "number":
      if (!Number.isFinite(value)) {
        throw new Error("Cannot fingerprint a non-finite number.");
      }
      return Object.is(value, -0) ? "0" : String(value);
    case "boolean":
      return value ? "true" : "false";
    case "object": {
      const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, entryValue]) => entryValue !== undefined)
        .sort(([left], [right]) => left.localeCompare(right));
      return `{${entries
        .map(
          ([key, entryValue]) =>
            `${JSON.stringify(key)}:${canonicalSerialize(entryValue)}`
        )
        .join(",")}}`;
    }
    default:
      throw new Error(`Cannot fingerprint value of type ${typeof value}.`);
  }
}

function fnv1a(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function createDecisionGhostFingerprint(
  input: DecisionGhostInput
): string {
  const serialized = canonicalSerialize({
    engineVersion: DECISION_GHOSTS_ENGINE_VERSION,
    input,
  });
  return `ghost-v${DECISION_GHOSTS_ENGINE_VERSION}-${fnv1a(serialized)
    .toString(16)
    .padStart(8, "0")}`;
}

export function createDecisionGhostSeed(input: DecisionGhostInput): number {
  return fnv1a(createDecisionGhostFingerprint(input));
}

export function createDefaultDecisionGhostInput(
  state: SessionState,
  config: SessionConfig,
  strategy: StrategyConfig,
  game: SimulationGameSpec = DEFAULT_SIMULATION_GAME
): DecisionGhostInput {
  return {
    state,
    config,
    strategy,
    game,
  };
}
