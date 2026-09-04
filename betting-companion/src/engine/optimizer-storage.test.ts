import { describe, expect, it } from "vitest";
import {
  assessOptimizerCheckpoint,
  OPTIMIZER_CHECKPOINT_SCHEMA_VERSION,
  seedBankFingerprints,
  type LegacyOptimizerCheckpoint,
  type OptimizerCheckpoint,
} from "./optimizer-storage";
import {
  createOptimizerInputFingerprint,
  createSeedBank,
  evaluateOptimizerCandidate,
  generateGridCandidates,
  OPTIMIZER_ENGINE_VERSION,
  type OptimizerJobInput,
} from "./optimizer";
import { createGameSnapshot } from "./games";

function gridInput(): OptimizerJobInput {
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
    game: createGameSnapshot("even_money", "even_money"),
    explorationSamples: 20,
    confirmationSamples: 40,
    seed: 7,
    concurrency: 1,
  };
}

function evolutionaryInput(): OptimizerJobInput {
  const base = gridInput();
  return {
    ...base,
    searchSpace: {
      ...base.searchSpace,
      ladderCount: { min: 1, max: 4 },
      stepsPerLadder: { min: 2, max: 8 },
      allowedStakeIncrements: [5, 10, 15, 20],
      recoveryTargetPctValues: [0.1, 0.25, 0.5, 0.75],
      crossoverOffsets: [0, 1, 2],
    },
  };
}

function legacyCheckpoint(
  input: OptimizerJobInput,
  overrides: Partial<LegacyOptimizerCheckpoint> = {}
): LegacyOptimizerCheckpoint {
  const candidates = generateGridCandidates({
    ...input,
    searchSpace: gridInput().searchSpace,
  });
  const seeds = createSeedBank(input.seed, input.explorationSamples, "exploration");
  return {
    jobId: "legacy-job",
    inputFingerprint: createOptimizerInputFingerprint(input),
    input,
    algorithm: "grid",
    stage: "exploration",
    status: "interrupted",
    candidates,
    exploration: [
      evaluateOptimizerCandidate(candidates[0], input, seeds, "exploration"),
    ],
    confirmation: [],
    activeComputeMs: 10,
    updatedAt: 1,
    ...overrides,
  };
}

function currentCheckpoint(
  input: OptimizerJobInput,
  overrides: Partial<OptimizerCheckpoint> = {}
): OptimizerCheckpoint {
  const legacy = legacyCheckpoint(input);
  const banks = seedBankFingerprints(input);
  return {
    ...legacy,
    schemaVersion: OPTIMIZER_CHECKPOINT_SCHEMA_VERSION,
    engineVersion: OPTIMIZER_ENGINE_VERSION,
    evolution: null,
    explorationSeedBankFingerprint: banks.exploration,
    confirmationSeedBankFingerprint: banks.confirmation,
    ...overrides,
  };
}

describe("assessOptimizerCheckpoint", () => {
  it("upgrades a legacy grid checkpoint in memory without rewriting it", () => {
    const stored = legacyCheckpoint(gridInput());
    const assessment = assessOptimizerCheckpoint(stored);
    expect(assessment.kind).toBe("resumable");
    if (assessment.kind !== "resumable") return;
    expect(assessment.upgraded).toBe(true);
    expect(assessment.checkpoint.schemaVersion).toBe(
      OPTIMIZER_CHECKPOINT_SCHEMA_VERSION
    );
    expect(assessment.checkpoint.engineVersion).toBe(OPTIMIZER_ENGINE_VERSION);
    expect(assessment.checkpoint.evolution).toBeNull();
    expect("schemaVersion" in stored).toBe(false);
  });

  it("refuses exact resume for a legacy evolutionary exploration", () => {
    const input = evolutionaryInput();
    const stored = legacyCheckpoint(input, { algorithm: "evolutionary" });
    const assessment = assessOptimizerCheckpoint(stored);
    expect(assessment.kind).toBe("incompatible");
    if (assessment.kind !== "incompatible") return;
    expect(assessment.reason).toMatch(/generation state/);
    expect(assessment.input).toEqual(input);
  });

  it("allows a legacy evolutionary job that already reached confirmation", () => {
    const input = evolutionaryInput();
    const stored = legacyCheckpoint(input, {
      algorithm: "evolutionary",
      stage: "confirmation",
    });
    expect(assessOptimizerCheckpoint(stored).kind).toBe("resumable");
  });

  it("rejects a checkpoint from another engine version", () => {
    const stored = currentCheckpoint(gridInput(), {
      engineVersion: "ladder-optimizer-v0",
    });
    const assessment = assessOptimizerCheckpoint(stored);
    expect(assessment.kind).toBe("incompatible");
    if (assessment.kind === "incompatible") {
      expect(assessment.reason).toMatch(/ladder-optimizer-v0/);
    }
  });

  it("rejects a checkpoint whose input fingerprint was computed by a different build", () => {
    const stored = legacyCheckpoint(gridInput(), {
      inputFingerprint: "fnv1a32:00000000",
    });
    expect(assessOptimizerCheckpoint(stored).kind).toBe("incompatible");
  });

  it("rejects evaluations built from a different seed bank", () => {
    const input = gridInput();
    const stored = currentCheckpoint(input);
    const tampered: OptimizerCheckpoint = {
      ...stored,
      exploration: stored.exploration.map((evaluation) => ({
        ...evaluation,
        seedBankFingerprint: "fnv1a32:deadbeef",
      })),
    };
    const assessment = assessOptimizerCheckpoint(tampered);
    expect(assessment.kind).toBe("incompatible");
    if (assessment.kind === "incompatible") {
      expect(assessment.reason).toMatch(/seed banks/);
    }
  });

  it("rejects an unknown newer schema", () => {
    const stored = {
      ...currentCheckpoint(gridInput()),
      schemaVersion: 99,
    } as unknown as OptimizerCheckpoint;
    const assessment = assessOptimizerCheckpoint(stored);
    expect(assessment.kind).toBe("incompatible");
    if (assessment.kind === "incompatible") {
      expect(assessment.reason).toMatch(/schema 99/);
    }
  });

  it("rejects a generation that references unstored candidates", () => {
    const input = evolutionaryInput();
    const stored = currentCheckpoint(input, {
      algorithm: "evolutionary",
      evolution: {
        generation: 2,
        generationCount: 6,
        populationSize: 32,
        population: ["fnv1a32:missing"],
      },
    });
    const assessment = assessOptimizerCheckpoint(stored);
    expect(assessment.kind).toBe("incompatible");
  });

  it("treats complete and cancelled jobs as finished", () => {
    expect(
      assessOptimizerCheckpoint(currentCheckpoint(gridInput(), { status: "complete" }))
        .kind
    ).toBe("finished");
    expect(
      assessOptimizerCheckpoint(currentCheckpoint(gridInput(), { status: "cancelled" }))
        .kind
    ).toBe("finished");
  });

  it("accepts a current-schema checkpoint unchanged", () => {
    const stored = currentCheckpoint(gridInput());
    const assessment = assessOptimizerCheckpoint(stored);
    expect(assessment).toEqual({
      kind: "resumable",
      upgraded: false,
      checkpoint: stored,
    });
  });
});
