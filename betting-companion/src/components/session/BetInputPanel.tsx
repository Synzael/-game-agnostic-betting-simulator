"use client";

import { useSessionStore } from "@/store";
import { formatStake } from "@/engine";

export function BetInputPanel() {
  const state = useSessionStore((s) => s.state);
  const game = useSessionStore((s) => s.game);
  const betHistory = useSessionStore((s) => s.betHistory);
  const recordOutcome = useSessionStore((s) => s.recordOutcome);
  const getCurrentStake = useSessionStore((s) => s.getCurrentStake);
  const isDecisionPending = useSessionStore((s) => s.isDecisionPending);

  if (!state || !game || state.stopped || isDecisionPending()) {
    return null;
  }

  const stake = getCurrentStake();
  const lastBet = betHistory[betHistory.length - 1];
  const lastWasPush = lastBet?.progressionEffect === "neutral";
  const outcomes = game.betVariant.outcomes;

  return (
    <div className="p-6 safe-bottom">
      {lastWasPush && (
        <div
          className="mb-5 rounded-xl border border-slate-500/60 bg-slate-700/30 px-4 py-3 text-center text-sm text-slate-200"
          role="status"
        >
          Push — stake unchanged, ladder held.
        </div>
      )}

      {/* Current Stake Display */}
      <div className="text-center mb-8">
        <span className="text-xs text-secondary uppercase tracking-[0.2em] font-medium">
          Current Stake
        </span>
        <div className="stake-display mt-2">
          {formatStake(stake)}
        </div>
      </div>

      {/* Decorative divider */}
      <div className="divider-gold mb-8 opacity-50" />

      {/* Outcome Buttons */}
      {/* Paired win/loss buttons; a neutral outcome spans the trailing row.
          A game with a different outcome shape would need a derived layout. */}
      <div className="grid gap-4 grid-cols-2">
        {outcomes.map((outcome) => (
          <button
            key={outcome.id}
            onClick={() => recordOutcome(outcome.id)}
            className={`btn-stakes h-28 px-2 text-xl font-bold tracking-wider relative overflow-hidden group ${
              outcome.progressionEffect === "win"
                ? "btn-win"
                : outcome.progressionEffect === "loss"
                  ? "btn-loss"
                  : "btn-neutral col-span-2 h-20"
            }`}
          >
            <span className="relative z-10 uppercase">
              {outcome.displayName}
            </span>
            <div className="absolute inset-0 bg-white/10 translate-y-full group-hover:translate-y-0 transition-transform duration-300" />
          </button>
        ))}
      </div>

      {/* Hint text */}
      <p className="text-center text-xs text-muted mt-6 tracking-wide">
        {game.gameDisplayName} · {game.betVariant.displayName}
      </p>
    </div>
  );
}
