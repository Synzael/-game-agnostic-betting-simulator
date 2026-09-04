/**
 * Effective session plan resolution.
 *
 * Setup previews and session creation must agree exactly. This module is the
 * single place that turns a preset selection plus session settings into the
 * config, strategy, and game snapshot that `startSession` freezes, and it
 * reports every adjustment the engine would otherwise apply silently.
 */

import type {
  FrozenGameSnapshot,
  PresetConfig,
  SessionConfig,
  StrategyConfig,
} from "./types";
import type { SavedOptimizerPreset } from "./optimizer";
import { PRESETS, createStrategyFromPreset } from "./presets";
import { createGameSnapshot, fingerprintValue, getAllGames } from "./games";
import { formatStake } from "./ladder";

export type SessionPlanSource =
  | { readonly kind: "builtin"; readonly preset: PresetConfig }
  | { readonly kind: "custom"; readonly preset: SavedOptimizerPreset };

/** A saved value the engine changes before the session runs. */
export interface SessionPlanAdjustment {
  readonly field: "startingLadder";
  readonly label: string;
  readonly saved: string;
  readonly effective: string;
  readonly reason: string;
}

export interface ProvenanceMismatch {
  readonly field: string;
  readonly confirmed: string;
  readonly current: string;
}

export interface SessionPlanProvenance {
  readonly status:
    | "confirmed_for_these_settings"
    | "confirmed_for_other_settings";
  readonly mismatches: readonly ProvenanceMismatch[];
  readonly ruinUpperBound: number;
  readonly targetLowerBound: number;
  readonly confidenceLevel: number;
  readonly sampleCount: number;
  readonly engineVersion: string;
}

export interface SessionPlan {
  readonly source: SessionPlanSource;
  /** Exactly what `startSession` receives. */
  readonly config: SessionConfig;
  /** Exactly what `startSession` receives. */
  readonly strategy: StrategyConfig;
  readonly game: FrozenGameSnapshot;
  readonly firstStake: number;
  readonly highestStake: number;
  readonly adjustments: readonly SessionPlanAdjustment[];
  /** Problems that make the session unable to run as configured. */
  readonly blockers: readonly string[];
  readonly provenance: SessionPlanProvenance | null;
}

export type SessionPlanResolution =
  | { readonly ok: true; readonly plan: SessionPlan }
  | { readonly ok: false; readonly error: string };

export interface ResolveSessionPlanInput {
  readonly presetId: string;
  readonly customPresets: readonly SavedOptimizerPreset[];
  readonly config: SessionConfig;
  readonly gameId: string;
  readonly betVariantId: string;
}

function describeTableMax(tableMax: number | undefined): string {
  return tableMax === undefined ? "none" : formatStake(tableMax);
}

function resolveSource(
  presetId: string,
  customPresets: readonly SavedOptimizerPreset[]
): SessionPlanSource | null {
  const custom = customPresets.find((preset) => preset.id === presetId);
  if (custom) return { kind: "custom", preset: custom };
  const builtin = PRESETS[presetId];
  if (builtin) return { kind: "builtin", preset: builtin };
  return null;
}

function resolveStrategy(source: SessionPlanSource): StrategyConfig {
  return source.kind === "custom"
    ? structuredClone(source.preset.strategy)
    : createStrategyFromPreset(source.preset.name);
}

function resolveProvenance(
  preset: SavedOptimizerPreset,
  strategy: StrategyConfig,
  config: SessionConfig,
  game: FrozenGameSnapshot
): SessionPlanProvenance {
  const { objective, gameFingerprint, confirmation } = preset.provenance;
  const mismatches: ProvenanceMismatch[] = [];
  const compare = (
    field: string,
    confirmed: string,
    current: string
  ): void => {
    if (confirmed !== current) mismatches.push({ field, confirmed, current });
  };

  compare(
    "Game",
    gameFingerprint,
    game.fingerprint
  );
  compare(
    "Bankroll",
    formatStake(objective.bankroll),
    formatStake(config.bankroll)
  );
  compare(
    "Profit target",
    formatStake(objective.profitTarget),
    formatStake(config.profitTarget)
  );
  compare(
    "Stop loss",
    formatStake(objective.stopLossAbs),
    formatStake(config.stopLossAbs)
  );
  compare(
    "Max rounds",
    String(objective.maxRounds),
    String(config.maxRounds)
  );
  compare(
    "Table max",
    describeTableMax(objective.tableMax),
    describeTableMax(config.tableMax)
  );
  // The Lab evaluates every candidate from its first ladder.
  compare(
    "Starting ladder",
    strategy.ladders[0].name,
    strategy.ladders[config.startingLadder].name
  );
  compare(
    "Ladder fingerprint",
    preset.provenance.candidateFingerprint,
    fingerprintValue(strategy)
  );

  return {
    status:
      mismatches.length === 0
        ? "confirmed_for_these_settings"
        : "confirmed_for_other_settings",
    mismatches: mismatches.map((mismatch) =>
      mismatch.field === "Game"
        ? {
            field: mismatch.field,
            confirmed: "a different game or bet variant",
            current: `${game.gameDisplayName} · ${game.betVariant.displayName}`,
          }
        : mismatch
    ),
    ruinUpperBound: confirmation.ruin.upper,
    targetLowerBound: confirmation.target.lower,
    confidenceLevel: confirmation.target.confidenceLevel,
    sampleCount: confirmation.sampleCount,
    engineVersion: preset.provenance.engineVersion,
  };
}

