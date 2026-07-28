# Implementation prompt: Decision Ghosts

## Mission

Turn every bridging decision into a “fortune-teller” moment by simulating the possible futures from the exact current session state. Show concise, conditional outcome forecasts inside the existing Carry Over, Write Off, and Stop Session cards without choosing for the user.

Example tone:

> Carry Over — 41% reach the recovery mark; median additional drawdown $310.
>
> Write Off — 55% reach the session target; current −$180 P&L remains.
>
> Stop — ends now at −$180.

The figures above are illustrative only. Never hard-code or display placeholder probabilities as real results.

## Product intent and non-negotiables

- This is descriptive scenario analysis, not a recommendation engine.
- Forecasts are conditional on the current recorded state and on explicit model assumptions.
- The UI must say that simulations are estimates, not guarantees.
- Do not visually crown a “best” choice, sort cards by probability, or add “recommended” copy.
- Stop Session is deterministic and must not be presented as a simulated outcome.
- The decision remains usable if the forecast worker fails or is unavailable.
- All simulation runs locally and off the main thread.

## Current code to extend

- `src/engine/types.ts`: `SessionState`, `SessionConfig`, `StrategyConfig`, decisions, results.
- `src/engine/session.ts`: `processBet` and `processBridgingDecision`.
- `src/store/session-store.ts`: exact active state, bet history, and decision action.
- `src/components/decision/DecisionScreen.tsx`: current three decision cards.
- `src/engine/session.test.ts` and store tests.
- Root `simulator.py`: reference Monte Carlo semantics only; it cannot be a runtime dependency.

On the current main branch there is no browser Monte Carlo implementation. If the implementation branch already has `simulateOneSession` and a risk-check worker, extend those. Otherwise add a reusable seeded TypeScript simulator and worker as part of this feature.

## Forecast semantics

At a state where `awaitingDecision === true` and `pendingDecisionType === "bridging"`:

1. Deep-clone the current `SessionState`.
2. Apply exactly one candidate decision with the same production transition used by the live session.
3. Simulate forward from the resulting state until a terminal stop condition.
4. Resolve any later bridge automatically using the selected strategy’s non-interactive bridging policy. For the existing `carry_over_index_delta` preset behavior, later bridges carry over while a next ladder exists. Document this continuation assumption in the detail sheet.
5. Use the same numbered seed stream for corresponding samples in the Carry Over and Write Off branches (“common random numbers”) so comparisons have less Monte Carlo noise.
6. Never mutate the live store, consume live RNG state, or add simulated bets to history.

Add a function with an API equivalent to:

```ts
interface SimulationStart {
  readonly state: SessionState;
  readonly config: SessionConfig;
  readonly strategy: StrategyConfig;
}

interface SimulationOptions {
  readonly seed: number;
  readonly maxAdditionalRounds?: number;
}

function simulateOneSession(
  start: SimulationStart,
  options: SimulationOptions
): SimulatedSessionResult;
```

`state` must be validated and cloned. The function must accept an arbitrary valid mid-session state rather than calling `createInitialState`.

Define the branch metrics precisely:

- `probHitTarget`: probability the session reaches its configured profit target.
- `probHitStop`: combined probability of stop loss, table limit, bankroll exhaustion, or max-round cutoff. Also retain each cause separately for details.
- `probReachRecoveryMark`: for Carry Over, probability of reaching the recovery target created by that decision before a terminal failure. If already at or above the mark, return 1.
- `medianAdditionalDrawdown`: median, across paths, of the greatest amount P&L falls below the P&L at the decision point. This is not lifetime `maxDrawdown`.
- `p90AdditionalDrawdown`: 90th percentile of the same value for an expanded detail view.
- `medianRoundsRemaining`: median additional rounds before terminal state.
- `sampleCount`, `seed`, `engineVersion`, and an assumptions fingerprint.

Write Off does not erase financial P&L. It resets the ladder/recovery state while retaining `state.pnl`; use wording such as “current P&L remains,” not “loss disappears.” Stop Session shows current P&L and round count with no probability.

