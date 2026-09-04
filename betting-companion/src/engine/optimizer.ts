import type {
  BridgingPolicy,
  FrozenGameSnapshot,
  StrategyConfig,
} from "./types";
import { createInitialState } from "./session";
import { createSeededRandom, simulateOneSession } from "./monte-carlo";
import { createLadder } from "./ladder";
import { fingerprintValue } from "./games";
import { isCanonicalMoney } from "./money";
import { quantileR7 } from "./variance-forecast";

export const OPTIMIZER_ENGINE_VERSION = "ladder-optimizer-v1";
export const OPTIMIZER_GRID_THRESHOLD = 256;
export const OPTIMIZER_MAX_CANDIDATES = 100_000;

export interface OptimizerSearchSpace {
  readonly ladderCount: { readonly min: number; readonly max: number };
  readonly stepsPerLadder: { readonly min: number; readonly max: number };
  readonly minimumStake: number;
  readonly maximumStake: number;
  readonly allowedStakeIncrements: readonly number[];
  readonly maxGrowthRatio: number;
  readonly allowedPolicies: readonly BridgingPolicy[];
  readonly recoveryTargetPctValues: readonly number[];
  readonly crossoverOffsets: readonly number[];
}

export interface OptimizerObjective {
  readonly bankroll: number;
  readonly profitTarget: number;
  readonly stopLossAbs: number;
  readonly maxRounds: number;
  readonly tableMax?: number;
  readonly ruinTolerance: number;
  readonly confidenceLevel: number;
}

export interface OptimizerJobInput {
  readonly searchSpace: OptimizerSearchSpace;
  readonly objective: OptimizerObjective;
  readonly game: FrozenGameSnapshot;
  readonly explorationSamples: number;
  readonly confirmationSamples: number;
  readonly seed: number;
  readonly concurrency: number;
}

export interface OptimizerCandidate {
  readonly fingerprint: string;
  readonly strategy: StrategyConfig;
  readonly shape: {
    readonly ladderCount: number;
    readonly stepsPerLadder: number;
    readonly stakeIncrement: number;
    readonly policy: BridgingPolicy;
    readonly recoveryTargetPct: number;
    readonly crossoverOffset: number;
  };
}

export interface ProbabilityInterval {
  readonly point: number;
  readonly lower: number;
  readonly upper: number;
  readonly confidenceLevel: number;
}

export interface OptimizerEvaluation {
  readonly candidate: OptimizerCandidate;
  readonly sampleCount: number;
  readonly target: ProbabilityInterval;
  readonly ruin: ProbabilityInterval;
  readonly maxRoundsCensored: number;
  readonly medianMaxStake: number;
  readonly medianMaxDrawdown: number;
  readonly feasible: boolean;
  readonly seedBankFingerprint: string;
  readonly stage: "exploration" | "confirmation";
}

export interface OptimizerResult {
  readonly candidate: OptimizerCandidate;
  readonly exploration: OptimizerEvaluation;
  readonly confirmation: OptimizerEvaluation;
  readonly feasible: boolean;
}

export interface SavedOptimizerPreset {
  readonly id: string;
  readonly version: number;
  readonly displayName: string;
  readonly createdAt: number;
  readonly strategy: StrategyConfig;
  readonly provenance: {
    readonly engineVersion: string;
    readonly candidateFingerprint: string;
    readonly inputFingerprint: string;
    readonly confirmation: OptimizerEvaluation;
    readonly objective: OptimizerObjective;
    readonly gameFingerprint: string;
  };
}

interface CandidateShape {
  ladderCount: number;
  stepsPerLadder: number;
  stakeIncrement: number;
  policy: BridgingPolicy;
  recoveryTargetPct: number;
  crossoverOffset: number;
}

