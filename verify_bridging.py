
from simulator import StrategyConfig, SessionConfig, SessionSimulator, LadderSpec
import numpy as np

def verify_carry_over_logic():
    print("Verifying carry_over_index_delta logic...")
    
    # Setup
    ladders = [
        LadderSpec("L1", [10, 20, 30]),
        LadderSpec("L2", [100, 200, 300]),
    ]
    
    # Config: Recover 50% of loss, Offset 1 (start at index 1 of next ladder)
    strategy = StrategyConfig(
        ladders=ladders, 
        bridging_policy="carry_over_index_delta",
        recovery_target_pct=0.5,
        crossover_offset=1
    )
    config = SessionConfig(bankroll=10000, profit_target=1000, stop_loss_abs=1000)
    rng = np.random.default_rng(42)
    
    sim = SessionSimulator(strategy, config, rng)
    
    # 1. Force loss at top of L1
    print("\n--- Step 1: Force loss at top of L1 ---")
    sim.current_ladder = 0
    sim.current_index = 2  # Top of L1 (stake 30)
    sim.pnl = -50.0 # Assume we lost some already
    
    print(f"Before bridging: Ladder {sim.current_ladder}, Index {sim.current_index}, PnL {sim.pnl}")
    
    # Trigger loss -> should bridge
    sim.step_index(won=False)
    
    print(f"After bridging:  Ladder {sim.current_ladder}, Index {sim.current_index}, PnL {sim.pnl}")
    print(f"In Recovery: {sim.in_recovery}")
    print(f"Recovery Target PnL: {sim.recovery_target_pnl}")
    
    # Checks
    assert sim.current_ladder == 1, "Should be in Ladder 2"
    assert sim.current_index == 1, "Should be at index 1 (offset 1)"
    assert sim.in_recovery == True, "Should be in recovery mode"
    
    # Target calculation:
    # Current PnL was -50. Loss of 30 (stake at index 2) happens BEFORE step_index? 
    # Wait, step_index is called AFTER the bet is resolved.
    # In play_round: 
    #   won, round_pnl = resolve_bet()
    #   self.pnl += round_pnl
    #   step_index(won)
    
    # So if we manually set PnL to -50 and call step_index(False), 
    # the simulator assumes the loss JUST happened.
    # So current_loss = 50.
    # Target = -50 + (50 * 0.5) = -25.
    expected_target = -50 + (50 * 0.5)
    assert abs(sim.recovery_target_pnl - expected_target) < 0.001, f"Expected target {expected_target}, got {sim.recovery_target_pnl}"
    print("✓ Bridging and Target Calculation correct")
    
    # 2. Simulate winning in L2 until recovery
    print("\n--- Step 2: Simulate winning in L2 ---")
    # Current state: L2, Index 1 (Stake 200). PnL -50. Target -25.
    # Win 1 bet: +200. New PnL +150.
    # This should trigger recovery completion.
    
    sim.pnl = 150 # Simulate the win effect on PnL
    stop = sim.step_index(won=True)
    
    print(f"After win: Ladder {sim.current_ladder}, Index {sim.current_index}, PnL {sim.pnl}")
    print(f"In Recovery: {sim.in_recovery}")
    
    assert sim.current_ladder == 0, "Should return to Ladder 1"
    assert sim.current_index == 0, "Should return to Index 0"
    assert sim.in_recovery == False, "Should clear recovery mode"
    print("✓ Recovery completion correct")

if __name__ == "__main__":
    verify_carry_over_logic()
