# The Vault — LLM Handoff

## Purpose

The Vault is a local-only trophy room that automatically preserves three
record-setting completed sessions:

1. Biggest Comeback
2. Longest Survival
3. Perfect Run

It is a memory/retention feature. It must never award XP, change gameplay,
encourage longer play, suggest larger stakes, or prompt the user to beat a
record.

The implementation brief remains the source of truth:
`../../Gameplay & roguelike feel/05-the-vault.md`.

## Worktree warning — read before editing

This repository is a shared worktree with several concurrent feature changes.

- The Vault work began after checking out `feat/codex-2`.
- Another process switched the shared worktree to `feat/codex-4` at
  `2026-07-28 04:23:21 -0700`.
- Both branches pointed to the same base commit, `cb65495`, at the time.
- The Vault work is currently uncommitted and is interleaved with unrelated
  multi-game, variance, decision-ghost, and optimizer work.

Do not run destructive cleanup, reset the worktree, revert whole shared files,
or stage/commit every modified file blindly. Inspect the diff and stage only
the intended hunks. In particular, `types.ts`, `engine/index.ts`,
`session-store.ts`, graph files, Home, Summary, and global CSS contain changes
from more than one feature.

Start with:

```bash
git status --short --branch
git diff --check
git reflog -10 --date=iso
```

## Record rules

All record calculations are pure functions in `src/engine/vault.ts`.

### Biggest Comeback

```text
minimumPnlObserved = min(0, every BetRecord.pnlAfter)
comebackAmount = finalPnl - minimumPnlObserved
```

A completed session qualifies only when it has at least one auditable bet and
`comebackAmount > 0`. This intentionally does not use `maxDrawdown`.

Stored evidence:

- `minimumPnlObserved`
- `finalPnl`
- `comebackAmount`

### Longest Survival

The score is exactly `roundsPlayed`. Any valid completed session with at least
one round qualifies.

User-facing copy says “longest recorded run.” It does not frame longer play as
desirable.

### Perfect Run

A session qualifies only when:

- `hitTarget === true`
- `topOfLadderTouches === 0`
- no `carry_over` or `write_off` events exist
- the retained data can prove the no-bridge condition

For legacy sessions without `events`, a present and trusted
`topOfLadderTouches === 0` aggregate is accepted. If both event evidence and
the aggregate are absent, Perfect Run is skipped while other provable
categories can still qualify.

### Deterministic ties

Higher numeric scores win. Equal scores prefer:

1. Earlier `endTime`
2. Lexicographically smaller session ID

Perfect Run is boolean, so this keeps the first qualifying session. Its card
says “First achieved” and includes the original completion date.

Current constants:

```text
TROPHY_RULES_VERSION = 1
VAULT_SCHEMA_VERSION = 1
```

Do not silently re-evaluate records when rules change. A future rules change
needs an explicit migration.

## Persistence architecture

Primary file: `src/store/vault-store.ts`

Storage is independent from History:

```text
localStorage key: betting-vault:v1
maximum serialized size: 750,000 bytes
maximum remembered evaluated IDs: 512
maximum sampled graph points per preserved session: 240
```

The normalized persisted shape contains:

- `sessionsById`
- one slot reference per trophy category
- bounded `evaluatedSessionIds`
- `pendingRevealsBySessionId`
- `legacyScanCompleted`
- schema and rules versions

A session that holds multiple trophies is stored once. After slot replacement,
a preserved snapshot is garbage-collected only when no trophy still references
it.

Long bet histories are compacted for graph rendering. Sampling prioritizes:

- first point
- last point
- exact trough
- bridge-event rounds while capacity remains
- evenly distributed trace points

All bridge events and exact trophy evidence remain preserved.

Persistence is transactional from the Vault’s perspective:

1. Build the complete next Vault state.
2. Serialize it and enforce the size ceiling.
3. Write it to localStorage.
4. Only then update Zustand state.

If serialization is too large or localStorage throws, no trophy state is
committed. The UI shows:

> Trophy could not be preserved on this device. Your session history is
> unchanged.

History insertion occurs independently before trophy evaluation, so a Vault
quota error must not damage ordinary history.

## Store API and lifecycle

The singleton hook is exported as `useVaultStore` from `src/store/index.ts`.

Important actions:

```ts
initializeFromHistory(historySessions);
evaluateSession(completedResult);
consumeReveal(completedResult.id);
clearVault();
dismissPersistenceError();
```

`initializeFromHistory` loads/migrates the store and performs the one-time
legacy scan. Legacy imports do not create Summary reveals.

`clearVault` persists an empty Vault with `legacyScanCompleted: true`. This is
important: existing History must not immediately re-seed trophies after an
explicit Vault clear.

