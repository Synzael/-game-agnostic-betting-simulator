"use client";

import { useEffect, useMemo, useState } from "react";
import type {
  DecisionGhostForecast,
  DecisionGhostInput,
} from "@/engine/decision-ghosts";
import {
  DECISION_GHOSTS_PREVIEW_SAMPLES,
  DECISION_GHOSTS_TOTAL_SAMPLES,
  createDecisionGhostFingerprint,
  createDecisionGhostSeed,
  createDefaultDecisionGhostInput,
} from "@/engine/decision-ghosts";
import type {
  FrozenGameSnapshot,
  SessionConfig,
  SessionState,
  StrategyConfig,
} from "@/engine/types";
import type {
  DecisionGhostWorkerRequest,
  DecisionGhostWorkerResponse,
} from "@/workers/decision-ghosts.protocol";

export type DecisionGhostStatus =
  | "idle"
  | "loading"
  | "preview"
  | "ready"
  | "error";

export interface DecisionGhostViewState {
  readonly status: DecisionGhostStatus;
  readonly forecast: DecisionGhostForecast | null;
  readonly completedSamples: number;
  readonly totalSamples: number;
  readonly error: string | null;
}

interface ForecastRequest {
  readonly input: DecisionGhostInput;
  readonly fingerprint: string;
  readonly seed: number;
}

interface DecisionGhostInternalState extends DecisionGhostViewState {
  readonly fingerprint: string | null;
}

const forecastCache = new Map<string, DecisionGhostForecast>();
const MAX_CACHE_ENTRIES = 8;
let requestSequence = 0;

const IDLE_STATE: DecisionGhostViewState = {
  status: "idle",
  forecast: null,
  completedSamples: 0,
  totalSamples: DECISION_GHOSTS_TOTAL_SAMPLES,
  error: null,
};

const INITIAL_INTERNAL_STATE: DecisionGhostInternalState = {
  ...IDLE_STATE,
  fingerprint: null,
};

function cacheForecast(
  fingerprint: string,
  forecast: DecisionGhostForecast
): void {
  if (forecastCache.has(fingerprint)) {
    forecastCache.delete(fingerprint);
  }
  forecastCache.set(fingerprint, forecast);

  while (forecastCache.size > MAX_CACHE_ENTRIES) {
    const oldestKey = forecastCache.keys().next().value;
    if (oldestKey === undefined) break;
    forecastCache.delete(oldestKey);
  }
}

function buildRequest(
  state: SessionState | null,
  config: SessionConfig | null,
  strategy: StrategyConfig | null,
  game: FrozenGameSnapshot | null
): ForecastRequest | null {
  if (
    !state ||
    !config ||
    !strategy ||
    !game ||
    state.stopped ||
    !state.awaitingDecision ||
    state.pendingDecisionType !== "bridging" ||
    state.currentLadder >= strategy.ladders.length - 1
  ) {
    return null;
  }

  const input = createDefaultDecisionGhostInput(
    state,
    config,
    strategy,
    game
  );
  return {
    input,
    fingerprint: createDecisionGhostFingerprint(input),
    seed: createDecisionGhostSeed(input),
  };
}

