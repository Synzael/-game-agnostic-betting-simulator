/**
 * Canonical money helpers.
 *
 * Settlement and accumulation are performed in integer cents. Dollar numbers
 * remain the public boundary format for compatibility with existing persisted
 * sessions and UI controls.
 */

export type MinorUnits = number & { readonly __minorUnits: unique symbol };

const MINOR_PER_MAJOR = 100;
const MAX_DECIMAL_PLACES = 2;

export function toMinorUnits(value: number): MinorUnits {
  if (!Number.isFinite(value)) {
    throw new Error("Money value must be finite");
  }

  return roundHalfAwayFromZero(value * MINOR_PER_MAJOR) as MinorUnits;
}

export function fromMinorUnits(value: MinorUnits): number {
  return value / MINOR_PER_MAJOR;
}

export function roundHalfAwayFromZero(value: number): number {
  if (!Number.isFinite(value)) {
    throw new Error("Value must be finite");
  }

  const magnitude = Math.floor(Math.abs(value) + 0.5 + Number.EPSILON);
  return value < 0 ? -magnitude : magnitude;
}

export function settleNetPnl(
  stake: number,
  netPayoutMultiplier: number
): MinorUnits {
  if (stake <= 0 || !Number.isFinite(stake)) {
    throw new Error("Stake must be a positive finite money value");
  }
  if (!Number.isFinite(netPayoutMultiplier)) {
    throw new Error("Payout multiplier must be finite");
  }

  const stakeMinor = toMinorUnits(stake);
  return roundHalfAwayFromZero(
    stakeMinor * netPayoutMultiplier
  ) as MinorUnits;
}

export function addMoney(left: number, right: number): number {
  return fromMinorUnits(
    (toMinorUnits(left) + toMinorUnits(right)) as MinorUnits
  );
}

export function subtractMoney(left: number, right: number): number {
  return fromMinorUnits(
    (toMinorUnits(left) - toMinorUnits(right)) as MinorUnits
  );
}

export function isCanonicalMoney(value: number): boolean {
  return (
    Number.isFinite(value) &&
    Math.abs(value * MINOR_PER_MAJOR - Math.round(value * MINOR_PER_MAJOR)) <
      10 ** -MAX_DECIMAL_PLACES
  );
}

