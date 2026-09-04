import { beforeEach, describe, expect, it } from "vitest";
import { useCustomPresetStore } from "./custom-preset-store";
import {
  createSeedBank,
  evaluateOptimizerCandidate,
  generateGridCandidates,
  type OptimizerJobInput,
} from "@/engine/optimizer";
import { createDefaultGameSnapshot } from "@/engine/games";

function input(): OptimizerJobInput {
  return {
    searchSpace: {
      ladderCount: { min: 1, max: 1 },
      stepsPerLadder: { min: 2, max: 2 },
      minimumStake: 5,
      maximumStake: 20,
      allowedStakeIncrements: [5],
      maxGrowthRatio: 3,
      allowedPolicies: ["carry_over_index_delta"],
      recoveryTargetPctValues: [0.5],
      crossoverOffsets: [0],
    },
    objective: {
      bankroll: 100,
      profitTarget: 5,
      stopLossAbs: 50,
      maxRounds: 10,
      tableMax: 20,
      ruinTolerance: 0.5,
      confidenceLevel: 0.95,
    },
    game: {
      ...createDefaultGameSnapshot(),
      fingerprint: "always-win",
      betVariant: {
        ...createDefaultGameSnapshot().betVariant,
        outcomes: createDefaultGameSnapshot().betVariant.outcomes.map(
          (outcome) => ({
            ...outcome,
            probability:
              outcome.progressionEffect === "win" ? 1 : 0,
          })
        ),
      },
    },
    explorationSamples: 20,
    confirmationSamples: 40,
    seed: 1,
    concurrency: 1,
  };
}

describe("custom optimizer presets", () => {
  beforeEach(() => useCustomPresetStore.setState({ presets: [] }));

  it("saves a new immutable version only after explicit confirmation", () => {
    const job = input();
    const candidate = generateGridCandidates(job)[0];
    const exploration = evaluateOptimizerCandidate(
      candidate,
      job,
      createSeedBank(1, 20, "exploration"),
      "exploration"
    );
    const confirmation = evaluateOptimizerCandidate(
      candidate,
      job,
      createSeedBank(1, 40, "confirmation"),
      "confirmation"
    );
    const preset = useCustomPresetStore
      .getState()
      .saveOptimizerPreset(
        "My Lab",
        { candidate, exploration, confirmation, feasible: true },
        job
      );
    expect(preset.id.startsWith("custom:")).toBe(true);
    expect(preset.version).toBe(1);
    expect(preset.provenance.candidateFingerprint).toBe(
      candidate.fingerprint
    );
    expect(useCustomPresetStore.getState().presets).toHaveLength(1);
  });

  it("does not allow a built-in preset name to be overwritten", () => {
    const job = input();
    const candidate = generateGridCandidates(job)[0];
    const evaluation = evaluateOptimizerCandidate(
      candidate,
      job,
      createSeedBank(1, 40, "confirmation"),
      "confirmation"
    );
    expect(() =>
      useCustomPresetStore.getState().saveOptimizerPreset(
        "Default",
        {
          candidate,
          exploration: { ...evaluation, stage: "exploration" },
          confirmation: evaluation,
          feasible: true,
        },
        job
      )
    ).toThrow(/built-in/i);
  });
});

