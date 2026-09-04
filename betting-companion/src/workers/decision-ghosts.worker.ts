import {
  addDecisionGhostSample,
  createDecisionGhostAccumulator,
  summarizeDecisionGhostForecast,
} from "@/engine/decision-ghosts";
import type {
  DecisionGhostStartRequest,
  DecisionGhostWorkerRequest,
  DecisionGhostWorkerResponse,
} from "./decision-ghosts.protocol";

const BATCH_SIZE = 100;
const PROGRESS_INTERVAL = 500;

let activeRequestId: string | null = null;

function post(response: DecisionGhostWorkerResponse): void {
  self.postMessage(response);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Forecast failed.";
}

function yieldToWorkerQueue(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function runForecast(request: DecisionGhostStartRequest): Promise<void> {
  activeRequestId = request.requestId;

  try {
    if (
      !Number.isInteger(request.previewSamples) ||
      !Number.isInteger(request.totalSamples) ||
      request.previewSamples <= 0 ||
      request.previewSamples > request.totalSamples ||
      request.totalSamples > 100_000
    ) {
      throw new Error("Forecast sample counts are invalid.");
    }

    const accumulator = createDecisionGhostAccumulator(request.input);
    let previewSent = false;

    while (
      accumulator.sampleCount < request.totalSamples &&
      activeRequestId === request.requestId
    ) {
      const batchEnd = Math.min(
        request.totalSamples,
        accumulator.sampleCount + BATCH_SIZE
      );
      while (accumulator.sampleCount < batchEnd) {
        addDecisionGhostSample(accumulator, request.input, request.seed);
      }

      if (
        !previewSent &&
        accumulator.sampleCount >= request.previewSamples
      ) {
        previewSent = true;
        post({
          type: "forecast",
          requestId: request.requestId,
          stage: "preview",
          forecast: summarizeDecisionGhostForecast(
            accumulator,
            request.input,
            request.seed
          ),
        });
      }

      if (
        accumulator.sampleCount % PROGRESS_INTERVAL === 0 ||
        accumulator.sampleCount === request.totalSamples
      ) {
        post({
          type: "progress",
          requestId: request.requestId,
          completedSamples: accumulator.sampleCount,
          totalSamples: request.totalSamples,
        });
      }

      // Let cancel/new-start messages run between bounded CPU batches.
      await yieldToWorkerQueue();
    }

    if (activeRequestId !== request.requestId) return;

    post({
      type: "forecast",
      requestId: request.requestId,
      stage: "final",
      forecast: summarizeDecisionGhostForecast(
        accumulator,
        request.input,
        request.seed
      ),
    });
    activeRequestId = null;
  } catch (error) {
    if (activeRequestId !== request.requestId) return;
    post({
      type: "error",
      requestId: request.requestId,
      message: errorMessage(error),
    });
    activeRequestId = null;
  }
}

self.onmessage = (event: MessageEvent<DecisionGhostWorkerRequest>) => {
  const request = event.data;

  if (request.type === "cancel") {
    if (activeRequestId === request.requestId) {
      activeRequestId = null;
    }
    return;
  }

  void runForecast(request);
};

