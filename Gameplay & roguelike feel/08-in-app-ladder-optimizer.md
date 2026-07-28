# Implementation prompt: In-app ladder optimizer

## Mission

Build a local, long-running optimizer that searches permitted ladder shapes and bridge policies for candidates maximizing probability of reaching a target while satisfying a fixed ruin-tolerance constraint.

This is the engine behind a future preset editor. It must be reproducible, honest about Monte Carlo uncertainty, cancelable, and unable to imply that optimization removes the house edge.

## Product constraints

- Never optimize or market expected value as positive when the game model is negative EV.
- A candidate is “within the selected simulated risk tolerance,” not “safe.”
- No result is valid without displaying game assumptions, bankroll, target, stop loss, table max, horizon, sample count, and uncertainty.
- If no candidate satisfies the constraint, say so; never return the least-bad candidate as feasible.
- Long work stays off the UI thread and runs entirely on device.
- The user must explicitly save a candidate before it becomes a preset. Running an optimizer cannot mutate the active preset/session.

## Current code to extend

- Root `simulator.py`: `MonteCarloEngine` and `SafeTargetFinder` are reference math, not browser runtime.
- `src/engine/ladder.ts`, `presets.ts`, and `types.ts`: ladder/policy definitions.
- A browser simulation/worker from Decision Ghosts or Live Variance Fan, if present.
- `idb` is already installed and may store jobs/checkpoints larger than localStorage.
- Static Next.js export and Capacitor mean no server process can perform the search.

The Python safe-target finder searches profit targets for one strategy; it is **not** yet a ladder-shape optimizer. Implement and test the new objective explicitly.

## Search input model

Create validated, serializable input:

```ts
interface OptimizerSearchSpace {
  readonly ladderCount: { min: number; max: number };
  readonly stepsPerLadder: { min: number; max: number };
  readonly minimumStake: number;
  readonly maximumStake: number;
  readonly allowedStakeIncrements: readonly number[];
  readonly maxGrowthRatio: number;
  readonly allowedPolicies: readonly BridgingPolicy[];
  readonly recoveryTargetPctValues: readonly number[];
  readonly crossoverOffsets: readonly number[];
}

interface OptimizerObjective {
  readonly bankroll: number;
  readonly profitTarget: number;
  readonly stopLossAbs: number;
  readonly maxRounds: number;
  readonly tableMax?: number;
  readonly ruinTolerance: number;
  readonly confidenceLevel: number;
}
```

Validate:

- Stakes are positive, sorted non-decreasing, representable in canonical money units, and do not exceed table/user max.
- Candidate minimum stake is affordable at the initial bankroll.
- Growth ratio, ladder count, and total steps have conservative hard caps.
- Probabilities/game outcomes are valid.
- Search-space cardinality is estimated before launch.
- Challenge modifiers do not silently affect optimization.

## Ruin and feasibility

For this feature:

```text
ruin = stop_loss OR table_limit OR bankroll_exhausted
```

Report `max_rounds` separately as censored/non-success, not ruin, unless product requirements explicitly change and version the definition.

A candidate is feasible only when the **upper confidence bound** on ruin probability is at or below the user’s tolerance. Use a documented binomial interval such as one-sided Wilson at the configured confidence level. Do not use only the point estimate.

The primary score is the lower confidence bound on `P(hit target)`, not the raw estimate. Use deterministic tie-breaks:

1. Higher lower confidence bound for target probability.
2. Lower upper confidence bound for ruin.
3. Lower median max stake.
4. Lower median max drawdown.
5. Fewer total ladder steps.
6. Canonical candidate fingerprint.

Show point estimates and intervals in results.

## Search algorithm

Implement a two-stage strategy behind an interface so grid and evolutionary search can share evaluation:

### Stage 1: exploration

- Use grid search when estimated candidates are below a hard threshold.
- Use a seeded evolutionary search for larger spaces.
- Generate only valid canonical candidates.
- Evaluate with a small common seed bank so candidates see the same random sequences.
- Keep the top feasible set plus a bounded near-feasible frontier.

