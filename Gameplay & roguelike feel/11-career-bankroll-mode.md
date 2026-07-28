# Implementation prompt: Career bankroll mode

## Mission

Add an opt-in persistent bankroll campaign that carries realized P&L across completed sessions. Track deposits/withdrawals separately, calculate actual lifetime drawdown, and estimate a clearly horizon-bounded career risk of ruin from the current balance.

This is accounting and risk visibility, not a deposit prompt or progression advantage.

## Product constraints

- Career mode is off by default and requires an explicit opening-balance confirmation.
- Never call a deposit “recovery,” award XP for adding funds, or prompt the user to replenish losses.
- Session P&L and external bankroll adjustments must remain separate in the ledger.
- All accounting is local, deterministic, auditable, and idempotent.
- “Risk of ruin” must always state a horizon and model assumptions. Do not present an unbounded “lifetime” probability from a finite simulation.
- Disabling Career mode pauses future posting but does not erase the ledger.

## Current code to extend

- `SessionConfig.bankroll` currently acts as the live session bankroll/affordability base.
- `SessionResult` stores final P&L, config, start/end time, and intrarun max drawdown.
- History retains only the newest 100 full sessions, which is not sufficient for lifetime accounting.
- Summary persistence must be made idempotent by session ID.
- Browser-side Monte Carlo may exist after Decision Ghosts/Fan; otherwise career risk needs the same reusable worker foundation.

## Ledger model

Use integer minor units and an append-only, versioned ledger:

```ts
type CareerEntry =
  | {
      readonly type: "opening_balance";
      readonly id: string;
      readonly amountMinor: number;
      readonly occurredAt: number;
    }
  | {
      readonly type: "session_result";
      readonly id: string;
      readonly sessionId: string;
      readonly pnlMinor: number;
      readonly sessionStartBalanceMinor: number;
      readonly intrarunMinimumDeltaMinor: number;
      readonly occurredAt: number;
    }
  | {
      readonly type: "adjustment";
      readonly id: string;
      readonly direction: "deposit" | "withdrawal";
      readonly amountMinor: number;
      readonly occurredAt: number;
      readonly note?: string;
    };

interface CareerCampaign {
  readonly id: string;
  readonly schemaVersion: number;
  readonly createdAt: number;
  readonly status: "active" | "paused";
  readonly entries: readonly CareerEntry[];
}
```

Derive current balance from the ledger; do not persist a mutable balance as the only source of truth. A session result entry ID must be deterministic from career ID and session ID, making duplicate posting impossible.

Store a compact summary for every career-linked session independent from the 100-item history cap. Clearing ordinary history must not change career accounting.

## Session integration

At setup:

- Let the user opt into the active career.
- Show current career balance.
- Default the session bankroll/affordability base to the full current career balance.
- If allowing a smaller “at-table allocation,” model it as an explicit session allocation bounded by career balance; do not subtract it as a deposit/withdrawal.
- Freeze `careerId`, starting career balance, allocation, and ledger revision in the session snapshot.
- Profit target and stop loss remain session-specific limits.

During a session:

- Affordability uses the frozen session allocation/current session P&L.
- Other tabs/routes cannot post an adjustment that retroactively changes the active session start balance.
- If adjustments during an active session are allowed, they affect only future sessions and are clearly labeled.

At completion:

- Post final P&L exactly once for every valid terminal reason, including manual stop.
- Record the intrarun minimum delta. Prefer exact `min(0, ...betHistory.pnlAfter)`; add a `minimumPnl` aggregate to `SessionResult` so career drawdown remains exact even if full bet history is later compacted.
- If a linked career was deleted/corrupt, preserve the ordinary session result and show a reconciliation action; never discard history.
- An abandoned/replaced active session without a `SessionResult` posts nothing.

## Adjustments

- Deposits and withdrawals require amount, direction, confirmation, and optional short note.
- They are not P&L and do not alter win rate, expected-vs-actual stats, XP, or trophy metrics.
- Prevent backdating in the MVP, or define strict ordering if it is allowed later.
- Never allow editing a posted entry in place. Correction uses a reversing adjustment with an audit link.
- Provide export before destructive campaign deletion.

## Metrics

Calculate through pure functions:

