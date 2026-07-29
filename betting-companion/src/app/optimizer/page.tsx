"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Button, Card, NumberInput } from "@/components/ui";
import {
  createGameSnapshot,
  expectedReturnPerUnit,
  formatStake,
  getAllGames,
} from "@/engine";
import {
  estimateSearchCardinality,
  validateOptimizerInput,
  type OptimizerJobInput,
  type OptimizerResult,
} from "@/engine/optimizer";
import {
  OptimizerCoordinator,
  type OptimizerCoordinatorCallbacks,
  type OptimizerProgress,
  type OptimizerRunSummary,
} from "@/engine/optimizer-coordinator";
import {
  loadLatestOptimizerCheckpoint,
  type OptimizerCheckpoint,
} from "@/engine/optimizer-storage";
import { useCustomPresetStore } from "@/store";

type View = "configure" | "review" | "running" | "results";

export default function OptimizerPage() {
  const games = getAllGames();
  const [gameId, setGameId] = useState(games[0].id);
  const selectedGame = games.find((game) => game.id === gameId) ?? games[0];
  const [variantId, setVariantId] = useState(
    selectedGame.betVariants[0].id
  );
  const selectedVariant =
    selectedGame.betVariants.find((variant) => variant.id === variantId) ??
    selectedGame.betVariants[0];
  const [view, setView] = useState<View>("configure");
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<OptimizerProgress | null>(null);
  const [summary, setSummary] = useState<OptimizerRunSummary | null>(null);
  const [jobStatus, setJobStatus] = useState<
    "idle" | "running" | "paused" | "cancelled" | "complete" | "failed"
  >("idle");
  const [checkpoint, setCheckpoint] =
    useState<OptimizerCheckpoint | null>(null);
  const [activeInput, setActiveInput] = useState<OptimizerJobInput | null>(
    null
  );
  const [savedCandidate, setSavedCandidate] = useState<string | null>(null);
  const [presetName, setPresetName] = useState("Ladder Lab 1");
  const coordinatorRef = useRef<OptimizerCoordinator | null>(null);
  const saveOptimizerPreset = useCustomPresetStore(
    (state) => state.saveOptimizerPreset
  );

  const [objective, setObjective] = useState({
    bankroll: 5_000,
    profitTarget: 250,
    stopLossAbs: 1_000,
    maxRounds: 300,
    tableMax: 500,
    ruinTolerancePct: 20,
    confidencePct: 95,
  });
  const [space, setSpace] = useState({
    minLadders: 1,
    maxLadders: 2,
    minSteps: 3,
    maxSteps: 5,
    minimumStake: 5,
    maximumStake: 500,
  });
  const defaultConcurrency =
    typeof navigator === "undefined"
      ? 1
      : Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1));
  const [concurrency, setConcurrency] = useState(defaultConcurrency);

  const input: OptimizerJobInput = {
      searchSpace: {
        ladderCount: { min: space.minLadders, max: space.maxLadders },
        stepsPerLadder: { min: space.minSteps, max: space.maxSteps },
        minimumStake: space.minimumStake,
        maximumStake: space.maximumStake,
        allowedStakeIncrements: [5, 10],
        maxGrowthRatio: 3,
        allowedPolicies: [
          "carry_over_index_delta",
          "advance_to_next_ladder_start",
        ],
        recoveryTargetPctValues: [0.25, 0.5],
        crossoverOffsets: [0, 1],
      },
      objective: {
        bankroll: objective.bankroll,
        profitTarget: objective.profitTarget,
        stopLossAbs: objective.stopLossAbs,
        maxRounds: objective.maxRounds,
        tableMax: objective.tableMax,
        ruinTolerance: objective.ruinTolerancePct / 100,
        confidenceLevel: objective.confidencePct / 100,
      },
      game: createGameSnapshot(selectedGame.id, selectedVariant.id),
      explorationSamples: 120,
      confirmationSamples: 600,
      seed: 0x4c414231,
      concurrency,
    };
  const cardinality = estimateSearchCardinality(input.searchSpace);

  useEffect(() => {
    void loadLatestOptimizerCheckpoint()
      .then((latest) => {
        if (
          latest &&
          latest.status !== "complete" &&
          latest.status !== "cancelled"
        ) {
          setCheckpoint(latest);
        }
      })
      .catch(() => {
        // IndexedDB is optional for starting a fresh in-memory job.
      });
  }, []);

  useEffect(
    () => () => {
      // Leaving the route is not the same as cancelling the job: detach keeps
      // the checkpoint resumable so the banner offers it on return.
      coordinatorRef.current?.detach();
    },
    []
  );

  const callbacks: OptimizerCoordinatorCallbacks = {
    onProgress: setProgress,
    onStatus: (status) => setJobStatus(status),
  };

  const review = () => {
    try {
      validateOptimizerInput(input);
      setError(null);
      setView("review");
    } catch (validationError) {
      setError(
        validationError instanceof Error
          ? validationError.message
          : "Invalid optimizer input"
      );
    }
  };

  const run = async (
    runInput: OptimizerJobInput,
    resumeFrom?: OptimizerCheckpoint
  ) => {
    setError(null);
    setSummary(null);
    setActiveInput(runInput);
    setView("running");
    setJobStatus("running");
    const coordinator = new OptimizerCoordinator(
      runInput,
      callbacks,
      resumeFrom?.jobId
    );
    coordinatorRef.current = coordinator;
    try {
      const completed = await coordinator.run(resumeFrom);
      setSummary(completed);
      setCheckpoint(null);
      setView("results");
    } catch (runError) {
      if (coordinatorRef.current === coordinator) {
        const message =
          runError instanceof Error ? runError.message : "Optimizer failed";
        setError(message);
        if (/cancelled/i.test(message)) {
          setJobStatus("cancelled");
        } else {
          setJobStatus("failed");
        }
      }
    }
  };

  const saveResult = (result: OptimizerResult) => {
    if (!activeInput) return;
    try {
      saveOptimizerPreset(presetName, result, activeInput);
      setSavedCandidate(result.candidate.fingerprint);
      setError(null);
    } catch (saveError) {
      setError(
        saveError instanceof Error ? saveError.message : "Preset save failed"
      );
    }
  };

  return (
    <div className="min-h-screen bg-noir p-4 safe-bottom">
      <header className="mx-auto mb-6 flex max-w-2xl items-center justify-between">
        <div>
          <Link href="/" className="text-sm text-secondary hover:text-white">
            &larr; Home
          </Link>
          <h1 className="mt-1 font-display text-3xl text-champagne">
            Ladder Lab
          </h1>
          <p className="text-xs text-muted">
            Local search under a fixed simulated ruin tolerance
          </p>
        </div>
        <span className="rounded-full border border-[var(--gold-dim)] px-3 py-1 text-[10px] uppercase tracking-wider text-gold">
          Atelier
        </span>
      </header>

      <main className="mx-auto max-w-2xl space-y-4">
        {checkpoint && view === "configure" && (
          <Card variant="warning">
            <h2 className="font-display text-lg text-amber-200">
              Interrupted job found
            </h2>
            <p className="mt-1 text-sm text-secondary">
              Resume from its last complete batch. No raw path traces are
              stored.
            </p>
            <Button
              className="mt-4"
              size="sm"
              onClick={() => void run(checkpoint.input, checkpoint)}
            >
              Resume Saved Job
            </Button>
          </Card>
        )}

        {view === "configure" && (
          <>
            <Section title="1 · Fixed assumptions">
              <div className="grid gap-3 sm:grid-cols-2">
                <NumberInput
                  label="Bankroll"
                  prefix="$"
                  value={objective.bankroll}
                  min={1}
                  onChange={(bankroll) =>
                    setObjective((current) => ({ ...current, bankroll }))
                  }
                />
                <NumberInput
                  label="Profit target"
                  prefix="$"
                  value={objective.profitTarget}
                  min={1}
                  onChange={(profitTarget) =>
                    setObjective((current) => ({
                      ...current,
                      profitTarget,
                    }))
                  }
                />
                <NumberInput
                  label="Stop loss"
                  prefix="$"
                  value={objective.stopLossAbs}
                  min={1}
                  onChange={(stopLossAbs) =>
                    setObjective((current) => ({
                      ...current,
                      stopLossAbs,
                    }))
                  }
                />
                <NumberInput
                  label="Table max"
                  prefix="$"
                  value={objective.tableMax}
                  min={1}
                  onChange={(tableMax) =>
                    setObjective((current) => ({ ...current, tableMax }))
                  }
                />
                <NumberInput
                  label="Max rounds"
                  value={objective.maxRounds}
                  min={1}
                  max={10_000}
                  onChange={(maxRounds) =>
                    setObjective((current) => ({ ...current, maxRounds }))
                  }
                />
                <NumberInput
                  label="Ruin tolerance"
                  value={objective.ruinTolerancePct}
                  min={0.1}
                  max={99}
                  step={0.1}
                  hint="Percent; feasibility uses its confidence upper bound"
                  onChange={(ruinTolerancePct) =>
                    setObjective((current) => ({
                      ...current,
                      ruinTolerancePct,
                    }))
                  }
                />
              </div>
              <div className="mt-4 grid gap-2 sm:grid-cols-3">
                {games.map((game) => (
                  <Card
                    key={game.id}
                    interactive
                    selected={game.id === selectedGame.id}
                    className="p-3"
                    onClick={() => {
                      setGameId(game.id);
                      setVariantId(game.betVariants[0].id);
                    }}
                  >
                    <div className="text-sm text-white">{game.displayName}</div>
                  </Card>
                ))}
              </div>
              {selectedGame.betVariants.length > 1 && (
                <select
                  value={selectedVariant.id}
                  onChange={(event) => setVariantId(event.target.value)}
                  className="mt-3 w-full rounded-lg border border-slate-700 bg-slate-800 p-3 text-sm text-white"
                  aria-label="Bet variant"
                >
                  {selectedGame.betVariants.map((variant) => (
                    <option key={variant.id} value={variant.id}>
                      {variant.displayName}
                    </option>
                  ))}
                </select>
              )}
            </Section>

            <Section title="2 · Constrained search space">
              <div className="grid gap-3 sm:grid-cols-2">
                <NumberInput
                  label="Minimum ladders"
                  value={space.minLadders}
                  min={1}
                  max={5}
                  onChange={(minLadders) =>
                    setSpace((current) => ({ ...current, minLadders }))
                  }
                />
                <NumberInput
                  label="Maximum ladders"
                  value={space.maxLadders}
                  min={1}
                  max={5}
                  onChange={(maxLadders) =>
                    setSpace((current) => ({ ...current, maxLadders }))
                  }
                />
                <NumberInput
                  label="Minimum steps"
                  value={space.minSteps}
                  min={1}
                  max={12}
                  onChange={(minSteps) =>
                    setSpace((current) => ({ ...current, minSteps }))
                  }
                />
                <NumberInput
                  label="Maximum steps"
                  value={space.maxSteps}
                  min={1}
                  max={12}
                  onChange={(maxSteps) =>
                    setSpace((current) => ({ ...current, maxSteps }))
                  }
                />
                <NumberInput
                  label="Minimum stake"
                  prefix="$"
                  value={space.minimumStake}
                  min={0.01}
                  step={0.01}
                  onChange={(minimumStake) =>
                    setSpace((current) => ({ ...current, minimumStake }))
                  }
                />
                <NumberInput
                  label="Maximum stake"
                  prefix="$"
                  value={space.maximumStake}
                  min={0.01}
                  step={0.01}
                  onChange={(maximumStake) =>
                    setSpace((current) => ({ ...current, maximumStake }))
                  }
                />
                <NumberInput
                  label="Worker concurrency"
                  value={concurrency}
                  min={1}
                  max={4}
                  onChange={setConcurrency}
                  hint="Capped at four workers"
                />
              </div>
              <p className="mt-4 text-sm text-secondary">
                Estimated {cardinality.toLocaleString()} canonical candidates ·{" "}
                {cardinality <= 256 ? "exhaustive grid" : "seeded evolutionary"}{" "}
                exploration.
              </p>
            </Section>
            <Button fullWidth size="lg" onClick={review}>
              Review Job
            </Button>
          </>
        )}

        {view === "review" && (
          <Section title="3 · Review">
            <div className="space-y-3 text-sm text-secondary">
              <Assumption
                label="Objective"
                value={`${formatStake(objective.profitTarget)} target at ${(objective.ruinTolerancePct).toFixed(1)}% simulated ruin tolerance`}
              />
              <Assumption
                label="Game"
                value={`${selectedGame.displayName} · ${selectedVariant.displayName}`}
              />
              <Assumption
                label="Horizon"
                value={`${objective.maxRounds} rounds; ${formatStake(objective.stopLossAbs)} stop; ${formatStake(objective.tableMax)} table max`}
              />
              <Assumption
                label="Monte Carlo"
                value={`${input.explorationSamples} shared-seed exploration paths, then ${input.confirmationSamples} independent holdout paths per finalist`}
              />
              <Assumption
                label="Expected return"
                value={`${(expectedReturnPerUnit(input.game) * 100).toFixed(3)}% per unit under the frozen module`}
              />
            </div>
            <div className="mt-5 rounded-xl border border-amber-700/60 bg-amber-950/30 p-4 text-sm text-amber-100">
              Every candidate retains the selected game assumptions. The Lab
              ranks simulated trade-offs; it does not remove a house edge or
              make future outcomes safe.
            </div>
            <div className="mt-5 grid grid-cols-2 gap-3">
              <Button variant="secondary" onClick={() => setView("configure")}>
                Back
              </Button>
              <Button onClick={() => void run(input)}>Start Local Search</Button>
            </div>
          </Section>
        )}

        {view === "running" && (
          <Section title="4 · Computing locally">
            <div className="mb-4 flex items-end justify-between">
              <div>
                <div className="text-xs uppercase tracking-wider text-muted">
                  {progress?.stage ?? "starting"}
                </div>
                <div className="font-display text-3xl text-gold">
                  {progress?.evaluated ?? 0} / {progress?.total ?? cardinality}
                </div>
              </div>
              <div className="text-right text-xs text-secondary">
                {((progress?.activeComputeMs ?? 0) / 1000).toFixed(1)}s active
                compute
              </div>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-slate-800">
              <div
                className="h-full bg-[var(--gold)] transition-[width]"
                style={{
                  width: `${Math.min(
                    100,
                    ((progress?.evaluated ?? 0) /
                      Math.max(1, progress?.total ?? cardinality)) *
                      100
                  )}%`,
                }}
              />
            </div>
            {progress?.best && (
              <div className="mt-4 rounded-xl bg-slate-800/60 p-4 text-sm text-secondary">
                Best {progress.stage === "confirmation" ? "confirmed" : "provisional"}:
                target lower bound{" "}
                {(progress.best.target.lower * 100).toFixed(1)}%, ruin upper
                bound {(progress.best.ruin.upper * 100).toFixed(1)}%.
              </div>
            )}
            {progress?.storageError && (
              <p className="mt-3 text-xs text-amber-300">
                Checkpoint unavailable: {progress.storageError}
              </p>
            )}
            <div className="mt-5 grid grid-cols-2 gap-3">
              <Button
                variant="secondary"
                onClick={() => {
                  if (jobStatus === "paused") coordinatorRef.current?.resume();
                  else coordinatorRef.current?.pause();
                }}
              >
                {jobStatus === "paused" ? "Resume" : "Pause"}
              </Button>
              <Button
                variant="danger"
                onClick={() => coordinatorRef.current?.cancel()}
              >
                Cancel
              </Button>
            </div>
          </Section>
        )}

        {view === "results" && summary && (
          <>
            <Section title="5 · Confirmed frontier">
              <p className="text-sm text-secondary">
                {summary.feasibleResults.length > 0
                  ? `${summary.feasibleResults.length} finalist(s) remained within the selected simulated risk tolerance on independent holdout seeds.`
                  : "No feasible candidate found. No least-bad candidate is labeled feasible."}
              </p>
              <p className="mt-2 text-xs text-muted">
                {summary.algorithm} exploration ·{" "}
                {(summary.activeComputeMs / 1000).toFixed(1)}s active compute ·
                fixed {activeInput?.game.gameDisplayName} assumptions
              </p>
            </Section>

            <div className="space-y-3">
              {summary.results.map((result, index) => (
                <Card
                  key={result.candidate.fingerprint}
                  variant={result.feasible ? "success" : "danger"}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="text-xs uppercase tracking-wider text-muted">
                        Candidate {index + 1}
                      </div>
                      <h2 className="font-display text-xl text-champagne">
                        {result.candidate.shape.ladderCount} ladder(s) ·{" "}
                        {result.candidate.shape.stepsPerLadder} steps each
                      </h2>
                    </div>
                    <span className="rounded-full border border-current px-2 py-1 text-[10px] uppercase">
                      {result.feasible ? "Within tolerance" : "Holdout failed"}
                    </span>
                  </div>
                  <div className="mt-4 grid grid-cols-2 gap-3 text-sm">
                    <Metric
                      label="P(target)"
                      value={`${(result.confirmation.target.point * 100).toFixed(1)}%`}
                      detail={`${(result.confirmation.target.lower * 100).toFixed(1)}–${(result.confirmation.target.upper * 100).toFixed(1)}%`}
                    />
                    <Metric
                      label="P(ruin)"
                      value={`${(result.confirmation.ruin.point * 100).toFixed(1)}%`}
                      detail={`${(result.confirmation.ruin.lower * 100).toFixed(1)}–${(result.confirmation.ruin.upper * 100).toFixed(1)}%`}
                    />
                    <Metric
                      label="Median max stake"
                      value={formatStake(result.confirmation.medianMaxStake)}
                    />
                    <Metric
                      label="Median drawdown"
                      value={formatStake(
                        result.confirmation.medianMaxDrawdown
                      )}
                    />
                  </div>
                  <details className="mt-4 text-xs text-secondary">
                    <summary className="cursor-pointer text-champagne">
                      Exact ladders and policy
                    </summary>
                    <div className="mt-2 space-y-1">
                      {result.candidate.strategy.ladders.map((ladder) => (
                        <p key={ladder.name}>
                          {ladder.name}: {ladder.stakes.map(formatStake).join(" · ")}
                        </p>
                      ))}
                      <p>
                        {result.candidate.strategy.bridgingPolicy} ·{" "}
                        {result.candidate.strategy.recoveryTargetPct * 100}%
                        recovery · offset{" "}
                        {result.candidate.strategy.crossoverOffset}
                      </p>
                    </div>
                  </details>
                  {result.feasible && (
                    <div className="mt-4 flex flex-col gap-2 sm:flex-row">
                      <input
                        value={presetName}
                        onChange={(event) => setPresetName(event.target.value)}
                        aria-label="Custom preset name"
                        className="min-w-0 flex-1 rounded-lg border border-slate-600 bg-slate-900 px-3 py-2 text-sm text-white"
                      />
                      <Button size="sm" onClick={() => saveResult(result)}>
                        {savedCandidate === result.candidate.fingerprint
                          ? "Saved"
                          : "Save as custom preset"}
                      </Button>
                    </div>
                  )}
                </Card>
              ))}
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Button
                variant="secondary"
                onClick={() => {
                  setView("configure");
                  setSummary(null);
                }}
              >
                New Search
              </Button>
              <Link href="/setup">
                <Button fullWidth>Open Setup</Button>
              </Link>
            </div>
          </>
        )}

        {error && (
          <div role="alert" className="rounded-xl border border-red-700 bg-red-950/40 p-4 text-sm text-red-200">
            {error}
          </div>
        )}
      </main>
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <Card>
      <h2 className="mb-4 text-xs uppercase tracking-[0.16em] text-gold">
        {title}
      </h2>
      {children}
    </Card>
  );
}

function Assumption({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4 border-b border-slate-800 pb-2">
      <span className="text-muted">{label}</span>
      <span className="text-right text-champagne">{value}</span>
    </div>
  );
}

function Metric({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail?: string;
}) {
  return (
    <div className="rounded-xl bg-slate-900/50 p-3">
      <div className="text-[10px] uppercase tracking-wider text-muted">
        {label}
      </div>
      <div className="font-display text-lg text-champagne">{value}</div>
      {detail && <div className="text-[10px] text-muted">{detail} interval</div>}
    </div>
  );
}
