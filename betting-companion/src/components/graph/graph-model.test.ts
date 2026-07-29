import { describe, it, expect } from 'vitest';
import { buildGraphModel, stopReasonFromResult } from './graph-model';
import { BetRecord, SessionEvent, SessionResult } from '@/engine/types';

const WIDTH = 320;
const HEIGHT = 110;

const makeBet = (
  round: number,
  won: boolean,
  stake: number,
  pnlAfter: number
): BetRecord => ({
  round,
  timestamp: round,
  ladder: 0,
  index: 0,
  stake,
  won,
  pnlAfter,
});

const makeEvent = (
  round: number,
  type: SessionEvent['type'],
  pnlAt: number
): SessionEvent => ({
  round,
  timestamp: round,
  type,
  pnlAt,
  fromLadder: 0,
  toLadder: 1,
});

const build = (
  bets: readonly BetRecord[],
  events: readonly SessionEvent[] = [],
  stopReason: Parameters<typeof buildGraphModel>[2] = null
) => buildGraphModel(bets, events, stopReason, WIDTH, HEIGHT);

describe('buildGraphModel', () => {
  describe('empty history', () => {
    it('reports empty with no dots or markers', () => {
      const model = build([]);
      expect(model.isEmpty).toBe(true);
      expect(model.dots).toEqual([]);
      expect(model.eventMarkers).toEqual([]);
      expect(model.terminalMarker).toBeNull();
    });

    it('places the zero line mid-chart', () => {
      const model = build([]);
      expect(model.zeroLineY).toBeGreaterThan(0);
      expect(model.zeroLineY).toBeLessThan(HEIGHT);
    });
  });

  describe('line and dots', () => {
    it('prepends an origin point at round 0, pnl 0', () => {
      const model = build([makeBet(1, true, 10, 10)]);
      const points = model.linePoints.split(' ');
      expect(points.length).toBe(2);
      const [, originY] = points[0].split(',').map(Number);
      expect(originY).toBeCloseTo(model.zeroLineY, 5);
    });

    it('creates one dot per bet with outcome and stake', () => {
      const model = build([
        makeBet(1, true, 10, 10),
        makeBet(2, false, 10, 0),
      ]);
      expect(model.dots.length).toBe(2);
      expect(model.dots[0].won).toBe(true);
      expect(model.dots[0].stake).toBe(10);
      expect(model.dots[1].won).toBe(false);
    });

    it('positions dots left to right by round', () => {
      const model = build([
        makeBet(1, true, 10, 10),
        makeBet(2, true, 10, 20),
        makeBet(3, true, 10, 30),
      ]);
      expect(model.dots[0].x).toBeLessThan(model.dots[1].x);
      expect(model.dots[1].x).toBeLessThan(model.dots[2].x);
    });
  });

  describe('y-axis scaling', () => {
    it('puts positive pnl above the zero line (smaller svg y)', () => {
      const model = build([makeBet(1, true, 10, 50)]);
      expect(model.dots[0].y).toBeLessThan(model.zeroLineY);
    });

    it('puts negative pnl below the zero line (larger svg y)', () => {
      const model = build([makeBet(1, false, 10, -50)]);
      expect(model.dots[0].y).toBeGreaterThan(model.zeroLineY);
    });

    it('always includes zero in the domain for all-positive series', () => {
      const model = build([
        makeBet(1, true, 10, 40),
        makeBet(2, true, 10, 80),
      ]);
      // Zero line must be on-chart, below every dot
      expect(model.zeroLineY).toBeLessThanOrEqual(HEIGHT);
      expect(model.dots.every((dot) => dot.y < model.zeroLineY)).toBe(true);
    });

    it('always includes zero in the domain for all-negative series', () => {
      const model = build([
        makeBet(1, false, 10, -40),
        makeBet(2, false, 10, -80),
      ]);
      expect(model.zeroLineY).toBeGreaterThanOrEqual(0);
      expect(model.dots.every((dot) => dot.y > model.zeroLineY)).toBe(true);
    });

    it('scales mixed series with extremes furthest from the zero line', () => {
      const model = build([
        makeBet(1, true, 10, 100),
        makeBet(2, false, 10, -100),
        makeBet(3, true, 10, 50),
      ]);
      const [high, low, mid] = model.dots;
      expect(high.y).toBeLessThan(mid.y);
      expect(low.y).toBeGreaterThan(model.zeroLineY);
      expect(mid.y).toBeLessThan(model.zeroLineY);
    });
  });

  describe('variance fan geometry', () => {
    const forecast = [
      { round: 0, p05: 0, p25: 0, p50: 0, p75: 0, p95: 0 },
      { round: 2, p05: -100, p25: -20, p50: 0, p75: 20, p95: 100 },
    ];

    it('builds closed outer/inner paths and a median from shared transforms', () => {
      const model = buildGraphModel(
        [makeBet(1, true, 10, 10), makeBet(2, false, 10, 0)],
        [],
        null,
        WIDTH,
        HEIGHT,
        forecast,
        true
      );
      expect(model.variance?.outerBandPath.startsWith('M ')).toBe(true);
      expect(model.variance?.outerBandPath.endsWith(' Z')).toBe(true);
      expect(model.variance?.innerBandPath.endsWith(' Z')).toBe(true);
      expect(model.variance?.medianPoints.split(' ')).toHaveLength(2);
      // The actual +$10 point remains inside the domain expanded to fan P95.
      expect(model.dots[0].y).toBeGreaterThan(16);
    });

    it('omits geometry when the display setting hides the snapshot', () => {
      const model = buildGraphModel(
        [makeBet(1, true, 10, 10), makeBet(2, false, 10, 0)],
        [],
        null,
        WIDTH,
        HEIGHT,
        forecast,
        false
      );
      expect(model.variance).toBeNull();
    });
  });

  describe('stake label thinning', () => {
    it('labels every dot for short sessions', () => {
      const bets = Array.from({ length: 10 }, (_, i) =>
        makeBet(i + 1, true, 10, (i + 1) * 10)
      );
      const model = build(bets);
      expect(model.dots.every((dot) => dot.showLabel)).toBe(true);
    });

    it('thins labels for long sessions but keeps the latest bet labeled', () => {
      const bets = Array.from({ length: 60 }, (_, i) =>
        makeBet(i + 1, i % 2 === 0, 10, i)
      );
      const model = build(bets);
      const labeled = model.dots.filter((dot) => dot.showLabel);
      expect(labeled.length).toBeLessThanOrEqual(25);
      expect(model.dots[model.dots.length - 1].showLabel).toBe(true);
    });
  });

  describe('event markers', () => {
    it('places carry_over and write_off markers at their round and pnl', () => {
      const bets = [
        makeBet(1, false, 10, -10),
        makeBet(2, false, 20, -30),
        makeBet(3, true, 10, -20),
      ];
      const events = [makeEvent(2, 'carry_over', -30)];
      const model = build(bets, events);

      expect(model.eventMarkers.length).toBe(1);
      expect(model.eventMarkers[0].type).toBe('carry_over');
      expect(model.eventMarkers[0].x).toBeCloseTo(model.dots[1].x, 5);
      expect(model.eventMarkers[0].y).toBeCloseTo(model.dots[1].y, 5);
    });

    it('keeps marker order for multiple events', () => {
      const bets = [
        makeBet(1, false, 10, -10),
        makeBet(2, false, 20, -30),
        makeBet(3, false, 40, -70),
      ];
      const events = [
        makeEvent(1, 'carry_over', -10),
        makeEvent(3, 'write_off', -70),
      ];
      const model = build(bets, events);
      expect(model.eventMarkers.map((marker) => marker.type)).toEqual([
        'carry_over',
        'write_off',
      ]);
    });
  });

  describe('terminal marker', () => {
    it('is absent while the session is running', () => {
      const model = build([makeBet(1, true, 10, 10)]);
      expect(model.terminalMarker).toBeNull();
    });

    it('marks the final point with the stop reason', () => {
      const bets = [makeBet(1, true, 10, 10), makeBet(2, true, 20, 30)];
      const model = build(bets, [], 'profit_target');
      expect(model.terminalMarker).not.toBeNull();
      expect(model.terminalMarker?.reason).toBe('profit_target');
      expect(model.terminalMarker?.x).toBeCloseTo(model.dots[1].x, 5);
      expect(model.terminalMarker?.y).toBeCloseTo(model.dots[1].y, 5);
    });
  });
});

describe('stopReasonFromResult', () => {
  const baseResult = {
    hitTarget: false,
    hitStopLoss: false,
    hitMaxRounds: false,
    hitTableLimit: false,
    bankrollExhausted: false,
    userStopped: false,
  } as SessionResult;

  it.each([
    ['hitTarget', 'profit_target'],
    ['hitStopLoss', 'stop_loss'],
    ['hitMaxRounds', 'max_rounds'],
    ['hitTableLimit', 'table_limit'],
    ['bankrollExhausted', 'bankroll_exhausted'],
    ['userStopped', 'user_stopped'],
  ] as const)('maps %s to %s', (flag, reason) => {
    expect(stopReasonFromResult({ ...baseResult, [flag]: true })).toBe(reason);
  });

  it('returns null when no flag is set', () => {
    expect(stopReasonFromResult(baseResult)).toBeNull();
  });
});
