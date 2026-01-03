#!/usr/bin/env python3
"""
Robust Monte Carlo Simulator for Loss-Recovery Staking Strategy
with Multiple Intersecting Fibonacci Ladders

This simulator evaluates a loss-recovery betting strategy using modified Fibonacci
ladders with the rule: move up 1 step on loss, down 2 steps on win.

KEY CONCEPTS:
-------------
1. Ladder Stepping: 
   - On loss: index += 1
   - On win: index -= 2
   - Clamp to [0, last_index] within current ladder

2. Bridging Policies (when losing at top of ladder):
   - advance_to_next_ladder_start: Move to next ladder at index 0
   - carry_over_index_delta: Carry overshoot into next ladder with offset
   - stop_at_table_limit: Treat as hard stop-loss event

3. Safe Target:
   - Largest profit target where P(ruin) <= alpha (default 1%)
   - Ruin = hitting stop-loss, table limit, or bankroll exhaustion before target

ASSUMPTIONS:
------------
- House edge: 1% for even-money bets (p_win = 0.495, p_loss = 0.505)
- No betting system can overcome negative expected value long-term
- Results depend critically on bankroll size and table limits
- All bets are resolved independently

USAGE:
------
python simulator.py --bankroll 800000 --n-sessions 100000 --alpha 0.01
"""

from dataclasses import dataclass, field, asdict
from typing import List, Optional, Literal, Tuple, Dict, Any
import numpy as np
from scipy import stats
import json
import argparse
from pathlib import Path
import csv
from datetime import datetime


# ============================================================================
# Core Data Structures
# ============================================================================

@dataclass
class GameSpec:
    """Specification for a betting game."""
    name: str
    payout_ratio: float  # Payout multiplier for winning bet (1:1 = 1.0)
    p_win: float  # Probability of winning
    
    def expected_value(self, stake: float) -> float:
        """Expected value of a bet."""
        return stake * (self.payout_ratio * self.p_win - (1 - self.p_win))
    
    def resolve_bet(
        self, stake: float, rng: np.random.Generator
    ) -> Tuple[bool, float]:
        """
        Resolve a single bet.
        Returns: (won: bool, pnl: float)
        """
        won = rng.random() < self.p_win
        if won:
            return True, stake * self.payout_ratio
        else:
            return False, -stake


@dataclass
class LadderSpec:
    """Specification for a stake ladder."""
    name: str
    stakes: List[float]
    
    def __post_init__(self):
        if not self.stakes:
            raise ValueError("Ladder must have at least one stake")
        if any(s <= 0 for s in self.stakes):
            raise ValueError("All stakes must be positive")
    
    @property
    def max_index(self) -> int:
        return len(self.stakes) - 1
    
    def get_stake(self, index: int) -> float:
        """Get stake at index, clamped to valid range."""
        return self.stakes[max(0, min(index, self.max_index))]


BridgingPolicy = Literal[
    "advance_to_next_ladder_start",
    "carry_over_index_delta",
    "stop_at_table_limit"
]


@dataclass
class StrategyConfig:
    """Configuration for the betting strategy."""
    ladders: List[LadderSpec]
    bridging_policy: BridgingPolicy = "advance_to_next_ladder_start"
    recovery_target_pct: float = 0.5  # % of loss to recover
    crossover_offset: int = 0  # Index offset in next ladder

    def __post_init__(self):
        if not self.ladders:
            raise ValueError("Strategy must have at least one ladder")
        if not 0 < self.recovery_target_pct <= 1:
            raise ValueError("recovery_target_pct must be in (0, 1]")
        if self.crossover_offset < 0:
            raise ValueError("crossover_offset must be non-negative")


@dataclass
class SessionConfig:
    """Configuration for a single session."""
    bankroll: float
    profit_target: float
    stop_loss_abs: float
    game_spec: GameSpec
    max_rounds: int = 5000
    table_max: Optional[float] = None
    rng_seed: Optional[int] = None

    def __post_init__(self):
        if self.bankroll <= 0:
            raise ValueError("Bankroll must be positive")
        if self.profit_target <= 0:
            raise ValueError("Profit target must be positive")
        if self.stop_loss_abs <= 0:
            raise ValueError("Stop loss must be positive")
        if self.max_rounds <= 0:
            raise ValueError("Max rounds must be positive")
        if self.table_max is not None and self.table_max <= 0:
            raise ValueError("Table max must be positive if specified")


