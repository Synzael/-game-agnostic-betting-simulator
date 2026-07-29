/**
 * Core type definitions for the betting strategy engine.
 * Ported from Python simulator.py dataclasses.
 */

/**
 * Specification for a stake ladder.
 */
export interface LadderSpec {
  readonly name: string;
  readonly stakes: readonly number[];
}

/**
 * Bridging policy when losing at top of ladder.
 */
export type BridgingPolicy =
  | "advance_to_next_ladder_start"
  | "carry_over_index_delta"
  | "stop_at_table_limit";

/**
 * Strategy configuration.
 */
export interface StrategyConfig {
  readonly ladders: readonly LadderSpec[];
  readonly bridgingPolicy: BridgingPolicy;
  readonly recoveryTargetPct: number; // 0.0-1.0
  readonly crossoverOffset: number;
}

/**
 * How a settled game outcome moves the staking ladder.
 */
export type ProgressionEffect = "win" | "loss" | "neutral";

/**
 * A declarative game outcome. `netPayoutMultiplier` is net P&L divided by
 * stake, not the amount returned including the original stake.
 */
export interface GameOutcomeSpec {
  readonly id: string;
  readonly displayName: string;
  readonly probability: number;
  readonly netPayoutMultiplier: number;
  readonly progressionEffect: ProgressionEffect;
}

export interface BetVariantSpec {
  readonly id: string;
  readonly displayName: string;
  readonly outcomes: readonly GameOutcomeSpec[];
  readonly settlementVersion: number;
  readonly roundingRule: "nearest_cent_half_away_from_zero";
}

export interface GameSpec {
  readonly id: string;
  readonly version: number;
  readonly displayName: string;
  readonly description: string;
  readonly betVariants: readonly BetVariantSpec[];
  readonly assumptions: string;
}

/**
 * The complete game/variant definition frozen into a session. Registry
 * updates cannot change settlement or replay for an active or old session.
 */
export interface FrozenGameSnapshot {
  readonly gameId: string;
  readonly gameVersion: number;
  readonly gameDisplayName: string;
  readonly gameDescription: string;
  readonly assumptions: string;
  readonly betVariant: BetVariantSpec;
  readonly fingerprint: string;
}

export interface RecordedOutcome {
  readonly gameId: string;
  readonly gameVersion: number;
  readonly betVariantId: string;
  readonly outcomeId: string;
}

/**
 * Session configuration.
 */
export interface SessionConfig {
  readonly bankroll: number;
  readonly profitTarget: number;
  readonly stopLossAbs: number;
  readonly maxRounds: number;
  readonly tableMax?: number;
  readonly startingLadder: number; // 0, 1, or 2 for L1, L2, L3
}

/**
 * Decision mode setting.
 */
export type DecisionMode = "at_bridging_only" | "every_bet";

/**
 * Decision options when at bridging point.
 */
export type BridgingDecision = "carry_over" | "write_off" | "stop_session";

/**
 * Stop reasons for session termination.
 */
export type StopReason =
  | "profit_target"
  | "stop_loss"
  | "max_rounds"
  | "table_limit"
  | "bankroll_exhausted"
  | "user_stopped"
  | null;

/**
 * Current session state.
 */
export interface SessionState {
  // Position tracking
  currentLadder: number;
  currentIndex: number;

  // Performance tracking
  pnl: number;
  rounds: number;
  totalWagered: number;
  maxStake: number;
  maxDrawdown: number;
  peakPnl: number;

  // Outcome statistics
  winCount: number;
  lossCount: number;
  pushCount: number;

  // Ladder statistics
  ladderTouches: Record<number, number>;
  topTouches: number;

  // Session control
  stopped: boolean;
  stopReason: StopReason;

  // Recovery mode (for carry_over_index_delta)
  inRecovery: boolean;
  recoveryTargetPnl: number;

  // Decision state
  awaitingDecision: boolean;
  pendingDecisionType: "bridging" | "every_bet" | null;
}

