import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SessionGraph } from './SessionGraph';
import { BetRecord, SessionEvent } from '@/engine/types';

const bets: BetRecord[] = [
  { round: 1, timestamp: 1, ladder: 0, index: 0, stake: 10, won: true, pnlAfter: 10 },
  { round: 2, timestamp: 2, ladder: 0, index: 0, stake: 10, won: false, pnlAfter: 0 },
];

const events: SessionEvent[] = [
  {
    round: 2,
    timestamp: 2,
    type: 'write_off',
    pnlAt: 0,
    fromLadder: 1,
    toLadder: 0,
  },
];

describe('SessionGraph', () => {
  it('renders stake labels when showBetNumbers is on', () => {
    render(<SessionGraph betHistory={bets} showBetNumbers={true} />);
    expect(screen.getAllByTestId('stake-label').length).toBe(2);
  });

  it('hides stake labels when showBetNumbers is off', () => {
    render(<SessionGraph betHistory={bets} showBetNumbers={false} />);
    expect(screen.queryByTestId('stake-label')).toBeNull();
  });

  it('renders event and terminal markers', () => {
    render(
      <SessionGraph
        betHistory={bets}
        events={events}
        stopReason="stop_loss"
        showBetNumbers={false}
      />
    );
    expect(screen.getByTestId('event-write_off')).toBeDefined();
    expect(screen.getByTestId('terminal-stop_loss')).toBeDefined();
  });

  it('renders an empty state with no session data', () => {
    render(<SessionGraph betHistory={[]} showBetNumbers={true} />);
    expect(screen.getByText('No bets yet')).toBeDefined();
  });

  it('renders and hides a completed variance snapshot without deleting it', () => {
    const varianceForecast = {
      points: [
        { round: 0, p05: 0, p25: 0, p50: 0, p75: 0, p95: 0 },
        { round: 2, p05: -20, p25: -10, p50: 0, p75: 10, p95: 20 },
      ],
      sampleCount: 100,
      seed: 1,
      engineVersion: 'test',
      inputFingerprint: 'input',
      anchorScheduleVersion: 1,
      terminalHandling: 'absorbing_final_pnl' as const,
      quantileEstimator: 'r7_linear' as const,
      gameFingerprint: 'game',
      generatedAt: 1,
      quality: 'full' as const,
    };
    const { rerender } = render(
      <SessionGraph
        betHistory={bets}
        varianceForecast={varianceForecast}
        showVarianceFan={true}
        showBetNumbers={false}
      />
    );
    expect(screen.getByTestId('variance-fan')).toBeDefined();
    expect(screen.getByTestId('variance-outer')).toBeDefined();
    rerender(
      <SessionGraph
        betHistory={bets}
        varianceForecast={varianceForecast}
        showVarianceFan={false}
        showBetNumbers={false}
      />
    );
    expect(screen.queryByTestId('variance-fan')).toBeNull();
  });
});