/**
 * Resolve the effective plan for a preset selection. Never substitutes a
 * different strategy: an unknown preset id is an error, not a fallback.
 */
export function resolveSessionPlan(
  input: ResolveSessionPlanInput
): SessionPlanResolution {
  const source = resolveSource(input.presetId, input.customPresets);
  if (!source) {
    return {
      ok: false,
      error:
        "The selected strategy preset is no longer available. Choose another preset before starting.",
    };
  }

  let game: FrozenGameSnapshot;
  try {
    game = createGameSnapshot(input.gameId, input.betVariantId);
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof Error
          ? error.message
          : "The selected game is not registered.",
    };
  }

  const strategy = resolveStrategy(source);
  if (strategy.ladders.length === 0) {
    return { ok: false, error: "The selected preset has no ladders." };
  }

  const adjustments: SessionPlanAdjustment[] = [];
  const savedStartingLadder = input.config.startingLadder;
  const effectiveStartingLadder = Math.max(
    0,
    Math.min(Math.trunc(savedStartingLadder), strategy.ladders.length - 1)
  );
  if (effectiveStartingLadder !== savedStartingLadder) {
    adjustments.push({
      field: "startingLadder",
      label: "Starting ladder",
      saved: `ladder ${savedStartingLadder + 1}`,
      effective: strategy.ladders[effectiveStartingLadder].name,
      reason: `${source.kind === "custom" ? "This Lab preset" : "This preset"} has ${strategy.ladders.length} ladder${strategy.ladders.length === 1 ? "" : "s"}, so the engine starts on the last available one.`,
    });
  }

  const config: SessionConfig = {
    ...input.config,
    startingLadder: effectiveStartingLadder,
  };

  const firstStake = strategy.ladders[effectiveStartingLadder].stakes[0];
  const highestStake = Math.max(
    ...strategy.ladders.flatMap((ladder) => [...ladder.stakes])
  );

  const blockers: string[] = [];
  if (firstStake > config.bankroll) {
    blockers.push(
      `The first stake ${formatStake(firstStake)} exceeds the ${formatStake(config.bankroll)} bankroll, so no bet could be placed.`
    );
  }
  if (config.tableMax !== undefined && firstStake > config.tableMax) {
    blockers.push(
      `The first stake ${formatStake(firstStake)} exceeds the ${formatStake(config.tableMax)} table max, so the session would stop at the table limit before its first bet.`
    );
  }

  return {
    ok: true,
    plan: {
      source,
      config,
      strategy,
      game,
      firstStake,
      highestStake,
      adjustments,
      blockers,
      provenance:
        source.kind === "custom"
          ? resolveProvenance(source.preset, strategy, config, game)
          : null,
    },
  };
}

/**
 * Session settings that reproduce the objective a Lab preset was confirmed
 * against. Only the settings change; the saved ladders are never reshaped.
 */
export function configFromPresetProvenance(
  preset: SavedOptimizerPreset,
  current: SessionConfig
): SessionConfig {
  const { objective } = preset.provenance;
  return {
    ...current,
    bankroll: objective.bankroll,
    profitTarget: objective.profitTarget,
    stopLossAbs: objective.stopLossAbs,
    maxRounds: objective.maxRounds,
    tableMax: objective.tableMax,
    startingLadder: 0,
  };
}

/**
 * Locate the registered game/variant whose frozen snapshot carries the given
 * fingerprint, or null when the registry no longer produces it.
 */
export function findRegisteredGameByFingerprint(
  fingerprint: string
): { readonly gameId: string; readonly betVariantId: string } | null {
  for (const game of getAllGames()) {
    for (const variant of game.betVariants) {
      if (createGameSnapshot(game.id, variant.id).fingerprint === fingerprint) {
        return { gameId: game.id, betVariantId: variant.id };
      }
    }
  }
  return null;
}
