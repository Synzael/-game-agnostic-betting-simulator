import {
  addVarianceSample,
  createVarianceAccumulator,
  summarizeVarianceForecast,
} from "@/engine/variance-forecast";
import type {
  VarianceForecastStartRequest,
  VarianceForecastWorkerRequest,
  VarianceForecastWorkerResponse,
} from "./variance-forecast.protocol";

const BATCH_SIZE = 25;
let activeRequestId: string | null = null;

function post(response: VarianceForecastWorkerResponse): void {
  self.postMessage(response);
}

function yieldToWorkerQueue(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function run(request: VarianceForecastStartRequest): Promise<void> {
  activeRequestId = request.requestId;
  try {
    if (
      request.previewSamples <= 0 ||
      request.previewSamples > request.totalSamples ||
      request.totalSamples > 100_000
    ) {
      throw new Error("Variance forecast sample counts are invalid");
    }

    const accumulator = createVarianceAccumulator(request.input, request.seed);
    let previewSent = false;
    while (
      accumulator.sampleCount < request.totalSamples &&
      activeRequestId === request.requestId
    ) {
      const end = Math.min(
        request.totalSamples,
        accumulator.sampleCount + BATCH_SIZE
      );
      while (accumulator.sampleCount < end) addVarianceSample(accumulator);

      if (
        !previewSent &&
        accumulator.sampleCount >= request.previewSamples
      ) {
        previewSent = true;
        post({
          type: "forecast",
          requestId: request.requestId,
          forecast: summarizeVarianceForecast(accumulator, "preview"),
        });
      }

      post({
        type: "progress",
        requestId: request.requestId,
        completedSamples: accumulator.sampleCount,
        totalSamples: request.totalSamples,
      });
      await yieldToWorkerQueue();
    }

    if (activeRequestId !== request.requestId) return;
    post({
      type: "forecast",
      requestId: request.requestId,
      forecast: summarizeVarianceForecast(accumulator, "full"),
    });
    activeRequestId = null;
  } catch (error) {
    if (activeRequestId !== request.requestId) return;
    post({
      type: "error",
      requestId: request.requestId,
      message:
        error instanceof Error ? error.message : "Variance modeling failed",
    });
    activeRequestId = null;
  }
}

self.onmessage = (
  event: MessageEvent<VarianceForecastWorkerRequest>
) => {
  if (event.data.type === "cancel") {
    if (activeRequestId === event.data.requestId) activeRequestId = null;
    return;
  }
  void run(event.data);
};

