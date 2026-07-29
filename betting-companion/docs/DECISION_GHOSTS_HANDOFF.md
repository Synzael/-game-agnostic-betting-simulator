# Decision Ghosts handoff

Last updated: 2026-07-28

## Status

Decision Ghosts is implemented end to end in the shared worktree but is not committed.

Important repository state:

- The work originally began for `feat/codex-1`.
- Other parallel work moved the shared checkout to `feat/codex-4`.
- The worktree also contains uncommitted Vault, multi-game, variance-fan, and optimizer work.
- Do **not** run `git add -A` or commit everything as a Decision Ghost change.
- Decision Ghosts currently integrates with the uncommitted multi-game/session foundation. It cannot be cleanly cherry-picked onto the old baseline without bringing that foundation along or adapting the simulator back to the legacy boolean game model.

Run `git status --short --branch` before making changes. Preserve all unrelated edits.

## Product goal

At every bridging decision, forecast the futures produced by each available choice from the exact current session state:

- Carry Over: probability of reaching its recovery mark and median additional drawdown.
- Write Off: probability of reaching the session target while accurately stating that current financial P&L remains.
- Stop Session: the exact deterministic ending P&L, with no fake probability.

The screen must remain usable while forecasts load or if forecasting fails. The feature is descriptive scenario analysis and never recommends a choice.

## Delivered user experience

The existing decision screen now includes:

- A “Decision Ghosts” status card.
- Loading skeletons while the worker starts.
- A 1,000-path preview followed by a 10,000-path refined result.
- Progress text while the full batch runs.
- Carry Over copy in the form:
  - `{N}% recover to {recovery target}`
  - `Median further drop {currency}`
- Write Off copy in the form:
  - `{N}% reach the session target`
  - `Current P&L stays {currency}`
- Stop copy in the form:
  - `Exact outcome`
  - `Ends now at {currency}`
- An assumptions disclosure explaining the frozen game/variant, matched paths, automatic future bridge policy, local processing, and estimates-not-guarantees constraint.
- A non-blocking error state: “Forecast unavailable — choices still work.”

The choice buttons are never disabled by forecasting.

## End-to-end flow

```text
Paused bridge SessionState
        |
        +-- apply production Carry Over transition
        |        |
        |        +-- simulate to terminal state
        |
        +-- apply production Write Off transition
                 |
                 +-- simulate to terminal state

Both branches use the same numbered outcome seed for each sample.
        |
        +-- aggregate preview at 1,000 paths
        +-- aggregate final result at 10,000 paths
        |
        +-- render branch metrics on DecisionScreen
```

## Simulation semantics

### Starting state

`simulateOneSession` accepts:

- The supplied `SessionState`.
- Frozen `SessionConfig`.
- Frozen `StrategyConfig`.
- A deterministic seed.
- The session’s `FrozenGameSnapshot`.
- An optional recovery target to track.

It never calls `createInitialState` and defensively clones `ladderTouches`. Live state, history, and RNG are not mutated.

### First decision

`createDecisionGhostAccumulator` validates that the state:

- Is active.
- Is awaiting a bridging decision.
- Has another ladder available.

It applies the real `processBridgingDecision` function once for Carry Over and once for Write Off. This prevents forecast/live transition drift.

### Later bridge decisions

Later bridge points are resolved by `processAutomatedBridge`, using the frozen `StrategyConfig.bridgingPolicy`:

- `carry_over_index_delta` carries over and applies recovery behavior.
- `advance_to_next_ladder_start` advances at index zero.
- `stop_at_table_limit` terminates at the bridge.

The forecast does not model future human changes of mind. This assumption is disclosed in the UI.

### Game outcomes

The simulator samples the complete frozen outcome distribution:

- Non-1:1 payouts settle through `processOutcome`.
- Commission uses the canonical cents settlement.
- Pushes/ties use the neutral progression effect.
- Target, stop-loss, affordability, table limits, drawdown, and max-round checks all use production engine behavior.

Do not replace this with `Math.random()` or a hard-coded `pWin`.

### Common random paths

For each sample index, Carry Over and Write Off receive the same derived seed. This “common random numbers” design makes branch comparisons less noisy.

The UI seed comes from a canonical fingerprint of:

- Engine version.
- Exact state.
- Config.
- Strategy.
- Frozen game snapshot.

Identical inputs therefore reproduce identical forecasts.

### Metric definitions

- `probHitTarget`: terminal reason is `profit_target`.
- `probReachRecoveryMark`: Carry Over reaches the recovery target at least once before termination.
- `probTerminalFailure`: combined stop loss, max rounds, table limit, bankroll exhaustion, or user stop.
- `medianAdditionalDrawdown`: median across paths of the greatest amount P&L falls below P&L at the decision point.
- `p90AdditionalDrawdown`: 90th percentile of the same quantity; retained for future detail UI.
- `medianRoundsRemaining`: median additional rounds to terminal state.

Write Off does not erase or financially lock the current loss. The current engine resets ladder/recovery state and retains `state.pnl`; the shipped copy deliberately says “Current P&L stays.”

## Files

### New Decision Ghost files

- `src/engine/monte-carlo.ts`
  - Seeded PRNG.
  - Defensive state clone.
  - `simulateOneSession` from arbitrary state.
  - Frozen multi-outcome game sampling.
- `src/engine/decision-ghosts.ts`
  - Branch initialization.
  - Matched sample seeds.
  - Accumulators and statistical summaries.
  - Canonical input fingerprint and stable seed.
- `src/workers/decision-ghosts.protocol.ts`
  - Typed start/cancel/progress/preview/final/error messages.
- `src/workers/decision-ghosts.worker.ts`
  - Bounded CPU batches.
  - Preview and final responses.
  - Cancellation points and stale-job replacement.
