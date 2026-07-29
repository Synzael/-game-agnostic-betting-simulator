"use client";

import {
  createOptimizerInputFingerprint,
  createSeedBank,
  evolveCandidatePopulation,
  generateEvolutionaryCandidates,
  generateGridCandidates,
  OPTIMIZER_ENGINE_VERSION,
  OPTIMIZER_GRID_THRESHOLD,
  rankOptimizerEvaluations,
  validateOptimizerInput,
  estimateSearchCardinality,
  type OptimizerCandidate,
  type OptimizerEvaluation,
  type OptimizerJobInput,
  type OptimizerResult,
} from "./optimizer";
import {
  saveOptimizerCheckpoint,
  type OptimizerCheckpoint,
} from "./optimizer-storage";
import type {
  OptimizerWorkerRequest,
  OptimizerWorkerResponse,
} from "@/workers/optimizer.protocol";

const CANDIDATES_PER_BATCH = 4;
const FINALIST_COUNT = 8;
const EVOLUTION_POPULATION = 32;
const EVOLUTION_GENERATIONS = 6;

function mergeCandidates(
  left: readonly OptimizerCandidate[],
  right: readonly OptimizerCandidate[]
): OptimizerCandidate[] {
  return [
    ...new Map(
      [...left, ...right].map((candidate) => [
        candidate.fingerprint,
        candidate,
      ])
    ).values(),
  ];
}

export interface OptimizerProgress {
  readonly stage: "exploration" | "confirmation" | "complete";
  readonly evaluated: number;
  readonly total: number;
  readonly activeComputeMs: number;
  readonly best: OptimizerEvaluation | null;
  readonly storageError: string | null;
}

export interface OptimizerRunSummary {
  readonly jobId: string;
  readonly inputFingerprint: string;
  readonly algorithm: "grid" | "evolutionary";
  readonly exploration: readonly OptimizerEvaluation[];
  readonly confirmation: readonly OptimizerEvaluation[];
  readonly results: readonly OptimizerResult[];
  readonly feasibleResults: readonly OptimizerResult[];
  readonly activeComputeMs: number;
}

export interface OptimizerCoordinatorCallbacks {
  readonly onProgress?: (progress: OptimizerProgress) => void;
  readonly onStatus?: (
    status: "running" | "paused" | "cancelled" | "complete" | "failed"
  ) => void;
}

export class OptimizerCoordinator {
  readonly input: OptimizerJobInput;
  readonly inputFingerprint: string;
  readonly jobId: string;

  private readonly callbacks: OptimizerCoordinatorCallbacks;
  private workers: Worker[] = [];
  private paused = false;
  private cancelled = false;
  private resumeWaiters: (() => void)[] = [];
  private activeComputeMs = 0;
  private activeStartedAt = 0;
  private storageError: string | null = null;
  private checkpoint: OptimizerCheckpoint | null = null;
  private stageSequence = 0;
  private persistInFlight: Promise<void> | null = null;
  private queuedCheckpoint: OptimizerCheckpoint | null = null;
  private pendingBatchRejectors = new Set<(error: Error) => void>();

  constructor(
    input: OptimizerJobInput,
    callbacks: OptimizerCoordinatorCallbacks = {},
    jobId = crypto.randomUUID()
  ) {
    validateOptimizerInput(input);
    this.input = input;
    this.callbacks = callbacks;
    this.inputFingerprint = createOptimizerInputFingerprint(input);
    this.jobId = jobId;
  }

  pause(): void {
    if (this.paused || this.cancelled) return;
    this.stopActiveClock();
    this.paused = true;
    this.callbacks.onStatus?.("paused");
    if (this.checkpoint) {
      this.queuedCheckpoint = null;
      this.persistThrottled({ ...this.checkpoint, status: "paused" });
    }
  }

  resume(): void {
    if (!this.paused || this.cancelled) return;
    this.paused = false;
    this.startActiveClock();
    this.callbacks.onStatus?.("running");
    const waiters = this.resumeWaiters;
    this.resumeWaiters = [];
    waiters.forEach((resolve) => resolve());
  }

  /**
   * Tear down without discarding the job: used when the route unmounts while a
   * run is in flight. Unlike `cancel`, the checkpoint stays resumable.
   */
  detach(): void {
    if (this.cancelled) return;
    this.cancel("interrupted");
  }

