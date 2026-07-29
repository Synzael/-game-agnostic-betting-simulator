"use client";

import { useRouter } from "next/navigation";
import { useSessionStore } from "@/store";
import { formatStake, processBridgingDecision } from "@/engine";
import { BridgingDecision, FrozenGameSnapshot } from "@/engine/types";
import { AdventureGraph } from "@/components/graph";
import {
  DecisionGhostViewState,
  useDecisionGhosts,
} from "./useDecisionGhosts";

export function DecisionScreen() {
  const router = useRouter();
  const state = useSessionStore((s) => s.state);
  const config = useSessionStore((s) => s.config);
  const strategy = useSessionStore((s) => s.strategy);
  const game = useSessionStore((s) => s.game);
  const makeDecision = useSessionStore((s) => s.makeDecision);
  const ghosts = useDecisionGhosts(state, config, strategy, game);

  if (!state || !config || !strategy || !game || !state.awaitingDecision) {
    return null;
  }

  // Derive display values through the production transition so commission
  // cents and canonical rounding cannot drift from the simulation.
  const potentialCarryState = processBridgingDecision(
    state,
    strategy,
    "carry_over"
  );
  const potentialRecoveryTarget = potentialCarryState.recoveryTargetPnl;

  const nextLadderIndex = state.currentLadder + 1;
  const hasNextLadder = nextLadderIndex < strategy.ladders.length;
  const nextLadder = hasNextLadder ? strategy.ladders[nextLadderIndex] : null;
  const nextStake = nextLadder
    ? nextLadder.stakes[Math.min(strategy.crossoverOffset, nextLadder.stakes.length - 1)]
    : 0;

  const handleDecision = (decision: BridgingDecision) => {
    makeDecision(decision);

    // Navigate based on result
    const newState = useSessionStore.getState().state;
    if (newState?.stopped) {
      router.push("/summary");
    } else {
      router.push("/session");
    }
  };

  return (
    <div className="min-h-screen bg-noir p-4 safe-bottom">
      {/* Dramatic Header */}
      <div className="text-center py-8 animate-fadeInUp">
        <div className="inline-flex items-center gap-2 bg-[var(--gold-glow)] border border-[var(--gold-dim)] rounded-full px-4 py-1.5 mb-4">
          <span className="w-2 h-2 rounded-full bg-gold animate-pulse" />
          <span className="text-xs text-gold uppercase tracking-wider font-medium">Decision Point</span>
        </div>
        <h1 className="font-display text-3xl text-champagne mb-3">
          Choose Your Path
        </h1>
        <p className="text-secondary text-sm max-w-xs mx-auto">
          You&apos;ve reached the top of <span className="text-gold">{strategy.ladders[state.currentLadder].name}</span>. What will you do?
        </p>
      </div>

      {/* Adventure Graph */}
      <div className="mb-4 animate-fadeInUp stagger-1">
        <AdventureGraph />
      </div>

      {/* Current Status */}
      <div className="card-noir p-4 mb-8 animate-fadeInUp stagger-1">
        <div className="grid grid-cols-2 gap-6 text-center">
          <div>
            <div className="text-[10px] text-muted uppercase tracking-[0.15em] mb-1">Current P&L</div>
            <div
              className={`font-display text-3xl font-semibold ${
                state.pnl >= 0 ? "pnl-positive" : "pnl-negative"
              }`}
            >
              {state.pnl >= 0 ? "+" : ""}
              {formatStake(state.pnl)}
            </div>
          </div>
          <div>
            <div className="text-[10px] text-muted uppercase tracking-[0.15em] mb-1">Rounds</div>
            <div className="font-display text-3xl text-champagne font-semibold">
              {state.rounds}
            </div>
          </div>
        </div>
      </div>

      <DecisionGhostStatus ghosts={ghosts} round={state.rounds} />

      {/* Decision Cards - Roguelike Style */}
      <div className="space-y-4">
        {/* Carry Over */}
        {hasNextLadder && (
          <button
            onClick={() => handleDecision("carry_over")}
            className="decision-card carry-over w-full text-left animate-fadeInUp stagger-2"
          >
            <div className="flex items-start gap-4">
              <div className="w-12 h-12 rounded-xl bg-[var(--emerald)]/20 flex items-center justify-center flex-shrink-0">
                <svg className="w-6 h-6 text-[var(--emerald)]" fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M11.3 1.046A1 1 0 0112 2v5h4a1 1 0 01.82 1.573l-7 10A1 1 0 018 18v-5H4a1 1 0 01-.82-1.573l7-10a1 1 0 011.12-.38z" clipRule="evenodd" />
                </svg>
              </div>
              <div className="flex-1 min-w-0">
                <h3 className="font-display text-xl text-[var(--emerald)] mb-1">Carry Over</h3>
                <p className="text-sm text-secondary mb-3">Enter recovery mode and continue fighting</p>
                <div className="space-y-1 text-xs">
                  <div className="flex items-center gap-2 text-champagne">
                    <span className="text-[var(--emerald)]">→</span>
                    Move to {nextLadder?.name} at {formatStake(nextStake)}
                  </div>
                  <div className="flex items-center gap-2 text-champagne">
                    <span className="text-[var(--emerald)]">→</span>
                    Recovery target: {formatStake(potentialRecoveryTarget)}
                  </div>
                  <div className="text-[var(--emerald)] mt-2 font-medium">
                    Reach target to reset to L1
                  </div>
                </div>
                <GhostBranchMetrics
                  ghosts={ghosts}
                  branch="carry_over"
                  recoveryTarget={potentialRecoveryTarget}
                />
              </div>
            </div>
          </button>
        )}

        {/* Write Off */}
        <button
          onClick={() => handleDecision("write_off")}
          className="decision-card write-off w-full text-left animate-fadeInUp stagger-3"
        >
          <div className="flex items-start gap-4">
            <div className="w-12 h-12 rounded-xl bg-[var(--amber)]/20 flex items-center justify-center flex-shrink-0">
              <svg className="w-6 h-6 text-[var(--amber)]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
            </div>
            <div className="flex-1 min-w-0">
              <h3 className="font-display text-xl text-[var(--amber)] mb-1">Write Off</h3>
              <p className="text-sm text-secondary mb-3">Accept the loss and reset to start</p>
              <div className="space-y-1 text-xs">
                <div className="flex items-center gap-2 text-champagne">
                  <span className="text-[var(--amber)]">→</span>
                  Reset to {strategy.ladders[0].name}[1]
                </div>
                <div className="flex items-center gap-2 text-champagne">
                  <span className="text-[var(--amber)]">→</span>
                  Keep current PnL: {formatStake(state.pnl)}
                </div>
                <div className="text-[var(--amber)] mt-2 font-medium">
                  Fresh start from bottom
                </div>
              </div>
              <GhostBranchMetrics
                ghosts={ghosts}
                branch="write_off"
                currentPnl={state.pnl}
              />
            </div>
          </div>
        </button>

        {/* Stop Session */}
        <button
          onClick={() => handleDecision("stop_session")}
          className="decision-card stop-session w-full text-left animate-fadeInUp stagger-4"
        >
          <div className="flex items-start gap-4">
            <div className="w-12 h-12 rounded-xl bg-[var(--crimson)]/20 flex items-center justify-center flex-shrink-0">
              <svg className="w-6 h-6 text-[var(--crimson)]" fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8 7a1 1 0 00-1 1v4a1 1 0 001 1h4a1 1 0 001-1V8a1 1 0 00-1-1H8z" clipRule="evenodd" />
              </svg>
            </div>
            <div className="flex-1 min-w-0">
              <h3 className="font-display text-xl text-[var(--crimson)] mb-1">Stop Session</h3>
              <p className="text-sm text-secondary mb-3">End the session and tally results</p>
              <div className="space-y-1 text-xs">
                <div className="flex items-center gap-2 text-champagne">
                  <span className="text-[var(--crimson)]">→</span>
                  Final PnL: {formatStake(state.pnl)}
                </div>
                <div className="flex items-center gap-2 text-champagne">
                  <span className="text-[var(--crimson)]">→</span>
                  Rounds played: {state.rounds}
                </div>
                <div className="text-[var(--crimson)] mt-2 font-medium">
                  Session complete
                </div>
              </div>
              <div className="mt-4 border-t border-white/10 pt-3">
                <div className="text-[10px] uppercase tracking-[0.14em] text-[var(--crimson)]">
                  Exact outcome
                </div>
                <div className="mt-1 text-sm text-champagne">
                  Ends now at {formatStake(state.pnl)}
                </div>
              </div>
            </div>
          </div>
        </button>
      </div>

      <details className="card-noir mt-5 px-4 py-3 text-xs text-secondary">
        <summary className="cursor-pointer text-champagne">
          How these futures are modeled
        </summary>
        <div className="mt-3 space-y-2 leading-relaxed">
          <p>
            Each choice uses matched, local Monte Carlo paths from round{" "}
            {state.rounds} and the exact P&amp;L, ladder, recovery state, bankroll,
            target, and stop loss shown here.
          </p>
          <p>
            Assumption:{" "}
            {describeModelledGame(ghosts.forecast?.game ?? game)}. Later bridge
            points follow the frozen strategy policy.
          </p>
          <p>
            Simulations are estimates, not guarantees, and do not change the
            house edge. No choice is automatically recommended.
          </p>
        </div>
      </details>
    </div>
  );
}

