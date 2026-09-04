import { openDB, type DBSchema } from "idb";
import {
  createOptimizerInputFingerprint,
  createSeedBank,
  estimateSearchCardinality,
  OPTIMIZER_ENGINE_VERSION,
  OPTIMIZER_GRID_THRESHOLD,
  type OptimizerCandidate,
  type OptimizerEvaluation,
  type OptimizerJobInput,
} from "./optimizer";
import { fingerprintValue } from "./games";

/**
 * Schema 1 stored inputs, candidates, and aggregates only. Schema 2 adds the
 * state an exact continuation needs: engine version, evolutionary generation
 * and population, and the seed-bank fingerprints the aggregates were built
 * from. Bump this whenever a resumed run could otherwise diverge.
 */
export const OPTIMIZER_CHECKPOINT_SCHEMA_VERSION = 2;

export type OptimizerAlgorithm = "grid" | "evolutionary";
export type OptimizerStage = "exploration" | "confirmation" | "complete";
export type OptimizerCheckpointStatus =
  | "running"
  | "paused"
  | "cancelled"
  | "interrupted"
  | "complete"
  | "failed";

/** Evolutionary search position: which generation is being evaluated and by whom. */
export interface OptimizerEvolutionState {
  /** Zero-based index of the generation whose population is being evaluated. */
  readonly generation: number;
  readonly generationCount: number;
  readonly populationSize: number;
  /** Candidate fingerprints of the current generation, all present in `candidates`. */
  readonly population: readonly string[];
}

export interface OptimizerCheckpoint {
  readonly schemaVersion: typeof OPTIMIZER_CHECKPOINT_SCHEMA_VERSION;
  readonly engineVersion: string;
  readonly jobId: string;
  readonly inputFingerprint: string;
  readonly input: OptimizerJobInput;
  readonly algorithm: OptimizerAlgorithm;
  readonly stage: OptimizerStage;
  readonly status: OptimizerCheckpointStatus;
  readonly candidates: readonly OptimizerCandidate[];
  readonly exploration: readonly OptimizerEvaluation[];
  readonly confirmation: readonly OptimizerEvaluation[];
  /** Null for grid search and once confirmation begins. */
  readonly evolution: OptimizerEvolutionState | null;
  readonly explorationSeedBankFingerprint: string;
  readonly confirmationSeedBankFingerprint: string;
  readonly activeComputeMs: number;
  readonly updatedAt: number;
}

/** Schema 1 record, kept so old databases can be assessed rather than crash. */
export interface LegacyOptimizerCheckpoint {
  readonly schemaVersion?: undefined;
  readonly engineVersion?: undefined;
  readonly jobId: string;
  readonly inputFingerprint: string;
  readonly input: OptimizerJobInput;
  readonly algorithm: OptimizerAlgorithm;
  readonly stage: OptimizerStage;
  readonly status: OptimizerCheckpointStatus;
  readonly candidates: readonly OptimizerCandidate[];
  readonly exploration: readonly OptimizerEvaluation[];
  readonly confirmation: readonly OptimizerEvaluation[];
  readonly activeComputeMs: number;
  readonly updatedAt: number;
}

export type StoredOptimizerCheckpoint =
  | OptimizerCheckpoint
  | LegacyOptimizerCheckpoint;

export type OptimizerCheckpointAssessment =
  | {
      readonly kind: "resumable";
      readonly checkpoint: OptimizerCheckpoint;
      /** True when a schema 1 record was upgraded in memory (not rewritten). */
      readonly upgraded: boolean;
    }
  | {
      readonly kind: "incompatible";
      readonly jobId: string;
      readonly reason: string;
      /** Inputs are offered for a fresh restart when they still validate. */
      readonly input: OptimizerJobInput | null;
      readonly updatedAt: number;
    }
  | { readonly kind: "finished"; readonly jobId: string };

interface OptimizerDatabase extends DBSchema {
  checkpoints: {
    key: string;
    value: StoredOptimizerCheckpoint;
    indexes: { "by-updated": number };
  };
}

const DATABASE_NAME = "velvet-stakes-optimizer";
const DATABASE_VERSION = 1;

let databasePromise: ReturnType<typeof openDB<OptimizerDatabase>> | null = null;

function database() {
  databasePromise ??= openDB<OptimizerDatabase>(
    DATABASE_NAME,
    DATABASE_VERSION,
    {
      upgrade(db) {
        const store = db.createObjectStore("checkpoints", { keyPath: "jobId" });
        store.createIndex("by-updated", "updatedAt");
      },
    }
  );
  // Don't cache a rejected connection — allow the next call to retry.
  const pending = databasePromise;
  pending.catch(() => {
    if (databasePromise === pending) databasePromise = null;
  });
  return pending;
}

export async function saveOptimizerCheckpoint(
  checkpoint: OptimizerCheckpoint
): Promise<void> {
  const db = await database();
  await db.put("checkpoints", checkpoint);
}

export async function loadLatestOptimizerCheckpoint(): Promise<
  StoredOptimizerCheckpoint | undefined