  cancel(status: "cancelled" | "interrupted" = "cancelled"): void {
    if (this.cancelled) return;
    this.cancelled = true;
    this.stopActiveClock();
    this.paused = false;
    const waiters = this.resumeWaiters;
    this.resumeWaiters = [];
    waiters.forEach((resolve) => resolve());
    this.pendingBatchRejectors.forEach((reject) =>
      reject(new Error("Optimizer job cancelled"))
    );
    this.pendingBatchRejectors.clear();
    this.workers.forEach((worker) => worker.terminate());
    this.workers = [];
    this.callbacks.onStatus?.("cancelled");
    if (this.checkpoint) {
      this.queuedCheckpoint = null;
      this.persistThrottled({ ...this.checkpoint, status });
    }
  }

  async run(
    resumeFrom?: OptimizerCheckpoint
  ): Promise<OptimizerRunSummary> {
    if (typeof Worker === "undefined") {
      throw new Error("Ladder Lab requires Web Worker support");
    }
    if (
      resumeFrom &&
      (resumeFrom.inputFingerprint !== this.inputFingerprint ||
        resumeFrom.jobId !== this.jobId)
    ) {
      throw new Error("Checkpoint does not match this optimizer job");
    }

    this.callbacks.onStatus?.("running");
    this.startActiveClock();
    const cardinality = estimateSearchCardinality(this.input.searchSpace);
    const algorithm =
      cardinality <= OPTIMIZER_GRID_THRESHOLD ? "grid" : "evolutionary";
    let candidates = resumeFrom?.candidates.length
      ? [...resumeFrom.candidates]
      : algorithm === "grid"
        ? generateGridCandidates(this.input)
        : generateEvolutionaryCandidates(
            this.input,
            EVOLUTION_POPULATION,
            1
          );
    if (candidates.length === 0) {
      throw new Error("Search space produced no valid candidates");
    }

    let exploration = [...(resumeFrom?.exploration ?? [])];
    let confirmation = [...(resumeFrom?.confirmation ?? [])];
    this.activeComputeMs = resumeFrom?.activeComputeMs ?? 0;
    this.startActiveClock();
    this.checkpoint = {
      jobId: this.jobId,
      inputFingerprint: this.inputFingerprint,
      input: this.input,
      algorithm,
      stage: "exploration",
      status: "running",
      candidates,
      exploration,
      confirmation,
      activeComputeMs: this.currentActiveComputeMs(),
      updatedAt: Date.now(),
    };

    try {
      this.createWorkers();
      if (resumeFrom?.stage !== "confirmation" && resumeFrom?.stage !== "complete") {
        const explorationSeeds = createSeedBank(
          this.input.seed,
          this.input.explorationSamples,
          "exploration"
        );
        if (algorithm === "evolutionary" && !resumeFrom) {
          let population = candidates;
          for (
            let generation = 0;
            generation < EVOLUTION_GENERATIONS;
            generation += 1
          ) {
            candidates = mergeCandidates(candidates, population);
            exploration = await this.evaluateStage(
              population,
              explorationSeeds,
              "exploration",
              exploration,
              algorithm,
              candidates,
              confirmation
            );
            population = evolveCandidatePopulation(
              this.input,
              exploration,
              generation,
              EVOLUTION_POPULATION
            );
          }
        } else {
          exploration = await this.evaluateStage(
            candidates,
            explorationSeeds,
            "exploration",
            exploration,
            algorithm,
            candidates,
            confirmation
          );
        }
      }

      const finalists = rankOptimizerEvaluations(exploration)
        .slice(0, FINALIST_COUNT)
        .map((evaluation) => evaluation.candidate);
      if (resumeFrom?.stage !== "complete") {
        confirmation = await this.evaluateStage(
          finalists,
          createSeedBank(
            this.input.seed,
            this.input.confirmationSamples,
            "confirmation"
          ),
          "confirmation",
          confirmation,
          algorithm,
          candidates,
          exploration
        );
      }

      if (this.cancelled) throw new Error("Optimizer job cancelled");
      const rankedConfirmation = rankOptimizerEvaluations(confirmation);
      const explorationById = new Map(
        exploration.map((evaluation) => [
          evaluation.candidate.fingerprint,
          evaluation,
        ])
      );
      const results = rankedConfirmation.map((confirmed) => ({
        candidate: confirmed.candidate,
        exploration: explorationById.get(confirmed.candidate.fingerprint)!,
        confirmation: confirmed,
        feasible: confirmed.feasible,
      }));
      this.stopActiveClock();
      const summary: OptimizerRunSummary = {
        jobId: this.jobId,
        inputFingerprint: this.inputFingerprint,
        algorithm,
        exploration,
        confirmation: rankedConfirmation,
        results,
        feasibleResults: results.filter((result) => result.feasible),
        activeComputeMs: this.activeComputeMs,
      };
      this.checkpoint = {
        ...this.checkpoint,
        stage: "complete",
        status: "complete",
        exploration,
        confirmation: rankedConfirmation,
        activeComputeMs: this.activeComputeMs,
        updatedAt: Date.now(),
      };
      await this.persist(this.checkpoint);
      this.callbacks.onProgress?.({
        stage: "complete",
        evaluated: results.length,
        total: results.length,
        activeComputeMs: this.activeComputeMs,
        best: rankedConfirmation[0] ?? null,
        storageError: this.storageError,
      });
      this.callbacks.onStatus?.("complete");
      return summary;
    } catch (error) {
      this.stopActiveClock();
      if (!this.cancelled) {
        this.callbacks.onStatus?.("failed");
        if (this.checkpoint) {
          await this.persist({ ...this.checkpoint, status: "failed" });
        }
      }
      throw error;
    } finally {
      this.workers.forEach((worker) => worker.terminate());
      this.workers = [];
    }
  }