@dataclass
class SessionResult:
    """Results from a single session."""
    # Stop reasons
    hit_target: bool
    hit_stop_loss: bool
    hit_max_rounds: bool
    hit_table_limit: bool
    bankroll_exhausted: bool

    # Performance metrics
    final_pnl: float
    rounds_played: int
    total_wagered: float
    max_stake_seen: float
    max_drawdown: float

    # Ladder tracking
    ladder_touches: Dict[int, int]
    top_of_ladder_touches: int
    final_ladder: int
    final_index: int


class SessionSimulator:
    """Simulates a single betting session using the loss-recovery strategy."""

    def __init__(
        self,
        strategy: StrategyConfig,
        config: SessionConfig,
        rng: np.random.Generator,
    ):
        """Initialize a session simulator."""
        self.strategy = strategy
        self.config = config
        self.rng = rng

        # Position tracking
        self.current_ladder = 0
        self.current_index = 0

        # Performance tracking
        self.pnl = 0.0
        self.rounds = 0
        self.total_wagered = 0.0
        self.max_stake = 0.0
        self.max_drawdown = 0.0
        self.peak_pnl = 0.0

        # Ladder statistics
        self.ladder_touches: Dict[int, int] = {
            i: 0 for i in range(len(strategy.ladders))
        }
        self.top_touches = 0

        # Session control
        self.stopped = False
        self.stop_reason = ""

        # Recovery mode (for carry_over_index_delta)
        self.in_recovery = False
        self.recovery_target_pnl = 0.0

    @property
    def current_stake(self) -> float:
        """Get the current stake based on ladder position."""
        ladder = self.strategy.ladders[self.current_ladder]
        return ladder.get_stake(self.current_index)

    def can_afford_stake(self) -> bool:
        """Check if current bankroll can afford the current stake."""
        current_bankroll = self.config.bankroll + self.pnl
        return current_bankroll >= self.current_stake

    def step_index(self, won: bool) -> bool:
        """
        Step the ladder index based on win/loss and handle bridging.

        Base logic:
        - Win: index -= 2 (move down 2 steps)
        - Loss: index += 1 (move up 1 step)
        - Clamp to [0, max_index] within current ladder

        Bridging (when losing at top of ladder):
        - advance_to_next_ladder_start: Move to next ladder at index 0
        - carry_over_index_delta: Enter recovery mode, advance with offset
        - stop_at_table_limit: Treat as table limit hit and stop

        Returns:
            True if session should stop
        """
        current_ladder_spec = self.strategy.ladders[self.current_ladder]
        max_index = current_ladder_spec.max_index

        # Check if at top before stepping
        at_top_before_step = (self.current_index == max_index)

        # Base stepping logic
        if won:
            self.current_index -= 2
        else:
            self.current_index += 1

        # Check if bridging needed (lost at top)
        need_bridging = (not won) and at_top_before_step

        if need_bridging:
            # Track that we hit top of ladder
            self.top_touches += 1

            # Check if at last ladder
            at_last_ladder = (self.current_ladder == len(self.strategy.ladders) - 1)

            # Apply bridging policy
            if self.strategy.bridging_policy == "advance_to_next_ladder_start":
                if at_last_ladder:
                    # Can't advance further - stop with table limit
                    self.stopped = True
                    self.stop_reason = "table_limit"
                    return True
                else:
                    # Advance to next ladder at index 0
                    self.current_ladder += 1
                    self.current_index = 0

            elif self.strategy.bridging_policy == "carry_over_index_delta":
                # Enter or maintain recovery mode
                if not self.in_recovery:
                    # Enter recovery mode
                    self.in_recovery = True
                    # Recovery target: current_pnl + (abs(current_pnl) * recovery_target_pct)
                    if self.pnl < 0:
                        recovery_amount = abs(self.pnl) * self.strategy.recovery_target_pct
                        self.recovery_target_pnl = self.pnl + recovery_amount
                    else:
                        # Edge case: in profit, no recovery needed
                        self.recovery_target_pnl = self.pnl

                # Advance to next ladder (or stop if at last)
                if at_last_ladder:
                    self.stopped = True
                    self.stop_reason = "table_limit"
                    return True
                else:
                    self.current_ladder += 1
                    # Start at crossover_offset index in next ladder
                    self.current_index = self.strategy.crossover_offset

            elif self.strategy.bridging_policy == "stop_at_table_limit":
                # Treat as hard stop
                self.stopped = True
                self.stop_reason = "table_limit"
                return True

            else:
                raise ValueError(f"Unknown bridging policy: {self.strategy.bridging_policy}")

        else:
            # Normal stepping - clamp to valid range
            self.current_index = max(0, min(self.current_index, max_index))

            # Check for recovery completion (only for carry_over_index_delta)
            if self.in_recovery and self.pnl >= self.recovery_target_pnl:
                # Recovery achieved - reset to ladder 0, index 0
                self.in_recovery = False
                self.recovery_target_pnl = 0.0
                self.current_ladder = 0
                self.current_index = 0

        return False

    def play_round(self) -> bool:
        """Play one round. Returns True if session should continue."""
        # Check affordability - if can't afford, bankroll exhausted
        if not self.can_afford_stake():
            self.stopped = True
            self.stop_reason = "bankroll_exhausted"
            return False
        
        # Check table limit
        stake = self.current_stake
        if self.config.table_max is not None and stake > self.config.table_max:
            self.stopped = True
            self.stop_reason = "table_limit"
            return False
        
        # Track
        self.ladder_touches[self.current_ladder] += 1
        self.max_stake = max(self.max_stake, stake)
        self.total_wagered += stake
        
        # Resolve bet
        won, round_pnl = self.config.game_spec.resolve_bet(stake, self.rng)
        self.pnl += round_pnl
        self.rounds += 1
        
        # Update drawdown tracking
        self.peak_pnl = max(self.peak_pnl, self.pnl)
        drawdown = self.peak_pnl - self.pnl
        self.max_drawdown = max(self.max_drawdown, drawdown)
        
        # Check profit target
        if self.pnl >= self.config.profit_target:
            self.stopped = True
            self.stop_reason = "profit_target"
            return False
        
        # Check stop loss
        if -self.pnl >= self.config.stop_loss_abs:
            self.stopped = True
            self.stop_reason = "stop_loss"
            return False
        
        # Check max rounds
        if self.rounds >= self.config.max_rounds:
            self.stopped = True
            self.stop_reason = "max_rounds"
            return False
        
        # Step the index
        should_stop = self.step_index(won)
        if should_stop:
            return False
        
        return True
    
    def run(self) -> SessionResult:
        """Run a complete session and return results."""
        while not self.stopped:
            self.play_round()
        
        return SessionResult(
            hit_target=(self.stop_reason == "profit_target"),
            hit_stop_loss=(self.stop_reason == "stop_loss"),
            hit_max_rounds=(self.stop_reason == "max_rounds"),
            hit_table_limit=(self.stop_reason == "table_limit"),
            bankroll_exhausted=(self.stop_reason == "bankroll_exhausted"),
            final_pnl=self.pnl,
            rounds_played=self.rounds,
            total_wagered=self.total_wagered,
            max_stake_seen=self.max_stake,
            max_drawdown=self.max_drawdown,
            ladder_touches=self.ladder_touches,
            top_of_ladder_touches=self.top_touches,
            final_ladder=self.current_ladder,
            final_index=self.current_index,
        )


