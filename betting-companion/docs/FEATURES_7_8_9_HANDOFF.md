# Handoff: Features 7–9

This document is the implementation handoff for:

1. Live variance fan
2. In-app ladder optimizer
3. True multi-game support

## Current state

- Features 7–9, Vault, and Decision Ghosts are committed (`f2fe5cb`). The `feat/codex-4` dirty-worktree notes below are historical.
- 2026-09-04 P0 follow-up (branch `ci/cd`, uncommitted): effective Setup preview, versioned optimizer checkpoints with exact resume, and real-browser QA. See "P0 follow-up (2026-09-04)" at the end of this document before the historical sections.
- Unrelated dirty files at the repo root (`HANDOFF.md`, `HANDOFF_BACCARAT.md`, `scripts/baccarat_exact.py`) belong to separate baccarat work; leave them alone.

## Validation completed

Run from `betting-companion/`:

```bash
npm test -- --run
npx tsc --noEmit
npm run lint -- --quiet
npm run build
git diff --check
```

Last results:

- 24 test files passed
- 320 tests passed
- TypeScript passed
- ESLint passed with zero errors
- Next.js 16.1.6 static/PWA build passed
- `git diff --check` passed

The normal, non-quiet lint command reports warnings in generated PWA service-worker files. The build also reports stale Browserslist data; neither is a feature failure.

Browser automation was unavailable in the shared T3 preview, so visual and interaction QA is still required.

## Phase 1: Live variance fan

The live adventure graph can display deterministic simulated P5–P95 and P25–P75 envelopes plus a median line. The fan is generated from the active session's frozen configuration, strategy, and game snapshot, and is clipped to the current round.

### Important files

- `src/engine/variance-forecast.ts`
- `src/workers/variance-forecast.worker.ts`
- `src/workers/variance-forecast.protocol.ts`
- `src/components/graph/useVarianceForecast.ts`
- `src/components/graph/graph-model.ts`
- `src/components/graph/SessionGraph.tsx`
- `src/components/AdventureGraph.tsx`
- `src/store/session-store.ts`
- `src/store/settings-store.ts`

### Data flow

```text
Frozen session configuration
  -> forecast fingerprint
  -> variance worker
  -> preview (400 samples)
  -> full result (2,500 samples)
  -> persisted session-store snapshot
  -> graph model/interpolation
  -> SVG fan and live classification
```

### Behavioral guarantees

- Forecasts are reproducible for the same engine version, seed, configuration, strategy, and game.
- The engine uses deterministic anchor rounds:
  - every round through 100
  - every 5 rounds through 500
  - every 25 rounds afterward
  - always includes round 0 and the configured maximum
- Quantiles use the R-7 method.
- Completed/terminal paths carry their final P&L through later anchors.
- Actual results and forecast bands share one y-domain.
- Classification is inclusive at the boundaries: below, within, or above the P5–P95 band.
- A late full forecast replaces the preview snapshot in the matching completed history result without creating another session.
- Historical graphs use their stored forecast snapshot rather than silently recomputing against current code.

### Persistence

The session store persists:

- `varianceForecast`
- `forecastStatus`
- the forecast snapshot attached to `SessionResult`

The Zustand schema version is 2 even though the storage key remains `betting-session:v1`; keeping the key permits in-place migration.

## Phase 2: In-app ladder optimizer

The Ladder Lab searches ladder shapes and policies for the highest conservative probability of hitting a target while respecting a conservative ruin-tolerance bound.

Route: `/optimizer`

### Important files

- `src/engine/optimizer.ts`
- `src/engine/optimizer-coordinator.ts`
- `src/engine/optimizer-storage.ts`
- `src/workers/optimizer.worker.ts`
- `src/workers/optimizer.protocol.ts`
- `src/app/optimizer/page.tsx`
- `src/store/custom-preset-store.ts`
- `src/app/setup/page.tsx`

### Search and evaluation

- Small spaces use grid enumeration.
- Larger spaces use seeded evolutionary proposals.
- Evolution uses objective-ranked elitism, uniform crossover, and bounded mutation.
- Candidate generation enforces:
  - nondecreasing stakes
  - configured increments
  - growth bounds
  - table and user maximums
  - canonical cent rounding
- Exploration candidates share a common seed bank for fair comparisons.
- Confirmation uses a separate domain-separated holdout seed bank.
- The final frontier is based on confirmed evaluations, not exploration scores.
- Target probability and ruin probability use one-sided Wilson bounds at the selected confidence.
- A candidate is feasible only when its ruin upper bound is at or below the requested tolerance.
- Reaching the maximum round count is censored separately; it is not counted as ruin.

