"use client";

import {
  createOptimizerInputFingerprint,
  createSeedBank,
  evolveCandidatePopulation,
  generateEvolutionaryCandidates,
  generateGridCandidates,
  OPTIMIZER_ENGINE_VERSION,
  rankOptimizerEvaluations,
  validateOptimizerInput,
  type OptimizerCandidate,
  type OptimizerEvaluation,
  type OptimizerJobInput,
  type OptimizerResult,
} from "./optimizer";
import {
  algorithmForInput,
  OPTIMIZER_CHECKPOINT_SCHEMA_VERSION,
  saveOptimizerCheckpoint,
  seedBankFingerprints,
  type OptimizerAlgorithm,
  type OptimizerCheckpoint,
  type OptimizerCheckpointStatus,
  type OptimizerEvolutionState,
  type OptimizerStage,
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
  readonly stage: OptimizerStage;
  /** Candidates with a committed evaluation in the current stage. */
  readonly evaluated: number;
  /** Candidates the current stage will evaluate in total. */
  readonly total: number;
  readonly activeComputeMs: number;
  readonly best: OptimizerEvaluation | null;
  readonly storageError: string | null;
  /** Evolutionary search position, null for grid search and confirmation. */
  readonly evolution: OptimizerEvolutionState | null;
}

/** What the durable checkpoint currently reflects. */
export interface OptimizerPersistenceState {
  readonly status: "unsaved" | "saving" | "saved" | "failed";
  readonly updatedAt: number | null;
  readonly error: string | null;
  /** Committed evaluations across both stages in the last saved checkpoint. */
  readonly savedEvaluations: number;
}

export interface OptimizerRunSummary {
  readonly jobId: string;
  readonly inputFingerprint: string;
  readonly algorithm: OptimizerAlgorithm;
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
  readonly onPersistence?: (state: OptimizerPersistenceState) => void;
}

export class OptimizerCoordinator {
  readonly input: OptimizerJobInput;
  readonly inputFingerprint: string;
  readonly jobId: string;
  readonly algorithm: OptimizerAlgorithm;

  private readonly callbacks: OptimizerCoordinatorCallbacks;
  private readonly seedBanks: ReturnType<typeof seedBankFingerprints>;
  private workers: Worker[] = [];
  private paused = false;
  private cancelled = false;
  private resumeWaiters: (() => void)[] = [];
  private activeComputeMs = 0;
  private activeStartedAt = 0;
  private storageError: string | null = null;
  private persistence: OptimizerPersistenceState = {
    status: "unsaved",
    updatedAt: null,
    error: null,
    savedEvaluations: 0,
  };
  private checkpoint: OptimizerCheckpoint | null = null;
  private evolution: OptimizerEvolutionState | null = null;
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
    this.algorithm = algorithmForInput(input);
    this.seedBanks = seedBankFingerprints(input);
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

  /** Resolves once every queued checkpoint write has settled. */
  settled(): Promise<void> {
    return this.flushPendingPersist();
  }

