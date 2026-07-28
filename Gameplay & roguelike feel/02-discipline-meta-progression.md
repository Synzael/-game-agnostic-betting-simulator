# Implementation prompt: Discipline meta-progression

## Mission

Add a career progression layer where every XP award recognizes a controllable process behavior, never profit, wager volume, session length, winning streaks, or financial outcome. Levels unlock Art Deco cosmetic themes and card backs only.

The product story is simple: Velvet Stakes rewards setting boundaries and walking away.

## Product rules

- XP must never increase because the user won more, bet more, played longer, bridged more, or deposited more.
- Reaching a target and hitting a stop loss must award equal-value “honored exit” XP when the configured boundary ends the session.
- Ending early must not be punished. A deliberate manual stop may earn a small “chose to stop” process award.
- Cosmetics must not alter stakes, odds, simulations, presets, progression rules, input speed, or decision availability.
- Do not use loss-chasing language, randomized rewards, loot boxes, daily streak pressure, expiring rewards, or near-miss effects.
- All data stays local and works offline.

## Current code to extend

- `src/store/session-store.ts`: session lifecycle and final result creation.
- `src/store/history-store.ts`: completed result persistence, currently capped at 100.
- `src/engine/types.ts`: session/config snapshots and event types.
- `src/app/summary/page.tsx`: completion presentation.
- `src/app/page.tsx`: home navigation and quick stats.
- `src/app/globals.css` and `docs/DESIGN_DIRECTION.md`: visual system.

The current summary page can call `addSession` more than once under remount/Strict Mode. Build progression awarding around an idempotent completion transaction keyed by `SessionResult.id`; do not rely on a one-time effect.

## Data model

Add a versioned persisted career/progression store, separate from session history:

```ts
type DisciplineAction =
  | "limits_locked"
  | "boundary_honored"
  | "manual_stop"
  | "challenge_honored";

interface XPAward {
  readonly id: string;
  readonly sessionId: string;
  readonly action: DisciplineAction;
  readonly xp: number;
  readonly awardedAt: number;
  readonly rulesVersion: number;
}

interface DisciplineProfile {
  readonly schemaVersion: number;
  readonly totalXp: number;
  readonly level: number;
  readonly awardsBySession: Record<string, readonly XPAward[]>;
  readonly unlockedCosmeticIds: readonly string[];
  readonly activeThemeId: string;
  readonly activeCardBackId: string;
}
```

Keep an append-only award ledger as the source of truth and derive total XP, level, and unlocks. Persist enough data to audit “why did I get this XP?” without keeping duplicate bet histories.

Add session compliance facts to `SessionResult` or a versioned `discipline` snapshot:

- Initial limits and final/effective limits.
- A typed list of mid-session limit edits, if that feature exists.
- Whether the session ended through an enforced boundary, manual stop, or invalid/abandoned replacement.
- Challenge IDs and their completion checks, when challenge runs exist.

Do not infer edit compliance from the current UI merely because editing is not currently exposed; model it explicitly so later settings cannot silently break XP.

## XP rules

Put XP amounts and level thresholds in a versioned pure rules module. A reasonable initial table is:

| Action | Condition | XP |
| --- | --- | ---: |
| Limits locked | Completed a session without widening stop loss, increasing target, or changing ladder/policy mid-run | 25 |
| Boundary honored | Session ended automatically at either profit target **or** stop loss | 40 |
| Chose to stop | User deliberately ended an active session | 40 |
| Challenge honored | Each selected challenge’s deterministic end check passes | 25 |

These values are product constants, not final balancing requirements; keep them easy to change without a storage migration. The invariants are more important:

- Target and stop-loss exits award the same XP.
- Final P&L does not enter any formula.
- Rounds, total wagered, max stake, and bridge count do not increase base XP.
- A single action can award at most once per session.
- Reloading, revisiting summary, importing duplicated history, or React Strict Mode cannot duplicate XP.
- An invalid/corrupt session earns no award and produces an auditable reason.

Use explicit level thresholds, for example an increasing array of cumulative XP. Do not make levels infinite through a formula without tests. Cosmetic unlocks map to fixed levels through a registry.

## Cosmetics

Create a typed cosmetic registry:

- Default noir theme and default card back are always unlocked.
- New themes may change CSS custom properties, texture, borders, and decorative motifs.
- Card backs appear only in cosmetic/profile/trophy surfaces unless actual game cards are later introduced.
- Every theme must preserve readable contrast and semantic emerald/amber/crimson states.
- Reduced motion remains respected.
- If a stored cosmetic no longer exists, fall back to default without deleting the unlock history.

Ship a small vertical slice: at least two unlockable themes and two card backs using code-native CSS/SVG assets. Do not add large raster assets unless necessary.

## User experience

Add:

- A “Discipline” or “Career” entry from Home.
- Profile header with level, current XP, and progress to the next level.
- A recent-awards ledger with plain-language reasons and session dates.
- A cosmetics grid showing locked level, unlocked state, preview, and active selection.
- Summary-page XP breakdown after a session, with equal visual treatment for target, stop-loss, and manual-stop discipline.
- A clear line: “XP tracks process, never profit.”

Do not show XP popups while a session is active. Award and present XP only after the session has ended so it cannot incentivize another bet.

## Persistence and migration

- Use a new namespaced Zustand key with an explicit schema version and migration function.
- Never derive the durable award ledger from only the last 100 history records.
- Provide a best-effort, one-time backfill for old `SessionResult` records only when the required facts are unambiguous. Mark backfilled awards with their rules version; do not assume “no edits” when old data cannot prove it.
- Clearing session history must not silently clear progression. Provide a separate, confirmed progression reset.
- Resetting progression must not delete session history.

## Tests

Add pure and store tests for:

- Equal XP for target and stop-loss boundary exits.
- No XP dependence on final P&L, rounds, wager amount, max stake, or bridge count.
- No duplicate awards for the same session/action.
- Manual stop is not penalized relative to a boundary exit.
- Widening a stop loss invalidates `limits_locked`; tightening it does not.
- Challenge awards consume deterministic completion facts.
- Level thresholds and cosmetic unlocks at every boundary.
- Missing cosmetic fallback.
- Old-schema migration and ambiguous backfill behavior.
- Summary remount/Strict Mode idempotence.

Add component tests for an empty profile, a level-up session, an already-awarded session, locked cosmetics, and selecting an unlocked theme.

## Acceptance criteria

- A completed session yields an explainable, idempotent XP breakdown based only on process.
- Profit/loss magnitude and play volume cannot increase XP.
- Levels unlock cosmetics and nothing that changes gameplay or forecasts.
- Profile and cosmetics work fully offline and survive reloads.
- Old local data remains readable.
- Existing session and history behavior continues to work.

## Out of scope

- Cloud accounts, social leaderboards, purchases, or tradable cosmetics.
- Daily streaks or time-limited progression.
- Gameplay perks, simulation boosts, or preset advantages.
- Career bankroll accounting; see `11-career-bankroll-mode.md`.