- Opening balance.
- Total session P&L.
- Net external adjustments.
- Current balance.
- Peak balance after each ordered ledger event.
- Lifetime maximum drawdown including intrarun troughs.
- Current drawdown from peak.
- Best/worst session by P&L, clearly separate from deposits.
- Session count and controlled-exit counts.

For maximum drawdown:

1. Start with opening balance.
2. For each session entry, consider `sessionStartBalance + intrarunMinimumDelta` before its ending balance.
3. Update peak only from actual chronological balance points.
4. Adjustments create a new balance point but a withdrawal must not be labeled gambling drawdown. Report market/session drawdown separately from owner withdrawals, or normalize peaks across external cash flows using a documented cash-flow-adjusted method.

Choose and test one method. The UI must explain it.

## Career risk of ruin

Define a versioned forecast:

> Probability that the simulated career balance reaches the ruin threshold within the next **N sessions**, assuming the selected game, preset, per-session limits, and session-allocation rule remain fixed.

Requirements:

- Let the user choose a bounded horizon such as 10, 25, 50, or 100 sessions.
- Define ruin as balance below the minimum affordable starting stake or zero, whichever is stricter for the selected strategy.
- Simulate sessions sequentially; each final P&L updates the next session’s bankroll.
- Stop a simulated career path at ruin or the horizon.
- Use the canonical game/session simulator in a Web Worker.
- Return point estimate, confidence interval, sample count, seed, horizon, engine/game/preset versions, and assumptions fingerprint.
- Invalidate forecasts when balance, adjustments, horizon, allocation rule, game, limits, or preset changes.
- Say “within N sessions,” never “lifetime risk.”
- If no compatible simulator exists, ship the ledger/metrics first and keep this feature incomplete rather than using a heuristic mislabeled as risk of ruin.

## User experience

Add a Career dashboard:

- Current balance and cash-flow-separated total P&L.
- Balance curve with deposits/withdrawals visually distinct from session returns.
- Peak, current drawdown, and lifetime session drawdown.
- Horizon-labeled risk card with assumptions disclosure.
- Chronological ledger and session links.
- Pause, export, adjustments, and delete controls.

Setup and Summary must show when a session is linked and the before/after career balance. A losing session receives the same neutral accounting treatment as a winning one. Do not add “win it back” copy or a one-tap new-session CTA to the loss state.

## Persistence, migration, and export

- Use a dedicated versioned store. Consider IndexedDB if the ledger/export grows; compact ledger summaries fit Zustand localStorage.
- Old sessions are not automatically assigned to a new career.
- Offer an explicit one-time import only if chronological data and minimum P&L are sufficient; preview its effect before committing.
- Export a versioned JSON/CSV ledger with separate entry types and money units.
- Career deletion is separate from History/Vault/Discipline deletion and requires exact scope confirmation.
- Handle localStorage quota/corruption without overwriting the last valid ledger.

## Tests

Add tests for:

- Balance derivation across sessions, deposits, withdrawals, and reversals.
- Duplicate session posting is a no-op.
- Manual-stop and stop-loss results both post.
- Abandoned/replaced sessions do not post.
- Full-balance and bounded allocation affordability.
- Intrarun trough lifetime drawdown.
- Cash-flow-adjusted drawdown behavior for deposits/withdrawals.
- History clear/trim independence.
- Pause/resume and missing-career reconciliation.
- Horizon simulation with deterministic all-win/all-loss fixtures.
- Ruin threshold, confidence interval, invalidation fingerprint, and sequential bankroll updates.
- Schema migration, export round-trip, quota/corruption recovery.

## Acceptance criteria

- Opted-in completed sessions update one auditable campaign ledger exactly once.
- Current balance reconciles opening balance, P&L, and explicit adjustments.
- Lifetime drawdown includes intrarun troughs and treats cash flows according to a documented rule.
- Ordinary history retention/deletion cannot alter career totals.
- Career ruin estimates are local, reproducible, confidence-bounded, and always horizon-labeled.
- Career mode creates no gameplay or progression advantage.

## Out of scope

- Bank/casino account connections.
- Real-money transfers.
- Multiple currencies or tax accounting.
- Cross-device/cloud sync.
- Unlimited-horizon analytical ruin formulas.
- XP, badges, or unlocks for bankroll size/deposits.

