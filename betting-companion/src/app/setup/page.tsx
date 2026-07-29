"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  useCustomPresetStore,
  useSessionStore,
  useSettingsStore,
} from "@/store";
import { Button, Card, NumberInput, Toggle } from "@/components/ui";
import {
  createGameSnapshot,
  getAllPresets,
  getAllGames,
  expectedReturnPerUnit,
  createStrategyFromPreset,
  DEFAULT_SESSION_CONFIG,
  SessionConfig,
  PresetConfig,
  DEFAULT_LADDERS,
  formatStake,
} from "@/engine";
import type { SavedOptimizerPreset } from "@/engine/optimizer";

interface SetupValidationErrors {
  bankroll?: string;
  profitTarget?: string;
  stopLossAbs?: string;
}

function validateSessionConfig(config: SessionConfig): SetupValidationErrors {
  const errors: SetupValidationErrors = {};

  if (config.bankroll <= 0) {
    errors.bankroll = "Bankroll must be greater than 0.";
  }

  if (config.profitTarget <= 0) {
    errors.profitTarget = "Profit target must be greater than 0.";
  }

  if (config.stopLossAbs <= 0) {
    errors.stopLossAbs = "Stop loss must be greater than 0.";
  } else if (config.stopLossAbs > config.bankroll) {
    errors.stopLossAbs = "Stop loss cannot be greater than bankroll.";
  }

  return errors;
}

