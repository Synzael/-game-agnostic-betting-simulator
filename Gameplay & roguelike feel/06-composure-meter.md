# Implementation prompt: Composure meter

## Mission

Surface observable tilt-risk signals as a gentle, in-fiction “Composure” stat. Use only behavior the app can actually observe: fast result entry after losses, limit changes during a session, and quick restarts after a large loss.

This is a responsible-gambling aid, not a diagnosis, truth detector, or gameplay mechanic.

## Product and safety constraints

- Never claim the user is “tilting,” addicted, irrational, or unsafe.
- Say “the app noticed…” and name the observable behavior.
- Composure cannot change odds, stake suggestions, simulation results, XP, badges, or feature access.
- Low composure must never encourage recovery, another bet, or a new session.
- Ending or pausing must be at least as visually prominent as continuing.
- Dismissing a nudge cannot cause punishment.
- The feature must be optional, local-only, and usable offline.
- Do not infer emotion from financial results alone.

## Current code to extend

- `BetRecord.timestamp` and `won` in `src/engine/types.ts`.
- `session-store.ts` start time, result recording, and session actions.
- `history-store.ts` previous session end time, stop reason, final P&L, and configured stop loss.
- `session/page.tsx` for the live meter and nudge sheet.
- Setup/settings for opt-in and signal explanations.

The current UI does not support mid-session limit editing. Model typed `SessionConfigEvent` records now and consume them when such editing exists; do not add limit editing merely to test this feature.

## Observable event model

Add a versioned, append-only local event stream:

```ts
type ComposureSignalType =
  | "rapid_entry_after_loss"
  | "loss_streak_acceleration"
  | "stop_loss_widened"
  | "target_increased"
  | "quick_restart_after_large_loss";

interface ComposureSignal {
  readonly id: string;
  readonly sessionId: string;
  readonly type: ComposureSignalType;
  readonly detectedAt: number;
  readonly evidence: Readonly<Record<string, number | string>>;
  readonly weight: number;
  readonly rulesVersion: number;
}

interface ComposureSnapshot {
  readonly score: number; // 0–100
  readonly band: "steady" | "strained" | "low";
  readonly signals: readonly ComposureSignal[];
}
```

Signal IDs must be deterministic from session ID, signal type, and triggering event(s), making detection idempotent after resume.

Store the final signal summary in `SessionResult` for audit, but do not add raw audio, external identifiers, or hidden behavioral telemetry.

## Initial detection rules

Keep rules in a pure, versioned module and pass `now` explicitly for testability.

### Rapid entry after loss

- Detect when the next result is entered no more than 3 seconds after the preceding recorded loss.
- Require two such intervals inside the last five results before emitting a signal; one quick tap is not enough.
- Emit at most once per rolling episode and apply a cooldown of five recorded results.
- Evidence includes only interval durations and round numbers.

### Loss-streak acceleration

- Require at least eight prior timed entries in the current session.
- Compare the median interval for the last three entries following losses against the median of the preceding valid session intervals.
- Detect only when the recent median is both at most 5 seconds and less than half the earlier median.
- Emit once per session unless the score has returned to the steady band and a new episode begins.

### Stop-loss widened or target increased

- Consume explicit config-edit events.
- Widening the allowed loss or increasing the profit target mid-session emits a signal.
- Tightening a stop loss, lowering a target, or ending a session does not lower composure.
- Evidence records old/new values, not free-form user text.

### Quick restart after a large loss

- At new-session confirmation, inspect the most recent completed session.
- Detect when it ended within 10 minutes and either hit stop loss or finished at/below 50% of its configured stop-loss amount.
- Show the nudge **before** starting; do not mutate the new active session until the user confirms a choice.
- A new session after a profitable result does not trigger this rule.

These thresholds are initial product constants. Centralize them and label the feature as experimental in settings.

## Score and recovery

- Begin a new session at 100, minus any quick-restart signal.
- Deduct fixed weights by signal type; clamp to 0–100.
- Suggested weights: rapid-entry 12, acceleration 18, widened stop 30, increased target 20, quick restart 25.
- Bands: Steady 75–100, Strained 40–74, Low 0–39.
- Do not increase composure because of a win.
- A continuous pause with no result entry may recover one point per full minute, capped at the session’s score before the latest signal and calculated from timestamps rather than timers. This prevents a reload from changing history.
- Ending the session freezes the final snapshot.

## User experience

### Live meter

- Show a small shield/flame-style Art Deco meter labeled “Composure.”
- Default state is quiet and does not compete with P&L or input controls.
- Tapping opens the current band, observed signals, and a plain-language “How this works.”
- Do not show a fake decimal precision or probability.

### Nudges

When crossing into Strained or Low, show one non-blocking sheet per band:

- State the observation: “Your last few entries came much faster after losses.”
- Offer “Pause 5 minutes,” “End session,” and “Continue.”
- Give Pause and End equal or greater prominence than Continue.
- Pause disables result entry locally until the chosen duration ends, but always allows End and emergency dismissal.
- Continuing does not clear the score and does not show another sheet for the same band.
- Allow “Not useful for this session” to mute further nudges while retaining no negative consequence.

For quick restart, offer “Wait,” “Review last session,” and “Start anyway.” Do not use a countdown that unlocks gambling as a reward.

## Accessibility and privacy

- Do not rely on color alone for bands.
- Announce a newly opened sheet once; do not repeatedly announce meter changes.
- Respect reduced motion.
- Add a setting to disable signal detection and delete composure history separately.
- Explain that timing is processed on device and never uploaded.
- Treat background/resume gaps as pauses, not rapid-entry evidence.
- Exclude imported/backfilled bets without trustworthy timestamps.

## Tests

Add table-driven tests for:

- Every threshold boundary and fixed weight.
- Median interval calculation and rolling cooldown.
- No signal from a single fast entry.
- Background/resume and identical timestamps.
- Tightened vs widened stop loss.
- Quick restart at 9:59 vs 10:00+ and exact large-loss threshold.
- No score increase from wins.
- Timestamp-derived pause recovery and cap.
- Deterministic signal IDs and resume idempotence.
- Settings opt-out and session mute.
- Legacy histories with missing/invalid timestamps.

Add store/component tests for band crossings, one nudge per band, pause input lock, End remaining available, Review navigation, deletion, and no gameplay/config mutation.

## Acceptance criteria

- The score is reproducible from local typed events and versioned rules.
- Every nudge identifies a real observable behavior.
- The feature never changes stakes, odds, forecasts, XP, or outcomes.
- Pause/end paths are prominent and remain available.
- Opt-out and data deletion work offline.
- False-positive-prone inputs degrade conservatively.

## Out of scope

- Clinical assessment, responsible-gambling diagnosis, or legal compliance claims.
- Camera, biometric, location, card-counting, or microphone-derived emotion inference.
- Notifications outside an active/setup flow.
- Cloud analytics or cross-device profiling.

