import type {
  OptimizerCandidate,
  OptimizerEvaluation,
  OptimizerJobInput,
} from "@/engine/optimizer";

export interface OptimizerEvaluateRequest {
  readonly type: "evaluate";
  readonly jobId: string;
  readonly batchId: string;
  readonly engineVersion: string;
  readonly inputFingerprint: string;
  readonly input: OptimizerJobInput;
  readonly candidates: readonly OptimizerCandidate[];
  readonly seeds: readonly number[];
  readonly stage: OptimizerEvaluation["stage"];
}

export type OptimizerWorkerRequest = OptimizerEvaluateRequest;

export type OptimizerWorkerResponse =
  | {
      readonly type: "result";
      readonly jobId: string;
      readonly batchId: string;
      readonly engineVersion: string;
      readonly inputFingerprint: string;
      readonly evaluations: readonly OptimizerEvaluation[];
    }
  | {
      readonly type: "error";
      readonly jobId: string;
      readonly batchId: string;
      readonly engineVersion: string;
      readonly inputFingerprint: string;
      readonly message: string;
    };

