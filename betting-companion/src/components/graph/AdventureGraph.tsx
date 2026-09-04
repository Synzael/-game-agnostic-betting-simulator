"use client";

import { useSessionStore, useSettingsStore } from "@/store";
import {
  classifyVariance,
  interpolateVarianceAtRound,
} from "@/engine/variance-forecast";
import { formatStake } from "@/engine";
import { SessionGraph } from "./SessionGraph";
import { useVarianceForecast } from "./useVarianceForecast";

interface AdventureGraphProps {
  readonly height?: number;
  readonly className?: string;
}

/**
 * Connected wrapper: renders the live adventure graph for the
 * current session. Returns null when no session exists.
 */
export function AdventureGraph({ height = 110, className }: AdventureGraphProps) {
  useVarianceForecast();
  const betHistory = useSessionStore((s) => s.betHistory);
  const sessionEvents = useSessionStore((s) => s.sessionEvents);
  const state = useSessionStore((s) => s.state);
  const stopReason = state?.stopReason ?? null;
  const hasSession = useSessionStore((s) => s.state !== null);
  const forecast = useSessionStore((s) => s.varianceForecast);
  const forecastStatus = useSessionStore((s) => s.forecastStatus);
  const game = useSessionStore((s) => s.game);
  const config = useSessionStore((s) => s.config);
  const showBetNumbers = useSettingsStore((s) => s.showBetNumbers);
  const showVarianceFan =
    useSettingsStore((s) => s.showVarianceFan) ?? true;
  const setShowVarianceFan = useSettingsStore(
    (s) => s.setShowVarianceFan
  );

  if (!hasSession) {
    return null;
  }

  const currentBand =
    forecast && state
      ? interpolateVarianceAtRound(forecast.points, state.rounds)
      : null;
  const classification =
    state && currentBand
      ? classifyVariance(state.pnl, currentBand)
      : null;
  const classificationLabel =
    classification === "within"
      ? "within range"
      : classification === "below"
        ? "below modeled range"
        : classification === "above"
          ? "above modeled range"
          : null;

  return (
    <div className={`card-noir p-3 ${className ?? ""}`}>
      <div className="flex items-center justify-between mb-1 px-1">
        <span className="text-[10px] text-muted uppercase tracking-[0.15em]">
          Adventure
        </span>
        <span className="flex items-center gap-2 text-[9px] text-muted">
          <span className="flex items-center gap-1">
            <span className="w-1.5 h-1.5 rounded-full bg-[var(--emerald)]" />
            Win
          </span>
          <span className="flex items-center gap-1">
            <span className="w-1.5 h-1.5 rounded-full bg-[var(--crimson)]" />
            Loss
          </span>
          <span className="flex items-center gap-1">
            <span className="w-1.5 h-1.5 rounded-full bg-slate-400 ring-1 ring-slate-200" />
            Push
          </span>
        </span>
      </div>
      <div className="mb-1 flex items-center justify-between gap-3 px-1">
        <span className="text-[9px] text-muted">
          {forecastStatus === "modeling" && !forecast
            ? "Modeling expected range…"
            : forecastStatus === "error"
              ? "Modeled range unavailable"
              : forecast
                ? `${forecast.sampleCount.toLocaleString()} simulations · ${forecast.quality}`
                : null}
        </span>
        {forecast && (
          <button
            type="button"
            onClick={() => setShowVarianceFan(!showVarianceFan)}
            className="rounded-full border border-[var(--noir-border)] px-2 py-0.5 text-[9px] text-secondary hover:border-[var(--gold-dim)]"
            aria-pressed={showVarianceFan}
          >
            Range {showVarianceFan ? "on" : "off"}
          </button>
        )}
      </div>
      <SessionGraph
        betHistory={betHistory}
        events={sessionEvents}
        stopReason={stopReason}
        varianceForecast={forecast}
        showVarianceFan={showVarianceFan}
        showBetNumbers={showBetNumbers}
        height={height}
      />
      {currentBand && state && showVarianceFan && (
        <details className="mt-2 border-t border-[var(--noir-border)] px-1 pt-2 text-[10px] text-secondary">
          <summary className="cursor-pointer list-none text-[10px] text-champagne">
            Round {state.rounds}: {formatStake(currentBand.p05)} to{" "}
            {formatStake(currentBand.p95)} · {classificationLabel}
          </summary>
          <div className="mt-2 space-y-1 text-muted">
            <p>
              Current P&amp;L: {state.pnl >= 0 ? "+" : ""}
              {formatStake(state.pnl)}. Modeled P5–P95 range from{" "}
              {forecast?.sampleCount.toLocaleString()} pre-session simulations.
            </p>
            <p>
              Frozen model: {game?.gameDisplayName} ·{" "}
              {game?.betVariant.displayName}; target{" "}
              {config ? formatStake(config.profitTarget) : "—"}, stop{" "}
              {config ? formatStake(config.stopLossAbs) : "—"}.
            </p>
            <p>
              Ended simulations keep their final P&amp;L in later rounds.
              A modeled range is not a guarantee and does not change the
              house edge.
            </p>
          </div>
        </details>
      )}
    </div>
  );
}
