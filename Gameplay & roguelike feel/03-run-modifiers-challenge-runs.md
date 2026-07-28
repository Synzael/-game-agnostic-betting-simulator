# Implementation prompt: Run modifiers and challenge runs

## Mission

Add optional self-imposed constraints selected during setup. A selected set becomes a named, immutable challenge run, is visibly enforced during play, and earns a cosmetic badge when its rules are honored.

Ship these first-party modifiers:

1. **Clean Slate** — no Carry Over decisions.
2. **Two Bridges** — at most two Carry Over decisions.
3. **Half Guardrail** — effective stop loss is 50% of the configured base stop loss.

Every modifier is a discipline mechanic. No modifier may improve odds or advertise greater profit.

## Current code to extend

- `src/app/setup/page.tsx`: setup form and warning confirmation.
- `src/engine/types.ts`: `SessionConfig`, `SessionState`, `SessionResult`, events.
- `src/engine/session.ts`: bridge and stop rules.
- `src/store/session-store.ts`: start snapshot, decisions, result.
- `src/components/decision/DecisionScreen.tsx`: decision availability and explanation.
- `src/app/session/page.tsx` and `src/app/summary/page.tsx`: active rules and results.
- History store/tests for persisted results.

## Rules architecture

Define modifiers in a versioned registry rather than scattered booleans:

```ts
type ChallengeModifierId =
  | "no_carry_over"
  | "max_two_carry_overs"
  | "half_stop_loss";

interface ChallengeModifierDefinition {
  readonly id: ChallengeModifierId;
  readonly rulesVersion: number;
  readonly displayName: string;
  readonly shortDescription: string;
  readonly compatibility: readonly ChallengeModifierId[];
}

interface ChallengeRunConfig {
  readonly id: string;
  readonly displayName: string;
  readonly modifierIds: readonly ChallengeModifierId[];
  readonly rulesVersion: number;
  readonly baseStopLossAbs: number;
  readonly effectiveStopLossAbs: number;
}
```

Persist the full challenge snapshot in the active session and `SessionResult`. Never reinterpret an old run using a newly edited registry.

Apply modifiers through pure functions at well-defined boundaries:

- `deriveEffectiveSessionConfig(baseConfig, challenge)`.
- `getAllowedDecisions(state, challenge)`.
- `evaluateChallenge(result): ChallengeEvaluation`.

The live engine/store must validate a decision even if the UI is bypassed. UI disabling alone is not enforcement.

## Exact modifier semantics

### Clean Slate

- Carry Over is not allowed at any bridge.
- Write Off and Stop Session remain available.
- The decision card remains visible but locked, with “Disabled by Clean Slate,” so the rule is understandable.
- A forged `makeDecision("carry_over")` call must be rejected without mutating state.

### Two Bridges

- Count successful `carry_over` bridging events, not top touches and not Write Off events.
- Carry Over is allowed while the prior count is less than two.
- At the third bridge opportunity, Carry Over is locked; Write Off and Stop remain available.
- Resuming the app reconstructs the count from persisted typed events or a persisted counter and produces the same allowed decisions.

### Half Guardrail

- At session start, calculate `effectiveStopLossAbs = baseStopLossAbs * 0.5` using the canonical money rounding rule.
- Freeze both base and effective values in the challenge snapshot.
- The engine enforces the effective value.
- Setup, pre-start confirmation, live HUD, decision screen, summary, history, simulations, and recaps must all use or label the effective stop loss consistently.
- Combining this with other modifiers is allowed.

Clean Slate and Two Bridges are redundant together. Either mark them incompatible in setup or define the combination as Clean Slate taking precedence and explain that clearly. Prefer incompatibility for the first release.

## Naming and badges

- Generate a stable default name from selected modifier IDs in registry order, such as “Clean Slate Run” or “Two Bridges · Half Guardrail.”
- Allow an optional user-edited local display name with a short length limit and plain-text rendering.
- The run is considered **honored** when it reaches any recorded terminal state without a rules violation. Target, stop loss, manual stop, max rounds, table limit, and bankroll exhaustion are all terminal; badges acknowledge constraint compliance, not winning.
- An abandoned/replaced active session is not completed.
- Because hard rules prevent most violations, preserve an explicit violation list for migration bugs, imported data, or future soft modifiers.
- Award each named modifier badge once, with repeat completion count tracked separately if desired.
- Badges are cosmetic only and must not award better parameters.

## User experience

On Setup:

- Add an optional “Challenge Run” section below core limits.
- Each modifier card states the concrete rule and shows the derived effective value where applicable.
- Show incompatibilities immediately.
- Summarize active modifiers in the existing pre-start warning modal.
- Selecting no modifiers preserves today’s normal session exactly.

During a run:

- Show a compact challenge crest/chip above or below the Adventure Graph.
- Tapping it opens the frozen rules and progress, such as “Carry Overs 1 / 2.”
- Disabled decisions explain the modifier that disabled them.
- Do not use failure countdowns or shame copy.

At completion:

- Show “Challenge honored” independently of profit/loss.
- List each rule and the evidence used to evaluate it.
- Persist the badge/evaluation in history and make it available to the discipline progression prompt.

## Persistence and compatibility

- Version the session-store and history-store persisted schemas.
- Migrate old sessions to `challenge: null`; normal sessions must remain unchanged.
- Snapshot modifier definitions needed for display so future copy/rule changes do not corrupt old history.
- Starting a new session while another is active must use the existing replacement behavior and must not mint a challenge completion.
- Completion and badge writes must be idempotent by session ID.

## Simulation integration

Any Monte Carlo/risk feature must consume effective config and allowed-decision rules:

- Half Guardrail uses the halved stop loss.
- Clean Slate never simulates Carry Over as an available human choice.
- Two Bridges includes the already-used count when forecasting from mid-session.
- Optimizer runs must not silently include challenge constraints unless the user explicitly selects them.

## Tests

Add tests for:

- Normal sessions are byte-for-byte behaviorally equivalent when no challenge is selected.
- Effective half stop loss, including odd-cent rounding.
- Clean Slate rejection at both UI and store/engine layers.
- Two Bridges allows exactly two carry overs and blocks the third.
- Write Off does not consume the Two Bridges allowance.
- Resume/reload keeps the same remaining allowance.
- Compatible and incompatible modifier combinations.
- Run-name generation and sanitization.
- All terminal reasons can honor a rule; abandoned sessions cannot.
- Idempotent badge/completion persistence.
- Migration of old active and historical sessions.

Add component tests for setup selection, derived stop-loss copy, locked decision cards, live progress, and success presentation on both a profitable and losing result.

## Acceptance criteria

- Users can select zero or more compatible modifiers and see their exact effects before starting.
- Selected rules are frozen, enforced below the UI layer, resume safely, and appear throughout the session lifecycle.
- Badges represent compliance only, never financial success.
- Existing unmodified sessions remain unchanged.
- Forecasting and summaries use effective rather than base limits.

## Out of scope

- User-authored rule code.
- Online challenge leaderboards.
- Time-limited daily challenges.
- Random modifiers or gameplay rewards.
- More than the three initial modifier definitions.

