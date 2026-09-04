import { describe, expect, it } from "vitest";
import { createLadder } from "./ladder";
import { createDefaultGameSnapshot } from "./games";
import type { FrozenGameSnapshot } from "./types";
import {
  classifyVariance,
  generateAnchorSchedule,
  interpolateVarianceAtRound,
  quantileR7,
  runVarianceForecast,
  simulatePnlAtAnchors,
  type VarianceForecastInput,
} from "./variance-forecast";

function binaryGame(pWin: number): FrozenGameSnapshot {
  const base = createDefaultGameSnapshot();
  return {
    ...base,
    fingerprint: `test-${pWin}`,
    betVariant: {
      ...base.betVariant,
      outcomes: base.betVariant.outcomes.map((outcome) => ({
        ...outcome,
        probability:
          outcome.progressionEffect === "win" ? pWin : 1 - pWin,
      })),
    },
  };
}

function input(game = binaryGame(0.5)): VarianceForecastInput {
  return {
    game,
    strategy: {
      ladders: [createLadder("L1", [10])],
      bridgingPolicy: "stop_at_table_limit",
      recoveryTargetPct: 0.5,
      crossoverOffset: 0,
    },
    config: {
      bankroll: 100,
      profitTarget: 10,
      stopLossAbs: 100,
      maxRounds: 550,
      startingLadder: 0,
    },
  };
}

describe("variance forecast", () => {
  it("uses R-7 linear quantiles", () => {
    expect(quantileR7([0, 10, 20, 30], 0.25)).toBe(7.5);
    expect(quantileR7([0, 10, 20, 30], 0.5)).toBe(15);
  });

  it("generates deterministic bounded anchors", () => {
    const anchors = generateAnchorSchedule(550);
    expect(anchors[0]).toBe(0);
    expect(anchors.at(-1)).toBe(550);
    expect(anchors).toContain(100);
    expect(anchors).toContain(105);
    expect(anchors).toContain(500);
    expect(anchors).toContain(525);
    expect(anchors).not.toContain(101);
  });

  it("carries terminal P&L through later anchors", () => {
    const base = input(binaryGame(1));
    const values = simulatePnlAtAnchors(
      {
        ...base,
        config: { ...base.config, maxRounds: 5 },
      },
      [0, 1, 2, 5],
      1
    );
    expect(values).toEqual([0, 10, 10, 10]);
  });

  it("is stable for a fixed seed and keeps percentile order", () => {
    const base = input(binaryGame(0.5));
    const forecastInput = {
      ...base,
      config: { ...base.config, profitTarget: 50, maxRounds: 20 },
    };
    const first = runVarianceForecast(forecastInput, 40, 1234, 10);
    const second = runVarianceForecast(forecastInput, 40, 1234, 10);
    expect(first).toEqual(second);
    first.points.forEach((point) => {
      expect(point.p05).toBeLessThanOrEqual(point.p25);
      expect(point.p25).toBeLessThanOrEqual(point.p50);
      expect(point.p50).toBeLessThanOrEqual(point.p75);
      expect(point.p75).toBeLessThanOrEqual(point.p95);
    });
  });

  it("interpolates boundaries and classifies P5/P95 as within", () => {
    const points = [
      { round: 0, p05: 0, p25: 0, p50: 0, p75: 0, p95: 0 },
      { round: 10, p05: -10, p25: -5, p50: 0, p75: 5, p95: 10 },
    ];
    const middle = interpolateVarianceAtRound(points, 5);
    expect(middle?.p05).toBe(-5);
    expect(middle?.p95).toBe(5);
    expect(classifyVariance(-5, middle!)).toBe("within");
    expect(classifyVariance(5, middle!)).toBe("within");
    expect(classifyVariance(-5.01, middle!)).toBe("below");
    expect(classifyVariance(5.01, middle!)).toBe("above");
  });
});