function DecisionGhostStatus({
  ghosts,
  round,
}: {
  ghosts: DecisionGhostViewState;
  round: number;
}) {
  const statusText = (() => {
    switch (ghosts.status) {
      case "loading":
        return `Reading ${ghosts.completedSamples.toLocaleString()} of ${ghosts.totalSamples.toLocaleString()} matched futures…`;
      case "preview":
        return `Preview from ${ghosts.forecast?.sampleCount.toLocaleString()} paths · refining ${ghosts.completedSamples.toLocaleString()} / ${ghosts.totalSamples.toLocaleString()}`;
      case "ready":
        return `${ghosts.forecast?.sampleCount.toLocaleString()} matched paths from round ${round}`;
      case "error":
        return "Forecast unavailable — choices still work";
      default:
        return "Preparing futures…";
    }
  })();

  return (
    <div
      className="card-gold p-4 mb-5 animate-fadeInUp stagger-2"
      role="status"
      aria-live="polite"
      data-testid="decision-ghost-status"
    >
      <div className="flex items-center gap-3">
        <div className="w-9 h-9 rounded-full bg-[var(--gold-glow)] border border-[var(--gold-dim)] flex items-center justify-center">
          <svg
            className="w-5 h-5 text-gold"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={1.5}
              d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z"
            />
            <circle cx="12" cy="12" r="2.5" strokeWidth={1.5} />
          </svg>
        </div>
        <div>
          <div className="text-[10px] text-gold uppercase tracking-[0.18em]">
            Decision Ghosts
          </div>
          <div className="text-xs text-secondary mt-0.5">{statusText}</div>
        </div>
      </div>
    </div>
  );
}

