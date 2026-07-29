import { openDB, type DBSchema } from "idb";
import type {
  OptimizerCandidate,
  OptimizerEvaluation,
  OptimizerJobInput,
} from "./optimizer";

export interface OptimizerCheckpoint {
  readonly jobId: string;
  readonly inputFingerprint: string;
  readonly input: OptimizerJobInput;
  readonly algorithm: "grid" | "evolutionary";
  readonly stage: "exploration" | "confirmation" | "complete";
  readonly status:
    | "running"
    | "paused"
    | "cancelled"
    | "interrupted"
    | "complete"
    | "failed";
  readonly candidates: readonly OptimizerCandidate[];
  readonly exploration: readonly OptimizerEvaluation[];
  readonly confirmation: readonly OptimizerEvaluation[];
  readonly activeComputeMs: number;
  readonly updatedAt: number;
}

interface OptimizerDatabase extends DBSchema {
  checkpoints: {
    key: string;
    value: OptimizerCheckpoint;
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
  OptimizerCheckpoint | undefined
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

