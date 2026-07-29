"use client";

import { useId } from "react";
import {
  BetRecord,
  SessionEvent,
  StopReason,
  VarianceForecast,
} from "@/engine/types";
import { formatStake } from "@/engine";
import { buildGraphModel } from "./graph-model";

interface SessionGraphProps {
  readonly betHistory: readonly BetRecord[];
  readonly events?: readonly SessionEvent[];
  readonly stopReason?: StopReason;
  readonly varianceForecast?: VarianceForecast | null;
  readonly showVarianceFan?: boolean;
  readonly showBetNumbers: boolean;
  readonly height?: number;
  readonly className?: string;
}

const VIRTUAL_WIDTH = 360;

const EVENT_COLORS: Record<SessionEvent["type"], string> = {
  carry_over: "var(--gold)",
  write_off: "var(--amber)",
};

const STOP_REASON_COLORS: Record<NonNullable<StopReason>, string> = {
  profit_target: "var(--emerald)",
  stop_loss: "var(--crimson)",
  bankroll_exhausted: "var(--crimson)",
  table_limit: "var(--crimson)",
  user_stopped: "var(--gold)",
  max_rounds: "var(--amber)",
};

const OUTCOME_COLORS = {
  win: "var(--emerald)",
  loss: "var(--crimson)",
  neutral: "#94a3b8",
} as const;

export function SessionGraph({
  betHistory,
  events = [],
  stopReason = null,
  varianceForecast = null,
  showVarianceFan = true,
  showBetNumbers,
  height = 110,
  className,
}: SessionGraphProps) {
  const clipId = `fan-clip-${useId().replace(/:/g, "")}`;
  const model = buildGraphModel(
    betHistory,
    events,
    stopReason,
    VIRTUAL_WIDTH,
    height,
    varianceForecast?.points,
    showVarianceFan
  );

  const pnlLabel = model.isEmpty
    ? "No bets yet"
    : `P&L ${model.finalPnl >= 0 ? "+" : ""}${formatStake(model.finalPnl)} after ${betHistory.length} bets`;

  return (
    <svg
      viewBox={`0 0 ${VIRTUAL_WIDTH} ${height}`}
      width="100%"
      height={height}
      preserveAspectRatio="none"
      role="img"
      aria-label={`Adventure graph: ${pnlLabel}`}
      className={className}
      data-testid="session-graph"
    >
      <defs>
        <clipPath id={clipId}>
          <rect x={12} y={16} width={VIRTUAL_WIDTH - 24} height={height - 32} />
        </clipPath>
        <pattern
          id={`${clipId}-pattern`}
          width="6"
          height="6"
          patternUnits="userSpaceOnUse"
        >
          <path
            d="M 0 6 L 6 0"
            stroke="var(--gold)"
            strokeWidth="0.5"
            opacity="0.18"
          />
        </pattern>
      </defs>

      {model.variance && (
        <g clipPath={`url(#${clipId})`} data-testid="variance-fan">
          <path
            d={model.variance.outerBandPath}
            fill={`url(#${clipId}-pattern)`}
            stroke="var(--gold-dim)"
            strokeWidth={0.7}
            strokeDasharray="3 3"
            opacity={0.62}
            vectorEffect="non-scaling-stroke"
            data-testid="variance-outer"
          />
          <path
            d={model.variance.innerBandPath}
            fill="var(--gold)"
            stroke="none"
            opacity={0.12}
            data-testid="variance-inner"
          />
          <polyline
            points={model.variance.medianPoints}
            fill="none"
            stroke="var(--champagne)"
            strokeWidth={0.9}
            strokeDasharray="5 4"
            opacity={0.75}
            vectorEffect="non-scaling-stroke"
            data-testid="variance-median"
          />
        </g>
      )}

      {/* Zero baseline */}
      <line
        x1={0}
        y1={model.zeroLineY}
        x2={VIRTUAL_WIDTH}
        y2={model.zeroLineY}
        stroke="var(--noir-border)"
        strokeWidth={1}
        strokeDasharray="3 4"
        vectorEffect="non-scaling-stroke"
      />

      {model.isEmpty ? (
        <text
          x={VIRTUAL_WIDTH / 2}
          y={model.zeroLineY - 8}
          textAnchor="middle"
          fontSize={10}
          fill="var(--noir-border)"
          className="font-display uppercase tracking-widest"
        >
          No bets yet
        </text>
      ) : (
        <>
          {/* Event markers behind the line: vertical tick + diamond */}
          {model.eventMarkers.map((marker, index) => (
            <g key={`event-${index}`} data-testid={`event-${marker.type}`}>
              <line
                x1={marker.x}
                y1={6}
                x2={marker.x}
                y2={height - 6}
                stroke={EVENT_COLORS[marker.type]}
                strokeWidth={1}
                strokeDasharray="2 3"
                opacity={0.6}
              />
              <rect
                x={-3.2}
                y={-3.2}
                width={6.4}
                height={6.4}
                fill={EVENT_COLORS[marker.type]}
                transform={`translate(${marker.x}, ${marker.y}) rotate(45)`}
              />
            </g>
          ))}

          {/* P&L line */}
          <polyline
            points={model.linePoints}
            fill="none"
            stroke="var(--gold)"
            strokeWidth={2}
            strokeLinejoin="round"
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
          />

          {/* Typed outcome dots with optional stake labels */}
          {model.dots.map((dot) => (
            <g key={`dot-${dot.round}`}>
              <circle
                cx={dot.x}
                cy={dot.y}
                r={2.5}
                fill={OUTCOME_COLORS[dot.progressionEffect]}
                stroke={
                  dot.progressionEffect === "neutral"
                    ? "var(--champagne)"
                    : "none"
                }
                strokeWidth={dot.progressionEffect === "neutral" ? 0.8 : 0}
                data-testid={`outcome-${dot.progressionEffect}`}
              />
              {showBetNumbers && dot.showLabel && (
                <text
                  x={dot.x}
                  y={
                    dot.progressionEffect === "win"
                      ? dot.y - 6
                      : dot.y + 12
                  }
                  textAnchor="middle"
                  fontSize={8}
                  fill={OUTCOME_COLORS[dot.progressionEffect]}
                  data-testid="stake-label"
                >
                  {formatStake(dot.stake)}
                </text>
              )}
            </g>
          ))}

          {/* Terminal outcome marker */}
          {model.terminalMarker && (
            <g data-testid={`terminal-${model.terminalMarker.reason}`}>
              <circle
                cx={model.terminalMarker.x}
                cy={model.terminalMarker.y}
                r={6}
                fill="none"
                stroke={STOP_REASON_COLORS[model.terminalMarker.reason]}
                strokeWidth={1.5}
                opacity={0.7}
              />
              <circle
                cx={model.terminalMarker.x}
                cy={model.terminalMarker.y}
                r={3}
                fill={STOP_REASON_COLORS[model.terminalMarker.reason]}
              />
            </g>
          )}
        </>
      )}
    </svg>
  );
}