Primary ranking order:

1. Higher target lower bound
2. Lower ruin upper bound
3. Lower median maximum stake
4. Lower drawdown
5. Fewer steps
6. Stable fingerprint tie-break

### Worker and checkpoint behavior

- The coordinator supports 1–4 workers.
- Work is dispatched in candidate batches.
- Pause, resume, and cancellation occur between batches.
- Stale messages are rejected by job, batch, engine-version, and fingerprint checks.
- IndexedDB database: `velvet-stakes-optimizer`
- Checkpoints store inputs, candidates, and aggregates, not raw simulation traces.

Resolved 2026-09-04: checkpoint schema 2 records the engine version, the evolutionary generation and population, and the seed-bank fingerprints, so an interrupted job continues exactly (see the P0 follow-up section). Schema 1 evolutionary checkpoints interrupted during exploration are reported as incompatible and offered a fresh start instead.

### Custom presets

- Only confirmed feasible candidates can be saved.
- Saved presets include immutable provenance and a version.
- Built-in presets cannot be overwritten.
- Setup clones a saved preset into the new session; the optimizer never mutates an active session.

Resolved 2026-09-04: Setup and session creation both go through `resolveSessionPlan` (`src/engine/session-plan.ts`), so the preview shows the selected preset's own ladders and an "Effective Session Plan" card lists exactly what gets frozen.

## Phase 3: True multi-game support

Production outcomes are now typed and settle against an immutable `FrozenGameSnapshot`. This supports asymmetric payouts, neutral ties/pushes, and versioned game/variant definitions.

### Important files

- `src/engine/types.ts`
- `src/engine/games.ts`
- `src/engine/money.ts`
- `src/engine/session.ts`
- `src/store/session-store.ts`
- `src/store/history-store.ts`
- `src/app/setup/page.tsx`
- `src/components/BetInput.tsx`
- `src/components/SessionStats.tsx`
- `src/components/graph/SessionGraph.tsx`

Monte Carlo and Decision Ghost code/workers were also updated to consume `FrozenGameSnapshot` and typed outcome distributions. Search for `FrozenGameSnapshot` before changing simulator interfaces.

### Registered games

- Even Money
  - win: `+1`
  - loss: `-1`
- Baccarat, standard 8-deck
  - Banker win: `+0.95`
  - Banker loss: `-1`
  - tie: `0`, neutral progression
- Craps single odds
  - point 4/10: `+2`, probability `1/3`
  - point 5/9: `+1.5`, probability `2/5`
  - point 6/8: `+1.2`, probability `5/11`

The craps module models only the supplemental odds bet. It does not include the required pass/don't-pass line bet; the UI must retain that assumption/disclaimer.

### Outcome and money invariants

- Production code should call `processOutcome`; do not add new boolean win/loss paths.
- `processBet` remains only as a compatibility adapter for legacy callers.
- Ties/pushes:
  - increment rounds and amount wagered
  - increment the push count
  - settle to zero
  - do not move the ladder
  - do not trigger bridge recovery
- Each `BetRecord` stores the typed outcome, progression effect, and exact settled P&L.
- Historical results must use recorded settlement; never recompute old bets using the current game registry.
- Monetary settlement and accumulation use integer cents with half-away-from-zero rounding.
- Public/UI and persisted legacy-compatible fields remain dollar `number` values. A complete branded-minor-unit schema migration has not been done.
- Game fingerprints include immutable game ID, version, variants, outcomes, probabilities, and payouts.
- Card-counting overlays remain separate from base game probabilities.

### Migration behavior

Legacy sessions are migrated to a frozen `legacy_even_money` snapshot. Existing `won` records receive typed win/loss outcomes and exact recorded deltas. Preserve this path until all supported stored data has aged out or an explicit breaking migration is approved.

Reference rules used during implementation:

- [GRA Baccarat rules](https://www.gra.gov.sg/docs/default-source/game-rules/mbs/baccarat-games/mbs-baccarat-game-rules---ver-8.pdf)
- [GRA Craps rules](https://www.gra.gov.sg/docs/default-source/game-rules/mbs/dice-games/mbs-craps-game-rules-version-3.pdf)
- [Baccarat probability analysis](https://wizardofodds.com/games/baccarat/basics/)

## Concurrent work to preserve

Vault and Decision Ghost changes were present in the shared worktree and are not cleanly separable by assuming every dirty file belongs to features 7–9. In particular, review these areas before staging or resolving conflicts:

- `src/engine/vault.ts`
- Vault store, components, route, and tests
- `src/engine/monte-carlo.ts`
- `src/engine/decision-ghosts.ts`
- Decision Ghost components, workers, and tests

`src/app/card-counting/page.tsx` also has a small hydration timing change needed for React lint and static prerendering.

## Required manual QA

Before merging, test in a real browser:

1. Start an even-money session and confirm preview/full fan transitions, range toggle, classification, and history snapshot.
2. Repeat with Baccarat Banker, including a tie that leaves the ladder unchanged.
3. Repeat with each craps point variant and inspect displayed payout assumptions.
4. Run Ladder Lab through exploration and confirmation; save a feasible preset and start a session with it.
5. Pause, reload, and resume an optimizer job from IndexedDB.
6. Cancel a multi-worker job and verify no late worker message mutates the UI.
7. Exercise narrow iPhone layouts, reduced motion, and a long session graph.
8. Benchmark a 2,500-sample, 5,000-round forecast and representative optimizer jobs on a midrange phone.
9. Verify behavior in the Capacitor shell, especially worker lifecycle/backgrounding.

## Recommended continuation order

1. Inspect `git status` and group changes into logical commits without resetting shared work.
2. Complete the browser/manual QA above.
3. Fix any visual or worker-lifecycle defects found.
4. Add a real-browser worker integration test if the project test stack permits it.
5. Decide whether exact optimizer generation resume and full minor-unit storage are merge blockers or documented follow-ups.
6. ~~Update the Setup custom-preset ladder preview.~~ Done 2026-09-04.

## Guardrails for future changes

- Do not replace typed production outcomes with a boolean.
- Do not derive historical settlement from a newer game definition.
- Do not label a candidate safe based on raw simulation frequency; use the configured conservative bound.
- Do not let optimizer results modify an active session without an explicit save-and-select flow.
- Do not recompute a historical variance fan silently.
- Do not merge card-counting adjustments into immutable base game odds.
- Do not delete or reset unrelated dirty work while preparing commits.

---

## P0 follow-up (2026-09-04)

Scope: the first milestone of the app-enhancement roadmap (trustworthy configuration and recovery). P1/P2 items were not started.

### A. Effective strategy preview (Setup)

Problem fixed: Setup previewed `DEFAULT_LADDERS` for every preset and built the session strategy separately from the preview, so a Lab preset user saw L1/L2/L3 while the session ran Lab ladders. Setup also had no Max Rounds or Table Max inputs, so a Lab preset could never match its confirmed objective.

- `src/engine/session-plan.ts` (new): `resolveSessionPlan` is the single resolution used by both the preview and `startSession`. It returns the exact `config`/`strategy`/`game` frozen into the session, the engine's starting-ladder clamp as an explicit adjustment (and writes the clamped value into the frozen config), blockers (first stake above bankroll or table max), and Lab provenance status with a per-field mismatch list (game, bankroll, target, stop loss, max rounds, table max, starting ladder, candidate fingerprint). An unknown preset id is an error, never a fallback to another strategy. `configFromPresetProvenance` and `findRegisteredGameByFingerprint` power the "Use confirmed settings" action.
- `src/app/setup/page.tsx`: Starting Ladder cards come from the resolved plan; new Max Rounds and Table Max (0 = none) inputs; new "Effective Session Plan" card (text only, `<dl>`/`<ul>`, no colour-only meaning); Start refuses when the plan cannot resolve or has blockers. Editing Setup never touches an active session (covered by test).
- Tests: `src/engine/session-plan.test.ts` (10), `src/app/setup/page.test.tsx` (4, router mocked), fixture `src/engine/optimizer-preset.fixture.ts`.

### B. Deterministic optimizer recovery

Checkpoint audit result: schema 1 lacked engine/schema version, generation and population state, and any seed-bank record; the resume path skipped remaining evolutionary generations.

- `src/engine/optimizer-storage.ts`: `OPTIMIZER_CHECKPOINT_SCHEMA_VERSION = 2`. New fields: `schemaVersion`, `engineVersion`, `evolution { generation, generationCount, populationSize, population[] }`, `explorationSeedBankFingerprint`, `confirmationSeedBankFingerprint`. IndexedDB database/version unchanged (`velvet-stakes-optimizer` v1); the record shape is versioned, not the store. `assessOptimizerCheckpoint` classifies a stored record as `resumable` (schema 1 grid or post-exploration records are upgraded in memory), `incompatible` (engine/schema/fingerprint/seed-bank/algorithm mismatch, or schema 1 evolutionary exploration) with a reason and the saved inputs, or `finished`.
- `src/engine/optimizer-coordinator.ts`: the evolutionary loop resumes at the saved generation with the saved population; committed evaluations are never re-dispatched and every batch merges at most once by candidate fingerprint; `assertResumable` re-checks versions, fingerprints, algorithm, and seed banks before running; worker replies are validated against the dispatched candidates; duplicate/late messages are dropped after settlement. New `onPersistence` callback reports `unsaved | saving | saved | failed` with the last saved time and committed-evaluation count so a failed write is never shown as saved. `settled()` awaits queued writes.
- `src/app/optimizer/page.tsx`: resumable banner (committed evaluations, generation, saved time, status, Resume/Discard); incompatible banner (reason, Start Fresh With Saved Inputs, Discard); running view shows status + stage labels, "N / M candidates", generation, an explicit "no time estimate" note, the checkpoint line, and Back to Setup / Start Over after failure or cancel. Progress bar has ARIA values and `motion-reduce`.
- Tests: `src/engine/optimizer-storage.test.ts` (10) and eight new cases in `src/engine/optimizer-coordinator.test.ts`: interrupted evolutionary exploration, interrupted confirmation (1 worker vs 2-worker baseline, so also scheduling independence), interrupted grid, duplicate deliveries, late results after cancel, refused engine/schema/seed/job mismatches, failed storage reporting, saved-count reporting. Determinism contract: same inputs, seed, budget, and engine version give identical confirmed frontiers whether or not the run was interrupted.

### C. Browser verification

`scripts/qa/browser-qa.mjs` drives the static export (`npm run build`, then any static server on `out/`) with Playwright. Playwright is not a project dependency; set `PLAYWRIGHT_MODULE` to an installed package directory (this machine: the global `grok-browser-cli` install). Run 2026-09-04, Chromium 149 headless, desktop Linux, all checks passed:

- Real workers + IndexedDB: evolutionary job (384-candidate space) paused mid-generation, page reloaded, resumed from the banner; the confirmed frontier matched the uninterrupted run exactly. Same result for a hard reload mid-run at 72 committed evaluations. Cancel of a 2-worker job showed "Cancelled" in 66 ms with no later progress mutation, and a cancelled job is not offered for resume. A schema-1 evolutionary record injected into IndexedDB produced the incompatible banner, not a resume.
- Setup: saved Lab preset previewed Lab 1–3 (no L1), mismatch list matched the confirmed objective, "Use confirmed settings" flipped it to "Confirmed for these settings", and the started session's persisted strategy/config equalled the preview.
- Forecast benchmark (default even-money session, 5,000 rounds): preview status at 13 ms, full 2,500-sample forecast ready at 823 ms, main-thread rAF latency ≈13 ms while modelling, ≈10 MB page heap. Desktop numbers only; no phone was measured.
- iPhone SE viewport with reduced motion: no horizontal overflow on Setup. Screenshots are written to `/tmp/velvet-qa` (ephemeral).

Not verified: Capacitor shell and worker backgrounding on a real phone, Baccarat/craps session flows through the browser (unit-covered only), real midrange-phone timings. The Maestro flows in `.maestro/` were not run.

### Observations for follow-up (not fixed)

- The Lab can confirm degenerate ladders (e.g. a third ladder of seven identical table-max rungs). Consider a candidate filter for flat capped ladders before P1 strategy comparison work.
- Setup still uses the slate palette while other routes use the noir tokens; left as-is to preserve the page's existing identity.

### Validation (2026-09-04, from `betting-companion/`)

- `npx vitest run`: 28 files, 365 tests passed (baseline before this work: 25 files, 333 tests)
- `npx tsc --noEmit`: passed
- `npm run lint -- --quiet`: passed
- `npm run build`: passed (static export)
- `git diff --check`: passed
- `node scripts/qa/browser-qa.mjs`: all browser checks passed

### Next bounded task

P1 strategy comparison with a flat-stake baseline, reusing `resolveSessionPlan` for the shared comparison configuration and the optimizer worker protocol for evaluation. Before that, decide whether to filter flat capped ladders out of Lab candidates.