  async run(
    resumeFrom?: OptimizerCheckpoint
  ): Promise<OptimizerRunSummary> {
    if (typeof Worker === "undefined") {
      throw new Error("Ladder Lab requires Web Worker support");
    }
    if (resumeFrom) this.assertResumable(resumeFrom);

    this.callbacks.onStatus?.("running");
    const algorithm = this.algorithm;
    let candidates: OptimizerCandidate[] = resumeFrom?.candidates.length
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
    this.evolution = resumeFrom?.evolution ?? null;
    this.checkpoint = this.buildCheckpoint({
      stage: resumeFrom?.stage ?? "exploration",
      status: "running",
      candidates,
      exploration,
      confirmation,
    });

    try {
      this.createWorkers();
      const explorationPending =
        resumeFrom?.stage !== "confirmation" && resumeFrom?.stage !== "complete";
      if (explorationPending) {
        const explorationSeeds = createSeedBank(
          this.input.seed,
          this.input.explorationSamples,
          "exploration"
        );
        if (algorithm === "evolutionary") {
          const startGeneration = resumeFrom?.evolution?.generation ?? 0;
          let population: OptimizerCandidate[] = resumeFrom?.evolution
            ? this.resolvePopulation(resumeFrom)
            : candidates;
          for (
            let generation = startGeneration;
            generation < EVOLUTION_GENERATIONS;
            generation += 1
          ) {
            this.evolution = {
              generation,
              generationCount: EVOLUTION_GENERATIONS,
              populationSize: EVOLUTION_POPULATION,
              population: population.map((candidate) => candidate.fingerprint),
            };
            candidates = mergeCandidates(candidates, population);
            exploration = await this.evaluateStage(
              population,
              explorationSeeds,
              "exploration",
              exploration,
              candidates,
              confirmation
            );
            if (generation + 1 < EVOLUTION_GENERATIONS) {
              population = evolveCandidatePopulation(
                this.input,
                exploration,
                generation,
                EVOLUTION_POPULATION
              );
            }
          }
        } else {
          exploration = await this.evaluateStage(
            candidates,
            explorationSeeds,
            "exploration",
            exploration,
            candidates,
            confirmation
          );
        }
      }

      // Generation state is only meaningful while exploring.
      this.evolution = null;
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
      this.checkpoint = this.buildCheckpoint({
        stage: "complete",
        status: "complete",
        candidates,
        exploration,
        confirmation: rankedConfirmation,
      });
      await this.flushPendingPersist();
      await this.persist(this.checkpoint);
      this.callbacks.onProgress?.({
        stage: "complete",
        evaluated: results.length,
        total: results.length,
        activeComputeMs: this.activeComputeMs,
        best: rankedConfirmation[0] ?? null,
        storageError: this.storageError,
        evolution: null,
      });
      this.callbacks.onStatus?.("complete");
      return summary;
    } catch (error) {
      this.stopActiveClock();
      if (!this.cancelled) {
        this.callbacks.onStatus?.("failed");
        if (this.checkpoint) {
          await this.flushPendingPersist();
          await this.persist({ ...this.checkpoint, status: "failed" });
        }
      }
      throw error;
    } finally {
      this.workers.forEach((worker) => worker.terminate());
      this.workers = [];
    }
  }

  /**
   * Refuse anything that would not continue exactly. `assessOptimizerCheckpoint`
   * explains these to the user before a resume is offered; this is the last line.
   */
  private assertResumable(checkpoint: OptimizerCheckpoint): void {
    if (checkpoint.schemaVersion !== OPTIMIZER_CHECKPOINT_SCHEMA_VERSION) {
      throw new Error("Checkpoint schema is not supported by this build");
    }
    if (checkpoint.engineVersion !== OPTIMIZER_ENGINE_VERSION) {
      throw new Error("Checkpoint was produced by a different optimizer engine");
    }
    if (
      checkpoint.inputFingerprint !== this.inputFingerprint ||
      checkpoint.jobId !== this.jobId
    ) {
      throw new Error("Checkpoint does not match this optimizer job");
    }
    if (checkpoint.algorithm !== this.algorithm) {
      throw new Error("Checkpoint used a different search algorithm");
    }
    if (
      checkpoint.explorationSeedBankFingerprint !== this.seedBanks.exploration ||
      checkpoint.confirmationSeedBankFingerprint !== this.seedBanks.confirmation
    ) {
      throw new Error("Checkpoint seed banks do not match this job");
    }
    if (
      checkpoint.algorithm === "evolutionary" &&
      checkpoint.stage === "exploration" &&
      !checkpoint.evolution
    ) {
      throw new Error("Checkpoint lacks evolutionary generation state");
    }
  }

  private resolvePopulation(
    checkpoint: OptimizerCheckpoint
  ): OptimizerCandidate[] {
    const byFingerprint = new Map(
      checkpoint.candidates.map((candidate) => [
        candidate.fingerprint,
        candidate,
      ])
    );
    return (checkpoint.evolution?.population ?? []).map((fingerprint) => {
      const candidate = byFingerprint.get(fingerprint);
      if (!candidate) {
        throw new Error("Checkpoint generation references an unknown candidate");
      }
      return candidate;
    });
  }

