"use client";

import { useEffect, useMemo } from "react";
import { useSessionStore } from "@/store";
import {
  createVarianceFingerprint,
  createVarianceSeed,
  VARIANCE_FULL_SAMPLES,
  VARIANCE_PREVIEW_SAMPLES,
} from "@/engine/variance-forecast";
import type {
  VarianceForecastWorkerRequest,
  VarianceForecastWorkerResponse,
} from "@/workers/variance-forecast.protocol";

export function useVarianceForecast(): void {
  const config = useSessionStore((state) => state.config);
  const strategy = useSessionStore((state) => state.strategy);
  const game = useSessionStore((state) => state.game);
  const input = useMemo(
    () =>
      config && strategy && game
        ? { config, strategy, game }
        : null,
    [config, strategy, game]
  );
  const inputFingerprint = useMemo(
    () => (input ? createVarianceFingerprint(input) : null),
    [input]
  );

  // Keyed on the fingerprint, not the input object: store updates that
  // recreate equal config/strategy/game references must not restart the run.
  useEffect(() => {
    if (!inputFingerprint) return;

    const store = useSessionStore.getState();
    const currentInput =
      store.config && store.strategy && store.game
        ? {
            config: store.config,
            strategy: store.strategy,
            game: store.game,
          }
        : null;
    if (!currentInput) return;
    if (
      store.varianceForecast?.inputFingerprint === inputFingerprint &&
      store.varianceForecast.quality === "full"
    ) {
      store.setForecastStatus("ready");
      return;
    }

    // Read `stopped` non-reactively: subscribing would re-run this effect when
    // the session ends and kill an in-flight forecast about to complete.
    if (store.state?.stopped) {
      const existing = store.varianceForecast;
      const upgradable =
        existing?.inputFingerprint === inputFingerprint &&
        existing.quality !== "full";
      // A finished session only ever runs once more, to upgrade a preview
      // snapshot to full quality; otherwise there is nothing left to model.
      if (!upgradable) return;
    }

    if (typeof Worker === "undefined") {
      store.setForecastStatus("error");
      return;
    }

    const requestId = crypto.randomUUID();
    const worker = new Worker(
      new URL("../../workers/variance-forecast.worker.ts", import.meta.url),
      { type: "module" }
    );
    store.setForecastStatus("modeling");

    worker.onmessage = (
      event: MessageEvent<VarianceForecastWorkerResponse>
    ) => {
      const response = event.data;
      if (response.requestId !== requestId) return;
      if (response.type === "forecast") {
        useSessionStore.getState().setVarianceForecast(response.forecast);
      } else if (response.type === "error") {
        useSessionStore.getState().setForecastStatus("error");
      }
    };
    worker.onerror = () => {
      useSessionStore.getState().setForecastStatus("error");
    };

    const request: VarianceForecastWorkerRequest = {
      type: "start",
      requestId,
      input: currentInput,
      seed: createVarianceSeed(currentInput),
      previewSamples: VARIANCE_PREVIEW_SAMPLES,
      totalSamples: VARIANCE_FULL_SAMPLES,
    };
    worker.postMessage(request);

    return () => {
      const cancel: VarianceForecastWorkerRequest = {
        type: "cancel",
        requestId,
      };
      worker.postMessage(cancel);
      worker.terminate();
    };
  }, [inputFingerprint]);
}

