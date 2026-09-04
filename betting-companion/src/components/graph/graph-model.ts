/**
 * Pure derivation logic for the adventure graph.
 * Maps bet history + roguelike events into SVG coordinates.
 * No React — fully unit-testable.
 */

import {
  BetRecord,
  SessionEvent,
  SessionResult,
  StopReason,
  ProgressionEffect,
  VarianceBandPoint,
} from "@/engine/types";
import { interpolateVarianceAtRound } from "@/engine/variance-forecast";

export interface GraphDot {
  readonly x: number;
  readonly y: number;
  readonly won: boolean;
  readonly progressionEffect: ProgressionEffect;
  readonly stake: number;
  readonly round: number;
  readonly showLabel: boolean;
}

export interface GraphEventMarker {
  readonly x: number;
  readonly y: number;
  readonly type: SessionEvent["type"];
}

export interface GraphTerminalMarker {
  readonly x: number;
  readonly y: number;
  readonly reason: NonNullable<StopReason>;
}

export interface GraphVarianceGeometry {
  readonly outerBandPath: string;
  readonly innerBandPath: string;
  readonly medianPoints: string;
}

export interface GraphModel {
  readonly isEmpty: boolean;
  readonly width: number;
  readonly height: number;
  readonly linePoints: string;
  readonly dots: readonly GraphDot[];
  readonly eventMarkers: readonly GraphEventMarker[];
  readonly terminalMarker: GraphTerminalMarker | null;
  readonly zeroLineY: number;
  readonly finalPnl: number;
  readonly variance: GraphVarianceGeometry | null;
}

const PAD_X = 12;
const PAD_Y = 16;
const MAX_LABELS = 25;

export function buildGraphModel(
  betHistory: readonly BetRecord[],
  events: readonly SessionEvent[],
  stopReason: StopReason,
  width: number,
  height: number,
  forecastPoints: readonly VarianceBandPoint[] = [],
  showVarianceFan = true
): GraphModel {
  if (betHistory.length === 0) {
    return {
      isEmpty: true,
      width,
      height,
      linePoints: "",
      dots: [],
      eventMarkers: [],
      terminalMarker: null,
      zeroLineY: height / 2,
      finalPnl: 0,
      variance: null,
    };
  }

  const pnls = betHistory.map((bet) => bet.pnlAfter);
  const maxRound = betHistory[betHistory.length - 1].round || 1;
  const visibleForecastPoints =
    showVarianceFan
      ? getVisibleForecastPoints(forecastPoints, maxRound)
      : [];
  const fanValues = visibleForecastPoints.flatMap((point) => [
    point.p05,
    point.p25,
    point.p50,
    point.p75,
    point.p95,
  ]);
  // Domain always includes zero so the baseline stays on-chart.
  const yMin = Math.min(0, ...pnls, ...fanValues);
  const yMax = Math.max(0, ...pnls, ...fanValues);
  const ySpan = yMax - yMin || 1;

  const toX = (round: number): number =>
    PAD_X + (round / maxRound) * (width - 2 * PAD_X);
  const toY = (pnl: number): number =>
    PAD_Y + ((yMax - pnl) / ySpan) * (height - 2 * PAD_Y);

  const labelEvery = Math.ceil(betHistory.length / MAX_LABELS);
  const lastIndex = betHistory.length - 1;

  const dots: GraphDot[] = betHistory.map((bet, index) => ({
    x: toX(bet.round),
    y: toY(bet.pnlAfter),
    won: bet.won ?? bet.progressionEffect === "win",
    progressionEffect:
      bet.progressionEffect ?? (bet.won === true ? "win" : "loss"),
    stake: bet.stake,
    round: bet.round,
    // Anchor thinning on the latest bet so it is always labeled.
    showLabel: (lastIndex - index) % labelEvery === 0,
  }));

  const originPoint = `${toX(0)},${toY(0)}`;
  const linePoints = [
    originPoint,
    ...dots.map((dot) => `${dot.x},${dot.y}`),
  ].join(" ");

  const eventMarkers: GraphEventMarker[] = events.map((event) => ({
    x: toX(event.round),
    y: toY(event.pnlAt),
    type: event.type,
  }));

  const lastDot = dots[dots.length - 1];
  const terminalMarker: GraphTerminalMarker | null = stopReason
    ? { x: lastDot.x, y: lastDot.y, reason: stopReason }
    : null;
  const variance =
    visibleForecastPoints.length >= 2
      ? {
          outerBandPath: buildClosedBandPath(
            visibleForecastPoints,
            "p95",
            "p05",
            toX,
            toY
          ),
          innerBandPath: buildClosedBandPath(
            visibleForecastPoints,
            "p75",
            "p25",
            toX,
            toY
          ),
          medianPoints: visibleForecastPoints
            .map((point) => `${toX(point.round)},${toY(point.p50)}`)
            .join(" "),
        }
      : null;

  return {
    isEmpty: false,
    width,
    height,
    linePoints,
    dots,
    eventMarkers,
    terminalMarker,
    zeroLineY: toY(0),
    finalPnl: pnls[pnls.length - 1],
    variance,
  };
}

function getVisibleForecastPoints(
  points: readonly VarianceBandPoint[],
  maxRound: number
): VarianceBandPoint[] {
  if (points.length === 0) return [];
  const visible = points.filter((point) => point.round <= maxRound);
  const lastVisible = visible[visible.length - 1];
  if (!lastVisible || lastVisible.round < maxRound) {
    const current = interpolateVarianceAtRound(points, maxRound);
    if (current) visible.push(current);
  }
  return visible;
}

export function buildClosedBandPath(
  points: readonly VarianceBandPoint[],
  upperKey: "p95" | "p75",
  lowerKey: "p05" | "p25",
  toX: (round: number) => number,
  toY: (pnl: number) => number
): string {
  if (points.length === 0) return "";
  const upper = points.map(
    (point) => `${toX(point.round)},${toY(point[upperKey])}`
  );
  const lower = [...points]
    .reverse()
    .map((point) => `${toX(point.round)},${toY(point[lowerKey])}`);
  return `M ${upper.join(" L ")} L ${lower.join(" L ")} Z`;
}

/**
 * Derive the StopReason from a stored SessionResult's outcome flags,
 * so History mini-graphs can render a terminal marker.
 */
export function stopReasonFromResult(result: SessionResult): StopReason {
  if (result.hitTarget) return "profit_target";
  if (result.hitStopLoss) return "stop_loss";
  if (result.hitMaxRounds) return "max_rounds";
  if (result.hitTableLimit) return "table_limit";
  if (result.bankrollExhausted) return "bankroll_exhausted";
  if (result.userStopped) return "user_stopped";
  return null;
}
