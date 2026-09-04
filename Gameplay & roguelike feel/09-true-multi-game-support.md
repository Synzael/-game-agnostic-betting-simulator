# Implementation prompt: True multi-game support

## Mission

Replace the TypeScript engine’s implicit even-money, win/loss-only model with a versioned, serializable game specification supporting non-1:1 payouts, pushes/ties, commission, and game-specific bet variants.

The vertical slice must correctly represent:

- A generic even-money bet.
- Baccarat Banker with commission and tie-as-push.
- Craps single odds bets for points 4/10, 5/9, and 6/8 with their correct payout variants.

The goal is a real game-module foundation, not merely labels on the existing ±stake calculation.

## Current code to change

- `src/engine/types.ts`: `BetRecord.won: boolean`, config and results.
- `src/engine/session.ts`: `roundPnl = won ? stake : -stake` and win/loss ladder stepping.
- `src/store/session-store.ts`: `recordBet(won)`.
- `src/components/session/BetInputPanel.tsx`: two result buttons.
- Graph dots/colors/labels and recap/stat logic that assumes boolean wins.
- Root `simulator.py` has `GameSpec(payout_ratio, p_win)` but no tie handling; it is reference material only.
- Presets/history/session persistence require migrations.

## Core model

Use a declarative, serializable registry. Do not persist functions in Zustand:

```ts
type ProgressionEffect = "win" | "loss" | "neutral";

interface GameOutcomeSpec {
  readonly id: string;
  readonly displayName: string;
  readonly probability: number;
  readonly netPayoutMultiplier: number;
  readonly progressionEffect: ProgressionEffect;
}

interface BetVariantSpec {
  readonly id: string;
  readonly displayName: string;
  readonly outcomes: readonly GameOutcomeSpec[];
  readonly settlementVersion: number;
}

interface GameSpec {
  readonly id: string;
  readonly version: number;
  readonly displayName: string;
  readonly description: string;
  readonly betVariants: readonly BetVariantSpec[];
}
```

`netPayoutMultiplier` is the net P&L divided by stake:

- Even-money win: `+1`; loss: `-1`.
- Banker win after 5% commission: `+0.95`; loss: `-1`; tie/push: `0`.
- Craps 4/10 odds win: `+2`; 5/9: `+1.5`; 6/8: `+1.2`; loss: `-1`.

Probabilities for every variant must sum to 1 within a documented tolerance and come from an authoritative, cited product constant file/comment when implemented. Do not guess. If exact casino rule variants differ, name the module/variant and assumptions explicitly.

For craps, model the point-specific odds bet as three selectable bet variants. Do not pretend one static payout ratio covers every point. A later stateful craps module may model come-out/point transitions.

## Money representation and rounding

Non-1:1 payouts expose floating-point errors. Establish one canonical approach:

- Prefer integer minor units (cents) inside settlement and engine comparisons.
- Convert existing dollar-number inputs at boundaries using validated decimal parsing.
- Define rounding for a payout that produces fractional cents. Use a named rule matching the module’s stated casino convention; do not rely on incidental `Math.round`.
- Format stored/displayed currency from minor units.

If a full engine migration to minor units is too large for one safe change, add an explicit `Money` utility with fixed decimal rounding and tests, then migrate all session P&L, target, stop, bankroll, stakes, histories, and forecasts in this feature. Do not mix dollars and cents in unbranded numeric fields.

## Engine transitions

Replace boolean input with a typed outcome:

```ts
interface RecordedOutcome {
  readonly gameId: string;
  readonly gameVersion: number;
  readonly betVariantId: string;
  readonly outcomeId: string;
}
```

`processBet` must:

1. Resolve the frozen game and bet variant from the session snapshot/registry.
2. Validate the recorded outcome belongs to that variant.
3. Calculate net P&L with canonical rounding.
4. Increment rounds and total wagered for win, loss, and push.
5. Update max stake/drawdown.
6. Check terminal limits against settled P&L.
7. Apply ladder movement from `progressionEffect`:
   - `win`: down two.
   - `loss`: up one and possibly bridge.
   - `neutral`: stay on the same ladder/index and do not bridge.