### Stage 2: confirmation

- Re-evaluate finalists with a larger, independent holdout seed bank not used for selection.
- Rank and label feasibility only from confirmation results.
- If a candidate fails holdout feasibility, mark it failed rather than quietly using exploration numbers.
- Persist both exploration and confirmation settings.

An evolutionary implementation should specify selection, mutation, crossover, elitism, generation count, and seeded PRNG. Avoid a library whose behavior cannot be reproduced across browser engines without tests.

## Parallelism and workers

- Use a coordinator plus a bounded worker pool.
- Default concurrency should be based on `navigator.hardwareConcurrency`, capped conservatively (for example 1–4 workers) and overridable in advanced settings.
- Split work by candidate batches, not by tiny individual simulations.
- Support pause, resume, and cancel between batches.
- Every message includes job ID, batch ID, engine version, and input fingerprint.
- Reject stale/duplicate batches and make aggregation order-independent.
- Persist checkpoint metadata and best candidates to IndexedDB. Do not persist raw path traces.
- On iOS background/suspension, recover from the last complete checkpoint rather than claiming continuous execution.

## Optimizer UI

Add a premium-feeling “Atelier”/“Ladder Lab” flow:

1. Assumptions and fixed risk tolerance.
2. Constrained search-space editor with a clear estimated workload.
3. Review screen explaining that all candidates retain the game’s house edge.
4. Progress screen with evaluated candidates, elapsed active compute time, stage, pause/cancel, and best confirmed-so-far.
5. Results frontier comparing target probability, ruin interval, max stake, drawdown, and complexity.
6. Candidate detail with exact ladders/policy and “Save as custom preset.”

Do not use a single “best strategy” headline without the fixed objective/assumptions beside it. Include “No feasible candidate found” and interrupted-job states.

Saving:

- Validate again using the production engine.
- Store an immutable custom-preset version and optimizer provenance.
- Never overwrite a built-in preset.
- Never apply it to an active session.

## Numerical quality

- Use a tested seeded PRNG with documented version.
- Reuse one canonical session simulator across risk check, ghosts, fan, ledger, and optimizer.
- Define money rounding and settlement once.
- Use online aggregation where possible; avoid keeping every P&L.
- Confidence intervals must handle 0 successes/failures correctly.
- Include a simulation-engine version in job and preset provenance.
- Add a small golden fixture cross-checked against Python under equivalent even-money assumptions. Statistical tolerances must be predeclared, not chosen after results.

## Tests

Add tests for:

- Candidate validation/canonicalization and search cardinality.
- Ruin classification and one-sided interval boundaries.
- Deterministic seeded grid/evolutionary output.
- Common exploration seeds and independent confirmation seeds.
- Tie-breaking independent of worker completion order.
- No feasible candidate.
- Pause/resume/cancel and IndexedDB checkpoint recovery.
- Duplicate/stale worker result rejection.
- Saved-preset provenance and built-in preset immutability.
- Zero/one probabilities, table limits, max rounds, pushes, and fractional payouts when supported.
- A tiny exhaustive search whose optimum is hand-verifiable.

Add integration/manual tests for a short job, a multi-worker job, app background/resume, storage quota failure, and a full static/native build.

## Acceptance criteria

- Valid jobs run locally off-thread, can be paused/canceled/resumed, and reproduce from saved inputs/seeds.
- Feasibility uses a confidence bound, not a raw ruin estimate.
- Finalists are independently confirmed.
- Results state assumptions and never claim the house edge is beaten.
- A saved result becomes a versioned custom preset only after explicit confirmation.
- Interrupted or failed jobs cannot corrupt active sessions or presets.

## Out of scope

- Cloud compute.
- Real-money execution or casino integration.
- Unbounded free-form evolutionary parameters.
- Automatic deployment of a candidate to an active session.
- Optimizing game rules or claiming positive expected value.

