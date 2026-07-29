import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OptimizerCoordinator } from "./optimizer-coordinator";
import {
  OPTIMIZER_ENGINE_VERSION,
  OPTIMIZER_GRID_THRESHOLD,
  estimateSearchCardinality,
  type OptimizerCandidate,
  type OptimizerEvaluation,
  type OptimizerJobInput,
} from "./optimizer";
import { createDefaultGameSnapshot } from "./games";
import type { FrozenGameSnapshot } from "./types";
import type {
  OptimizerWorkerRequest,
  OptimizerWorkerResponse,
} from "@/workers/optimizer.protocol";

vi.mock("./optimizer-storage", () => ({
  saveOptimizerCheckpoint: vi.fn(async () => {}),
  loadLatestOptimizerCheckpoint: vi.fn(async () => undefined),
  deleteOptimizerCheckpoint: vi.fn(async () => {}),
}));

function binaryGame(pWin: number): FrozenGameSnapshot {
  const base = createDefaultGameSnapshot();
  return {
    ...base,
    fingerprint: `binary-${pWin}`,
    betVariant: {
      ...base.betVariant,
      outcomes: base.betVariant.outcomes.map((outcome) => ({
        ...outcome,
        probability: outcome.progressionEffect === "win" ? pWin : 1 - pWin,
      })),
    },
  };
}

/** Records every dispatched request and answers with one evaluation per candidate. */
const dispatched: OptimizerWorkerRequest[] = [];
let onDispatch: ((request: OptimizerWorkerRequest) => void) | null = null;

function fakeEvaluation(
  candidate: OptimizerCandidate,
  stage: OptimizerEvaluation["stage"],
  index: number
): OptimizerEvaluation {
  // Deterministic, fingerprint-derived scores so ranking is stable.
  const score = (candidate.fingerprint.charCodeAt(0) % 50) / 100 + index * 1e-6;
  return {
    candidate,
    sampleCount: 20,
    target: { point: score, lower: score, upper: score, confidenceLevel: 0.95 },
    ruin: { point: 0.01, lower: 0.01, upper: 0.01, confidenceLevel: 0.95 },
    maxRoundsCensored: 0,
    medianMaxStake: 10,
    medianMaxDrawdown: 5,
    feasible: true,
    seedBankFingerprint: "seed-bank",
    stage,
  };
}

class FakeWorker {
  private listeners = new Map<string, Set<(event: unknown) => void>>();
  terminated = false;

  addEventListener(type: string, listener: (event: unknown) => void): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(listener);
  }

  removeEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  terminate(): void {
    this.terminated = true;
  }

  postMessage(request: OptimizerWorkerRequest): void {
    dispatched.push(request);
    onDispatch?.(request);
    // Reply asynchronously, like a real worker.
    void Promise.resolve().then(() => {
      if (this.terminated) return;
      const response: OptimizerWorkerResponse = {
        type: "result",
        jobId: request.jobId,
        batchId: request.batchId,
        engineVersion: OPTIMIZER_ENGINE_VERSION,
        inputFingerprint: request.inputFingerprint,
        evaluations: request.candidates.map((candidate, index) =>
          fakeEvaluation(candidate, request.stage, index)
        ),
      };
      this.listeners
        .get("message")
        ?.forEach((listener) => listener({ data: response }));
    });
  }
}

function baseInput(overrides: Partial<OptimizerJobInput> = {}): OptimizerJobInput {
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
    game: binaryGame(0.5),
    explorationSamples: 20,
    confirmationSamples: 40,
    seed: 123,
    concurrency: 2,
    ...overrides,
  };
}

describe("optimizer coordinator", () => {
  beforeEach(() => {
    dispatched.length = 0;
    onDispatch = null;
    vi.stubGlobal("Worker", FakeWorker);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("never dispatches an out-of-range batch when workers outnumber batches", async () => {
    // 4 workers against a search that produces far fewer than 4 batches:
    // a check-then-claim race would hand a runner `batches[i] === undefined`.
    const coordinator = new OptimizerCoordinator(
      baseInput({ concurrency: 4 }),
      {},
      "job-race"
    );
    const summary = await coordinator.run();

    expect(dispatched.length).toBeGreaterThan(0);
    for (const request of dispatched) {
      expect(Array.isArray(request.candidates)).toBe(true);
      expect(request.candidates.length).toBeGreaterThan(0);
    }
    expect(summary.confirmation.length).toBeGreaterThan(0);
    expect(summary.results.every((result) => result.exploration)).toBe(true);
  });

  it("evaluates candidates produced by later evolutionary generations", async () => {
    const input = baseInput({
      searchSpace: {
        ...baseInput().searchSpace,
        ladderCount: { min: 1, max: 4 },
        stepsPerLadder: { min: 2, max: 8 },
        allowedStakeIncrements: [5, 10, 15, 20],
        recoveryTargetPctValues: [0.1, 0.25, 0.5, 0.75],
        crossoverOffsets: [0, 1, 2],
      },
      concurrency: 2,
    });
    // Guard the premise: this must take the evolutionary branch.
    expect(estimateSearchCardinality(input.searchSpace)).toBeGreaterThan(
      OPTIMIZER_GRID_THRESHOLD
    );

    const explorationBatchIds: string[] = [];
    onDispatch = (request) => {
      if (request.stage === "exploration") {
        explorationBatchIds.push(request.batchId);
      }
    };

    const coordinator = new OptimizerCoordinator(input, {}, "job-evolution");
    const summary = await coordinator.run();

    // Stale batch IDs colliding across generations silently dropped every
    // generation after the first; IDs must be unique per evaluateStage call.
    expect(new Set(explorationBatchIds).size).toBe(explorationBatchIds.length);

    // Generation 0 is a single population; more evaluated fingerprints than
    // that means children from later generations were actually evaluated.
    const firstGenerationSize = dispatched
      .filter((request) => request.stage === "exploration")
      .slice(0, 1)
      .flatMap((request) => request.candidates).length;
    expect(summary.exploration.length).toBeGreaterThan(firstGenerationSize);
    expect(summary.algorithm).toBe("evolutionary");
  });

  it("rejects the run when cancelled mid-flight", async () => {
    const coordinator = new OptimizerCoordinator(
      baseInput({ concurrency: 1 }),
      {},
      "job-cancel"
    );
    onDispatch = () => coordinator.cancel();
    await expect(coordinator.run()).rejects.toThrow(/cancelled/i);
  });

  it("completes after a pause and resume", async () => {
    const coordinator = new OptimizerCoordinator(
      baseInput({ concurrency: 2 }),
      {},
      "job-pause"
    );
    let paused = false;
    onDispatch = () => {
      if (paused) return;
      paused = true;
      coordinator.pause();
      setTimeout(() => coordinator.resume(), 0);
    };
    const summary = await coordinator.run();
    expect(summary.confirmation.length).toBeGreaterThan(0);
  });
});
