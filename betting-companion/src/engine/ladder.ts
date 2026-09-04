/**
 * Ladder specification and stake calculation utilities.
 * Ported from Python simulator.py LadderSpec class.
 */

import { LadderSpec } from "./types";

/**
 * Create a new ladder specification.
 */
export function createLadder(name: string, stakes: number[]): LadderSpec {
  if (stakes.length === 0) {
    throw new Error("Ladder must have at least one stake");
  }
  if (stakes.some((s) => s <= 0)) {
    throw new Error("All stakes must be positive");
  }
  return { name, stakes: Object.freeze([...stakes]) };
}

/**
 * Get the maximum valid index for a ladder.
 */
export function getMaxIndex(ladder: LadderSpec): number {
  return ladder.stakes.length - 1;
}

/**
 * Get stake at given index, clamped to valid range.
 */
export function getStake(ladder: LadderSpec, index: number): number {
  const clampedIndex = Math.max(0, Math.min(index, getMaxIndex(ladder)));
  return ladder.stakes[clampedIndex];
}

/**
 * Check if index is at top of ladder.
 */
export function isAtTop(ladder: LadderSpec, index: number): boolean {
  return index >= getMaxIndex(ladder);
}

/**
 * Check if index is at bottom of ladder.
 */
export function isAtBottom(index: number): boolean {
  return index <= 0;
}

/**
 * Default ladders from Python create_default_ladders().
 * L1: Low stakes progression
 * L2: Medium stakes progression
 * L3: High stakes progression
 */
export const DEFAULT_LADDERS: readonly LadderSpec[] = Object.freeze([
  createLadder("L1", [5, 10, 15, 25, 40, 65, 105, 170, 275]),
  createLadder("L2", [50, 100, 150, 250, 400, 650, 1050, 1750]),
  createLadder("L3", [
    500, 1000, 1500, 2500, 4000, 6500, 10500, 17000, 27500, 44500,
  ]),
]);

/**
 * Get the total number of stakes across all ladders.
 */
export function getTotalStakes(ladders: readonly LadderSpec[]): number {
  return ladders.reduce((sum, ladder) => sum + ladder.stakes.length, 0);
}

/**
 * Format stake as currency string.
 */
export function formatStake(stake: number): string {
  const hasCents = Math.abs(stake * 100 - Math.round(stake) * 100) > 0.001;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: hasCents ? 2 : 0,
    maximumFractionDigits: 2,
  }).format(stake);
}
