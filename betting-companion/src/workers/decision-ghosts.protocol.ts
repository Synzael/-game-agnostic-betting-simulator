import type {
  DecisionGhostForecast,
  DecisionGhostInput,
} from "@/engine/decision-ghosts";

export interface DecisionGhostStartRequest {
  readonly type: "start";
  readonly requestId: string;
  readonly input: DecisionGhostInput;
  readonly seed: number;
  readonly previewSamples: number;
  readonly totalSamples: number;
}

export interface DecisionGhostCancelRequest {
  readonly type: "cancel";
  readonly requestId: string;
}

export type DecisionGhostWorkerRequest =
  | DecisionGhostStartRequest
  | DecisionGhostCancelRequest;

export interface DecisionGhostProgressResponse {
  readonly type: "progress";
  readonly requestId: string;
  readonly completedSamples: number;
  readonly totalSamples: number;
}

export interface DecisionGhostForecastResponse {
  readonly type: "forecast";
  readonly requestId: string;
  readonly stage: "preview" | "final";
  readonly forecast: DecisionGhostForecast;
}

export interface DecisionGhostErrorResponse {
  readonly type: "error";
  readonly requestId: string;
  readonly message: string;
}

export type DecisionGhostWorkerResponse =
  | DecisionGhostProgressResponse
  | DecisionGhostForecastResponse
  | DecisionGhostErrorResponse;