export default function SetupPage() {
  const router = useRouter();
  const startSession = useSessionStore((s) => s.startSession);
  const setDecisionMode = useSessionStore((s) => s.setDecisionMode);
  const decisionMode = useSessionStore((s) => s.decisionMode);
  const showBetNumbers = useSettingsStore((s) => s.showBetNumbers);
  const setShowBetNumbers = useSettingsStore((s) => s.setShowBetNumbers);

  const presets = getAllPresets();
  const customPresets = useCustomPresetStore((state) => state.presets);
  const games = getAllGames();
  const [selectedGameId, setSelectedGameId] = useState<string>(
    games[0].id
  );
  const selectedGame =
    games.find((game) => game.id === selectedGameId) ?? games[0];
  const [selectedVariantId, setSelectedVariantId] = useState<string>(
    selectedGame.betVariants[0].id
  );
  const selectedVariant =
    selectedGame.betVariants.find(
      (variant) => variant.id === selectedVariantId
    ) ?? selectedGame.betVariants[0];
  const [selectedPreset, setSelectedPreset] = useState<string>("default");
  const [showWarningModal, setShowWarningModal] = useState(false);
  const [config, setConfig] = useState<SessionConfig>({
    ...DEFAULT_SESSION_CONFIG,
  });
  const [showValidationSummary, setShowValidationSummary] = useState(false);

  const validationErrors = validateSessionConfig(config);
  const hasValidationErrors = Object.keys(validationErrors).length > 0;

  /**
   * A Lab preset's feasibility was confirmed against one specific objective and
   * game. Starting it under different settings does not reshape the ladder, so
   * the confirmed ruin bound would no longer describe what the user is running.
   */
  const presetMatchesCurrentSettings = (
    preset: SavedOptimizerPreset
  ): boolean => {
    const { objective, gameFingerprint } = preset.provenance;
    return (
      gameFingerprint ===
        createGameSnapshot(selectedGame.id, selectedVariant.id).fingerprint &&
      objective.bankroll === config.bankroll &&
      objective.profitTarget === config.profitTarget &&
      objective.stopLossAbs === config.stopLossAbs &&
      objective.maxRounds === config.maxRounds &&
      (objective.tableMax ?? null) === (config.tableMax ?? null)
    );
  };

  const handlePresetSelect = (preset: PresetConfig) => {
    setSelectedPreset(preset.name);
  };

  const handleStartSession = () => {
    if (hasValidationErrors) {
      setShowValidationSummary(true);
      return;
    }

    setShowValidationSummary(false);
    setShowWarningModal(true);
  };

  const confirmStartSession = () => {
    const custom = customPresets.find(
      (preset) => preset.id === selectedPreset
    );
    const strategy = custom
      ? structuredClone(custom.strategy)
      : createStrategyFromPreset(selectedPreset);
    const game = createGameSnapshot(selectedGame.id, selectedVariant.id);
    startSession(config, strategy, game);
    setShowWarningModal(false);
    router.push("/session");
  };

  const updateConfig = (updates: Partial<SessionConfig>) => {
    setConfig((prev) => ({ ...prev, ...updates }));
  };

  return (
    <div className="min-h-screen bg-slate-900 p-4">
      {/* Header */}
      <div className="flex items-center gap-4 mb-6">
        <Link href="/" className="text-slate-400 hover:text-white">
          ← Back
        </Link>
        <h1 className="text-xl font-bold text-white">
          New Session
        </h1>
      </div>

      <div className="max-w-md mx-auto space-y-6">
        {/* Game Selection */}
        <div>
          <h2 className="text-sm text-slate-400 uppercase tracking-wide mb-3">
            Game
          </h2>
          <div className="grid grid-cols-1 gap-2">
            {games.map((game) => (
              <Card
                key={game.id}
                variant={selectedGame.id === game.id ? "info" : "default"}
                interactive
                selected={selectedGame.id === game.id}
                className="p-3"
                onClick={() => {
                  setSelectedGameId(game.id);
                  setSelectedVariantId(game.betVariants[0].id);
                }}
              >
                <div className="font-medium text-white text-sm">
                  {game.displayName}
                </div>
                <div className="text-xs text-slate-400 mt-1">
                  {game.description}
                </div>
              </Card>
            ))}
          </div>
        </div>

        {selectedGame.betVariants.length > 1 && (
          <div>
            <h2 className="text-sm text-slate-400 uppercase tracking-wide mb-3">
              Bet Variant
            </h2>
            <div className="grid grid-cols-1 gap-2">
              {selectedGame.betVariants.map((variant) => (
                <Card
                  key={variant.id}
                  variant={
                    selectedVariant.id === variant.id ? "info" : "default"
                  }
                  interactive
                  selected={selectedVariant.id === variant.id}
                  className="p-3"
                  onClick={() => setSelectedVariantId(variant.id)}
                >
                  <div className="font-medium text-white text-sm">
                    {variant.displayName}
                  </div>
                </Card>
              ))}
            </div>
          </div>
        )}

        <Card className="p-4">
          <div className="text-xs text-slate-300">
            {selectedVariant.outcomes.map((outcome) => (
              <div
                key={outcome.id}
                className="flex justify-between gap-3 py-1"
              >
                <span>{outcome.displayName}</span>
                <span className="text-slate-400 text-right">
                  {(outcome.probability * 100).toFixed(2)}% ·{" "}
                  {outcome.netPayoutMultiplier > 0 ? "+" : ""}
                  {outcome.netPayoutMultiplier}:1 net
                </span>
              </div>
            ))}
          </div>
          <div className="mt-3 border-t border-slate-700 pt-3 text-xs text-slate-400">
            Theoretical return:{" "}
            <span
              className={
                expectedReturnPerUnit(
                  createGameSnapshot(selectedGame.id, selectedVariant.id)
                ) < 0
                  ? "text-red-400"
                  : "text-amber-300"
              }
            >
              {(
                expectedReturnPerUnit(
                  createGameSnapshot(selectedGame.id, selectedVariant.id)
                ) * 100
              ).toFixed(3)}
              % per unit wagered
            </span>
            <p className="mt-2">{selectedGame.assumptions}</p>
            <p className="mt-2">
              Game modules model settlement rules; they do not turn a
              negative-EV wager into a profitable one.
            </p>
          </div>
        </Card>

        {/* Preset Selection */}
        <div>
          <h2 className="text-sm text-slate-400 uppercase tracking-wide mb-3">
            Strategy Preset
          </h2>
          <div className="grid grid-cols-2 gap-2">
            {presets.map((preset) => (
              <Card
                key={preset.name}
                variant={selectedPreset === preset.name ? "info" : "default"}
                interactive
                selected={selectedPreset === preset.name}
                className="p-3"
                onClick={() => handlePresetSelect(preset)}
              >
                <div className="font-medium text-white text-sm">
                  {preset.displayName}
                </div>
                <div className="text-xs text-slate-400 mt-1">
                  {preset.recoveryTargetPct * 100}% recovery
                </div>
              </Card>
            ))}
          </div>
          <p className="text-xs text-slate-500 mt-2">
            {(() => {
              const custom = customPresets.find(
                (preset) => preset.id === selectedPreset
              );
              if (!custom) {
                return presets.find((p) => p.name === selectedPreset)
                  ?.description;
              }
              return presetMatchesCurrentSettings(custom)
                ? "Versioned Ladder Lab result with saved optimizer provenance."
                : "Confirmed under a different game or session settings, so its ruin bound does not describe this setup.";
            })()}
          </p>
          {customPresets.length > 0 && (
            <>
              <h3 className="mt-4 mb-2 text-xs uppercase tracking-wide text-slate-500">
                Custom Lab Presets
              </h3>
              <div className="grid grid-cols-2 gap-2">
                {customPresets.map((preset) => (
                  <Card
                    key={preset.id}
                    variant={
                      selectedPreset === preset.id ? "info" : "default"
                    }
                    interactive
                    selected={selectedPreset === preset.id}
                    className="p-3"
                    onClick={() => setSelectedPreset(preset.id)}
                  >
                    <div className="font-medium text-white text-sm">
                      {preset.displayName}
                    </div>
                    <div className="text-xs text-slate-400 mt-1">
                      v{preset.version} ·{" "}
                      {presetMatchesCurrentSettings(preset)
                        ? "confirmed"
                        : "confirmed for other settings"}
                    </div>
                  </Card>
                ))}
              </div>
            </>
          )}
        </div>

        {/* Session Configuration */}
        <div>
          <h2 className="text-sm text-slate-400 uppercase tracking-wide mb-3">
            Session Settings
          </h2>
          <div className="space-y-4">
            <NumberInput
              label="Starting Bankroll"
              value={config.bankroll}
              onChange={(v) => updateConfig({ bankroll: v })}
              min={0}
              prefix="$"
              hint="Your starting balance"
              error={validationErrors.bankroll}
            />
            <NumberInput
              label="Profit Target"
              value={config.profitTarget}
              onChange={(v) => updateConfig({ profitTarget: v })}
              min={0}
              prefix="$"
              hint="Session ends when you reach this profit"
              error={validationErrors.profitTarget}
            />
            <NumberInput
              label="Stop Loss"
              value={config.stopLossAbs}
              onChange={(v) => updateConfig({ stopLossAbs: v })}
              min={0}
              prefix="$"
              hint="Session ends if you lose this amount"
              error={validationErrors.stopLossAbs}
            />
          </div>
        </div>

        {/* Starting Ladder */}
        <div>
          <h2 className="text-sm text-slate-400 uppercase tracking-wide mb-3">
            Starting Ladder
          </h2>
          <div className="grid grid-cols-3 gap-2">
            {DEFAULT_LADDERS.map((ladder, index) => {
              const minStake = ladder.stakes[0];
              const maxStake = ladder.stakes[ladder.stakes.length - 1];
              return (
                <Card
                  key={ladder.name}
                  variant={config.startingLadder === index ? "info" : "default"}
                  interactive
                  selected={config.startingLadder === index}
                  className="p-3"
                  onClick={() => updateConfig({ startingLadder: index })}
                >
                  <div className="font-medium text-white text-sm">
                    {ladder.name}
                  </div>
                  <div className="text-xs text-slate-400 mt-1">
                    {formatStake(minStake)} – {formatStake(maxStake)}
                  </div>
                </Card>
              );
            })}
          </div>
        </div>

        {/* Decision Mode */}
        <div>
          <h2 className="text-sm text-slate-400 uppercase tracking-wide mb-3">
            Decision Mode
          </h2>
          <div className="grid grid-cols-2 gap-2">
            <Card
              variant={decisionMode === "at_bridging_only" ? "info" : "default"}
              interactive
              selected={decisionMode === "at_bridging_only"}
              className="p-3"
              onClick={() => setDecisionMode("at_bridging_only")}
            >
              <div className="font-medium text-white text-sm">
                At Bridging Only
              </div>
              <div className="text-xs text-slate-400 mt-1">
                Decisions only at ladder top
              </div>
            </Card>
            <Card
              variant={decisionMode === "every_bet" ? "info" : "default"}
              interactive
              selected={decisionMode === "every_bet"}
              className="p-3"
              onClick={() => setDecisionMode("every_bet")}
            >
              <div className="font-medium text-white text-sm">
                Every Bet
              </div>
              <div className="text-xs text-slate-400 mt-1">
                Confirm each bet
              </div>
            </Card>
          </div>
        </div>

        {/* Display */}
        <div>
          <h2 className="text-sm text-slate-400 uppercase tracking-wide mb-3">
            Display
          </h2>
          <Card className="p-3">
            <div className="flex items-center justify-between">
              <div>
                <div className="font-medium text-white text-sm">
                  Bet amounts on graph
                </div>
                <div className="text-xs text-slate-400 mt-1">
                  Show win/loss stakes next to each point
                </div>
              </div>
              <Toggle
                checked={showBetNumbers}
                onChange={setShowBetNumbers}
                size="sm"
              />
            </div>
          </Card>
        </div>

        {/* Start Button */}
        {showValidationSummary && hasValidationErrors && (
          <p className="text-sm text-red-400">
            Please fix invalid session settings before starting.
          </p>
        )}
        <Button
          variant="success"
          size="xl"
          fullWidth
          onClick={handleStartSession}
          className="mt-8"
        >
          Start Session
        </Button>
      </div>

      {showWarningModal && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="w-full max-w-lg rounded-2xl border-2 border-pink-400 bg-pink-950/90 p-5 shadow-[0_0_40px_rgba(236,72,153,0.35)]">
            <div className="text-xs uppercase tracking-[0.2em] text-pink-200 mb-2">
              Warning
            </div>
            <p className="text-pink-50 font-semibold leading-relaxed">
              Every ladder remains exposed to the selected game&apos;s
              assumptions and variance. A modeled range or optimized shape
              cannot remove a house edge.
            </p>
            <div className="mt-5 grid grid-cols-2 gap-2">
              <Button
                variant="secondary"
                size="md"
                fullWidth
                onClick={() => setShowWarningModal(false)}
              >
                Cancel
              </Button>
              <Button
                variant="danger"
                size="md"
                fullWidth
                onClick={confirmStartSession}
              >
                I Understand
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
