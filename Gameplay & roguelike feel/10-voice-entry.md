# Implementation prompt: Voice entry

## Mission

Add hold-to-talk result entry on the live session screen so a user can record “win” or “loss” hands-free. Use native speech recognition through Capacitor and require on-device recognition for the iOS offline path.

Voice entry is an input adapter for the existing session action. It must not bypass session validation, duplicate bets, listen continuously, or upload/store audio.

## Scope and platform promise

- iOS native is the required offline vertical slice.
- The feature must work in airplane mode on a supported iPhone with the needed on-device language model installed.
- Android may be added if a verified offline recognizer is available, but do not claim offline support without device testing.
- Browser/PWA fallback is the existing tap UI. Do not silently use cloud Web Speech APIs while advertising offline behavior.
- If on-device recognition is unavailable, fail closed and keep tap controls available.

## Current code to extend

- `src/components/session/BetInputPanel.tsx`: Win/Loss controls.
- `src/store/session-store.ts`: `recordBet`, stopped/decision validation.
- `src/app/session/page.tsx`: session lifecycle and decision redirects.
- `src/lib/platform.ts` and Capacitor configuration.
- `package.json`, native plugin setup, iOS privacy usage descriptions, and native project files when present/generated.

The repository may not currently commit `ios/` or `android/`. Keep web builds working, document required `npx cap sync ios`, and commit native code/config only according to the project’s established native workflow.

## Native adapter

Create a small platform-neutral interface:

```ts
type VoiceEntryStatus =
  | "idle"
  | "requesting_permission"
  | "listening"
  | "processing"
  | "recognized"
  | "unavailable"
  | "error";

interface VoiceRecognitionResult {
  readonly transcript: string;
  readonly isFinal: boolean;
  readonly confidence?: number;
}

interface VoiceEntryAdapter {
  isAvailable(options: { requireOnDevice: boolean }): Promise<boolean>;
  requestPermission(): Promise<"granted" | "denied" | "restricted">;
  start(options: {
    locale: string;
    requireOnDevice: boolean;
  }): Promise<void>;
  stop(): Promise<VoiceRecognitionResult>;
  cancel(): Promise<void>;
}
```

Before choosing or adding a Capacitor plugin, verify its current Capacitor 7 and iOS support, maintenance state, license, privacy behavior, and ability to set iOS `requiresOnDeviceRecognition = true`. If no maintained plugin exposes the required semantics, implement a minimal local Capacitor plugin around Apple Speech APIs instead of weakening the offline requirement.

Native requirements:

- Request microphone and speech-recognition permissions only after the user taps/holds the control.
- Configure the required iOS usage-description strings.
- Create recognition requests with on-device recognition required.
- Do not fall back to server recognition when the device rejects on-device mode.
- Stop/cancel the audio engine on release, route change, app background, session stop, decision point, or component unmount.
- Do not persist audio buffers or full transcripts.

## Command grammar

Keep recognition conservative:

```ts
type VoiceCommand = "win" | "loss" | "unknown";
```

Normalize case, surrounding punctuation, and whitespace. Accept only a short allowlist:

- Win: `win`, `won`.
- Loss: `loss`, `lost`, `lose`.

Do not fuzzy-match unrelated words or infer from sentiment. If a transcript contains both command classes, multiple commands, extra numeric content, or uncertain partial speech, return `unknown`.

If multi-game support is present:

- Only enable voice for variants whose active outcomes map unambiguously to Win/Loss.
- Do not map “tie,” “push,” point names, or side-bet results until explicitly designed and tested.

## Interaction state machine

Use press-and-hold:

1. Finger/key down starts permission/recognition.
2. Show “Listening…” only after native start succeeds.
3. Finger/key up stops and requests a final transcript.
4. Parse one command.
5. Re-read the current session store immediately before commit.
6. Call the same `recordBet` action as tap input exactly once.
7. Show a large visual/haptic confirmation and a short Undo action.

Rules:

- Ignore a second pointer/key while one recognition request is active.
- Generate a recognition request ID; one request can commit at most once.
- Reject late results after route/state/request changes.
- Never commit while stopped, awaiting a decision, paused by Composure, or unable to afford/continue.
- An unknown command records nothing and says “Didn’t catch win or loss.”
- Permission denial records nothing and keeps tap controls.
- A tap without holding long enough cancels cleanly; do not guess.

## Undo

Voice errors are plausible, so add a safe undo transaction:

- The store should expose a general `undoLastBet` only if the last bet is still the latest state transition and no decision/terminal side effect has been finalized.
- Prefer implementing event-sourced/replay-safe undo rather than manually subtracting P&L.
- If undo would cross a bridge decision, terminal save, or another input, disable it and explain why.
- Undo is available for a short UI window but is validated by state identity, not only elapsed time.
- If a general safe undo is too broad for this task, show a confirmation step before committing instead. Do not ship irreversible auto-entry without one of these safeguards.

## User experience

- Add a microphone control adjacent to Win/Loss, sized for one-handed use.
- Provide visible Idle, Listening, Processing, Recognized, Unavailable, and Error states.
- Keep Win/Loss buttons available except while a single recognition request is being resolved.
- Add a setting to enable Voice Entry and choose a supported locale.
- Explain: “Speech is processed on this device. Audio and transcripts are not saved.”
- Use haptics that distinguish committed Win, committed Loss, and no command, while honoring the existing haptic setting.
- Do not read P&L aloud by default in a public setting.

Accessibility:

- Support Space/Enter press-and-hold semantics where possible.
- Provide an accessible label and status live region that does not repeatedly announce partial transcripts.
- Do not rely on microphone color alone.
- Respect reduced motion.

## Offline and lifecycle verification

Test on a physical iPhone:

- Airplane mode enabled before app launch.
- Fresh permission grant and previously granted permission.
- On-device recognition available and unavailable.
- Screen lock/background during listening.
- Incoming audio interruption.
- Session reaches decision/terminal state before recognition returns.
- Repeated quick holds and noisy/empty speech.

Document device, iOS version, locale, and whether the language’s offline model was installed. Simulator testing alone does not satisfy the offline acceptance criterion.

## Automated tests

Mock the adapter and test:

- Grammar normalization and rejection.
- Permission denied/restricted.
- On-device unavailable never falls back to network.
- One request ID commits no more than once.
- Late/stale native result is ignored.
- Release/cancel/unmount/background cleanup.
- Store is revalidated immediately before commit.
- Decision, stopped, pause, and unaffordable states reject input.
- Win and Loss use the exact same action as tap input.
- Undo/confirmation safeguard.
- Web/static build imports no unavailable native global at module initialization.

## Acceptance criteria

- On a supported physical iPhone in airplane mode, holding the control and saying Win/Loss records exactly one correct result.
- No audio or transcript is persisted or uploaded.
- Unavailable, denied, ambiguous, late, and canceled recognition records no result.
- Tap entry and static PWA builds keep working.
- Native lifecycle cleanup prevents a background recognizer from committing later.
- Users have a tested correction safeguard.

## Out of scope

- Continuous listening or wake words.
- Hermes integration.
- Free-form notes, bet amounts, decision choices, or card-count commands.
- Cloud speech fallback.
- Speaker identification or emotion inference.