`clearHistory` never touches the Vault. `clearVault` never touches History.

## Idempotent completion flow

Files involved:

- `src/store/session-store.ts`
- `src/store/history-store.ts`
- `src/app/summary/page.tsx`

`endSession()` caches a `completedResult`, including its generated session ID.
Repeated calls return the same result. New bets/decisions invalidate an
earlier cached result, and starting/resetting a session clears it.

History insertion now ignores an already-present session ID.

Summary:

1. Initializes the Vault from current History.
2. Inserts the stable result into History.
3. Evaluates it once for all trophy categories.
4. Reads the persisted pending reveal.
5. Shows a restrained “New Vault Record” panel.
6. Consumes the reveal so later remounts do not announce it again.

The Summary effect includes a local ref guard for React Strict Mode.

## UI

### Vault page

Route: `/vault`

Main files:

- `src/app/vault/page.tsx`
- `src/components/vault/TrophyCard.tsx`
- `src/app/globals.css`

The page contains:

- a narrow-screen three-card trophy case and desktop three-column grid
- Art Deco card geometry implemented in CSS/SVG
- neutral empty-slot qualification copy
- metric, date, ending P&L, and compact graph on filled cards
- evidence dialog with the exact mathematical explanation
- multi-trophy ownership label without duplicate snapshots
- local-device disclosure
- non-blocking persistence error
- a separate permanent “Clear Vault” confirmation

Three-Act Recaps do not currently exist in this codebase. Cards are deliberately
complete without a recap excerpt.

### Navigation

The Vault is linked from:

- Home: `src/app/page.tsx`
- History: `src/app/history/page.tsx`
- new-record Summary panel: `src/components/vault/NewVaultRecord.tsx`

History’s clear confirmation explicitly states that Vault trophies are
preserved separately.

## Data types and exports

Vault types were added to `src/engine/types.ts`:

- `TrophyCategory`
- `TrophyEvidence`
- `VaultSessionSnapshot`
- `TrophySlot`

The evaluation helpers and types are re-exported through
`src/engine/index.ts`.

The graph compatibility line in `src/components/graph/graph-model.ts` supports
both legacy `BetRecord.won` and the concurrent multi-outcome
`progressionEffect` field:

```ts
won: bet.won ?? bet.progressionEffect === "win"
```

Do not revert that compatibility fallback while multi-game records make
`won` optional.

## Tests

Vault-specific coverage:

- `src/engine/vault.test.ts`
  - exact metrics
  - minimum observed P&L rather than `maxDrawdown`
  - every Perfect Run exclusion
  - tie-breaking
  - compact trace invariants
- `src/store/vault-store.test.ts`
  - one snapshot for multiple slots
  - reference-aware garbage collection
  - duplicate evaluation
  - History/Vault clearing independence
  - legacy scan and unprovable Perfect Run
  - quota failure consistency
  - schema migration and migration persistence
- `src/components/vault/TrophyCard.test.tsx`
  - empty, filled, multi-trophy, missing-recap-safe, and Summary reveal states
- `src/app/vault/page.test.tsx`
  - three-slot empty page
  - non-blocking persistence error

Last Vault-focused command:

```bash
npm test -- --run \
  src/engine/vault.test.ts \
  src/store/vault-store.test.ts \
  src/components/vault/TrophyCard.test.tsx \
  src/app/vault/page.test.tsx
```

Last result: 25 tests passed.

At the last full verification point:

```text
Full Vitest suite: 285 tests passed
Production build: passed; /vault generated as a static route
Vault-targeted ESLint: passed
git diff --check: passed
```

The full repository lint still reported unrelated errors in
`src/app/card-counting/page.tsx` and two `prefer-const` errors in
`src/engine/session.ts`, plus warnings from generated PWA assets. Do not
attribute those failures to the Vault without rechecking the current shared
worktree.

The collaborative browser preview host was unavailable. `/vault` returned HTTP
200 from the local dev server, and page/component states were verified through
tests, but a final interactive visual pass on a phone-sized viewport is still a
useful follow-up.

## Suggested next steps

1. Re-run the targeted tests, full suite, build, and targeted lint because
   concurrent work continued after the last verification.
2. Perform an interactive mobile and desktop visual pass of `/vault`.
3. Test a real completed session through Summary, including a multi-trophy
   result and a forced localStorage quota failure.
4. Decide how to isolate and commit Vault hunks from the shared uncommitted
   changes. Do not assume the current branch name reflects where this work was
   intended to land.
5. If Three-Act Recaps or Discipline cosmetics land later, consume them only as
   optional presentation metadata; do not change trophy scoring or gameplay.