  private buildCheckpoint(fields: {
    stage: OptimizerStage;
    status: OptimizerCheckpointStatus;
    candidates: readonly OptimizerCandidate[];
    exploration: readonly OptimizerEvaluation[];
    confirmation: readonly OptimizerEvaluation[];
  }): OptimizerCheckpoint {
    return {
      schemaVersion: OPTIMIZER_CHECKPOINT_SCHEMA_VERSION,
      engineVersion: OPTIMIZER_ENGINE_VERSION,
      jobId: this.jobId,
      inputFingerprint: this.inputFingerprint,
      input: this.input,
      algorithm: this.algorithm,
      stage: fields.stage,
      status: fields.status,
      candidates: fields.candidates,
      exploration: fields.exploration,
      confirmation: fields.confirmation,
      evolution: fields.stage === "exploration" ? this.evolution : null,
      explorationSeedBankFingerprint: this.seedBanks.exploration,
      confirmationSeedBankFingerprint: this.seedBanks.confirmation,
      activeComputeMs: this.currentActiveComputeMs(),
      updatedAt: Date.now(),
    };
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
    allCandidates: readonly OptimizerCandidate[],
    otherStageResults: readonly OptimizerEvaluation[]
  ): Promise<OptimizerEvaluation[]> {
    const byFingerprint = new Map(
      existing.map((evaluation) => [
        evaluation.candidate.fingerprint,
        evaluation,
      ])
    );
    // Only this stage's pending work is dispatched; anything already committed
    // (from this run or a resumed checkpoint) is merged exactly once.
    const pending = candidates.filter(
      (candidate) => !byFingerprint.has(candidate.fingerprint)
    );
    const stageCandidates = new Set([
      ...candidates.map((candidate) => candidate.fingerprint),
    ]);
    const stageTotal =
      stage === "exploration" ? byFingerprint.size + pending.length : stageCandidates.size;
    const batches: OptimizerCandidate[][] = [];
    for (let index = 0; index < pending.length; index += CANDIDATES_PER_BATCH) {
      batches.push(pending.slice(index, index + CANDIDATES_PER_BATCH));
    }
    let nextBatch = 0;
    const invocation = this.stageSequence;
    this.stageSequence += 1;

    const commit = (evaluations: readonly OptimizerEvaluation[]) => {
      evaluations.forEach((evaluation) =>
        byFingerprint.set(evaluation.candidate.fingerprint, evaluation)
      );
      const combined = [...byFingerprint.values()];
      const exploration =
        stage === "exploration" ? combined : [...otherStageResults];
      const confirmation =
        stage === "confirmation" ? combined : [...otherStageResults];
      this.checkpoint = this.buildCheckpoint({
        stage,
        status: this.paused ? "paused" : "running",
        candidates: allCandidates,
        exploration,
        confirmation,
      });
      this.persistThrottled(this.checkpoint);
      const ranked = rankOptimizerEvaluations(combined);
      this.callbacks.onProgress?.({
        stage,
        evaluated:
          stage === "exploration"
            ? combined.length
            : combined.filter((evaluation) =>
                stageCandidates.has(evaluation.candidate.fingerprint)
              ).length,
        total: stageTotal,
        activeComputeMs: this.currentActiveComputeMs(),
        best: ranked[0] ?? null,
        storageError: this.storageError,
        evolution: stage === "exploration" ? this.evolution : null,
      });
    };

    if (batches.length === 0) {
      // Nothing new to dispatch (fully resumed stage); still surface progress.
      commit([]);
    }

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
        if (this.cancelled) return;
        commit(evaluations);
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
      let settled = false;
      const cleanup = () => {
        settled = true;
        worker.removeEventListener("message", onMessage);
        worker.removeEventListener("error", onError);
        this.pendingBatchRejectors.delete(rejectPending);
      };
      const rejectPending = (error: Error) => {
        if (settled) return;
        cleanup();
        reject(error);
      };
      const onMessage = (event: MessageEvent<OptimizerWorkerResponse>) => {
        const response = event.data;
        // Duplicate, obsolete, or foreign messages never reach the merge.
        if (
          settled ||
          response.jobId !== this.jobId ||
          response.batchId !== batchId
        ) {
          return;
        }
        cleanup();
        if (
          response.engineVersion !== OPTIMIZER_ENGINE_VERSION ||
          response.inputFingerprint !== this.inputFingerprint
        ) {
          reject(new Error("Rejected stale optimizer batch"));
        } else if (response.type === "error") {
          reject(new Error(response.message));
        } else if (
          response.evaluations.length !== candidates.length ||
          response.evaluations.some(
            (evaluation, index) =>
              evaluation.candidate.fingerprint !== candidates[index].fingerprint
          )
        ) {
          reject(new Error("Optimizer batch returned unexpected candidates"));
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
    this.reportPersistence({ ...this.persistence, status: "saving" });
    try {
      await saveOptimizerCheckpoint(checkpoint);
      this.storageError = null;
      this.reportPersistence({
        status: "saved",
        updatedAt: checkpoint.updatedAt,
        error: null,
        savedEvaluations:
          checkpoint.exploration.length + checkpoint.confirmation.length,
      });
    } catch (error) {
      this.storageError =
        error instanceof Error ? error.message : "Checkpoint storage failed";
      this.reportPersistence({
        ...this.persistence,
        status: "failed",
        error: this.storageError,
      });
    }
  }

  private reportPersistence(state: OptimizerPersistenceState): void {
    this.persistence = state;
    this.callbacks.onPersistence?.(state);
  }
}