  private createWorkers(): void {
    if (this.workers.length > 0) return;
    this.workers = Array.from({ length: this.input.concurrency }, () =>
      new Worker(
        new URL("../workers/optimizer.worker.ts", import.meta.url),
        { type: "module" }
      )
    );
  }

  private async evaluateStage(
    candidates: readonly OptimizerCandidate[],
    seeds: readonly number[],
    stage: OptimizerEvaluation["stage"],
    existing: readonly OptimizerEvaluation[],
    algorithm: "grid" | "evolutionary",
    allCandidates: readonly OptimizerCandidate[],
    otherStageResults: readonly OptimizerEvaluation[]
  ): Promise<OptimizerEvaluation[]> {
    const byFingerprint = new Map(
      existing.map((evaluation) => [
        evaluation.candidate.fingerprint,
        evaluation,
      ])
    );
    const pending = candidates.filter(
      (candidate) => !byFingerprint.has(candidate.fingerprint)
    );
    const stageTotal = byFingerprint.size + pending.length;
    const batches: OptimizerCandidate[][] = [];
    for (let index = 0; index < pending.length; index += CANDIDATES_PER_BATCH) {
      batches.push(pending.slice(index, index + CANDIDATES_PER_BATCH));
    }
    let nextBatch = 0;
    const invocation = this.stageSequence;
    this.stageSequence += 1;

    const runner = async (worker: Worker) => {
      while (!this.cancelled) {
        // Claim the batch index synchronously with the bounds check;
        // an await between them lets every runner pass a stale check.
        if (nextBatch >= batches.length) return;
        const batchIndex = nextBatch;
        nextBatch += 1;
        await this.waitIfPaused();
        if (this.cancelled) return;
        const batch = batches[batchIndex];
        const batchId = `${stage}-${invocation}-${batchIndex}`;
        const evaluations = await this.runWorkerBatch(
          worker,
          batch,
          seeds,
          stage,
          batchId
        );
        evaluations.forEach((evaluation) =>
          byFingerprint.set(evaluation.candidate.fingerprint, evaluation)
        );
        const combined = [...byFingerprint.values()];
        const exploration =
          stage === "exploration" ? combined : [...otherStageResults];
        const confirmation =
          stage === "confirmation" ? combined : [...otherStageResults];
        this.checkpoint = {
          jobId: this.jobId,
          inputFingerprint: this.inputFingerprint,
          input: this.input,
          algorithm,
          stage,
          status: this.paused ? "paused" : "running",
          candidates: allCandidates,
          exploration,
          confirmation,
          activeComputeMs: this.currentActiveComputeMs(),
          updatedAt: Date.now(),
        };
        this.persistThrottled(this.checkpoint);
        const ranked = rankOptimizerEvaluations(combined);
        this.callbacks.onProgress?.({
          stage,
          evaluated: combined.length,
          total: stageTotal,
          activeComputeMs: this.currentActiveComputeMs(),
          best: ranked[0] ?? null,
          storageError: this.storageError,
        });
      }
    };

    await Promise.all(this.workers.map((worker) => runner(worker)));
    await this.flushPendingPersist();
    if (this.cancelled) throw new Error("Optimizer job cancelled");
    return [...byFingerprint.values()];
  }