export function validateOptimizerInput(input: OptimizerJobInput): void {
  const { searchSpace, objective } = input;
  validateIntegerRange(searchSpace.ladderCount, "ladder count", 1, 5);
  validateIntegerRange(
    searchSpace.stepsPerLadder,
    "steps per ladder",
    1,
    12
  );
  if (
    searchSpace.ladderCount.max * searchSpace.stepsPerLadder.max >
    48
  ) {
    throw new Error("Optimizer candidates may contain at most 48 total steps");
  }
  if (
    !isCanonicalMoney(searchSpace.minimumStake) ||
    !isCanonicalMoney(searchSpace.maximumStake) ||
    searchSpace.minimumStake <= 0 ||
    searchSpace.maximumStake < searchSpace.minimumStake
  ) {
    throw new Error("Stake bounds must be positive canonical money values");
  }
  if (
    searchSpace.allowedStakeIncrements.length === 0 ||
    searchSpace.allowedStakeIncrements.some(
      (increment) => increment <= 0 || !isCanonicalMoney(increment)
    )
  ) {
    throw new Error("Stake increments must be positive canonical money values");
  }
  if (
    !Number.isFinite(searchSpace.maxGrowthRatio) ||
    searchSpace.maxGrowthRatio < 1 ||
    searchSpace.maxGrowthRatio > 10
  ) {
    throw new Error("Growth ratio must be between 1 and 10");
  }
  if (new Set(searchSpace.allowedPolicies).size !== searchSpace.allowedPolicies.length) {
    throw new Error("Allowed policies must be unique");
  }
  if (searchSpace.allowedPolicies.length === 0) {
    throw new Error("At least one bridging policy is required");
  }
  if (
    searchSpace.recoveryTargetPctValues.length === 0 ||
    searchSpace.recoveryTargetPctValues.some(
      (value) => !Number.isFinite(value) || value <= 0 || value > 1
    )
  ) {
    throw new Error("Recovery target values must be in (0, 1]");
  }
  if (
    searchSpace.crossoverOffsets.length === 0 ||
    searchSpace.crossoverOffsets.some(
      (value) => !Number.isInteger(value) || value < 0 || value > 11
    )
  ) {
    throw new Error("Crossover offsets must be integers between 0 and 11");
  }

  for (const [label, value] of [
    ["bankroll", objective.bankroll],
    ["profit target", objective.profitTarget],
    ["stop loss", objective.stopLossAbs],
  ] as const) {
    if (value <= 0 || !isCanonicalMoney(value)) {
      throw new Error(`${label} must be positive canonical money`);
    }
  }
  if (objective.stopLossAbs > objective.bankroll) {
    throw new Error("Stop loss cannot exceed bankroll");
  }
  if (
    !Number.isInteger(objective.maxRounds) ||
    objective.maxRounds <= 0 ||
    objective.maxRounds > 10_000
  ) {
    throw new Error("Max rounds must be an integer between 1 and 10,000");
  }
  if (
    objective.tableMax !== undefined &&
    (objective.tableMax <= 0 || !isCanonicalMoney(objective.tableMax))
  ) {
    throw new Error("Table max must be positive canonical money");
  }
  const effectiveMax = Math.min(
    searchSpace.maximumStake,
    objective.tableMax ?? Number.POSITIVE_INFINITY
  );
  if (searchSpace.minimumStake > effectiveMax) {
    throw new Error("Minimum stake exceeds the effective table maximum");
  }
  if (searchSpace.minimumStake > objective.bankroll) {
    throw new Error("Minimum stake is not affordable at the initial bankroll");
  }
  if (
    objective.ruinTolerance <= 0 ||
    objective.ruinTolerance >= 1 ||
    objective.confidenceLevel <= 0.5 ||
    objective.confidenceLevel >= 1
  ) {
    throw new Error("Risk tolerance and confidence level are invalid");
  }
  if (
    !Number.isInteger(input.explorationSamples) ||
    input.explorationSamples < 20 ||
    input.explorationSamples > 100_000 ||
    !Number.isInteger(input.confirmationSamples) ||
    input.confirmationSamples < input.explorationSamples ||
    input.confirmationSamples > 250_000
  ) {
    throw new Error("Optimizer sample counts are invalid");
  }
  if (!Number.isInteger(input.concurrency) || input.concurrency < 1 || input.concurrency > 4) {
    throw new Error("Optimizer concurrency must be between 1 and 4");
  }
  if (estimateSearchCardinality(searchSpace) > OPTIMIZER_MAX_CANDIDATES) {
    throw new Error("Search space exceeds the conservative candidate cap");
  }
}

function validateIntegerRange(
  range: { readonly min: number; readonly max: number },
  label: string,
  hardMin: number,
  hardMax: number
): void {
  if (
    !Number.isInteger(range.min) ||
    !Number.isInteger(range.max) ||
    range.min < hardMin ||
    range.max > hardMax ||
    range.min > range.max
  ) {
    throw new Error(`Invalid ${label} range`);
  }
}

