import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  OptimizerCoordinator,
  type OptimizerPersistenceState,
  type OptimizerProgress,
} from "./optimizer-coordinator";
import {
  assessOptimizerCheckpoint,
  type OptimizerCheckpoint,
} from "./optimizer-storage";
import {
  OPTIMIZER_ENGINE_VERSION,
  OPTIMIZER_GRID_THRESHOLD,
  estimateSearchCardinality,
  type OptimizerCandidate,
  type OptimizerEvaluation,
  type OptimizerJobInput,
} from "./optimizer";
import { createDefaultGameSnapshot, fingerprintValue } from "./games";
import type { FrozenGameSnapshot } from "./types";
import type {
  OptimizerWorkerRequest,
  OptimizerWorkerResponse,
} from "@/workers/optimizer.protocol";

/** Every persisted checkpoint, in write order; the last one is what a reload would see. */
const savedCheckpoints: OptimizerCheckpoint[] = [];
let failPersistence: Error | null = null;

vi.mock("./optimizer-storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./optimizer-storage")>();
  return {
    ...actual,
    saveOptimizerCheckpoint: vi.fn(async (checkpoint: OptimizerCheckpoint) => {
      if (failPersistence) throw failPersistence;
      savedCheckpoints.push(structuredClone(checkpoint));
    }),
    loadLatestOptimizerCheckpoint: vi.fn(async () => undefined),
    deleteOptimizerCheckpoint: vi.fn(async () => {}),
  };
});

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
  index: number,
  seeds: readonly number[]
): OptimizerEvaluation {
  // Deterministic, fingerprint-derived scores so ranking is stable and does
  // not depend on how candidates were batched.
  void index;
  const score =
    (parseInt(candidate.fingerprint.slice(-8), 16) % 1_000) / 1_000;
  return {
    candidate,
    sampleCount: 20,
    target: { point: score, lower: score, upper: score, confidenceLevel: 0.95 },
    ruin: { point: 0.01, lower: 0.01, upper: 0.01, confidenceLevel: 0.95 },
    maxRoundsCensored: 0,
    medianMaxStake: 10,
    medianMaxDrawdown: 5,
    feasible: true,
    // Real workers fingerprint the seed bank they used; resume checks it.
    seedBankFingerprint: fingerprintValue(seeds),
    stage,
  };
}