/**
 * Roguelike adventure event recorded when the player makes a
 * bridging decision. Terminal outcomes are not logged here — they
 * are derivable from SessionState.stopReason / SessionResult flags.
 */
export interface SessionEvent {
  readonly round: number;
  readonly timestamp: number;
  readonly type: "carry_over" | "write_off";
  readonly pnlAt: number;
  readonly fromLadder: number;
  readonly toLadder: number;
}

/**
 * Single bet record for history tracking.
 */
export interface BetRecord {
  readonly round: number;
  readonly timestamp: number;
  readonly ladder: number;
  readonly index: number;
  readonly stake: number;
  /**
   * Compatibility evidence for v1 histories. New records use `outcome`,
   * `progressionEffect`, and exact `settledPnl`.
   */
  readonly won?: boolean;
  readonly outcome?: RecordedOutcome;
  readonly outcomeDisplayName?: string;
  readonly progressionEffect?: ProgressionEffect;
  readonly settledPnl?: number;
  readonly pnlAfter: number;
}

export interface VarianceBandPoint {
  readonly round: number;
  readonly p05: number;
  readonly p25: number;
  readonly p50: number;
  readonly p75: number;
  readonly p95: number;
}

export interface VarianceForecast {
  readonly points: readonly VarianceBandPoint[];
  readonly sampleCount: number;
  readonly seed: number;
  readonly engineVersion: string;
  readonly inputFingerprint: string;
  readonly anchorScheduleVersion: number;
  readonly terminalHandling: "absorbing_final_pnl";
  readonly quantileEstimator: "r7_linear";
  readonly gameFingerprint: string;
  readonly generatedAt: number;
  readonly quality: "preview" | "full";
}

/**
 * Complete session result for history.
 */
export interface SessionResult {
  readonly id: string;
  readonly startTime: number;
  readonly endTime: number;

  // Stop reasons
  readonly hitTarget: boolean;
  readonly hitStopLoss: boolean;
  readonly hitMaxRounds: boolean;
  readonly hitTableLimit: boolean;
  readonly bankrollExhausted: boolean;
  readonly userStopped: boolean;

  // Performance metrics
  readonly finalPnl: number;
  readonly roundsPlayed: number;
  readonly totalWagered: number;
  readonly maxStakeSeen: number;
  readonly maxDrawdown: number;

  // Ladder tracking
  readonly ladderTouches: Record<number, number>;
  readonly topOfLadderTouches: number;
  readonly finalLadder: number;
  readonly finalIndex: number;

  // Configuration snapshot
  readonly config: SessionConfig;
  readonly strategy: StrategyConfig;
  readonly game?: FrozenGameSnapshot;

  // Bet history (optional, for replay)
  readonly betHistory?: readonly BetRecord[];

  // Bridging decision events (optional, for adventure graph)
  readonly events?: readonly SessionEvent[];

  // Compact pre-session modeled range used by history/ledger views.
  readonly forecastSnapshot?: VarianceForecast;
}

/**
 * Categories preserved independently from ordinary session history.
 */
export type TrophyCategory =
  | "biggest_comeback"
  | "longest_survival"
  | "perfect_run";

export interface TrophyEvidence {
  readonly metric: number | boolean;
  readonly facts: Readonly<Record<string, number | string | boolean>>;
  readonly rulesVersion: number;
}

export interface VaultSessionSnapshot {
  readonly session: SessionResult;
  readonly preservedAt: number;
}

export interface TrophySlot {
  readonly category: TrophyCategory;
  readonly sessionId: string;
  readonly evidence: TrophyEvidence;
}

/**
 * Preset configuration.
 */
export interface PresetConfig {
  readonly name: string;
  readonly displayName: string;
  readonly bridgingPolicy: BridgingPolicy;
  readonly recoveryTargetPct: number;
  readonly crossoverOffset: number;
  readonly description: string;
}

/**
 * App settings persisted across sessions.
 */
export interface AppSettings {
  decisionMode: DecisionMode;
  hapticFeedback: boolean;
  soundEffects: boolean;
  theme: "light" | "dark" | "system";
  lastPreset: string;
}