export function estimateSearchCardinality(
  searchSpace: OptimizerSearchSpace
): number {
  return (
    (searchSpace.ladderCount.max - searchSpace.ladderCount.min + 1) *
    (searchSpace.stepsPerLadder.max -
      searchSpace.stepsPerLadder.min +
      1) *
    searchSpace.allowedStakeIncrements.length *
    searchSpace.allowedPolicies.length *
    searchSpace.recoveryTargetPctValues.length *
    searchSpace.crossoverOffsets.length
  );
}

export function createOptimizerInputFingerprint(
  input: OptimizerJobInput
): string {
  return fingerprintValue({
    engineVersion: OPTIMIZER_ENGINE_VERSION,
    searchSpace: input.searchSpace,
    objective: input.objective,
    game: input.game,
    explorationSamples: input.explorationSamples,
    confirmationSamples: input.confirmationSamples,
    seed: input.seed,
  });
}

function buildCandidate(
  shape: CandidateShape,
  searchSpace: OptimizerSearchSpace,
  tableMax?: number
): OptimizerCandidate | null {
  const maximumStake = Math.min(
    searchSpace.maximumStake,
    tableMax ?? Number.POSITIVE_INFINITY
  );
  const ladders = [];
  let previous = searchSpace.minimumStake;

  for (let ladderIndex = 0; ladderIndex < shape.ladderCount; ladderIndex += 1) {
    const stakes: number[] = [];
    for (let step = 0; step < shape.stepsPerLadder; step += 1) {
      const globalStep = ladderIndex * shape.stepsPerLadder + step;
      if (globalStep > 0) {
        const fibGrowth = fibonacci(Math.min(step + 1, 10));
        previous = Math.min(
          maximumStake,
          previous + shape.stakeIncrement * fibGrowth
        );
      }
      stakes.push(previous);
    }
    ladders.push(createLadder(`Lab ${ladderIndex + 1}`, stakes));
  }

  const strategy: StrategyConfig = {
    ladders,
    bridgingPolicy: shape.policy,
    recoveryTargetPct: shape.recoveryTargetPct,
    crossoverOffset: Math.min(
      shape.crossoverOffset,
      shape.stepsPerLadder - 1
    ),
  };
  try {
    validateCandidate(strategy, searchSpace, tableMax);
  } catch {
    return null;
  }

  return {
    strategy,
    shape: {
      ...shape,
      crossoverOffset: strategy.crossoverOffset,
    },
    fingerprint: fingerprintValue(strategy),
  };
}

function fibonacci(index: number): number {
  if (index <= 1) return 1;
  let left = 1;
  let right = 1;
  for (let step = 2; step <= index; step += 1) {
    [left, right] = [right, left + right];
  }
  return right;
}

export function validateCandidate(
  strategy: StrategyConfig,
  searchSpace: OptimizerSearchSpace,
  tableMax?: number
): void {
  const effectiveMax = Math.min(
    searchSpace.maximumStake,
    tableMax ?? Number.POSITIVE_INFINITY
  );
  if (
    strategy.ladders.length < searchSpace.ladderCount.min ||
    strategy.ladders.length > searchSpace.ladderCount.max
  ) {
    throw new Error("Candidate ladder count is outside the search space");
  }
  let previous: number | null = null;
  for (const ladder of strategy.ladders) {
    if (
      ladder.stakes.length < searchSpace.stepsPerLadder.min ||
      ladder.stakes.length > searchSpace.stepsPerLadder.max
    ) {
      throw new Error("Candidate step count is outside the search space");
    }
    for (const stake of ladder.stakes) {
      if (
        stake <= 0 ||
        stake < searchSpace.minimumStake ||
        stake > effectiveMax ||
        !isCanonicalMoney(stake)
      ) {
        throw new Error("Candidate has an invalid stake");
      }
      if (previous !== null) {
        if (stake < previous) throw new Error("Candidate stakes must be sorted");
        if (
          previous > 0 &&
          stake / previous > searchSpace.maxGrowthRatio + Number.EPSILON
        ) {
          throw new Error("Candidate exceeds the maximum growth ratio");
        }
      }
      previous = stake;
    }
  }
}

