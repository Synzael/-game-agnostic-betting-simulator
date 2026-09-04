import {
  FrozenGameSnapshot,
  SessionConfig,
  SessionState,
  StrategyConfig,
  VarianceBandPoint,
  VarianceForecast,
} from "./types";
import {
  createInitialState,
  processAutomatedBridge,
  processOutcome,
} from "./session";
import {
  createSeededRandom,
  deriveSampleSeed,
  sampleOutcomeId,
} from "./monte-carlo";
import { fingerprintValue } from "./games";

export const VARIANCE_ENGINE_VERSION = "variance-v1";
export const VARIANCE_ANCHOR_SCHEDULE_VERSION = 1;
export const VARIANCE_PREVIEW_SAMPLES = 400;
export const VARIANCE_FULL_SAMPLES = 2_500;

export interface VarianceForecastInput {
  readonly config: SessionConfig;
  readonly strategy: StrategyConfig;
  readonly game: FrozenGameSnapshot;
}

export interface VarianceAccumulator {
  readonly input: VarianceForecastInput;
  readonly anchors: readonly number[];
  readonly samplesByAnchor: number[][];
  readonly seed: number;
  sampleCount: number;
}

export type VarianceClassification = "below" | "within" | "above";

export function generateAnchorSchedule(maxRounds: number): number[] {
  if (!Number.isInteger(maxRounds) || maxRounds <= 0 || maxRounds > 100_000) {
    throw new Error("maxRounds must be an integer between 1 and 100,000");
  }

  const anchors = new Set<number>([0, maxRounds]);
  for (let round = 1; round <= Math.min(100, maxRounds); round += 1) {
    anchors.add(round);
  }
  for (let round = 105; round <= Math.min(500, maxRounds); round += 5) {
    anchors.add(round);
  }
  for (let round = 525; round <= maxRounds; round += 25) {
    anchors.add(round);
  }
  return [...anchors].sort((left, right) => left - right);
}

/**
 * R-7 quantile estimator: linear interpolation at (n - 1) * probability.
 */
export function quantileR7(
  values: readonly number[],
  probability: number
): number {
  if (values.length === 0) {
    throw new Error("Cannot calculate a quantile from an empty sample");
  }
  if (!Number.isFinite(probability) || probability < 0 || probability > 1) {
    throw new Error("Quantile probability must be between 0 and 1");
  }

  return quantileFromSorted(
    [...values].sort((left, right) => left - right),
    probability
  );
}

/**
 * Same R-7 estimator for callers that already hold a sorted sample, so a set of
 * quantiles over one anchor costs a single sort instead of one per quantile.
 */
