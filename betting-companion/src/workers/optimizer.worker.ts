import {
  evaluateOptimizerCandidate,
  OPTIMIZER_ENGINE_VERSION,
} from "@/engine/optimizer";
import type {
  OptimizerWorkerRequest,
  OptimizerWorkerResponse,
} from "./optimizer.protocol";

function post(response: OptimizerWorkerResponse): void {
  self.postMessage(response);
}

self.onmessage = (event: MessageEvent<OptimizerWorkerRequest>) => {
  const request = event.data;
  try {
    if (
      request.engineVersion !== OPTIMIZER_ENGINE_VERSION ||
      request.candidates.length === 0
    ) {
      throw new Error("Stale optimizer batch");
    }
    const evaluations = request.candidates.map((candidate) =>
      evaluateOptimizerCandidate(
        candidate,
        request.input,
        request.seeds,
        request.stage
      )
    );
    post({
      type: "result",
      jobId: request.jobId,
      batchId: request.batchId,
      engineVersion: request.engineVersion,
      inputFingerprint: request.inputFingerprint,
      evaluations,
    });
  } catch (error) {
    post({
      type: "error",
      jobId: request.jobId,
      batchId: request.batchId,
      engineVersion: request.engineVersion,
      inputFingerprint: request.inputFingerprint,
      message:
        error instanceof Error ? error.message : "Optimizer batch failed",
    });
  }
};

