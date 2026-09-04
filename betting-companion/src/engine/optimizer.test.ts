import { describe, expect, it } from "vitest";
import {
  compareOptimizerEvaluations,
  createSeedBank,
  estimateSearchCardinality,
  evaluateOptimizerCandidate,
  evolveCandidatePopulation,
  generateEvolutionaryCandidates,
  generateGridCandidates,
  rankOptimizerEvaluations,
  validateOptimizerInput,
  wilsonInterval,
  type OptimizerJobInput,
} from "./optimizer";
import { createDefaultGameSnapshot, createGameSnapshot } from "./games";
import type { FrozenGameSnapshot } from "./types";

function binaryGame(pWin: number): FrozenGameSnapshot {
  const base = createDefaultGameSnapshot();
  return {
    ...base,
    fingerprint: `binary-${pWin}`,
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

function baseInput(game = binaryGame(0.5)): OptimizerJobInput {
  return {
    searchSpace: {
      ladderCount: { min: 1, max: 2 },
      stepsPerLadder: { min: 2, max: 3 },
      minimumStake: 5,
      maximumStake: 100,
      allowedStakeIncrements: [5, 10],
      maxGrowthRatio: 3,
      allowedPolicies: [
        "carry_over_index_delta",
        "advance_to_next_ladder_start",
      ],
      recoveryTargetPctValues: [0.25, 0.5],
      crossoverOffsets: [0, 1],
    },
    objective: {
      bankroll: 1_000,
      profitTarget: 20,
      stopLossAbs: 100,
      maxRounds: 30,
      tableMax: 100,
      ruinTolerance: 0.25,
      confidenceLevel: 0.95,
    },
    game,
    explorationSamples: 20,
    confirmationSamples: 40,
    seed: 123,
    concurrency: 2,
  };
}

describe("ladder optimizer engine", () => {
  it("validates input and estimates the Cartesian search cardinality", () => {
    const input = baseInput();
    expect(() => validateOptimizerInput(input)).not.toThrow();
    expect(estimateSearchCardinality(input.searchSpace)).toBe(64);
  });

  it("rejects an unaffordable minimum stake", () => {
    const input = baseInput();
    expect(() =>
      validateOptimizerInput({
        ...input,
        searchSpace: {
          ...input.searchSpace,
          minimumStake: 2_000,
          maximumStake: 3_000,
        },
        objective: { ...input.objective, tableMax: undefined },
      })
    ).toThrow(/affordable|maximum/i);
  });

  it("generates canonical grid candidates deterministically", () => {
    const input = baseInput();
    const first = generateGridCandidates(input);
    const second = generateGridCandidates(input);
    expect(first.length).toBeGreaterThan(0);
    expect(first.map((candidate) => candidate.fingerprint)).toEqual(
      second.map((candidate) => candidate.fingerprint)
    );
    first.forEach((candidate) => {
      candidate.strategy.ladders.forEach((ladder) => {
        expect(ladder.stakes).toEqual(
          [...ladder.stakes].sort((left, right) => left - right)
        );
      });
    });
  });

  it("generates deterministic bounded evolutionary proposals", () => {
    const input = baseInput();
    const first = generateEvolutionaryCandidates(input, 12, 3);
    const second = generateEvolutionaryCandidates(input, 12, 3);
    expect(first.map((candidate) => candidate.fingerprint)).toEqual(
      second.map((candidate) => candidate.fingerprint)
    );
    expect(first.length).toBeLessThanOrEqual(12);
  });

  it("selects elites and evolves reproducibly from evaluated fitness", () => {
    const input = {
      ...baseInput(binaryGame(1)),
      objective: { ...baseInput().objective, profitTarget: 5 },
    };
    const candidates = generateEvolutionaryCandidates(input, 8, 1);
    const evaluations = candidates.map((candidate) =>
      evaluateOptimizerCandidate(
        candidate,
        input,
        createSeedBank(7, 20, "exploration"),
        "exploration"
      )
    );
    const first = evolveCandidatePopulation(input, evaluations, 2, 8);
    const second = evolveCandidatePopulation(input, evaluations, 2, 8);
    const best = rankOptimizerEvaluations(evaluations)[0].candidate.fingerprint;
    expect(first.map((candidate) => candidate.fingerprint)).toEqual(
      second.map((candidate) => candidate.fingerprint)
    );
    expect(first.some((candidate) => candidate.fingerprint === best)).toBe(true);
  });

  it("handles zero and one successes in Wilson intervals", () => {
    const zero = wilsonInterval(0, 20, 0.95);
    const one = wilsonInterval(20, 20, 0.95);
    expect(zero.lower).toBe(0);
    expect(zero.upper).toBeGreaterThan(0);
    expect(one.upper).toBe(1);
    expect(one.lower).toBeLessThan(1);
  });

  it("uses common exploration seeds and independent confirmation seeds", () => {
    const exploration = createSeedBank(42, 20, "exploration");
    expect(exploration).toEqual(createSeedBank(42, 20, "exploration"));
    expect(exploration).not.toEqual(
      createSeedBank(42, 20, "confirmation")
    );
  });

  it("classifies ruin separately from max-round censoring", () => {
    const tieGame = createGameSnapshot(
      "baccarat_standard_8_deck",
      "banker_5pct_commission"
    );
    const alwaysPush: FrozenGameSnapshot = {
      ...tieGame,
      fingerprint: "always-push",
      betVariant: {
        ...tieGame.betVariant,
        outcomes: tieGame.betVariant.outcomes.map((outcome) => ({
          ...outcome,
          probability: outcome.progressionEffect === "neutral" ? 1 : 0,
        })),
      },
    };
    const input = {
      ...baseInput(alwaysPush),
      objective: { ...baseInput().objective, maxRounds: 3 },
    };
    const candidate = generateGridCandidates(input)[0];
    const evaluation = evaluateOptimizerCandidate(
      candidate,
      input,
      [1, 2, 3, 4],
      "confirmation"
    );
    expect(evaluation.ruin.point).toBe(0);
    expect(evaluation.maxRoundsCensored).toBe(4);
    expect(evaluation.target.point).toBe(0);
  });

  it("requires the ruin confidence upper bound for feasibility", () => {
    const input = {
      ...baseInput(binaryGame(0)),
      objective: {
        ...baseInput().objective,
        ruinTolerance: 0.01,
        stopLossAbs: 5,
      },
    };
    const candidate = generateGridCandidates(input)[0];
    const evaluation = evaluateOptimizerCandidate(
      candidate,
      input,
      createSeedBank(1, 20, "confirmation"),
      "confirmation"
    );
    expect(evaluation.ruin.point).toBe(1);
    expect(evaluation.feasible).toBe(false);
  });

  it("ranks identically regardless of worker completion order", () => {
    const input = {
      ...baseInput(binaryGame(1)),
      objective: { ...baseInput().objective, profitTarget: 5 },
    };
    const candidates = generateGridCandidates(input).slice(0, 3);
    const evaluations = candidates.map((candidate) =>
      evaluateOptimizerCandidate(
        candidate,
        input,
        createSeedBank(3, 20, "confirmation"),
        "confirmation"
      )
    );
    const forward = rankOptimizerEvaluations(evaluations).map(
      (evaluation) => evaluation.candidate.fingerprint
    );
    const reverse = rankOptimizerEvaluations(
      [...evaluations].reverse()
    ).map((evaluation) => evaluation.candidate.fingerprint);
    expect(forward).toEqual(reverse);
    expect(compareOptimizerEvaluations(evaluations[0], evaluations[0])).toBe(0);
  });
});