> {
  const db = await database();
  const cursor = await db
    .transaction("checkpoints")
    .store.index("by-updated")
    .openCursor(null, "prev");
  return cursor?.value;
}

export async function deleteOptimizerCheckpoint(jobId: string): Promise<void> {
  const db = await database();
  await db.delete("checkpoints", jobId);
}

export function algorithmForInput(input: OptimizerJobInput): OptimizerAlgorithm {
  return estimateSearchCardinality(input.searchSpace) <=
    OPTIMIZER_GRID_THRESHOLD
    ? "grid"
    : "evolutionary";
}

export function seedBankFingerprints(input: OptimizerJobInput): {
  readonly exploration: string;
  readonly confirmation: string;
} {
  return {
    exploration: fingerprintValue(
      createSeedBank(input.seed, input.explorationSamples, "exploration")
    ),
    confirmation: fingerprintValue(
      createSeedBank(input.seed, input.confirmationSamples, "confirmation")
    ),
  };
}

/**
 * Decide whether a stored checkpoint can be continued exactly by this build.
 * Anything that cannot be continued exactly is reported as incompatible with
 * the reason, never silently approximated.
 */
export function assessOptimizerCheckpoint(
  stored: StoredOptimizerCheckpoint,
  engineVersion: string = OPTIMIZER_ENGINE_VERSION
): OptimizerCheckpointAssessment {
  if (stored.status === "complete" || stored.status === "cancelled") {
    return { kind: "finished", jobId: stored.jobId };
  }

  const incompatible = (reason: string): OptimizerCheckpointAssessment => ({
    kind: "incompatible",
    jobId: stored.jobId,
    reason,
    input: stored.input ?? null,
    updatedAt: stored.updatedAt,
  });

  if (!stored.input || !Array.isArray(stored.candidates)) {
    return incompatible("The saved job is missing its inputs or candidates.");
  }

  const storedEngine = stored.engineVersion ?? null;
  if (storedEngine !== null && storedEngine !== engineVersion) {
    return incompatible(
      `The job was saved by optimizer engine ${storedEngine}; this build runs ${engineVersion}, so its results cannot be continued exactly.`
    );
  }

  let expectedInputFingerprint: string;
  try {
    expectedInputFingerprint = createOptimizerInputFingerprint(stored.input);
  } catch {
    return incompatible("The saved job's inputs no longer validate.");
  }
  if (expectedInputFingerprint !== stored.inputFingerprint) {
    return incompatible(
      "The saved job's inputs or engine version no longer match this build."
    );
  }

  const expectedAlgorithm = algorithmForInput(stored.input);
  if (stored.algorithm !== expectedAlgorithm) {
    return incompatible(
      "The saved job used a different search algorithm than this build would."
    );
  }

  const seeds = seedBankFingerprints(stored.input);
  const stale = (evaluations: readonly OptimizerEvaluation[], bank: string) =>
    evaluations.some((evaluation) => evaluation.seedBankFingerprint !== bank);
  if (
    stale(stored.exploration, seeds.exploration) ||
    stale(stored.confirmation, seeds.confirmation)
  ) {
    return incompatible(
      "The saved evaluations were built from different Monte Carlo seed banks."
    );
  }

  if (stored.schemaVersion === undefined) {
    if (stored.algorithm === "evolutionary" && stored.stage === "exploration") {
      return incompatible(
        "This job was saved before generation state was recorded, so its evolutionary search cannot be continued exactly."
      );
    }
    return {
      kind: "resumable",
      upgraded: true,
      checkpoint: {
        ...stored,
        schemaVersion: OPTIMIZER_CHECKPOINT_SCHEMA_VERSION,
        engineVersion,
        evolution: null,
        explorationSeedBankFingerprint: seeds.exploration,
        confirmationSeedBankFingerprint: seeds.confirmation,
      },
    };
  }

  const storedSchema: number = stored.schemaVersion;
  if (storedSchema !== OPTIMIZER_CHECKPOINT_SCHEMA_VERSION) {
    return incompatible(
      `The job was saved with checkpoint schema ${storedSchema}; this build reads schema ${OPTIMIZER_CHECKPOINT_SCHEMA_VERSION}.`
    );
  }

  if (
    stored.explorationSeedBankFingerprint !== seeds.exploration ||
    stored.confirmationSeedBankFingerprint !== seeds.confirmation
  ) {
    return incompatible(
      "The saved seed banks do not match the ones this build derives."
    );
  }

  if (stored.algorithm === "evolutionary" && stored.stage === "exploration") {
    const evolution = stored.evolution;
    if (!evolution) {
      return incompatible("The saved evolutionary job has no generation state.");
    }
    const known = new Set(stored.candidates.map((c) => c.fingerprint));
    if (evolution.population.some((fingerprint) => !known.has(fingerprint))) {
      return incompatible(
        "The saved generation references candidates that were not stored."
      );
    }
  }

  return { kind: "resumable", upgraded: false, checkpoint: stored };
}