  private runWorkerBatch(
    worker: Worker,
    candidates: readonly OptimizerCandidate[],
    seeds: readonly number[],
    stage: OptimizerEvaluation["stage"],
    batchId: string
  ): Promise<readonly OptimizerEvaluation[]> {
    return new Promise((resolve, reject) => {
      const rejectPending = (error: Error) => {
        worker.removeEventListener("message", onMessage);
        worker.removeEventListener("error", onError);
        this.pendingBatchRejectors.delete(rejectPending);
        reject(error);
      };
      const onMessage = (event: MessageEvent<OptimizerWorkerResponse>) => {
        const response = event.data;
        if (
          response.jobId !== this.jobId ||
          response.batchId !== batchId
        ) {
          return;
        }
        worker.removeEventListener("message", onMessage);
        worker.removeEventListener("error", onError);
        this.pendingBatchRejectors.delete(rejectPending);
        if (
          response.engineVersion !== OPTIMIZER_ENGINE_VERSION ||
          response.inputFingerprint !== this.inputFingerprint
        ) {
          reject(new Error("Rejected stale optimizer batch"));
        } else if (response.type === "error") {
          reject(new Error(response.message));
        } else {
          resolve(response.evaluations);
        }
      };
      const onError = () => {
        rejectPending(new Error("Optimizer worker failed"));
      };
      this.pendingBatchRejectors.add(rejectPending);
      worker.addEventListener("message", onMessage);
      worker.addEventListener("error", onError);
      const request: OptimizerWorkerRequest = {
        type: "evaluate",
        jobId: this.jobId,
        batchId,
        engineVersion: OPTIMIZER_ENGINE_VERSION,
        inputFingerprint: this.inputFingerprint,
        input: this.input,
        candidates,
        seeds,
        stage,
      };
      worker.postMessage(request);
    });
  }

  private waitIfPaused(): Promise<void> {
    if (!this.paused) return Promise.resolve();
    return new Promise((resolve) => this.resumeWaiters.push(resolve));
  }

  private startActiveClock(): void {
    if (this.activeStartedAt === 0 && !this.paused && !this.cancelled) {
      this.activeStartedAt = performance.now();
    }
  }

  private stopActiveClock(): void {
    if (this.activeStartedAt !== 0) {
      this.activeComputeMs += performance.now() - this.activeStartedAt;
      this.activeStartedAt = 0;
    }
  }

  private currentActiveComputeMs(): number {
    return (
      this.activeComputeMs +
      (this.activeStartedAt === 0
        ? 0
        : performance.now() - this.activeStartedAt)
    );
  }

  /**
   * Checkpoints are large and grow with the evaluation set, so writing one per
   * batch and awaiting it stalls worker dispatch. Keep at most one write in
   * flight and coalesce the rest; `flushPendingPersist` settles the tail.
   */
  private persistThrottled(checkpoint: OptimizerCheckpoint): void {
    this.queuedCheckpoint = checkpoint;
    if (this.persistInFlight) return;
    const next = this.queuedCheckpoint;
    this.queuedCheckpoint = null;
    this.persistInFlight = this.persist(next).finally(() => {
      this.persistInFlight = null;
      if (this.queuedCheckpoint) {
        const queued = this.queuedCheckpoint;
        this.queuedCheckpoint = null;
        this.persistThrottled(queued);
      }
    });
  }

  private async flushPendingPersist(): Promise<void> {
    while (this.persistInFlight) {
      await this.persistInFlight;
    }
    if (this.queuedCheckpoint) {
      const queued = this.queuedCheckpoint;
      this.queuedCheckpoint = null;
      await this.persist(queued);
    }
  }

  private async persist(checkpoint: OptimizerCheckpoint): Promise<void> {
    try {
      await saveOptimizerCheckpoint(checkpoint);
      this.storageError = null;
    } catch (error) {
      this.storageError =
        error instanceof Error ? error.message : "Checkpoint storage failed";
    }
  }
}
