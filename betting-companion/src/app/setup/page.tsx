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
  resolveSessionPlan,
  configFromPresetProvenance,
  findRegisteredGameByFingerprint,
  DEFAULT_SESSION_CONFIG,
  SessionConfig,
  SessionPlan,
  PresetConfig,
  formatStake,
} from "@/engine";

interface SetupValidationErrors {
  bankroll?: string;
  profitTarget?: string;
  stopLossAbs?: string;
  maxRounds?: string;
  tableMax?: string;
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

  if (!Number.isInteger(config.maxRounds) || config.maxRounds <= 0) {
    errors.maxRounds = "Max rounds must be a whole number greater than 0.";
  }

  if (config.tableMax !== undefined && config.tableMax <= 0) {
    errors.tableMax = "Table max must be greater than 0, or 0 for no limit.";
  }

  return errors;
}

const POLICY_LABELS: Record<SessionPlan["strategy"]["bridgingPolicy"], string> =
  {
    carry_over_index_delta: "Carry over index delta",
    advance_to_next_ladder_start: "Advance to next ladder start",
    stop_at_table_limit: "Stop at table limit",
  };

function describeOutcomes(plan: SessionPlan): string {
  return plan.game.betVariant.outcomes
    .map((outcome) => {
      const sign = outcome.netPayoutMultiplier > 0 ? "+" : "";
      return `${outcome.displayName} ${sign}${outcome.netPayoutMultiplier}:1`;
    })
    .join(" · ");
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

  // One resolution feeds both the preview and session creation, so what the
  // user reads here is exactly what gets frozen into the session.
  const resolution = resolveSessionPlan({
    presetId: selectedPreset,
    customPresets,
    config,
    gameId: selectedGame.id,
    betVariantId: selectedVariant.id,
  });
  const plan = resolution.ok ? resolution.plan : null;
  const planError = resolution.ok ? null : resolution.error;
  const blockers = plan?.blockers ?? [];
  const canStart = !hasValidationErrors && plan !== null && blockers.length === 0;

  const handlePresetSelect = (preset: PresetConfig) => {
    setSelectedPreset(preset.name);
  };

  const handleStartSession = () => {
    if (!canStart) {
      setShowValidationSummary(true);
      return;
    }

    setShowValidationSummary(false);
    setShowWarningModal(true);
  };

  const confirmStartSession = () => {
    if (!plan) return;
    startSession(plan.config, plan.strategy, plan.game);
    setShowWarningModal(false);
    router.push("/session");
  };

  const updateConfig = (updates: Partial<SessionConfig>) => {
    setConfig((prev) => ({ ...prev, ...updates }));
  };

  const alignWithProvenance = () => {
    if (!plan || plan.source.kind !== "custom") return;
    const preset = plan.source.preset;
    setConfig((prev) => configFromPresetProvenance(preset, prev));
    const game = findRegisteredGameByFingerprint(
      preset.provenance.gameFingerprint
    );
    if (game) {
      setSelectedGameId(game.gameId);
      setSelectedVariantId(game.betVariantId);
    }
  };

  const presetSummary = (() => {
    if (planError) return planError;
    if (!plan) return null;
    if (plan.source.kind === "builtin") return plan.source.preset.description;
    return plan.provenance?.status === "confirmed_for_these_settings"
      ? "Versioned Ladder Lab result. Its confirmed ruin bound describes this exact setup."
      : "Confirmed under different settings, so its ruin bound does not describe this setup. See the effective plan below.";
  })();

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
          <p className="text-xs text-slate-500 mt-2">{presetSummary}</p>
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
                      v{preset.version} · {preset.strategy.ladders.length}{" "}
                      ladder{preset.strategy.ladders.length === 1 ? "" : "s"}
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
            <NumberInput
              label="Max Rounds"
              value={config.maxRounds}
              onChange={(v) => updateConfig({ maxRounds: v })}
              min={1}
              step={1}
              hint="Session ends after this many settled rounds"
              error={validationErrors.maxRounds}
            />
            <NumberInput
              label="Table Max"
              value={config.tableMax ?? 0}
              onChange={(v) =>
                updateConfig({ tableMax: v > 0 ? v : undefined })
              }
              min={0}
              prefix="$"
              hint="0 = no table limit. A required stake above this ends the session."
              error={validationErrors.tableMax}
            />
          </div>
        </div>

        {/* Starting Ladder */}
        <div>
          <h2 className="text-sm text-slate-400 uppercase tracking-wide mb-3">
            Starting Ladder
          </h2>
          {plan ? (
            <div className="grid grid-cols-3 gap-2">
              {plan.strategy.ladders.map((ladder, index) => {
                const minStake = ladder.stakes[0];
                const maxStake = ladder.stakes[ladder.stakes.length - 1];
                const selected = plan.config.startingLadder === index;
                return (
                  <Card
                    key={ladder.name}
                    variant={selected ? "info" : "default"}
                    interactive
                    selected={selected}
                    className="p-3"
                    onClick={() => updateConfig({ startingLadder: index })}
                  >
                    <div className="font-medium text-white text-sm">
                      {ladder.name}
                    </div>
                    <div className="text-xs text-slate-400 mt-1">
                      {formatStake(minStake)} – {formatStake(maxStake)}
                    </div>
                    <div className="text-xs text-slate-500 mt-1">
                      {ladder.stakes.length} steps
                    </div>
                  </Card>
                );
              })}
            </div>
          ) : (
            <p className="text-xs text-slate-500">
              Choose an available preset to preview its ladders.
            </p>
          )}
        </div>

        {/* Effective plan */}
        <div>
          <h2 className="text-sm text-slate-400 uppercase tracking-wide mb-3">
            Effective Session Plan
          </h2>
          {plan ? (
            <Card className="p-4 space-y-4" data-testid="effective-plan">
              <p className="text-xs text-slate-400">
                These are the exact values frozen into the session when you
                start. They come from the selected preset and the settings
                above.
              </p>
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
                <dt className="text-slate-500">Preset</dt>
                <dd className="text-slate-200 text-right">
                  {plan.source.kind === "builtin"
                    ? `${plan.source.preset.displayName} (built-in)`
                    : `${plan.source.preset.displayName} (Ladder Lab v${plan.source.preset.version})`}
                </dd>
                <dt className="text-slate-500">Game</dt>
                <dd className="text-slate-200 text-right">
                  {plan.game.gameDisplayName} · {plan.game.betVariant.displayName}
                </dd>
                <dt className="text-slate-500">Payouts</dt>
                <dd className="text-slate-200 text-right">
                  {describeOutcomes(plan)}
                </dd>
                <dt className="text-slate-500">Bankroll / target / stop</dt>
                <dd className="text-slate-200 text-right">
                  {formatStake(plan.config.bankroll)} /{" "}
                  {formatStake(plan.config.profitTarget)} /{" "}
                  {formatStake(plan.config.stopLossAbs)}
                </dd>
                <dt className="text-slate-500">Max rounds</dt>
                <dd className="text-slate-200 text-right">
                  {plan.config.maxRounds}
                </dd>
                <dt className="text-slate-500">Table max</dt>
                <dd className="text-slate-200 text-right">
                  {plan.config.tableMax === undefined
                    ? "none"
                    : formatStake(plan.config.tableMax)}
                </dd>
                <dt className="text-slate-500">Bridging</dt>
                <dd className="text-slate-200 text-right">
                  {POLICY_LABELS[plan.strategy.bridgingPolicy]} ·{" "}
                  {Math.round(plan.strategy.recoveryTargetPct * 100)}% recovery
                  · offset {plan.strategy.crossoverOffset}
                </dd>
                <dt className="text-slate-500">First stake</dt>
                <dd className="text-slate-200 text-right">
                  {formatStake(plan.firstStake)} on{" "}
                  {plan.strategy.ladders[plan.config.startingLadder].name}
                </dd>
                <dt className="text-slate-500">Highest stake</dt>
                <dd className="text-slate-200 text-right">
                  {formatStake(plan.highestStake)}
                </dd>
              </dl>

              <div>
                <div className="text-xs text-slate-500 mb-1">Ladders</div>
                <ul className="space-y-1 text-xs text-slate-300">
                  {plan.strategy.ladders.map((ladder) => (
                    <li key={ladder.name}>
                      <span className="text-slate-400">{ladder.name}:</span>{" "}
                      {ladder.stakes.map(formatStake).join(" · ")}
                    </li>
                  ))}
                </ul>
              </div>

              {plan.adjustments.length > 0 && (
                <div role="note" className="text-xs text-amber-200">
                  <div className="font-medium">Adjusted before start</div>
                  <ul className="mt-1 space-y-1">
                    {plan.adjustments.map((adjustment) => (
                      <li key={adjustment.field}>
                        {adjustment.label}: saved {adjustment.saved}, effective{" "}
                        {adjustment.effective}. {adjustment.reason}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {plan.provenance && (
                <div className="border-t border-slate-700 pt-3 text-xs">
                  <div className="font-medium text-slate-200">
                    {plan.provenance.status === "confirmed_for_these_settings"
                      ? "Confirmed for these settings"
                      : "Confirmed for other settings"}
                  </div>
                  <p className="mt-1 text-slate-400">
                    Holdout confirmation: target lower bound{" "}
                    {(plan.provenance.targetLowerBound * 100).toFixed(1)}%,
                    ruin upper bound{" "}
                    {(plan.provenance.ruinUpperBound * 100).toFixed(1)}% at{" "}
                    {Math.round(plan.provenance.confidenceLevel * 100)}%
                    confidence over {plan.provenance.sampleCount} modeled
                    sessions ({plan.provenance.engineVersion}). This is a
                    modeled bound under the confirmed assumptions, not a
                    guarantee.
                  </p>
                  {plan.provenance.mismatches.length > 0 && (
                    <>
                      <p className="mt-2 text-amber-200">
                        The session below differs from the confirmed candidate,
                        so that bound does not apply to it:
                      </p>
                      <ul className="mt-1 space-y-1 text-slate-300">
                        {plan.provenance.mismatches.map((mismatch) => (
                          <li key={mismatch.field}>
                            {mismatch.field}: confirmed {mismatch.confirmed},
                            now {mismatch.current}
                          </li>
                        ))}
                      </ul>
                      {plan.provenance.mismatches.some(
                        (mismatch) => mismatch.field !== "Ladder fingerprint"
                      ) && (
                        <Button
                          variant="secondary"
                          size="sm"
                          className="mt-3"
                          onClick={alignWithProvenance}
                        >
                          Use confirmed settings
                        </Button>
                      )}
                    </>
                  )}
                </div>
              )}

              {blockers.length > 0 && (
                <div role="alert" className="text-xs text-red-300">
                  <div className="font-medium">Cannot start as configured</div>
                  <ul className="mt-1 space-y-1">
                    {blockers.map((blocker) => (
                      <li key={blocker}>{blocker}</li>
                    ))}
                  </ul>
                </div>
              )}
            </Card>
          ) : (
            <Card variant="danger" className="p-4">
              <p role="alert" className="text-xs text-red-200">
                {planError}
              </p>
            </Card>
          )}
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
        {showValidationSummary && !canStart && (
          <p className="text-sm text-red-400" role="alert">
            {hasValidationErrors
              ? "Please fix invalid session settings before starting."
              : planError ??
                "Resolve the effective plan problems above before starting."}
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