Keep a temporary compatibility adapter only where needed for tests/migrations:

```ts
recordLegacyBet(won: boolean)
```

New production UI and records must use typed outcomes.

## Session and history snapshots

Freeze enough game data at session start to replay/audit results after registry changes:

- Game ID/version and bet variant ID.
- Outcome definitions/probabilities/payouts used by the session.
- Settlement/rounding version.

Each `BetRecord` stores the typed outcome and exact settled net P&L. Graph/history should use settled P&L rather than recomputing old bets from today’s registry.

Migrate legacy data as:

- Game: `legacy_even_money`.
- Version: migration version.
- Variant: `even_money`.
- `won: true/false` maps to win/loss outcome.
- Preserve original numeric P&L exactly; do not retroactively add a house-edge probability to actual records.

Persisted active sessions must resume under their frozen game snapshot even after an app update.

## Setup and input UX

On Setup:

- Add Game selection before strategy preset.
- Then select a bet variant when the game has more than one.
- Show payout, push/tie behavior, assumed probabilities, and theoretical expected return per unit wagered.
- Explain that game modules model rules; they do not make a negative-EV game profitable.
- Freeze the selection at start. Changing game mid-session is out of scope.

During a session:

- Render buttons from the selected outcome specs: Win/Loss for even money, Banker Win/Loss/Tie for Banker, and Win/Loss for a selected craps odds point.
- Keep common Win/Loss controls large. Add Tie/Push as a distinct neutral control that is not styled as success/failure.
- On a push, show “Push — stake unchanged, ladder held.”
- Voice input remains limited to outcomes it can identify unambiguously.

Graphs:

- Add a neutral/push marker style and accessible legend.
- Do not classify a push as a win.
- Stats include win/loss/push counts and net return.

## Simulation and downstream integration

Update the canonical simulator to sample all outcomes from their probability distribution and settle them through the same production function.

Decision Ghosts, variance fan, optimizer, career risk, and expectation ledger must fingerprint game/variant/version. Old forecast caches are invalid when game or settlement versions change.

Card counting overlays must remain separate from the base game probability model unless an explicitly reviewed dynamic-probability integration is later built.

## Validation and edge cases

- Outcome probabilities negative, non-finite, or not summing to 1.
- Duplicate game/variant/outcome IDs.
- Missing registry version for a resumed session.
- Payout rounding at half-cent boundaries.
- Push at profit-target/stop boundary: terminal checks occur after zero settlement and should not newly trigger unless state was already invalid.
- Push at top of ladder does not bridge.
- Commission variants.
- Table max and affordability in minor units.
- Legacy histories and active sessions.
- A game update that changes probabilities but not payouts must still increment version.

## Tests

Add tests for:

- Registry validation and exact probability sum tolerance.
- Even-money parity with existing engine fixtures.
- Banker win/loss/tie settlement, including commission and cents.
- Craps point payout variants and expected values.
- Push increments rounds/wagered, leaves index unchanged, and never bridges.
- Drawdown/target/stop rules under fractional payouts.
- Typed outcome rejection across variants.
- Seeded Monte Carlo outcome frequencies within predeclared tolerances.
- Legacy active/history migrations and frozen snapshot resume.
- Graph/stats/input rendering for push and multi-outcome variants.
- Forecast cache invalidation by game/version.

Use property tests where practical for money conservation/settlement invariants and valid ladder indices.

## Acceptance criteria

- Production sessions no longer assume `won ? +stake : -stake`.
- Banker commission and tie handling produce audited exact results.
- Craps odds payout depends on the selected point variant.
- Pushes are neutral for ladder progression and visible throughout history.
- Old sessions migrate without changing their recorded P&L.
- Simulation and forecast fingerprints include the frozen game model.
- Core app remains offline and statically exportable.

## Out of scope

- A full craps table state machine.
- Dynamic card-count-adjusted baccarat probabilities.
- Side bets, parlays, partial wins, cash-out, or multi-leg wagers.
- Live casino data feeds.
- Changing games mid-session.

