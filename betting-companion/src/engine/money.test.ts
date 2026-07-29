import { describe, expect, it } from "vitest";
import {
  addMoney,
  fromMinorUnits,
  roundHalfAwayFromZero,
  settleNetPnl,
  toMinorUnits,
} from "./money";

describe("canonical money", () => {
  it("rounds half cents away from zero", () => {
    expect(roundHalfAwayFromZero(9.5)).toBe(10);
    expect(roundHalfAwayFromZero(-9.5)).toBe(-10);
  });

  it("round-trips canonical cents", () => {
    expect(fromMinorUnits(toMinorUnits(12.34))).toBe(12.34);
  });

  it("settles a half-cent commission deterministically", () => {
    expect(fromMinorUnits(settleNetPnl(0.1, 0.95))).toBe(0.1);
    expect(fromMinorUnits(settleNetPnl(0.1, -0.95))).toBe(-0.1);
  });

  it("accumulates without floating-point drift", () => {
    expect(addMoney(addMoney(0.1, 0.2), 0.3)).toBe(0.6);
  });
});

