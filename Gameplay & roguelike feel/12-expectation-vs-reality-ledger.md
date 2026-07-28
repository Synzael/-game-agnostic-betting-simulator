# Implementation prompt: Expectation-vs-reality ledger

## Mission

For each preset/configuration cohort, compare recorded target-hit results with the probabilities frozen by the simulator before those sessions began. Explain whether the observed count falls within ordinary model variance or in an unusually extreme tail.

The ledger must be brutally honest without calling any finite result “impossible,” proving skill, or retrofitting predictions after outcomes are known.

## Product definition

For eligible sessions:

- **Actual:** number and rate of sessions that hit the configured profit target.
- **Expected:** sum/average of each session’s pre-session `probHitTarget`.
- **Variance verdict:** a two-sided tail assessment under the independent Bernoulli probabilities frozen for those sessions.
- **Model coverage:** eligible sessions vs sessions excluded due to missing/mismatched forecasts.

This is a calibration ledger, not a leaderboard.

## Current code to extend

- `history-store.ts`: last 100 session results and aggregate stats.
- `SessionResult`: preset name is not currently stored directly; strategy/config snapshots exist.
- Decision Ghosts/Variance Fan may introduce a risk/forecast snapshot.
- Root Python Monte Carlo results can inform field names but cannot be rerun after seeing actual outcomes to fabricate a “pre-session” prediction.

The feature depends on storing a forecast snapshot **before the first real bet**. Legacy sessions without such a snapshot are ineligible for statistical verdicts.

## Forecast snapshot

Persist a compact immutable snapshot on the active session before round 1 and copy it into `SessionResult`:

```ts
interface SessionForecastSnapshot {
  readonly createdAt: number;
  readonly sampleCount: number;
  readonly seed: number;
  readonly probHitTarget: number;
  readonly probRuin: number;
  readonly probabilityIntervals?: {
    readonly hitTargetLow: number;
    readonly hitTargetHigh: number;
  };
  readonly assumptionsFingerprint: string;
  readonly engineVersion: number;
  readonly gameId: string;
  readonly gameVersion: number;
  readonly presetId: string;
  readonly presetVersion: number;
  readonly effectiveConfigFingerprint: string;
}
```

Rules:

- Once round 1 is recorded, the snapshot cannot be replaced.
- A preview batch may be replaced by a final batch only before round 1; otherwise freeze the available preview and label its smaller sample count.
- Sessions started without a completed/valid snapshot remain usable but are excluded from this ledger.
- Never recompute old expected probabilities using today’s engine/preset.
- A challenge’s effective stop loss and selected game variant must be in the fingerprint.

## Cohorting

The UI is “per preset,” but do not pool incompatible assumptions invisibly.

Primary grouping:

- Preset ID and version.
- Game ID and version.
- Simulation engine version.

Within a group, individual session probabilities may differ because bankroll/target/stop/table limits differ. That is statistically valid for the Poisson-binomial calculation, but the UI must say “mixed limits” and provide filters/details.

Offer a stricter “same setup” subgroup by `effectiveConfigFingerprint`. Do not compare:

- Different game/settlement versions.
- Forecasts created after a session started.
- Invalid sample counts/probabilities.
- Imported/manual history with no frozen prediction.
- Abandoned sessions without a terminal result.

Manual stop/max rounds/table limit/bankroll exhaustion count as “did not hit target,” because the predicted event is target hit before any terminal condition under the same rules.

## Statistical calculation

When sessions have probabilities `p1...pn`, the actual target-hit count follows a Poisson-binomial distribution.

Implement a stable dynamic-programming PMF:

```text
pmf[0] = 1
for each p:
  update k from currentN down to 0
  next[k] = pmf[k] * (1-p) + pmf[k-1] * p
```

Use `Float64Array`, validate `0 <= p <= 1`, normalize small accumulated floating error, and test larger cohorts. History is currently capped at 100, so O(n²) is acceptable. If durable calibration later exceeds that, move to a numerically stable convolution/FFT implementation or keep aggregate cohorts.

Calculate:

- `expectedWins = sum(pi)`.
- `expectedRate = expectedWins / n`.
- `variance = sum(pi * (1 - pi))`.
- Central 95% predicted count interval from the PMF.
- Lower-tail probability `P(X <= observed)`.
- Upper-tail probability `P(X >= observed)`.
- Two-sided tail value `min(1, 2 * min(lowerTail, upperTail))`.

