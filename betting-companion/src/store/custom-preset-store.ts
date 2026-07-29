"use client";

import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type {
  OptimizerJobInput,
  OptimizerResult,
  SavedOptimizerPreset,
} from "@/engine/optimizer";
import {
  createOptimizerInputFingerprint,
  OPTIMIZER_ENGINE_VERSION,
  validateCandidate,
} from "@/engine/optimizer";
import { PRESETS } from "@/engine/presets";

interface CustomPresetStore {
  presets: SavedOptimizerPreset[];
  saveOptimizerPreset: (
    displayName: string,
    result: OptimizerResult,
    input: OptimizerJobInput
  ) => SavedOptimizerPreset;
  removeCustomPreset: (id: string) => void;
}

export const useCustomPresetStore = create<CustomPresetStore>()(
  persist(
    (set) => ({
      presets: [],
      saveOptimizerPreset: (displayName, result, input) => {
        if (!result.confirmation.feasible) {
          throw new Error(
            "Only a holdout-confirmed feasible candidate can be saved"
          );
        }
        const normalizedName = displayName.trim();
        if (!normalizedName) throw new Error("Custom preset needs a name");
        if (
          Object.values(PRESETS).some(
            (preset) =>
              preset.displayName.toLowerCase() === normalizedName.toLowerCase()
          )
        ) {
          throw new Error("A built-in preset cannot be overwritten");
        }
        validateCandidate(
          result.candidate.strategy,
          input.searchSpace,
          input.objective.tableMax
        );
        const preset: SavedOptimizerPreset = {
          id: `custom:${crypto.randomUUID()}`,
          version: 1,
          displayName: normalizedName,
          createdAt: Date.now(),
          strategy: structuredClone(result.candidate.strategy),
          provenance: {
            engineVersion: OPTIMIZER_ENGINE_VERSION,
            candidateFingerprint: result.candidate.fingerprint,
            inputFingerprint: createOptimizerInputFingerprint(input),
            confirmation: structuredClone(result.confirmation),
            objective: structuredClone(input.objective),
            gameFingerprint: input.game.fingerprint,
          },
        };
        set((state) => ({ presets: [preset, ...state.presets] }));
        return preset;
      },
      removeCustomPreset: (id) => {
        set((state) => ({
          presets: state.presets.filter((preset) => preset.id !== id),
        }));
      },
    }),
    {
      name: "custom-presets:v1",
      storage: createJSONStorage(() => localStorage),
    }
  )
);

