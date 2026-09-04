import { describe, expect, it } from "vitest";
import {
  GAME_SPECS,
  createGameSnapshot,
  expectedReturnPerUnit,
  settleOutcome,
  validateGameRegistry,
} from "./games";
import { createInitialState, processOutcome } from "./session";
import { createLadder } from "./ladder";
import type { GameSpec, SessionConfig, StrategyConfig } from "./types";

const strategy: StrategyConfig = {
  ladders: [createLadder("L1", [10, 20])],
  bridgingPolicy: "carry_over_index_delta",
  recoveryTargetPct: 0.5,
  crossoverOffset: 0,
};
const config: SessionConfig = {
  bankroll: 1_000,
  profitTarget: 500,
  stopLossAbs: 500,
  maxRounds: 100,
  startingLadder: 0,
};

describe("game registry and settlement", () => {
  it("validates the built-in registry", () => {
    expect(() => validateGameRegistry(GAME_SPECS)).not.toThrow();
  });

  it("rejects probabilities that do not sum to one", () => {
    const invalid = structuredClone(GAME_SPECS) as GameSpec[];
    const outcomes = invalid[0].betVariants[0].outcomes as unknown as {
      probability: number;
    }[];
    outcomes[0].probability = 0.1;
    expect(() => validateGameRegistry(invalid)).toThrow(/sum/i);
  });

  it("settles even-money wins and losses exactly", () => {
    const game = createGameSnapshot("even_money", "even_money");
    expect(settleOutcome(10, game, "win")).toBe(10);
    expect(settleOutcome(10, game, "loss")).toBe(-10);
  });

  it("settles Banker commission and tie-as-push to cents", () => {
    const game = createGameSnapshot(
      "baccarat_standard_8_deck",
      "banker_5pct_commission"
    );
    expect(settleOutcome(5, game, "banker_win")).toBe(4.75);
    expect(settleOutcome(0.1, game, "banker_win")).toBe(0.1);
    expect(settleOutcome(5, game, "banker_loss")).toBe(-5);
    expect(settleOutcome(5, game, "tie")).toBe(0);
    expect(expectedReturnPerUnit(game)).toBeCloseTo(-0.010579, 5);
  });

  it("uses point-specific craps odds payouts with zero conditional EV", () => {
    const cases = [
      ["point_4_10", 2],
      ["point_5_9", 1.5],
      ["point_6_8", 1.2],
    ] as const;
    for (const [variant, payout] of cases) {
      const game = createGameSnapshot("craps_single_odds", variant);
      expect(settleOutcome(10, game, "point_win")).toBe(10 * payout);
      expect(settleOutcome(10, game, "seven_loss")).toBe(-10);
      expect(expectedReturnPerUnit(game)).toBeCloseTo(0, 12);
    }
  });

  it("keeps a push on the same ladder position without bridging", () => {
    const game = createGameSnapshot(
      "baccarat_standard_8_deck",
      "banker_5pct_commission"
    );
    const initial = {
      ...createInitialState(strategy),
      currentIndex: 1,
    };
    const result = processOutcome(
      initial,
      config,
      strategy,
      game,
      "tie",
      "at_bridging_only"
    );
    expect(result.rounds).toBe(1);
    expect(result.totalWagered).toBe(20);
    expect(result.pnl).toBe(0);
    expect(result.currentIndex).toBe(1);
    expect(result.currentLadder).toBe(0);
    expect(result.awaitingDecision).toBe(false);
    expect(result.pushCount).toBe(1);
  });

  it("rejects an outcome from another variant", () => {
    const game = createGameSnapshot("craps_single_odds", "point_4_10");
    expect(() =>
      processOutcome(
        createInitialState(strategy),
        config,
        strategy,
        game,
        {
          gameId: game.gameId,
          gameVersion: game.gameVersion,
          betVariantId: "point_5_9",
          outcomeId: "point_win",
        },
        "at_bridging_only"
      )
    ).toThrow(/does not belong/i);
  });
});