## Forecast orchestration

- Run simulations in a dedicated Web Worker.
- Use a deterministic default seed derived from a stable state/config fingerprint plus an engine-version salt. The same decision state must reproduce the same display.
- Use a stable canonical serializer rather than raw object key order for fingerprints.
- Start with a fast preview batch and refine to the production sample count. Suggested shape: 1,000 samples for preview, then 10,000 total. Make counts constants that tests can override.
- Report progress and sample count. Replace preview figures atomically; do not animate through random-looking values.
- Cancel work when the decision is made, the state fingerprint changes, or the component unmounts.
- Cache only completed forecasts by fingerprint and engine version. Bound the cache and do not persist large raw trajectories.
- Reject stale worker responses by request ID.
- If the worker errors, show “Forecast unavailable — choices still work” and keep all decision actions enabled.

## User experience

Keep the existing dramatic decision screen and cards. Add:

- A small “Decision Ghosts” label and “Simulated from round N” context.
- A skeleton in the metric area while forecasts load.
- Two primary facts per actionable branch, optimized for quick scanning.
- A “How this was estimated” disclosure containing sample count, game win/push assumptions, future bridge policy, and an estimates-not-guarantees note.
- Stop Session’s exact outcome in the same visual rhythm as forecast cards.
- A compact worker-error state that does not dominate the decision.

Do not delay or disable clicking Carry Over, Write Off, or Stop while forecasts run. Do not use urgent countdowns, celebratory effects, or probability-colored “good/bad” judgments.

## Engine consistency requirements

- Extract or share transition logic so live play and simulation cannot drift.
- The simulation must honor starting ladder/index, P&L, rounds, wager totals, peak P&L, recovery state, table max, remaining bankroll, maximum rounds, payout rules, and terminal rules.
- The simulation may bypass interactive pauses only through an explicit simulation policy; production live state must still pause.
- If multi-game `GameSpec` exists, sample its full outcome distribution including pushes and non-1:1 payouts. If it does not exist, isolate the even-money assumption behind a versioned game model rather than scattering `0.495`.
- Do all financial comparisons with the project’s canonical rounding rules.

## Edge cases

- No next ladder: omit/disable Carry Over exactly as production does; do not simulate an impossible action.
- Decision state already terminal or malformed: return a typed validation error and render the normal deterministic choices where safe.
- Remaining max rounds is zero.
- Current bankroll cannot afford the post-decision stake.
- Table max blocks the next stake.
- Recovery target is already satisfied.
- Very small sample batches with no target hits.
- Persisted active sessions created before forecast fields existed.
- Route remount while the same forecast is still running.

## Tests

Add deterministic tests that cover:

- Starting from a supplied mid-session state preserves all state fields and does not call initial-state creation.
- Applying the first branch uses the exact production decision transition.
- Identical seeds and inputs produce byte-equivalent aggregate results.
- Live state, history, and Zustand storage are unchanged by simulation.
- A contrived `pWin = 1` game always hits the expected successful terminal path.
- A contrived `pWin = 0` game always reaches the expected failure path.
- Recovery probability and additional drawdown definitions on hand-checkable traces.
- Later bridging follows the documented automatic continuation policy.
- Worker cancellation and stale-response rejection.
- Loading, success, error, and “click before forecast completes” UI behavior.
- Stop Session never shows a Monte Carlo probability.

## Acceptance criteria

- At every valid bridge, both non-terminal choices receive forecasts derived from the exact current state.
- Forecasts are reproducible, local, non-blocking, and cancelable.
- The decision can be completed immediately with or without the worker.
- UI copy clearly distinguishes recovery mark, session target, and deterministic stop.
- No simulated event leaks into live state or history.
- Existing session, decision, history, and graph tests still pass.

## Out of scope

- Predicting real-world card sequences from card counting.
- Cloud simulation or account sync.
- Automatically selecting a decision.
- Live variance fan rendering; that is covered by `07-live-variance-fan.md`.
- Optimizing ladder shapes; that is covered by `08-in-app-ladder-optimizer.md`.
