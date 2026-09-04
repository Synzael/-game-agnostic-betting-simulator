import { describe, it, expect } from 'vitest';
import {
  createLadder,
  getMaxIndex,
  getStake,
  isAtTop,
  isAtBottom,
  DEFAULT_LADDERS,
  getTotalStakes,
  formatStake,
} from './ladder';

describe('createLadder', () => {
  it('creates a ladder with valid stakes', () => {
    const ladder = createLadder('Test', [10, 20, 30]);
    expect(ladder.name).toBe('Test');
    expect(ladder.stakes).toEqual([10, 20, 30]);
  });

  it('freezes the stakes array', () => {
    const ladder = createLadder('Test', [10, 20, 30]);
    expect(Object.isFrozen(ladder.stakes)).toBe(true);
  });

  it('throws error for empty stakes array', () => {
    expect(() => createLadder('Empty', [])).toThrow(
      'Ladder must have at least one stake'
    );
  });

  it('throws error for zero stake', () => {
    expect(() => createLadder('Zero', [10, 0, 30])).toThrow(
      'All stakes must be positive'
    );
  });

  it('throws error for negative stake', () => {
    expect(() => createLadder('Negative', [10, -5, 30])).toThrow(
      'All stakes must be positive'
    );
  });
});

describe('getMaxIndex', () => {
  it('returns correct max index for ladder', () => {
    const ladder = createLadder('Test', [10, 20, 30, 40]);
    expect(getMaxIndex(ladder)).toBe(3);
  });

  it('returns 0 for single-stake ladder', () => {
    const ladder = createLadder('Single', [100]);
    expect(getMaxIndex(ladder)).toBe(0);
  });
});

describe('getStake', () => {
  const ladder = createLadder('Test', [10, 20, 30, 40, 50]);

  it('returns correct stake at given index', () => {
    expect(getStake(ladder, 0)).toBe(10);
    expect(getStake(ladder, 2)).toBe(30);
    expect(getStake(ladder, 4)).toBe(50);
  });

  it('clamps negative index to 0', () => {
    expect(getStake(ladder, -1)).toBe(10);
    expect(getStake(ladder, -100)).toBe(10);
  });

  it('clamps index exceeding max to max', () => {
    expect(getStake(ladder, 5)).toBe(50);
    expect(getStake(ladder, 100)).toBe(50);
  });
});

describe('isAtTop', () => {
  const ladder = createLadder('Test', [10, 20, 30, 40]);

  it('returns true when at max index', () => {
    expect(isAtTop(ladder, 3)).toBe(true);
  });

  it('returns true when above max index', () => {
    expect(isAtTop(ladder, 4)).toBe(true);
    expect(isAtTop(ladder, 100)).toBe(true);
  });

  it('returns false when below max index', () => {
    expect(isAtTop(ladder, 2)).toBe(false);
    expect(isAtTop(ladder, 0)).toBe(false);
  });
});

describe('isAtBottom', () => {
  it('returns true when at index 0', () => {
    expect(isAtBottom(0)).toBe(true);
  });

  it('returns true when below 0', () => {
    expect(isAtBottom(-1)).toBe(true);
    expect(isAtBottom(-100)).toBe(true);
  });

  it('returns false when above 0', () => {
    expect(isAtBottom(1)).toBe(false);
    expect(isAtBottom(5)).toBe(false);
  });
});

describe('DEFAULT_LADDERS', () => {
  it('has three ladders', () => {
    expect(DEFAULT_LADDERS.length).toBe(3);
  });

  it('has correct ladder names', () => {
    expect(DEFAULT_LADDERS[0].name).toBe('L1');
    expect(DEFAULT_LADDERS[1].name).toBe('L2');
    expect(DEFAULT_LADDERS[2].name).toBe('L3');
  });

  it('has frozen ladders array', () => {
    expect(Object.isFrozen(DEFAULT_LADDERS)).toBe(true);
  });

  it('L1 starts at $5', () => {
    expect(DEFAULT_LADDERS[0].stakes[0]).toBe(5);
  });

  it('L2 starts at $50', () => {
    expect(DEFAULT_LADDERS[1].stakes[0]).toBe(50);
  });

  it('L3 starts at $500', () => {
    expect(DEFAULT_LADDERS[2].stakes[0]).toBe(500);
  });
});

describe('getTotalStakes', () => {
  it('calculates total stakes across all ladders', () => {
    const ladders = [
      createLadder('L1', [10, 20, 30]),
      createLadder('L2', [100, 200]),
    ];
    expect(getTotalStakes(ladders)).toBe(5);
  });

  it('returns 0 for empty ladders array', () => {
    expect(getTotalStakes([])).toBe(0);
  });

  it('works with DEFAULT_LADDERS', () => {
    const total = getTotalStakes(DEFAULT_LADDERS);
    expect(total).toBe(27); // 9 + 8 + 10
  });
});

describe('formatStake', () => {
  it('formats positive integers with currency symbol', () => {
    expect(formatStake(100)).toBe('$100');
    expect(formatStake(1000)).toBe('$1,000');
    expect(formatStake(10000)).toBe('$10,000');
  });

  it('formats zero', () => {
    expect(formatStake(0)).toBe('$0');
  });

  it('formats negative values', () => {
    expect(formatStake(-500)).toBe('-$500');
    expect(formatStake(-1500)).toBe('-$1,500');
  });

  it('preserves cents for non-whole payouts', () => {
    expect(formatStake(99.99)).toBe('$99.99');
    expect(formatStake(100.01)).toBe('$100.01');
  });
});