export function useDecisionGhosts(
  state: SessionState | null,
  config: SessionConfig | null,
  strategy: StrategyConfig | null,
  game: FrozenGameSnapshot | null
): DecisionGhostViewState {
  const request = useMemo(
    () => buildRequest(state, config, strategy, game),
    [state, config, strategy, game]
  );
  // The fingerprint covers every input the forecast depends on, so hold the
  // request identity stable across store updates that merely recreate equal
  // objects — otherwise the effect would restart the 10,000-path run.
  const requestFingerprint = request?.fingerprint ?? null;
  const stableRequest = useMemo(
    () => request,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [requestFingerprint]
  );
  const [internalState, setInternalState] =
    useState<DecisionGhostInternalState>(INITIAL_INTERNAL_STATE);

  useEffect(() => {
    const request = stableRequest;
    if (!request) return;

    const cached = forecastCache.get(request.fingerprint);
    if (cached) return;

    if (typeof Worker === "undefined") return;

    const requestId = `${request.fingerprint}-${requestSequence += 1}`;
    let worker: Worker;
    let cancelled = false;

    try {
      worker = new Worker(
        new URL("../../workers/decision-ghosts.worker.ts", import.meta.url),
        { type: "module" }
      );
    } catch {
      queueMicrotask(() => {
        if (cancelled) return;
        setInternalState({
          fingerprint: request.fingerprint,
          status: "error",
          forecast: null,
          completedSamples: 0,
          totalSamples: DECISION_GHOSTS_TOTAL_SAMPLES,
          error: "Forecast worker could not start.",
        });
      });
      return;
    }

    worker.onmessage = (
      event: MessageEvent<DecisionGhostWorkerResponse>
    ) => {
      const response = event.data;
      if (response.requestId !== requestId) return;

      if (response.type === "progress") {
        setInternalState((current) => {
          const currentForecast =
            current.fingerprint === request.fingerprint
              ? current.forecast
              : null;
          return {
            fingerprint: request.fingerprint,
            status: currentForecast ? "preview" : "loading",
            forecast: currentForecast,
            completedSamples: response.completedSamples,
            totalSamples: response.totalSamples,
            error: null,
          };
        });
        return;
      }

      if (response.type === "error") {
        setInternalState({
          fingerprint: request.fingerprint,
          status: "error",
          forecast: null,
          completedSamples: 0,
          totalSamples: DECISION_GHOSTS_TOTAL_SAMPLES,
          error: response.message,
        });
        worker.terminate();
        return;
      }

      if (response.stage === "preview") {
        setInternalState({
          fingerprint: request.fingerprint,
          status: "preview",
          forecast: response.forecast,
          completedSamples: response.forecast.sampleCount,
          totalSamples: DECISION_GHOSTS_TOTAL_SAMPLES,
          error: null,
        });
        return;
      }

      cacheForecast(request.fingerprint, response.forecast);
      setInternalState({
        fingerprint: request.fingerprint,
        status: "ready",
        forecast: response.forecast,
        completedSamples: response.forecast.sampleCount,
        totalSamples: response.forecast.sampleCount,
        error: null,
      });
      worker.terminate();
    };

    worker.onerror = () => {
      setInternalState({
        fingerprint: request.fingerprint,
        status: "error",
        forecast: null,
        completedSamples: 0,
        totalSamples: DECISION_GHOSTS_TOTAL_SAMPLES,
        error: "Forecast worker stopped unexpectedly.",
      });
      worker.terminate();
    };

    const startRequest: DecisionGhostWorkerRequest = {
      type: "start",
      requestId,
      input: request.input,
      seed: request.seed,
      previewSamples: DECISION_GHOSTS_PREVIEW_SAMPLES,
      totalSamples: DECISION_GHOSTS_TOTAL_SAMPLES,
    };
    worker.postMessage(startRequest);

    return () => {
      cancelled = true;
      const cancelRequest: DecisionGhostWorkerRequest = {
        type: "cancel",
        requestId,
      };
      worker.postMessage(cancelRequest);
      worker.terminate();
    };
  }, [stableRequest]);

  if (!request) return IDLE_STATE;

  const cached = forecastCache.get(request.fingerprint);
  if (cached) {
    return {
      status: "ready",
      forecast: cached,
      completedSamples: cached.sampleCount,
      totalSamples: cached.sampleCount,
      error: null,
    };
  }

  if (typeof Worker === "undefined") {
    return {
      status: "error",
      forecast: null,
      completedSamples: 0,
      totalSamples: DECISION_GHOSTS_TOTAL_SAMPLES,
      error: "Forecast worker is unavailable.",
    };
  }

  if (internalState.fingerprint === request.fingerprint) {
    return internalState;
  }

  return {
    status: "loading",
    forecast: null,
    completedSamples: 0,
    totalSamples: DECISION_GHOSTS_TOTAL_SAMPLES,
    error: null,
  };
}