# ============================================================================
# Monte Carlo Engine
# ============================================================================

@dataclass
class MonteCarloResults:
    """Aggregated results from Monte Carlo simulation."""
    n_sessions: int
    
    # Success metrics
    prob_hit_target: float
    prob_hit_stop_loss: float
    prob_hit_max_rounds: float
    prob_hit_table_limit: float
    prob_bankroll_exhausted: float
    
    # PnL metrics
    mean_pnl: float
    median_pnl: float
    std_pnl: float
    skew_pnl: float
    kurtosis_pnl: float
    pnl_95ci_lower: float
    pnl_95ci_upper: float
    
    # Round metrics
    mean_rounds: float
    median_rounds: float
    mean_rounds_to_target: float
    median_rounds_to_target: float
    
    # Risk metrics
    mean_max_stake: float
    median_max_stake: float
    mean_max_drawdown: float
    median_max_drawdown: float
    prob_touch_ladder: Dict[int, float]
    prob_top_of_ladder: float
    
    # Per-bet metrics
    mean_total_wagered: float
    
    # Raw data (optional)
    all_pnls: Optional[np.ndarray] = None
    all_rounds: Optional[np.ndarray] = None
    
    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary, excluding large arrays."""
        d = asdict(self)
        d.pop("all_pnls", None)
        d.pop("all_rounds", None)
        return d


class MonteCarloEngine:
    """Efficient Monte Carlo simulation engine."""
    
    def __init__(
        self,
        strategy: StrategyConfig,
        session_config: SessionConfig,
        n_sessions: int,
        seed: Optional[int] = None,
    ):
        self.strategy = strategy
        self.session_config = session_config
        self.n_sessions = n_sessions
        self.rng = np.random.default_rng(seed)
    
    def run(self, store_traces: bool = False) -> MonteCarloResults:
        """Run Monte Carlo simulation."""
        # Storage for results
        pnls = np.zeros(self.n_sessions)
        rounds = np.zeros(self.n_sessions, dtype=np.int32)
        hit_target = np.zeros(self.n_sessions, dtype=bool)
        hit_stop_loss = np.zeros(self.n_sessions, dtype=bool)
        hit_max_rounds = np.zeros(self.n_sessions, dtype=bool)
        hit_table_limit = np.zeros(self.n_sessions, dtype=bool)
        bankroll_exhausted = np.zeros(self.n_sessions, dtype=bool)
        max_stakes = np.zeros(self.n_sessions)
        max_drawdowns = np.zeros(self.n_sessions)
        top_touches = np.zeros(self.n_sessions, dtype=np.int32)
        total_wagered_arr = np.zeros(self.n_sessions)
        ladder_touches = {
            i: np.zeros(self.n_sessions, dtype=np.int32)
            for i in range(len(self.strategy.ladders))
        }
        
        # Run sessions
        for i in range(self.n_sessions):
            sim = SessionSimulator(self.strategy, self.session_config, self.rng)
            result = sim.run()
            
            pnls[i] = result.final_pnl
            rounds[i] = result.rounds_played
            hit_target[i] = result.hit_target
            hit_stop_loss[i] = result.hit_stop_loss
            hit_max_rounds[i] = result.hit_max_rounds
            hit_table_limit[i] = result.hit_table_limit
            bankroll_exhausted[i] = result.bankroll_exhausted
            max_stakes[i] = result.max_stake_seen
            max_drawdowns[i] = result.max_drawdown
            top_touches[i] = result.top_of_ladder_touches
            total_wagered_arr[i] = result.total_wagered
            
            for ladder_idx, count in result.ladder_touches.items():
                ladder_touches[ladder_idx][i] = count
        
        # Compute metrics
        prob_hit_target = np.mean(hit_target)
        
        # PnL metrics
        mean_pnl = np.mean(pnls)
        median_pnl = np.median(pnls)
        std_pnl = np.std(pnls, ddof=1)
        
        # Skewness and kurtosis
        if std_pnl > 0:
            skew_pnl = stats.skew(pnls)
            kurtosis_pnl = stats.kurtosis(pnls)
        else:
            skew_pnl = 0.0
            kurtosis_pnl = 0.0
        
        # 95% CI for mean PnL using t-distribution
        sem_pnl = std_pnl / np.sqrt(self.n_sessions)
        ci_margin = stats.t.ppf(0.975, self.n_sessions - 1) * sem_pnl
        pnl_95ci_lower = mean_pnl - ci_margin
        pnl_95ci_upper = mean_pnl + ci_margin
        
        # Round metrics
        mean_rounds = np.mean(rounds)
        median_rounds = np.median(rounds)
        
        rounds_to_target = rounds[hit_target]
        if len(rounds_to_target) > 0:
            mean_rounds_to_target = np.mean(rounds_to_target)
            median_rounds_to_target = np.median(rounds_to_target)
        else:
            mean_rounds_to_target = 0.0
            median_rounds_to_target = 0.0
        
        # Risk metrics
        mean_max_stake = np.mean(max_stakes)
        median_max_stake = np.median(max_stakes)
        mean_max_drawdown = np.mean(max_drawdowns)
        median_max_drawdown = np.median(max_drawdowns)
        
        prob_touch_ladder = {
            i: np.mean(ladder_touches[i] > 0)
            for i in range(len(self.strategy.ladders))
        }
        prob_top_of_ladder = np.mean(top_touches > 0)
        
        mean_total_wagered = np.mean(total_wagered_arr)
        
        return MonteCarloResults(
            n_sessions=self.n_sessions,
            prob_hit_target=float(prob_hit_target),
            prob_hit_stop_loss=float(np.mean(hit_stop_loss)),
            prob_hit_max_rounds=float(np.mean(hit_max_rounds)),
            prob_hit_table_limit=float(np.mean(hit_table_limit)),
            prob_bankroll_exhausted=float(np.mean(bankroll_exhausted)),
            mean_pnl=float(mean_pnl),
            median_pnl=float(median_pnl),
            std_pnl=float(std_pnl),
            skew_pnl=float(skew_pnl),
            kurtosis_pnl=float(kurtosis_pnl),
            pnl_95ci_lower=float(pnl_95ci_lower),
            pnl_95ci_upper=float(pnl_95ci_upper),
            mean_rounds=float(mean_rounds),
            median_rounds=float(median_rounds),
            mean_rounds_to_target=float(mean_rounds_to_target),
            median_rounds_to_target=float(median_rounds_to_target),
            mean_max_stake=float(mean_max_stake),
            median_max_stake=float(median_max_stake),
            mean_max_drawdown=float(mean_max_drawdown),
            median_max_drawdown=float(median_max_drawdown),
            prob_touch_ladder=prob_touch_ladder,
            prob_top_of_ladder=float(prob_top_of_ladder),
            mean_total_wagered=float(mean_total_wagered),
            all_pnls=pnls if store_traces else None,
            all_rounds=rounds if store_traces else None,
        )


# ============================================================================
# Safe Target Finder
# ============================================================================

@dataclass
class SafeTargetResult:
    """Results from safe target search."""
    safe_target: float
    ruin_probability: float
    results: MonteCarloResults
    trade_off_curve: List[Dict[str, Any]]


class SafeTargetFinder:
    """Find the safe profit target for given risk tolerance."""
    
    def __init__(
        self,
        strategy: StrategyConfig,
        base_config: SessionConfig,
        n_sessions: int = 100000,
        alpha: float = 0.01,
        seed: Optional[int] = None,
    ):
        self.strategy = strategy
        self.base_config = base_config
        self.n_sessions = n_sessions
        self.alpha = alpha
        self.seed = seed
    
    def search_grid(
        self, target_min: float, target_max: float, target_step: float, verbose: bool = True
    ) -> SafeTargetResult:
        """Search over grid of profit targets."""
        targets = np.arange(target_min, target_max + target_step, target_step)
        trade_off_curve = []
        
        safe_target = 0.0
        safe_results = None
        safe_ruin_prob = 1.0
        
        for target in targets:
            if verbose:
                print(f"Testing profit target: ${target:.0f}...", end=" ")
            
            # Create config for this target
            config = SessionConfig(
                bankroll=self.base_config.bankroll,
                profit_target=target,
                stop_loss_abs=self.base_config.stop_loss_abs,
                max_rounds=self.base_config.max_rounds,
                game_spec=self.base_config.game_spec,
                table_max=self.base_config.table_max,
                rng_seed=self.seed,
            )
            
            # Run simulation
            engine = MonteCarloEngine(
                self.strategy, config, self.n_sessions, seed=self.seed
            )
            results = engine.run()
            
            # Ruin probability = P(hit stop loss before target)
            ruin_prob = (
                results.prob_hit_stop_loss
                + results.prob_hit_table_limit
                + results.prob_bankroll_exhausted
            )
            
            if verbose:
                print(f"Ruin prob: {ruin_prob:.4f}")
            
            # Store in trade-off curve
            trade_off_curve.append(
                {
                    "profit_target": float(target),
                    "ruin_probability": float(ruin_prob),
                    "prob_hit_target": float(results.prob_hit_target),
                    "mean_pnl": float(results.mean_pnl),
                    "std_pnl": float(results.std_pnl),
                    "mean_rounds": float(results.mean_rounds),
                    "median_rounds_to_target": float(results.median_rounds_to_target),
                }
            )
            
            # Check if this is safe
            if ruin_prob <= self.alpha:
                safe_target = target
                safe_results = results
                safe_ruin_prob = ruin_prob
        
        if safe_results is None:
            raise ValueError(
                f"No safe target found in range [{target_min}, {target_max}] "
                f"with alpha={self.alpha}"
            )
        
        return SafeTargetResult(
            safe_target=safe_target,
            ruin_probability=safe_ruin_prob,
            results=safe_results,
            trade_off_curve=trade_off_curve,
        )


# ============================================================================
# Utilities
# ============================================================================

def create_default_ladders() -> List[LadderSpec]:
    """Create the default ladder configuration."""
    return [
        LadderSpec("L1", [5, 10, 15, 25, 40, 65, 105, 170, 275]),
        LadderSpec("L2", [50, 100, 150, 250, 400, 650, 1050, 1750]),
        LadderSpec(
            "L3", [500, 1000, 1500, 2500, 4000, 6500, 10500, 17000, 27500, 44500]
        ),
    ]


def print_results_summary(result: SafeTargetResult, config: SessionConfig):
    """Print human-readable summary of results."""
    print("\n" + "=" * 80)
    print("SAFE PROFIT TARGET ANALYSIS")
    print("=" * 80)
    print(f"\nSimulation Parameters:")
    print(f"  Bankroll:              ${config.bankroll:,.0f}")
    print(
        f"  Stop Loss:             ${config.stop_loss_abs:,.0f} "
        f"({config.stop_loss_abs/config.bankroll*100:.1f}% of bankroll)"
    )
    print(f"  Max Rounds:            {config.max_rounds:,}")
    print(f"  Sessions Simulated:    {result.results.n_sessions:,}")
    print(f"  House Edge:            {(1 - config.game_spec.p_win * 2)*100:.2f}%")

    print(f"\n{'-'*80}")
    print(f"RECOMMENDED SAFE PROFIT TARGET: ${result.safe_target:,.0f}")
    print(f"{'-'*80}")
    
    r = result.results
    print(f"\nSuccess Metrics:")
    print(f"  P(Hit Target):         {r.prob_hit_target*100:.2f}%")
    print(f"  P(Hit Stop Loss):      {r.prob_hit_stop_loss*100:.2f}%")
    print(f"  P(Table Limit):        {r.prob_hit_table_limit*100:.2f}%")
    print(f"  P(Max Rounds):         {r.prob_hit_max_rounds*100:.2f}%")
    print(f"  Ruin Probability:      {result.ruin_probability*100:.4f}%")
    
    print(f"\nPnL Metrics:")
    print(f"  Expected PnL:          ${r.mean_pnl:,.2f}")
    print(f"  Median PnL:            ${r.median_pnl:,.2f}")
    print(f"  Std Dev:               ${r.std_pnl:,.2f}")
    print(f"  95% CI:                [${r.pnl_95ci_lower:,.2f}, ${r.pnl_95ci_upper:,.2f}]")
    print(f"  Skewness:              {r.skew_pnl:.3f}")
    print(f"  Kurtosis:              {r.kurtosis_pnl:.3f}")
    
    print(f"\nSession Length:")
    print(f"  Mean Rounds:           {r.mean_rounds:.1f}")
    print(f"  Median Rounds:         {r.median_rounds:.1f}")
    if r.mean_rounds_to_target > 0:
        print(f"  Mean Rounds to Target: {r.mean_rounds_to_target:.1f}")
        print(f"  Median Rounds to Target: {r.median_rounds_to_target:.1f}")
    
    print(f"\nRisk Metrics:")
    print(f"  Mean Max Stake:        ${r.mean_max_stake:,.2f}")
    print(f"  Median Max Stake:      ${r.median_max_stake:,.2f}")
    print(f"  Mean Max Drawdown:     ${r.mean_max_drawdown:,.2f}")
    print(f"  Median Max Drawdown:   ${r.median_max_drawdown:,.2f}")
    print(f"  Mean Total Wagered:    ${r.mean_total_wagered:,.2f}")
    print(f"  P(Touch Ladder L1):    {r.prob_touch_ladder[0]*100:.1f}%")
    print(f"  P(Touch Ladder L2):    {r.prob_touch_ladder.get(1, 0)*100:.1f}%")
    print(f"  P(Touch Ladder L3):    {r.prob_touch_ladder.get(2, 0)*100:.1f}%")
    print(f"  P(Hit Top of Ladder):  {r.prob_top_of_ladder*100:.2f}%")
    
    print("\n" + "=" * 80)


# ============================================================================
# Unit Tests
# ============================================================================

def test_step_logic():
    """Test the basic stepping logic."""
    print("\nRunning unit tests...")
    
    # Test 1: Win at index 0 stays at 0
    ladder = LadderSpec("Test", [10, 20, 30])
    strategy = StrategyConfig(ladders=[ladder])
    game = GameSpec(name="test", payout_ratio=1.0, p_win=0.5)
    config = SessionConfig(bankroll=10000, profit_target=100, stop_loss_abs=1000, game_spec=game)
    rng = np.random.default_rng(42)
    
    sim = SessionSimulator(strategy, config, rng)
    sim.current_index = 0
    sim.step_index(won=True)  # Win
    assert sim.current_index == 0, "Win at index 0 should stay at 0"
    print("[PASS] Test 1: Win at index 0 stays at 0")

    # Test 2: Loss moves up 1
    sim.current_index = 0
    sim.step_index(won=False)  # Loss
    assert sim.current_index == 1, "Loss should move index up by 1"
    print("[PASS] Test 2: Loss moves up 1")

    # Test 3: Win moves down 2
    sim.current_index = 2
    sim.step_index(won=True)  # Win
    assert sim.current_index == 0, "Win should move index down by 2"
    print("[PASS] Test 3: Win moves down 2")

    # Test 4: Win at top of ladder stays in ladder
    sim.current_index = 2  # Max index
    sim.step_index(won=True)  # Win
    assert sim.current_index == 0 and sim.current_ladder == 0
    print("[PASS] Test 4: Win at top stays in ladder")
    
    print("All unit tests passed!\n")


def test_bridging_policies():
    """Test different bridging policies."""
    print("Testing bridging policies...")
    
    ladders = [
        LadderSpec("L1", [10, 20, 30]),
        LadderSpec("L2", [100, 200, 300]),
    ]
    
    # Test advance_to_next_ladder_start
    strategy = StrategyConfig(
        ladders=ladders, bridging_policy="advance_to_next_ladder_start"
    )
    game = GameSpec(name="test", payout_ratio=1.0, p_win=0.5)
    config = SessionConfig(bankroll=10000, profit_target=100, stop_loss_abs=1000, game_spec=game)
    rng = np.random.default_rng(42)
    
    sim = SessionSimulator(strategy, config, rng)
    sim.current_index = 2  # At top
    should_stop = sim.step_index(won=False)  # Loss at top
    assert not should_stop
    assert sim.current_ladder == 1 and sim.current_index == 0
    print("[PASS] advance_to_next_ladder_start works correctly")

    # Test carry_over_index_delta
    strategy = StrategyConfig(
        ladders=ladders, bridging_policy="carry_over_index_delta"
    )
    sim = SessionSimulator(strategy, config, rng)
    sim.current_index = 2  # At top
    should_stop = sim.step_index(won=False)  # Loss at top
    assert not should_stop
    assert sim.current_ladder == 1 and sim.current_index == 0
    print("[PASS] carry_over_index_delta works correctly")
    
    # Test stop_at_table_limit
    strategy = StrategyConfig(ladders=ladders, bridging_policy="stop_at_table_limit")
    sim = SessionSimulator(strategy, config, rng)
    sim.current_index = 2  # At top
    should_stop = sim.step_index(won=False)  # Loss at top
    assert should_stop and sim.stop_reason == "table_limit"
    print("[PASS] stop_at_table_limit works correctly")
    
    print("All bridging tests passed!\n")


# ============================================================================
# CLI
# ============================================================================

def main():
    parser = argparse.ArgumentParser(
        description="Monte Carlo simulator for loss-recovery staking strategy"
    )
    parser.add_argument(
        "--bankroll", type=float, default=800000, help="Initial bankroll (default: 800000)"
    )
    parser.add_argument(
        "--n-sessions",
        type=int,
        default=100000,
        help="Number of sessions (default: 100000)",
    )
    parser.add_argument(
        "--alpha", type=float, default=0.01, help="Max ruin probability (default: 0.01)"
    )
    parser.add_argument(
        "--policy",
        type=str,
        choices=[
            "advance_to_next_ladder_start",
            "carry_over_index_delta",
            "stop_at_table_limit",
        ],
        default="advance_to_next_ladder_start",
        help="Bridging policy (default: advance_to_next_ladder_start)",
    )
    parser.add_argument(
        "--profit-target-grid",
        type=str,
        default="50:5000:50",
        help="Profit target grid as min:max:step (default: 50:5000:50)",
    )
    parser.add_argument("--seed", type=int, default=42, help="Random seed (default: 42)")
    parser.add_argument(
        "--output-dir", type=str, default=".", help="Output directory (default: .)"
    )
    parser.add_argument(
        "--stop-loss-pct",
        type=float,
        default=10.0,
        help="Stop loss %% of bankroll (default: 10.0)",
    )
    parser.add_argument(
        "--max-rounds", type=int, default=5000, help="Max rounds (default: 5000)"
    )
    parser.add_argument("--run-tests", action="store_true", help="Run unit tests")
    
    args = parser.parse_args()
    
    if args.run_tests:
        test_step_logic()
        test_bridging_policies()
        return
    
    # Parse profit target grid
    grid_parts = args.profit_target_grid.split(":")
    if len(grid_parts) != 3:
        raise ValueError("profit-target-grid must be in format min:max:step")
    target_min, target_max, target_step = map(float, grid_parts)
    
    # Setup
    ladders = create_default_ladders()
    strategy = StrategyConfig(ladders=ladders, bridging_policy=args.policy)
    
    game = GameSpec(name="even_money", payout_ratio=1.0, p_win=0.495)
    
    base_config = SessionConfig(
        bankroll=args.bankroll,
        profit_target=100,  # Placeholder
        stop_loss_abs=args.bankroll * (args.stop_loss_pct / 100),
        max_rounds=args.max_rounds,
        game_spec=game,
        rng_seed=args.seed,
    )
    
    # Run safe target search
    print(f"\nSearching for safe profit target with alpha = {args.alpha}...")
    print(
        f"Testing targets from ${target_min:.0f} to ${target_max:.0f} "
        f"in steps of ${target_step:.0f}"
    )
    print(f"Using {args.n_sessions:,} sessions per target\n")
    
    finder = SafeTargetFinder(
        strategy=strategy,
        base_config=base_config,
        n_sessions=args.n_sessions,
        alpha=args.alpha,
        seed=args.seed,
    )
    
    result = finder.search_grid(
        target_min=target_min, target_max=target_max, target_step=target_step, verbose=True
    )
    
    # Print results
    print_results_summary(result, base_config)
    
    # Save results
    output_dir = Path(args.output_dir)
    output_dir.mkdir(exist_ok=True)

    # Generate timestamp for filenames
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")

    # Save JSON
    json_output = {
        "timestamp": timestamp,
        "parameters": {
            "bankroll": args.bankroll,
            "stop_loss_pct": args.stop_loss_pct,
            "stop_loss_abs": base_config.stop_loss_abs,
            "max_rounds": args.max_rounds,
            "n_sessions": args.n_sessions,
            "alpha": args.alpha,
            "bridging_policy": args.policy,
            "seed": args.seed,
            "house_edge": (1 - game.p_win * 2) * 100,
        },
        "safe_target": result.safe_target,
        "ruin_probability": result.ruin_probability,
        "results": result.results.to_dict(),
    }

    json_path = output_dir / f"simulation_results_{timestamp}.json"
    with open(json_path, "w") as f:
        json.dump(json_output, f, indent=2)
    print(f"\nResults saved to: {json_path}")

    # Save trade-off curve as CSV
    csv_path = output_dir / f"trade_off_curve_{timestamp}.csv"
    with open(csv_path, "w", newline="") as f:
        if result.trade_off_curve:
            writer = csv.DictWriter(f, fieldnames=result.trade_off_curve[0].keys())
            writer.writeheader()
            writer.writerows(result.trade_off_curve)
    print(f"Trade-off curve saved to: {csv_path}")


if __name__ == "__main__":
    main()