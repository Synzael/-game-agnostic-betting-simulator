# Implementation prompt: Live variance fan

## Mission

Overlay a simulated P5–P95 P&L envelope on the live Adventure Graph so the player can see whether the recorded run is inside the preset model’s expected range at the same round.

This is context, not a signal to increase stakes or continue. Use neutral language such as “outside the modeled range,” never “due for a reversal” or “off-script, chase recovery.”

## Product definition

The first release shows a **pre-session baseline fan**:

- Simulate many complete sessions from the exact frozen setup configuration.
- For each round, calculate P5, P25, P50, P75, and P95 of P&L.
- Overlay P5–P95 as the outer fan, P25–P75 as a subtler inner fan, and P50 as a dashed median.
- Plot the actual session line over the fan.
- At the current round, show the expected P5–P95 range and whether actual P&L is below, within, or above it.

Do not silently change the baseline after seeing real results. A conditional future cone from the current state belongs to Decision Ghosts or a later feature.

## Current code to extend

- `src/components/graph/SessionGraph.tsx`: SVG rendering.
- `src/components/graph/graph-model.ts`: pure coordinate derivation.
- `src/components/graph/AdventureGraph.tsx`: connected live wrapper.
- `src/store/session-store.ts`: frozen session/config/strategy snapshot.
- `src/engine/session.ts` and root `simulator.py`: simulation rules.
- `src/app/setup/page.tsx`: risk-check/start flow if one exists on the implementation branch.

The current main branch has no TypeScript risk-check output. If a newer branch has it, extend its trajectory data. Otherwise build a small shared seeded simulation worker; reuse the Decision Ghosts simulation layer if that prompt was implemented.

## Statistical semantics

### Terminal-path handling

Use an absorbing terminal value:

- Once a simulated session ends at round `r`, carry its final P&L forward for all later requested round anchors.
- This makes each quantile answer: “Where would session P&L be by this round, counting already-ended sessions at their final value?”
- Document this in “How the range is modeled.”
- Do not calculate quantiles only from surviving sessions; that produces survivorship bias.

### Round anchors

Do not persist a value for every possible round up to 5,000 unless measurements show it is safe. Create a deterministic anchor schedule, for example:

- Every round through 100.
- Every 5 rounds through 500.
- Every 25 rounds thereafter through `maxRounds`.
- Always include round 0 and `maxRounds`.

Interpolate linearly between quantile anchors for rendering only. Classification at the current round must either use an exact simulated anchor or a clearly shared interpolation function.

### Quantiles

- Use a documented deterministic quantile estimator (for example sorted-array linear interpolation equivalent to R-7).
- Financial values are calculated in canonical money units and rounded only for display.
- Each quantile series must be monotone by percentile at every round: `p05 <= p25 <= p50 <= p75 <= p95`.
- Quantile P&L over time does not need to be monotone.
- Store `sampleCount`, `seed`, `engineVersion`, game/preset/config fingerprint, anchor schedule version, and terminal handling.

### “Outside range”

- `actual < p05`: below modeled 90% range.
- `p05 <= actual <= p95`: within modeled 90% range.
- `actual > p95`: above modeled 90% range.
- This classification is descriptive. Do not label it impossible, anomalous, safe, or dangerous.

## Forecast lifecycle

- Generate the baseline after setup values are frozen and before or immediately after starting.
- Run in a Web Worker; session input must remain responsive.
- A quick preview may use fewer samples and then atomically upgrade to the full result.
- Persist the completed compact envelope with the active session so it survives reload and remains tied to original assumptions.
- When the session becomes a `SessionResult`, persist a small `forecastSnapshot`/fingerprint required by History and the expectation ledger.
- Cancel stale setup runs when inputs change.
- If the player starts before the fan is ready, allow the session and show a compact “Modeling range…” state.
- If generation fails, render the normal graph without the fan.

## Graph model and rendering

Extend the pure graph model with forecast geometry:

```ts
interface VarianceBandPoint {
  readonly round: number;
  readonly p05: number;
  readonly p25: number;
  readonly p50: number;
  readonly p75: number;
  readonly p95: number;
}
```

- The y-domain must include zero, actual P&L, and all visible fan values.
- Use one shared `toX`/`toY` transform for actual line, events, terminal marker, and fan.
- Render closed SVG paths for outer and inner bands behind events/actual line.
- Clip drawing to the graph plot area.
- The actual line must retain sufficient contrast in every theme.
- Use a pattern/dash distinction in addition to opacity/color where practical.
- With reduced motion, do not morph the fan when the refined batch arrives; replace it.
- `preserveAspectRatio="none"` currently stretches the SVG. Ensure strokes/markers remain legible on narrow screens and fan paths do not distort hit targets.

Add a compact legend toggle:

- Fan visible by default only when data exists.
- User can hide/show it without deleting the snapshot.
- Persist this as a display setting, not a session rule.

## Detail copy

At the live round, a detail popover may say:

> Round 34 modeled range: −$420 to +$115 (P5–P95). Current P&L: −$180, within range.

Also show:

- Number of simulations.
- Frozen game/preset and limits.
- “Ended simulations keep their final P&L in later rounds.”
- “A modeled range is not a guarantee and does not change the house edge.”

## Performance

- Keep SVG path point counts bounded by the anchor schedule.
- Memoize pure geometry by bet-history/fan fingerprint.
- Do not sort large sample arrays on the React render path.
- Measure worker time and serialized snapshot size on a mid-range mobile device.
- Cap concurrency so the fan cannot starve touch input or native speech.

## Tests

Add tests for:

- Quantiles on hand-calculated arrays, including interpolation.
- Absorbing terminal P&L rather than survivor-only samples.
- Stable seed/input output.
- Anchor generation and interpolation at boundaries.
- Quantile order at every anchor.
- Current-round classification exactly at P5/P95.
- Shared y-domain includes fan and actual extremes.
- Correct closed SVG path geometry for a small fixture.
- Empty/loading/error/hidden fan states.
- Persist/resume uses the frozen snapshot rather than rerunning with changed presets.
- Legacy sessions without a forecast render the existing graph unchanged.

Add a visual/manual check for dense 5,000-round sessions, narrow iPhone width, reduced motion, and light/dark/system theme behavior if all remain supported.

## Acceptance criteria

- A session with a completed forecast shows a mathematically defined P5–P95 overlay.
- Actual values and the fan use the same graph scales.
- Terminal samples are handled without survivorship bias.
- The feature is local, reproducible, bounded, and non-blocking.
- Failure or missing legacy data falls back to the current graph.
- Copy cannot be read as a reversal or betting recommendation.

## Out of scope

- Conditional re-simulation after every bet.
- Choice-specific Decision Ghost metrics.
- Strategy optimization.
- Alerts or notifications based on leaving the fan.