- `src/components/decision/useDecisionGhosts.ts`
  - Worker lifecycle.
  - Eight-entry in-memory completed-forecast cache.
  - Request IDs and stale-response filtering.
  - Loading/preview/ready/error view states.
- `src/engine/monte-carlo.test.ts`
- `src/engine/decision-ghosts.test.ts`
- `src/components/decision/DecisionScreen.test.tsx`

### Modified shared files

- `src/components/decision/DecisionScreen.tsx`
  - Connects active state/config/strategy/game to the hook.
  - Renders status, branch metrics, exact Stop result, and assumptions.
  - Derives the recovery target through the production decision transition.
- `src/engine/index.ts`
  - Exports Monte Carlo and Decision Ghost types/functions.
  - This file also contains exports from other parallel features; stage hunks carefully.
- `src/engine/session.ts`
  - Decision Ghosts depends on `processAutomatedBridge` and typed `processOutcome`.
  - Those larger engine changes belong to the concurrent multi-game/variance work.
  - The only Decision Ghost cleanup made directly here was lint-safe `const` usage.
- Several existing tests were updated for the concurrent typed-outcome/cents model:
  - `src/engine/session.test.ts`
  - `src/store/session-store.test.ts`
  - `src/engine/ladder.test.ts`

## Worker lifecycle

- Preview samples: `DECISION_GHOSTS_PREVIEW_SAMPLES = 1_000`.
- Final samples: `DECISION_GHOSTS_TOTAL_SAMPLES = 10_000`.
- Worker batch size: 100 paired samples.
- Progress message interval: 500 samples.
- Each batch yields with `setTimeout(..., 0)` so cancel/new-start messages can be processed.
- A new request ID supersedes an old request.
- Component cleanup sends cancel and terminates the worker.
- Only completed final forecasts enter the bounded memory cache.
- A worker error never blocks Carry Over, Write Off, or Stop.

If mobile profiling shows slow previews, tune sample counts or batch size only after measuring. Keep the values centralized.

## Tests and validation

Focused coverage includes:

- Starting at a supplied mid-session P&L/round/ladder state.
- No input-state mutation.
- Deterministic seeded runs.
- Automatic later bridges.
- Recovery-mark detection.
- Additional drawdown.
- All-win and all-loss forecasts.
- Commission payout settlement.
- Neutral push sampling and ladder hold.
- Canonical fingerprints.
- Preview metrics on the decision cards.
- Decisions remaining usable during loading.
- All choices remaining usable after worker failure.
- Stop showing an exact outcome rather than a probability.

Commands:

```bash
cd betting-companion

npm run test -- --run
./node_modules/.bin/tsc --noEmit
npm run build

./node_modules/.bin/eslint \
  src/components/decision/useDecisionGhosts.ts \
  src/components/decision/DecisionScreen.tsx \
  src/engine/monte-carlo.ts \
  src/engine/decision-ghosts.ts \
  src/engine/session.ts \
  src/workers/decision-ghosts.worker.ts \
  src/workers/decision-ghosts.protocol.ts
```

Validation completed during implementation:

- Full test suite passed at the time: 281 tests.
- Focused Decision Ghost/session suite passed: 85 tests.
- TypeScript passed.
- Static production build passed.
- The build emitted a client decision page and separate worker chunk.
- Feature-scoped ESLint passed.

Parallel features continued adding files after those runs. Re-run all gates before committing.

## Manual verification

1. Run `npm run dev`.
2. Start an even-money session with the default L1 ladder, $10,000 bankroll, and $1,000 stop loss.
3. Enter nine consecutive losses. The ninth loss at the L1 top should open `/decision` before the stop loss.
4. Confirm:
   - The screen first shows loading skeletons.
   - A 1,000-path preview appears.
   - Progress continues to 10,000.
   - Carry Over shows recovery probability and median further drop.
   - Write Off shows target probability and retained current P&L.
   - Stop shows an exact ending value.
5. Reload on the same decision and confirm deterministic final values.
6. Click a choice before the preview finishes and confirm navigation/state transition succeeds.
7. Repeat with Baccarat Banker and confirm the disclosure names Baccarat/Banker and the forecast completes with commission/tie rules.
8. Test a narrow phone viewport and reduced motion.

The collaborative T3 browser preview was unavailable during implementation, so the visual check still needs to be performed in a real browser/device.

## Known limitations

- Forecasts assume independent outcomes from the frozen game model.
- They do not consume card-counting state or predict real card sequences.
- Later decisions follow the frozen automatic policy rather than modeling adaptive human decisions.
- Completed forecasts are cached only in memory and are not persisted across a full app restart.
- Worker cancellation is implemented and indirectly exercised through component cleanup, but there is no dedicated worker-runtime unit test.
- The 10,000-path final batch needs physical mid-range iPhone/Android performance profiling.
- Decision Ghosts and the variance fan share the seeded PRNG and production engine but still have separate aggregation/trajectory code. Consolidate only where it reduces drift without forcing unrelated result shapes together.

## Recommended next actions

1. Let parallel feature work settle, then run every validation command again.
2. Perform the manual bridge flow on a phone-sized browser and physical mobile device.
3. Measure preview time, final time, input responsiveness, and battery/thermal impact.
4. Add a fake-worker lifecycle test covering cancel and stale responses if this feature is made release-blocking.
5. Decide whether completed forecasts should persist with the active decision state.
6. Stage only the Decision Ghost files and reviewed shared hunks.
7. If Decision Ghosts must live alone on `feat/codex-1`, first decide whether to:
   - include the multi-game/money/automated-bridge foundation, or
   - adapt `monte-carlo.ts` back to the old even-money boolean engine.

Do not silently take the second option; it would remove correct commission, tie, and multi-game forecast behavior.

