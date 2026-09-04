/**
 * Test fixture: a saved Ladder Lab preset with coherent provenance. Used by
 * engine and page tests; not part of the production bundle.
 */

import type { SavedOptimizerPreset } from "./optimizer";
import type { StrategyConfig } from "./types";
import { createGameSnapshot, fingerprintValue } from "./games";
import { createLadder } from "./ladder";

export const LAB_FIXTURE_OBJECTIVE = {
  bankroll: 5_000,
  profitTarget: 250,
  stopLossAbs: 1_000,
  maxRounds: 300,
  tableMax: 500,
  ruinTolerance: 0.2,
  confidenceLevel: 0.95,
} as const;

export const LAB_FIXTURE_GAME = {
  gameId: "baccarat_standard_8_deck",
  betVariantId: "banker_5pct_commission",
} as const;

export const LAB_FIXTURE_ONE_LADDER = [createLadder("Lab 1", [5, 10, 20])];
export const LAB_FIXTURE_TWO_LADDERS = [
  createLadder("Lab 1", [5, 10, 20]),
  createLadder("Lab 2", [25, 50, 100]),
];

export function createLabPresetFixture(
  ladders: StrategyConfig["ladders"] = LAB_FIXTURE_TWO_LADDERS,
  overrides: Partial<SavedOptimizerPreset["provenance"]> = {}
): SavedOptimizerPreset {
  const strategy: StrategyConfig = {
    ladders,
    bridgingPolicy: "advance_to_next_ladder_start",
    recoveryTargetPct: 0.25,
    crossoverOffset: 1,
  };
  const game = createGameSnapshot(
    LAB_FIXTURE_GAME.gameId,
    LAB_FIXTURE_GAME.betVariantId
  );
  const candidate = {
    fingerprint: fingerprintValue(strategy),
    strategy,
    shape: {
      ladderCount: ladders.length,
      stepsPerLadder: ladders[0].stakes.length,
      stakeIncrement: 5,
      policy: strategy.bridgingPolicy,
      recoveryTargetPct: strategy.recoveryTargetPct,
      crossoverOffset: strategy.crossoverOffset,
    },
  };
  return {
    id: "custom:test-preset",
    version: 1,
    displayName: "Lab Test",
    createdAt: 0,
    strategy,
    provenance: {
      engineVersion: "ladder-optimizer-v1",
      candidateFingerprint: candidate.fingerprint,
      inputFingerprint: "input",
      confirmation: {
        candidate,
        sampleCount: 600,
        target: { point: 0.6, lower: 0.55, upper: 0.65, confidenceLevel: 0.95 },
        ruin: { point: 0.1, lower: 0.08, upper: 0.15, confidenceLevel: 0.95 },
        maxRoundsCensored: 0,
        medianMaxStake: 20,
        medianMaxDrawdown: 40,
        feasible: true,
        seedBankFingerprint: "seeds",
        stage: "confirmation",
      },
      objective: LAB_FIXTURE_OBJECTIVE,
      gameFingerprint: game.fingerprint,
      ...overrides,
    },
  };
}