export function generateGridCandidates(
  input: OptimizerJobInput
): OptimizerCandidate[] {
  validateOptimizerInput(input);
  const candidates = new Map<string, OptimizerCandidate>();
  for (
    let ladderCount = input.searchSpace.ladderCount.min;
    ladderCount <= input.searchSpace.ladderCount.max;
    ladderCount += 1
  ) {
    for (
      let stepsPerLadder = input.searchSpace.stepsPerLadder.min;
      stepsPerLadder <= input.searchSpace.stepsPerLadder.max;
      stepsPerLadder += 1
    ) {
      for (const stakeIncrement of input.searchSpace.allowedStakeIncrements) {
        for (const policy of input.searchSpace.allowedPolicies) {
          for (const recoveryTargetPct of input.searchSpace.recoveryTargetPctValues) {
            for (const crossoverOffset of input.searchSpace.crossoverOffsets) {
              const candidate = buildCandidate(
                {
                  ladderCount,
                  stepsPerLadder,
                  stakeIncrement,
                  policy,
                  recoveryTargetPct,
                  crossoverOffset,
                },
                input.searchSpace,
                input.objective.tableMax
              );
              if (candidate) candidates.set(candidate.fingerprint, candidate);
            }
          }
        }
      }
    }
  }
  return [...candidates.values()].sort((left, right) =>
    left.fingerprint.localeCompare(right.fingerprint)
  );
}

/**
 * Seeded bounded proposal evolution for large grids. The worker confirmation
 * stage still determines all labels and ranking; this only limits exploration.
 */
export function generateEvolutionaryCandidates(
  input: OptimizerJobInput,
  populationSize = OPTIMIZER_GRID_THRESHOLD,
  generationCount = 8
): OptimizerCandidate[] {
  validateOptimizerInput(input);
  const random = createSeededRandom(input.seed ^ 0x5f3759df);
  const candidates = new Map<string, OptimizerCandidate>();
  let population = Array.from({ length: Math.min(32, populationSize) }, () =>
    randomShape(input.searchSpace, random)
  );

  for (let generation = 0; generation < generationCount; generation += 1) {
    for (const shape of population) {
      const candidate = buildCandidate(
        shape,
        input.searchSpace,
        input.objective.tableMax
      );
      if (candidate) candidates.set(candidate.fingerprint, candidate);
      if (candidates.size >= populationSize) break;
    }
    if (candidates.size >= populationSize) break;

    const elites = population
      .slice()
      .sort(
        (left, right) =>
          left.ladderCount * left.stepsPerLadder -
            right.ladderCount * right.stepsPerLadder ||
          left.stakeIncrement - right.stakeIncrement
      )
      .slice(0, Math.max(2, Math.floor(population.length * 0.2)));
    const next: CandidateShape[] = elites.map((shape) => ({ ...shape }));
    while (next.length < Math.min(populationSize, population.length * 2)) {
      const left = elites[Math.floor(random() * elites.length)];
      const right = population[Math.floor(random() * population.length)];
      next.push(mutateShape(crossoverShape(left, right, random), input.searchSpace, random));
    }
    population = next;
  }

  let attempts = 0;
  const maxAttempts = Math.max(1_000, populationSize * 100);
  while (candidates.size < populationSize && attempts < maxAttempts) {
    attempts += 1;
    const candidate = buildCandidate(
      randomShape(input.searchSpace, random),
      input.searchSpace,
      input.objective.tableMax
    );
    if (candidate) candidates.set(candidate.fingerprint, candidate);
    if (candidates.size >= estimateSearchCardinality(input.searchSpace)) break;
  }
  return [...candidates.values()].sort((left, right) =>
    left.fingerprint.localeCompare(right.fingerprint)
  );
}

/**
 * Create the next seeded generation from Monte Carlo-ranked parents.
 * Selection is objective-based, with 20% elitism, uniform crossover, and one
 * bounded field mutation per child.
 */
export function evolveCandidatePopulation(
  input: OptimizerJobInput,
  evaluations: readonly OptimizerEvaluation[],
  generation: number,
  populationSize = 32
): OptimizerCandidate[] {
  if (evaluations.length === 0) {
    return generateEvolutionaryCandidates(input, populationSize, 1);
  }
  const ranked = rankOptimizerEvaluations(evaluations);
  const eliteCount = Math.max(
    2,
    Math.min(ranked.length, Math.ceil(populationSize * 0.2))
  );
  const elites = ranked
    .slice(0, eliteCount)
    .map((evaluation) => evaluation.candidate);
  const parentPool = ranked
    .slice(0, Math.max(eliteCount, Math.ceil(ranked.length / 2)))
    .map((evaluation) => evaluation.candidate);
  const next = new Map<string, OptimizerCandidate>(
    elites.map((candidate) => [candidate.fingerprint, candidate])
  );
  const random = createSeededRandom(
    input.seed ^ Math.imul(generation + 1, 0x9e3779b1)
  );
  let attempts = 0;
  while (next.size < populationSize && attempts < populationSize * 100) {
    attempts += 1;
    const left =
      parentPool[Math.floor(random() * parentPool.length)].shape;
    const right =
      parentPool[Math.floor(random() * parentPool.length)].shape;
    const childShape = mutateShape(
      crossoverShape({ ...left }, { ...right }, random),
      input.searchSpace,
      random
    );
    const candidate = buildCandidate(
      childShape,
      input.searchSpace,
      input.objective.tableMax
    );
    if (candidate) next.set(candidate.fingerprint, candidate);
  }
  return [...next.values()].sort((left, right) =>
    left.fingerprint.localeCompare(right.fingerprint)
  );
}