/** Test knobs for the fake worker: duplicate deliveries and post-terminate leaks. */
const workerBehavior = {
  duplicateResponses: false,
  /** Deliver even after terminate(), like a message already queued in the event loop. */
  leakAfterTerminate: false,
  responseDelayMs: 0,
};

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
    const deliver = () => {
      if (this.terminated && !workerBehavior.leakAfterTerminate) return;
      const response: OptimizerWorkerResponse = {
        type: "result",
        jobId: request.jobId,
        batchId: request.batchId,
        engineVersion: OPTIMIZER_ENGINE_VERSION,
        inputFingerprint: request.inputFingerprint,
        evaluations: request.candidates.map((candidate, index) =>
          fakeEvaluation(candidate, request.stage, index, request.seeds)
        ),
      };
      const emit = () =>
        this.listeners
          .get("message")
          ?.forEach((listener) => listener({ data: response }));
      emit();
      if (workerBehavior.duplicateResponses) emit();
    };
    if (workerBehavior.responseDelayMs > 0) {
      setTimeout(deliver, workerBehavior.responseDelayMs);
    } else {
      void Promise.resolve().then(deliver);
    }
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
    savedCheckpoints.length = 0;
    failPersistence = null;
    onDispatch = null;
    workerBehavior.duplicateResponses = false;
    workerBehavior.leakAfterTerminate = false;
    workerBehavior.responseDelayMs = 0;
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

  const evolutionaryInput = () =>
    baseInput({
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

  /** Stable projection of a summary for equality across runs. */
  const frontier = (summary: {
    exploration: readonly OptimizerEvaluation[];
    confirmation: readonly OptimizerEvaluation[];
  }) => ({
    explored: [...summary.exploration]
      .map((evaluation) => evaluation.candidate.fingerprint)
      .sort(),
    confirmed: summary.confirmation.map((evaluation) => [
      evaluation.candidate.fingerprint,
      evaluation.target.lower,
      evaluation.ruin.upper,
    ]),
  });

  /**
   * Run until the Nth dispatch of `stage`, detach there (like a route unmount or
   * tab kill), and hand back the checkpoint a reload would find.
   */
  const interruptAt = async (
    input: OptimizerJobInput,
    jobId: string,
    stage: OptimizerEvaluation["stage"],
    dispatchIndex: number
  ): Promise<OptimizerCheckpoint> => {
    let seen = 0;
    const coordinator = new OptimizerCoordinator(input, {}, jobId);
    onDispatch = (request) => {
      if (request.stage !== stage) return;
      seen += 1;
      if (seen === dispatchIndex) coordinator.detach();
    };
    await expect(coordinator.run()).rejects.toThrow(/cancelled/i);
    await coordinator.settled();
    onDispatch = null;
    const latest = savedCheckpoints[savedCheckpoints.length - 1];
    expect(latest.status).toBe("interrupted");
    expect(latest.stage).toBe(stage);
    return latest;
  };

  const resumeFrom = async (stored: OptimizerCheckpoint) => {
    const assessment = assessOptimizerCheckpoint(stored);
    expect(assessment.kind).toBe("resumable");
    if (assessment.kind !== "resumable") throw new Error("not resumable");
    const coordinator = new OptimizerCoordinator(
      assessment.checkpoint.input,
      {},
      assessment.checkpoint.jobId
    );
    return coordinator.run(assessment.checkpoint);
  };

  it("resumes an interrupted evolutionary exploration to the identical confirmed frontier", async () => {
    const input = evolutionaryInput();
    const uninterrupted = await new OptimizerCoordinator(
      input,
      {},
      "job-evo-straight"
    ).run();
    expect(uninterrupted.algorithm).toBe("evolutionary");

    // Interrupt deep enough that at least one later generation exists.
    const checkpoint = await interruptAt(input, "job-evo-cut", "exploration", 11);
    expect(checkpoint.evolution).not.toBeNull();
    expect(checkpoint.evolution!.generation).toBeGreaterThan(0);
    expect(checkpoint.schemaVersion).toBe(2);

    const dispatchedBefore = dispatched.length;
    const resumed = await resumeFrom(checkpoint);

    expect(frontier(resumed)).toEqual(frontier(uninterrupted));
    // Committed evaluations were not recomputed; only pending work ran.
    const redispatched = dispatched
      .slice(dispatchedBefore)
      .filter((request) => request.stage === "exploration")
      .flatMap((request) => request.candidates.map((c) => c.fingerprint));
    const committed = new Set(
      checkpoint.exploration.map((evaluation) => evaluation.candidate.fingerprint)
    );
    expect(redispatched.some((fingerprint) => committed.has(fingerprint))).toBe(false);
    expect(resumed.exploration.length).toBe(uninterrupted.exploration.length);
  });

  it("resumes an interrupted confirmation to the identical result", async () => {
    const input = evolutionaryInput();
    const uninterrupted = await new OptimizerCoordinator(
      input,
      {},
      "job-conf-straight"
    ).run();
    // One worker so the second confirmation dispatch follows a committed batch;
    // the uninterrupted run used two workers, so equality also covers
    // scheduling independence.
    const checkpoint = await interruptAt(
      { ...input, concurrency: 1 },
      "job-conf-cut",
      "confirmation",
      2
    );
    expect(checkpoint.evolution).toBeNull();
    expect(checkpoint.confirmation.length).toBe(4);
    const resumed = await resumeFrom(checkpoint);
    expect(frontier(resumed)).toEqual(frontier(uninterrupted));
  });

  it("resumes a grid job interrupted mid-exploration", async () => {
    const input = baseInput({ concurrency: 1 });
    const uninterrupted = await new OptimizerCoordinator(
      input,
      {},
      "job-grid-straight"
    ).run();
    expect(uninterrupted.algorithm).toBe("grid");
    const checkpoint = await interruptAt(input, "job-grid-cut", "exploration", 2);
    const resumed = await resumeFrom(checkpoint);
    expect(frontier(resumed)).toEqual(frontier(uninterrupted));
  });

  it("merges duplicated worker deliveries at most once", async () => {
    const input = baseInput({ concurrency: 2 });
    const clean = await new OptimizerCoordinator(input, {}, "job-dup-a").run();
    workerBehavior.duplicateResponses = true;
    const progress: OptimizerProgress[] = [];
    const duplicated = await new OptimizerCoordinator(
      input,
      { onProgress: (update) => progress.push(update) },
      "job-dup-b"
    ).run();
    expect(frontier(duplicated)).toEqual(frontier(clean));
    expect(progress.every((update) => update.evaluated <= update.total)).toBe(true);
  });

  it("ignores results that arrive after cancellation", async () => {
    workerBehavior.responseDelayMs = 5;
    workerBehavior.leakAfterTerminate = true;
    const progress: OptimizerProgress[] = [];
    const coordinator = new OptimizerCoordinator(
      baseInput({ concurrency: 2 }),
      { onProgress: (update) => progress.push(update) },
      "job-late"
    );
    onDispatch = () => setTimeout(() => coordinator.cancel(), 0);
    await expect(coordinator.run()).rejects.toThrow(/cancelled/i);
    const seenAtCancel = progress.length;
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(progress.length).toBe(seenAtCancel);
    await coordinator.settled();
    expect(savedCheckpoints[savedCheckpoints.length - 1]?.status).toBe(
      "cancelled"
    );
  });

  it("refuses a checkpoint from another engine, schema, or seed bank", async () => {
    const input = baseInput({ concurrency: 1 });
    const checkpoint = await interruptAt(input, "job-verify", "exploration", 1);
    const attempt = (patch: Partial<OptimizerCheckpoint>) =>
      new OptimizerCoordinator(input, {}, "job-verify").run({
        ...checkpoint,
        ...patch,
      });
    await expect(attempt({ engineVersion: "other" })).rejects.toThrow(/engine/);
    await expect(
      attempt({ schemaVersion: 1 as unknown as 2 })
    ).rejects.toThrow(/schema/);
    await expect(
      attempt({ explorationSeedBankFingerprint: "fnv1a32:0" })
    ).rejects.toThrow(/seed banks/);
    await expect(
      new OptimizerCoordinator(input, {}, "other-job").run(checkpoint)
    ).rejects.toThrow(/does not match/);
  });

  it("reports a failed checkpoint write instead of implying the job is saved", async () => {
    failPersistence = new Error("QuotaExceededError");
    const states: OptimizerPersistenceState[] = [];
    let lastProgress: OptimizerProgress | null = null;
    const summary = await new OptimizerCoordinator(
      baseInput({ concurrency: 1 }),
      {
        onPersistence: (state) => states.push(state),
        onProgress: (update) => {
          lastProgress = update;
        },
      },
      "job-storage"
    ).run();
    expect(summary.confirmation.length).toBeGreaterThan(0);
    expect(states.some((state) => state.status === "failed")).toBe(true);
    expect(states.some((state) => state.status === "saved")).toBe(false);
    expect(states[states.length - 1]).toMatchObject({
      status: "failed",
      error: "QuotaExceededError",
      savedEvaluations: 0,
    });
    expect(lastProgress!.storageError).toBe("QuotaExceededError");
  });

  it("records saved checkpoints with their committed evaluation count", async () => {
    const states: OptimizerPersistenceState[] = [];
    await new OptimizerCoordinator(
      baseInput({ concurrency: 1 }),
      { onPersistence: (state) => states.push(state) },
      "job-saved"
    ).run();
    const last = states[states.length - 1];
    expect(last.status).toBe("saved");
    expect(last.savedEvaluations).toBeGreaterThan(0);
    expect(savedCheckpoints[savedCheckpoints.length - 1].status).toBe("complete");
  });
});