function quantileFromSorted(
  sorted: readonly number[],
  probability: number
): number {
  const position = (sorted.length - 1) * probability;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  const weight = position - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

export function createVarianceFingerprint(
  input: VarianceForecastInput
): string {
  return fingerprintValue({
    engineVersion: VARIANCE_ENGINE_VERSION,
    anchorScheduleVersion: VARIANCE_ANCHOR_SCHEDULE_VERSION,
    terminalHandling: "absorbing_final_pnl",
    config: input.config,
    strategy: input.strategy,
    game: input.game,
  });
}

export function createVarianceSeed(input: VarianceForecastInput): number {
  const fingerprint = createVarianceFingerprint(input);
  let seed = 0;
  for (let index = 0; index < fingerprint.length; index += 1) {
    seed = Math.imul(seed ^ fingerprint.charCodeAt(index), 0x45d9f3b);
  }
  return seed >>> 0;
}

/** @see deriveSampleSeed - re-exported so the forecast API stays stable. */
export const deriveVarianceSampleSeed = deriveSampleSeed;

/** @see sampleOutcomeId - the shared cumulative-probability sampler. */
export function sampleGameOutcomeId(
  game: FrozenGameSnapshot,
  randomValue: number
): string {
  return sampleOutcomeId(game, randomValue);
}

/**
 * Return P&L at every requested round. A terminal result is carried forward
 * through all later anchors, avoiding survivor-only bias.
 */
export function simulatePnlAtAnchors(
  input: VarianceForecastInput,
  anchors: readonly number[],
  seed: number
): number[] {
  if (anchors.length === 0 || anchors[0] !== 0) {
    throw new Error("Variance anchors must start at round 0");
  }

  const random = createSeededRandom(seed);
  let state: SessionState = createInitialState(
    input.strategy,
    input.config.startingLadder
  );
  const values = new Array<number>(anchors.length);
  values[0] = 0;
  let anchorIndex = 1;

  while (!state.stopped && anchorIndex < anchors.length) {
    if (state.awaitingDecision) {
      state = processAutomatedBridge(state, input.strategy);
      if (state.stopped) break;
      if (state.awaitingDecision) {
        throw new Error("Variance simulation could not resolve a bridge");
      }
    }

    const roundsBefore = state.rounds;
    state = processOutcome(
      state,
      input.config,
      input.strategy,
      input.game,
      sampleGameOutcomeId(input.game, random()),
      "at_bridging_only"
    );

    while (
      anchorIndex < anchors.length &&
      anchors[anchorIndex] <= state.rounds
    ) {
      values[anchorIndex] = state.pnl;
      anchorIndex += 1;
    }

    if (!state.stopped && state.rounds === roundsBefore) {
      throw new Error("Variance simulation did not advance or stop");
    }
  }

  while (anchorIndex < anchors.length) {
    values[anchorIndex] = state.pnl;
    anchorIndex += 1;
  }

  return values;
}

export function createVarianceAccumulator(
  input: VarianceForecastInput,
  seed = createVarianceSeed(input)
): VarianceAccumulator {
  const anchors = generateAnchorSchedule(input.config.maxRounds);
  return {
    input,
    anchors,
    samplesByAnchor: anchors.map(() => []),
    seed: seed >>> 0,
    sampleCount: 0,
  };
}

export function addVarianceSample(accumulator: VarianceAccumulator): void {
  const values = simulatePnlAtAnchors(
    accumulator.input,
    accumulator.anchors,
    deriveVarianceSampleSeed(accumulator.seed, accumulator.sampleCount)
  );
  values.forEach((value, index) => {
    accumulator.samplesByAnchor[index].push(value);
  });
  accumulator.sampleCount += 1;
}

export function summarizeVarianceForecast(
  accumulator: VarianceAccumulator,
  quality: VarianceForecast["quality"],
  generatedAt = Date.now()
): VarianceForecast {
  if (accumulator.sampleCount === 0) {
    throw new Error("Variance forecast requires at least one sample");
  }

  const points = accumulator.anchors.map((round, index) => {
    const samples = [...accumulator.samplesByAnchor[index]].sort(
      (left, right) => left - right
    );
    const p05 = quantileFromSorted(samples, 0.05);
    const p25 = Math.max(p05, quantileFromSorted(samples, 0.25));
    const p50 = Math.max(p25, quantileFromSorted(samples, 0.5));
    const p75 = Math.max(p50, quantileFromSorted(samples, 0.75));
    const p95 = Math.max(p75, quantileFromSorted(samples, 0.95));
    return { round, p05, p25, p50, p75, p95 };
  });

  return {
    points,
    sampleCount: accumulator.sampleCount,
    seed: accumulator.seed,
    engineVersion: VARIANCE_ENGINE_VERSION,
    inputFingerprint: createVarianceFingerprint(accumulator.input),
    anchorScheduleVersion: VARIANCE_ANCHOR_SCHEDULE_VERSION,
    terminalHandling: "absorbing_final_pnl",
    quantileEstimator: "r7_linear",
    gameFingerprint: accumulator.input.game.fingerprint,
    generatedAt,
    quality,
  };
}

export function runVarianceForecast(
  input: VarianceForecastInput,
  sampleCount: number,
  seed = createVarianceSeed(input),
  generatedAt = Date.now()
): VarianceForecast {
  if (!Number.isInteger(sampleCount) || sampleCount <= 0 || sampleCount > 100_000) {
    throw new Error("Variance sample count is invalid");
  }
  const accumulator = createVarianceAccumulator(input, seed);
  while (accumulator.sampleCount < sampleCount) {
    addVarianceSample(accumulator);
  }
  return summarizeVarianceForecast(accumulator, "full", generatedAt);
}

export function interpolateVarianceAtRound(
  points: readonly VarianceBandPoint[],
  round: number
): VarianceBandPoint | null {
  if (points.length === 0 || !Number.isFinite(round)) return null;
  if (round <= points[0].round) return { ...points[0], round };
  const last = points[points.length - 1];
  if (round >= last.round) return { ...last, round };

  let upperIndex = 1;
  while (points[upperIndex].round < round) upperIndex += 1;
  const lower = points[upperIndex - 1];
  const upper = points[upperIndex];
  const span = upper.round - lower.round;
  const weight = span === 0 ? 0 : (round - lower.round) / span;
  const mix = (key: keyof Omit<VarianceBandPoint, "round">): number =>
    lower[key] + (upper[key] - lower[key]) * weight;

  return {
    round,
    p05: mix("p05"),
    p25: mix("p25"),
    p50: mix("p50"),
    p75: mix("p75"),
    p95: mix("p95"),
  };
}

export function classifyVariance(
  actualPnl: number,
  point: Pick<VarianceBandPoint, "p05" | "p95">
): VarianceClassification {
  if (actualPnl < point.p05) return "below";
  if (actualPnl > point.p95) return "above";
  return "within";
}