function randomShape(
  search: OptimizerSearchSpace,
  random: () => number
): CandidateShape {
  const integer = (min: number, max: number): number =>
    min + Math.floor(random() * (max - min + 1));
  const pick = <T>(values: readonly T[]): T =>
    values[Math.floor(random() * values.length)];
  return {
    ladderCount: integer(search.ladderCount.min, search.ladderCount.max),
    stepsPerLadder: integer(
      search.stepsPerLadder.min,
      search.stepsPerLadder.max
    ),
    stakeIncrement: pick(search.allowedStakeIncrements),
    policy: pick(search.allowedPolicies),
    recoveryTargetPct: pick(search.recoveryTargetPctValues),
    crossoverOffset: pick(search.crossoverOffsets),
  };
}

function crossoverShape(
  left: CandidateShape,
  right: CandidateShape,
  random: () => number
): CandidateShape {
  return {
    ladderCount: random() < 0.5 ? left.ladderCount : right.ladderCount,
    stepsPerLadder:
      random() < 0.5 ? left.stepsPerLadder : right.stepsPerLadder,
    stakeIncrement:
      random() < 0.5 ? left.stakeIncrement : right.stakeIncrement,
    policy: random() < 0.5 ? left.policy : right.policy,
    recoveryTargetPct:
      random() < 0.5 ? left.recoveryTargetPct : right.recoveryTargetPct,
    crossoverOffset:
      random() < 0.5 ? left.crossoverOffset : right.crossoverOffset,
  };
}

function mutateShape(
  shape: CandidateShape,
  search: OptimizerSearchSpace,
  random: () => number
): CandidateShape {
  const mutation = Math.floor(random() * 6);
  const fresh = randomShape(search, random);
  const keys: (keyof CandidateShape)[] = [
    "ladderCount",
    "stepsPerLadder",
    "stakeIncrement",
    "policy",
    "recoveryTargetPct",
    "crossoverOffset",
  ];
  return { ...shape, [keys[mutation]]: fresh[keys[mutation]] };
}

export function createSeedBank(
  baseSeed: number,
  sampleCount: number,
  domain: "exploration" | "confirmation"
): number[] {
  const domainMask = domain === "exploration" ? 0xa511e9b3 : 0x63d83595;
  const random = createSeededRandom(baseSeed ^ domainMask);
  return Array.from({ length: sampleCount }, () =>
    Math.floor(random() * 0x1_0000_0000) >>> 0
  );
}

export function wilsonInterval(
  successes: number,
  sampleCount: number,
  confidenceLevel: number
): ProbabilityInterval {
  if (
    !Number.isInteger(successes) ||
    !Number.isInteger(sampleCount) ||
    successes < 0 ||
    sampleCount <= 0 ||
    successes > sampleCount ||
    confidenceLevel <= 0.5 ||
    confidenceLevel >= 1
  ) {
    throw new Error("Invalid binomial interval inputs");
  }
  const point = successes / sampleCount;
  const z = inverseStandardNormal(confidenceLevel);
  const zSquared = z * z;
  const denominator = 1 + zSquared / sampleCount;
  const center = (point + zSquared / (2 * sampleCount)) / denominator;
  const margin =
    (z *
      Math.sqrt(
        (point * (1 - point)) / sampleCount +
          zSquared / (4 * sampleCount * sampleCount)
      )) /
    denominator;
  return {
    point,
    lower: Math.max(0, center - margin),
    upper: Math.min(1, center + margin),
    confidenceLevel,
  };
}