function GhostBranchMetrics({
  ghosts,
  branch,
  recoveryTarget,
  currentPnl,
}: {
  ghosts: DecisionGhostViewState;
  branch: "carry_over" | "write_off";
  recoveryTarget?: number;
  currentPnl?: number;
}) {
  if (ghosts.status === "error") {
    return (
      <div className="mt-4 border-t border-white/10 pt-3 text-xs text-secondary">
        Forecast unavailable. You can still choose this path.
      </div>
    );
  }

  if (!ghosts.forecast) {
    return (
      <div
        className="mt-4 border-t border-white/10 pt-3 space-y-2"
        aria-label="Forecast loading"
      >
        <div className="h-3 w-3/4 rounded bg-white/10 animate-pulse" />
        <div className="h-3 w-2/3 rounded bg-white/10 animate-pulse" />
      </div>
    );
  }

  if (branch === "carry_over") {
    const forecast = ghosts.forecast.carryOver;
    return (
      <div
        className="mt-4 border-t border-white/10 pt-3"
        data-testid="carry-over-ghost"
      >
        <div className="text-[10px] uppercase tracking-[0.14em] text-[var(--emerald)]">
          Ghost forecast
        </div>
        <div className="mt-1 text-sm text-champagne">
          {formatProbability(forecast.probReachRecoveryMark ?? 0)} recover to{" "}
          {formatStake(recoveryTarget ?? 0)}
        </div>
        <div className="mt-1 text-xs text-secondary">
          Median further drop{" "}
          {formatStake(forecast.medianAdditionalDrawdown)}
        </div>
      </div>
    );
  }

  const forecast = ghosts.forecast.writeOff;
  return (
    <div
      className="mt-4 border-t border-white/10 pt-3"
      data-testid="write-off-ghost"
    >
      <div className="text-[10px] uppercase tracking-[0.14em] text-[var(--amber)]">
        Ghost forecast
      </div>
      <div className="mt-1 text-sm text-champagne">
        {formatProbability(forecast.probHitTarget)} reach the session target
      </div>
      <div className="mt-1 text-xs text-secondary">
        Current P&amp;L stays {formatStake(currentPnl ?? 0)}
      </div>
    </div>
  );
}

/**
 * Names the game the forecast actually simulated. Falls back to the session's
 * own frozen snapshot while loading or after a worker error, so the disclosure
 * can never describe a different game than the one being played.
 */
function describeModelledGame(
  game: FrozenGameSnapshot | null | undefined
): string {
  if (!game) return "the session's frozen game model";
  return `${game.gameDisplayName} · ${game.betVariant.displayName}`;
}

/**
 * Rounding alone would report a rare outcome as impossible and a near-certain
 * one as guaranteed. Only an exact 0 or 1 may be shown as such.
 */
function formatProbability(probability: number): string {
  if (probability > 0 && probability < 0.005) return "<1%";
  if (probability < 1 && probability > 0.995) return ">99%";
  return `${Math.round(probability * 100)}%`;
}
