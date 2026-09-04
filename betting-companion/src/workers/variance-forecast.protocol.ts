import type {
  VarianceForecastInput,
} from "@/engine/variance-forecast";
import type { VarianceForecast } from "@/engine/types";

export interface VarianceForecastStartRequest {
  readonly type: "start";
  readonly requestId: string;
  readonly input: VarianceForecastInput;
  readonly seed: number;
  readonly previewSamples: number;
  readonly totalSamples: number;
}

export interface VarianceForecastCancelRequest {
  readonly type: "cancel";
  readonly requestId: string;
}

export type VarianceForecastWorkerRequest =
  | VarianceForecastStartRequest
  | VarianceForecastCancelRequest;

export type VarianceForecastWorkerResponse =
  | {
      readonly type: "forecast";
      readonly requestId: string;
      readonly forecast: VarianceForecast;
    }
  | {
      readonly type: "progress";
      readonly requestId: string;
      readonly completedSamples: number;
      readonly totalSamples: number;
    }
  | {
      readonly type: "error";
      readonly requestId: string;
      readonly message: string;
    };