// Peter J. Acklam's inverse-normal approximation.
function inverseStandardNormal(probability: number): number {
  const a = [
    -39.69683028665376,
    220.9460984245205,
    -275.9285104469687,
    138.357751867269,
    -30.66479806614716,
    2.506628277459239,
  ];
  const b = [
    -54.47609879822406,
    161.5858368580409,
    -155.6989798598866,
    66.80131188771972,
    -13.28068155288572,
  ];
  const c = [
    -0.007784894002430293,
    -0.3223964580411365,
    -2.400758277161838,
    -2.549732539343734,
    4.374664141464968,
    2.938163982698783,
  ];
  const d = [
    0.007784695709041462,
    0.3224671290700398,
    2.445134137142996,
    3.754408661907416,
  ];
  const low = 0.02425;
  const high = 1 - low;
  if (probability < low) {
    const q = Math.sqrt(-2 * Math.log(probability));
    return (
      (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q +
        c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
    );
  }
  if (probability > high) {
    const q = Math.sqrt(-2 * Math.log(1 - probability));
    return -(
      (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q +
        c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
    );
  }
  const q = probability - 0.5;
  const r = q * q;
  return (
    (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r +
      a[5]) *
    q /
    (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1)
  );
}

export function evaluateOptimizerCandidate(
  candidate: OptimizerCandidate,
  input: OptimizerJobInput,
  seeds: readonly number[],
  stage: OptimizerEvaluation["stage"]
): OptimizerEvaluation {
  validateCandidate(
    candidate.strategy,
    input.searchSpace,
    input.objective.tableMax
  );
  if (seeds.length === 0) throw new Error("Evaluation requires a seed bank");

  let targetCount = 0;
  let ruinCount = 0;
  let maxRoundsCensored = 0;
  const maxStakes: number[] = [];
  const maxDrawdowns: number[] = [];
  const config = {
    bankroll: input.objective.bankroll,
    profitTarget: input.objective.profitTarget,
    stopLossAbs: input.objective.stopLossAbs,
    maxRounds: input.objective.maxRounds,
    tableMax: input.objective.tableMax,
    startingLadder: 0,
  };

  for (const seed of seeds) {
    const result = simulateOneSession(
      {
        state: createInitialState(candidate.strategy, 0),
        config,
        strategy: candidate.strategy,
      },
      { seed, game: input.game }
    );
    const reason = result.stopReason;
    if (reason === "profit_target") targetCount += 1;
    if (
      reason === "stop_loss" ||
      reason === "table_limit" ||
      reason === "bankroll_exhausted"
    ) {
      ruinCount += 1;
    }
    if (reason === "max_rounds") maxRoundsCensored += 1;
    maxStakes.push(result.finalState.maxStake);
    maxDrawdowns.push(result.finalState.maxDrawdown);
  }

  const target = wilsonInterval(
    targetCount,
    seeds.length,
    input.objective.confidenceLevel
  );
  const ruin = wilsonInterval(
    ruinCount,
    seeds.length,
    input.objective.confidenceLevel
  );
  return {
    candidate,
    sampleCount: seeds.length,
    target,
    ruin,
    maxRoundsCensored,
    medianMaxStake: quantileR7(maxStakes, 0.5),
    medianMaxDrawdown: quantileR7(maxDrawdowns, 0.5),
    feasible: ruin.upper <= input.objective.ruinTolerance,
    seedBankFingerprint: fingerprintValue(seeds),
    stage,
  };
}

export function compareOptimizerEvaluations(
  left: OptimizerEvaluation,
  right: OptimizerEvaluation
): number {
  return (
    right.target.lower - left.target.lower ||
    left.ruin.upper - right.ruin.upper ||
    left.medianMaxStake - right.medianMaxStake ||
    left.medianMaxDrawdown - right.medianMaxDrawdown ||
    totalSteps(left.candidate) - totalSteps(right.candidate) ||
    left.candidate.fingerprint.localeCompare(right.candidate.fingerprint)
  );
}

export function rankOptimizerEvaluations(
  evaluations: readonly OptimizerEvaluation[]
): OptimizerEvaluation[] {
  return [...evaluations].sort((left, right) => {
    if (left.feasible !== right.feasible) return left.feasible ? -1 : 1;
    return compareOptimizerEvaluations(left, right);
  });
}

function totalSteps(candidate: OptimizerCandidate): number {
  return candidate.strategy.ladders.reduce(
    (total, ladder) => total + ladder.stakes.length,
    0
  );
}