Label this a model-tail probability, not the probability the model is true.

Monte Carlo estimates `pi` also have sampling error. At minimum:

- Display each forecast’s sample count and aggregate range.
- Require a minimum forecast sample count for verdict eligibility.
- Document that the initial Poisson-binomial verdict treats frozen point estimates as fixed.

A later enhancement may integrate uncertainty intervals. Do not pretend it is already included.

## Verdict language

Use conservative, versioned thresholds:

| Condition | Label | Explanation |
| --- | --- | --- |
| Fewer than 20 eligible sessions | Collecting data | Too few comparable sessions for a verdict |
| Two-sided tail ≥ 0.05 | Within expected variance | Observed target hits fit the modeled range |
| 0.01 ≤ tail < 0.05 | Unusual, still plausible | This count is uncommon under the frozen model |
| Tail < 0.01 | Extreme tail result | Rare under the model, but not impossible |

Do not use “impossible luck” as the literal verdict. If retaining the feature’s nickname, explain that no finite streak is impossible and an extreme result may also indicate input errors or model mismatch.

Never say:

- The user has skill because actual exceeds expected.
- The user is due for wins/losses.
- The model is proven because results fall in range.
- The preset beats the house edge.

## Durable data

The 100-session history cap can make the ledger drift. Add either:

- A compact, append-only calibration record per completed eligible session, independent of full history; or
- Versioned aggregate cohorts that retain enough per-session probabilities/counts for exact PMF updates and deletion behavior.

Prefer compact per-session records for audit:

```ts
interface CalibrationEntry {
  readonly sessionId: string;
  readonly endedAt: number;
  readonly hitTarget: boolean;
  readonly forecast: SessionForecastSnapshot;
}
```

Deduplicate by session ID. Clearing History must explicitly state whether calibration entries are also cleared and offer separate controls; do not silently retain surprising analytics. Because data is local, include delete/export.

## User experience

Add an “Expectation Ledger” section in History/Analytics:

- Preset/game cohort selector.
- Actual target-hit rate vs expected average rate.
- Observed hit count, expected count, and central modeled count range.
- Plain-language verdict and eligible sample size.
- A compact dot/range visualization, accessible as text.
- “Why sessions were excluded” disclosure.
- “Mixed limits” disclosure and same-setup filter.
- Model assumptions, sample counts, versions, and local-only note.

For fewer than 20 sessions, show the comparison but no variance verdict. Do not gamify crossing the minimum sample size.

Use target hits rather than raw “win rate” terminology where possible; a manually ended profitable session is not the same event as hitting the configured target.

## Edge cases

- All `pi` are 0 or 1.
- Zero eligible sessions.
- One or more corrupt probabilities.
- Identical session ID imported twice.
- Mixed preview/final sample counts.
- Preset renamed but same ID/version.
- Engine/game version migration.
- Every observed session hits target or none do.
- Deleted full history with retained/cleared calibration.
- Rounding expected rate for display without changing calculations.

## Tests

Add tests for:

- Poisson-binomial PMFs with hand-calculated probabilities.
- Equivalence to ordinary binomial when all `pi` are equal.
- PMF sums to 1 within tolerance.
- Expected value and variance formulas.
- Exact lower/upper/two-sided tail boundaries.
- Central predicted count interval.
- Verdict thresholds and minimum 20-session gate.
- Grouping by preset/game/engine versions and strict config.
- Mixed limits use individual probabilities, not their average in a binomial shortcut.
- Snapshot immutability after round 1.
- Invalid/legacy forecast exclusion reasons.
- Idempotent calibration insertion and store migration.
- History/calibration clear semantics and export round-trip.

Add component tests for empty, collecting, within-range, unusual, extreme, mixed-limits, excluded-session, and corrupt-data states.

## Acceptance criteria

- Every eligible session is compared only to a forecast frozen before its first bet.
- Mixed per-session probabilities are evaluated with a Poisson-binomial distribution.
- Verdicts require at least 20 eligible sessions and never call outcomes impossible.
- Cohorts never mix incompatible game/preset/engine versions.
- Exclusions and assumptions are visible.
- The ledger is local, auditable, deletable, exportable, and independent of full-history trimming.

## Out of scope

- Causal claims about user skill.
- Forecast backfilling for legacy sessions.
- Bayesian model calibration or automatic probability adjustment.
- Cloud analytics or population comparisons.
- Comparing raw P&L distributions in the first release.

