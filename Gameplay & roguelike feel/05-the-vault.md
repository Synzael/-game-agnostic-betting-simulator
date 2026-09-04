# Implementation prompt: The Vault

## Mission

Create a local trophy room that automatically preserves record-setting sessions even after ordinary history rolls off or is cleared. Render each record as a distinctive Art Deco trophy card.

Initial trophy slots:

1. **Biggest Comeback**
2. **Longest Survival**
3. **Perfect Run**

This is a retention and memory feature, not a reason to increase stakes or prolong play.

## Current code to extend

- `src/store/history-store.ts`: session insertion and 100-session cap.
- `src/engine/types.ts`: stored result, bet history, events.
- `src/components/graph/SessionGraph.tsx`: compact session visualization.
- `src/app/history/page.tsx` and `src/app/page.tsx`: navigation.
- `src/app/summary/page.tsx`: new-trophy reveal after completion.

The summary currently derives and saves results on mount. Trophy evaluation must be part of one idempotent completion transaction or safely deduplicated by session ID.

## Exact record definitions

Implement record metrics as pure functions:

### Biggest Comeback

`comebackAmount = finalPnl - minimumPnlObserved`

- `minimumPnlObserved` is the minimum of zero and every `BetRecord.pnlAfter`.
- A session qualifies only when `comebackAmount > 0` and at least one bet exists.
- This measures recovery from the trough, not profit and not `maxDrawdown`.
- Store both the trough and final P&L for explanation.

### Longest Survival

`survivalRounds = roundsPlayed`

- Any completed, non-corrupt session with at least one round qualifies.
- Copy must say “longest recorded run,” not imply that playing longer is desirable.
- Do not award XP for this trophy and do not add prompts to beat it.

### Perfect Run

A session qualifies when:

- `hitTarget === true`.
- `topOfLadderTouches === 0`.
- There are no Carry Over or Write Off bridge events.
- The event record is complete enough to prove the condition.

Its score is boolean; the first qualifying session remains until the user explicitly chooses a newer perfect run or until a documented tie-break replaces it. For a fully automatic MVP, use the global tie-break below.

## Tie-breaking

For equal metric scores, prefer:

1. Earlier `endTime` (the first record holder).
2. Lexicographically smaller session ID.

This makes re-evaluation deterministic and prevents a re-render from constantly replacing cards. Display “First achieved” for a perfect-run tie.

## Data model and persistence

Use a versioned store independent from history:

```ts
type TrophyCategory =
  | "biggest_comeback"
  | "longest_survival"
  | "perfect_run";

interface TrophyEvidence {
  readonly metric: number | boolean;
  readonly facts: Readonly<Record<string, number | string | boolean>>;
  readonly rulesVersion: number;
}

interface VaultSessionSnapshot {
  readonly session: SessionResult;
  readonly preservedAt: number;
}

interface TrophySlot {
  readonly category: TrophyCategory;
  readonly sessionId: string;
  readonly evidence: TrophyEvidence;
}
```

Normalize storage as `sessionsById` plus trophy-slot references so one session occupying multiple slots is saved only once. Garbage-collect a preserved snapshot only when no slot references it.

Keep at most the records required by current slots. Bet histories can contain thousands of entries, so:

- Preserve a lossless-enough graph trace and evidence needed to render/audit the trophy.
- If retaining the full `SessionResult`, check serialized size before committing.
- Prefer a compact trophy snapshot with sampled graph points plus all bridge events and exact evidence, while retaining final config/strategy metadata.
- Never silently exceed localStorage quota. If persistence fails, keep ordinary history intact and show a non-blocking “Trophy could not be preserved on this device” message.

Clearing History must not clear the Vault. The Vault gets its own destructive “Clear Vault” confirmation. Say explicitly that clearing is permanent and separate from history.

## Trophy evaluation transaction

On session completion:

1. Validate the `SessionResult`.
2. Compute all qualifying category candidates.
3. Compare them to existing slots with the deterministic comparator.
4. Commit all winning slots and the normalized snapshot in one Zustand update.
5. Record which categories were newly set for the summary reveal.
6. Mark the session ID as evaluated so remount, resume, Strict Mode, or duplicated history insertion cannot repeat the reveal or corrupt storage.

Re-evaluation after a rules migration must be an explicit migration path with a new `rulesVersion`, not a side effect of rendering.

## User experience

Add a `/vault` page reachable from Home and History:

- A three-card trophy case on narrow screens and a wider row/grid on desktop.
- Empty slots explain the qualifying condition neutrally.
- Filled cards show category, key metric, date, ending P&L, a compact graph, and relevant recap excerpt if Three-Act Recaps exists.
- Decorative card backs/themes can consume cosmetics from Discipline progression but must remain readable with defaults.
- Opening a trophy shows its evidence: e.g. “Rose from −$420 to +$80: a $500 comeback.”
- If one session owns multiple trophies, say so without duplicating the stored snapshot.

On Summary, show a restrained “New Vault Record” panel after the session result. Do not use casino win sounds, confetti, or prompts to start another run.

## Legacy behavior

- Existing history can be scanned once on first Vault initialization to seed records.
- Only award Perfect Run when legacy data can prove zero bridges. Missing `events` plus `topOfLadderTouches === 0` is sufficient if that aggregate is trusted and present; otherwise skip.
- Mark imported/seeded records with their original session end time and current trophy rules version.
- History records later removed must leave their trophy snapshot intact.

## Tests

Add tests for:

- Each metric definition on hand-checkable sessions.
- Comeback uses minimum observed P&L, not max drawdown.
- Perfect Run excludes Write Off, Carry Over, top touches, and non-target stops.
- Deterministic tie-breaking.
- One session winning multiple slots is stored once.
- Replacing a slot garbage-collects only unreferenced snapshots.
- Duplicate evaluation is a no-op.
- Clear History leaves Vault unchanged; Clear Vault leaves History unchanged.
- Initial legacy scan and unprovable perfect runs.
- localStorage quota failure leaves stores consistent.
- Store migration between rules/schema versions.

Add component tests for empty, filled, multi-trophy, new-record, missing-recap, and persistence-error states.

## Acceptance criteria

- Qualifying records are detected and preserved automatically and idempotently.
- Vault trophies survive history trimming and history clearing.
- Trophy evidence is mathematically auditable.
- Storage is bounded and quota failure is safe.
- Trophy presentation is cosmetic and never changes progression or gameplay.

## Out of scope

- Online leaderboards, sharing, or cloud backup.
- User-created trophy formulas.
- More than the three initial categories.
- XP rewards for trophies.
- Prompts to chase or beat records.

