/**
 * Engine module barrel export.
 */

// Types
export type {
  LadderSpec,
  BridgingPolicy,
  StrategyConfig,
  ProgressionEffect,
  GameOutcomeSpec,
  BetVariantSpec,
  GameSpec,
  FrozenGameSnapshot,
  RecordedOutcome,
  SessionConfig,
  DecisionMode,
  BridgingDecision,
  StopReason,
  SessionState,
  BetRecord,
  SessionResult,
  VarianceBandPoint,
  VarianceForecast,
  TrophyCategory,
  TrophyEvidence,
  TrophySlot,
  VaultSessionSnapshot,
  PresetConfig,
  AppSettings,
} from "./types";

export type {
  SimulationGameSpec,
  SessionSimulationStart,
  SimulateOneSessionOptions,
  SimulatedSessionResult,
} from "./monte-carlo";

export type {
  DecisionGhostInput,
  DecisionGhostStopProbabilities,
  DecisionGhostBranchForecast,
  DecisionGhostForecast,
  DecisionGhostAccumulator,
  RunDecisionGhostForecastOptions,
} from "./decision-ghosts";

export type {
  SideBetKey,
  CountZone,
  CardRank,
  CountingEngineConfig,
  SideBetSnapshot,
  CountingSnapshot,
} from "./countingEngine";

// Ladder utilities
export {
  createLadder,
  getMaxIndex,
  getStake,
  isAtTop,
  isAtBottom,
  DEFAULT_LADDERS,
  getTotalStakes,
  formatStake,
} from "./ladder";

// Presets
export {
  PRESETS,
  getPreset,
  getPresetNames,
  getAllPresets,
  createStrategyFromPreset,
  createStrategy,
  DEFAULT_SESSION_CONFIG,
} from "./presets";

// Session engine
export {
  createInitialState,
  getCurrentStake,
  getCurrentBankroll,
  canAffordStake,
  exceedsTableMax,
  processBet,
  processOutcome,
  processBridgingDecision,
  processAutomatedBridge,
  getProfitProgress,
  getStopLossProgress,
  getStopReasonText,
  isWinningSession,
  getLadderName,
} from "./session";

// Game registry and settlement
export {
  GAME_REGISTRY_VERSION,
  GAME_PROBABILITY_TOLERANCE,
  GAME_SPECS,
  validateGameRegistry,
  getAllGames,
  getGame,
  getBetVariant,
  createGameSnapshot,
  createDefaultGameSnapshot,
  createLegacyGameSnapshot,
  resolveOutcomeSpec,
  createRecordedOutcome,
  settleOutcome,
  expectedReturnPerUnit,
  fingerprintValue,
} from "./games";

export type { MinorUnits } from "./money";
export {
  toMinorUnits,
  fromMinorUnits,
  roundHalfAwayFromZero,
  settleNetPnl,
  addMoney,
  subtractMoney,
  isCanonicalMoney,
} from "./money";

// Browser-side Monte Carlo
export {
  DEFAULT_SIMULATION_GAME,
  createSeededRandom,
  cloneSessionState,
  simulateOneSession,
} from "./monte-carlo";

export type {
  VarianceForecastInput,
  VarianceAccumulator,
  VarianceClassification,
} from "./variance-forecast";
export {
  VARIANCE_ENGINE_VERSION,
  VARIANCE_ANCHOR_SCHEDULE_VERSION,
  VARIANCE_PREVIEW_SAMPLES,
  VARIANCE_FULL_SAMPLES,
  generateAnchorSchedule,
  quantileR7,
  createVarianceFingerprint,
  createVarianceSeed,
  deriveVarianceSampleSeed,
  sampleGameOutcomeId,
  simulatePnlAtAnchors,
  createVarianceAccumulator,
  addVarianceSample,
  summarizeVarianceForecast,
  runVarianceForecast,
  interpolateVarianceAtRound,
  classifyVariance,
} from "./variance-forecast";

export type {
  OptimizerSearchSpace,
  OptimizerObjective,
  OptimizerJobInput,
  OptimizerCandidate,
  ProbabilityInterval,
  OptimizerEvaluation,
  OptimizerResult,
  SavedOptimizerPreset,
} from "./optimizer";
export {
  OPTIMIZER_ENGINE_VERSION,
  OPTIMIZER_GRID_THRESHOLD,
  OPTIMIZER_MAX_CANDIDATES,
  validateOptimizerInput,
  estimateSearchCardinality,
  createOptimizerInputFingerprint,
  validateCandidate,
  generateGridCandidates,
  generateEvolutionaryCandidates,
  evolveCandidatePopulation,
  createSeedBank,
  wilsonInterval,
  evaluateOptimizerCandidate,
  compareOptimizerEvaluations,
  rankOptimizerEvaluations,
} from "./optimizer";

// Mid-session choice forecasts
export {
  DECISION_GHOSTS_ENGINE_VERSION,
  DECISION_GHOSTS_PREVIEW_SAMPLES,
  DECISION_GHOSTS_TOTAL_SAMPLES,
  createDecisionGhostAccumulator,
  deriveDecisionSampleSeed,
  addDecisionGhostSample,
  quantile,
  summarizeDecisionGhostForecast,
  runDecisionGhostForecast,
  createDecisionGhostFingerprint,
  createDecisionGhostSeed,
  createDefaultDecisionGhostInput,
} from "./decision-ghosts";

export { CountingEngine, DEFAULT_COUNTING_ENGINE_CONFIG } from "./countingEngine";

// Vault trophy evaluation
export {
  TROPHY_CATEGORIES,
  TROPHY_RULES_VERSION,
  compactSessionResult,
  evaluateTrophyCandidates,
  isValidCompletedSession,
  shouldReplaceTrophy,
} from "./vault";
