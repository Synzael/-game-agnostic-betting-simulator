# Implementation prompt: Three-act session recaps

## Mission

Transform a completed session’s bet history and bridge events into a short, deterministic three-act narrative. The recap should make history memorable while remaining mathematically faithful and suitable for a later share-card renderer.

Example:

> **Act II — The Collapse**
>
> Round 34 marked the deepest drop. Three bridges arrived in eleven hands.

No LLM, network call, random adjective, or free-form generative text is allowed. Identical session data and template version must always produce identical output.

## Current code to extend

- `src/engine/types.ts`: `BetRecord`, `SessionEvent`, and `SessionResult`.
- `src/store/session-store.ts`: result construction.
- `src/app/summary/page.tsx`: post-session presentation.
- `src/app/history/page.tsx`: stored-session detail/list.
- `src/components/graph/graph-model.ts`: existing pure event-to-graph derivation patterns.
- `src/components/graph/SessionGraph.tsx`: visual companion for recap acts.

## Output model

Build a pure recap module with structured output, not only a finished string:

```ts
type RecapTone =
  | "opening"
  | "ascent"
  | "pressure"
  | "collapse"
  | "recovery"
  | "resolution";

interface RecapAct {
  readonly act: 1 | 2 | 3;
  readonly title: string;
  readonly tone: RecapTone;
  readonly startRound: number;
  readonly endRound: number;
  readonly summary: string;
  readonly facts: readonly RecapFact[];
}

interface SessionRecap {
  readonly templateVersion: number;
  readonly sessionId: string;
  readonly acts: readonly RecapAct[];
  readonly closingLine: string;
}
```

`RecapFact` should carry typed facts used by later UI/share-card code, such as P&L change, peak, trough, bridge count, longest win/loss streak, and terminal reason. Do not force later code to parse prose.

## Deterministic act segmentation

Implement and document one deterministic segmentation algorithm. Use this initial algorithm:

1. Sort bets by round, rejecting duplicate/non-monotonic rounds as invalid input.
2. For sessions with at least three bets, divide the run into three contiguous, non-empty ranges near one-third and two-thirds of total rounds.
3. Snap each boundary to the nearest meaningful pivot within a bounded window (for example ±10% of total rounds), preferring in order:
   - a bridge event,
   - the first occurrence of the session’s maximum drawdown trough,
   - a new running P&L high,
   - the unsnapped boundary.
4. Resolve equal-distance ties by earlier round, then by the priority above.
5. Ensure `act1.end < act2.end < finalRound` after snapping. Fall back to unsnapped boundaries if a valid partition cannot be made.

For one- and two-bet sessions, still return three display sections but mark unavailable acts as brief prologue/epilogue entries with an empty round range. Do not invent events.

Compute all act facts from the bets/events inside the range. Compute running peaks and drawdowns using the full preceding session context so an act’s “deepest drop” is mathematically correct.

## Template selection

Choose titles and sentences from ordered, versioned rules. First matching rule wins. Suggested title rules:

### Act I

- `ascent`: positive P&L change and a new running high.
- `pressure`: negative P&L change or a loss streak of at least three.
- `opening`: otherwise.

### Act II

- `collapse`: contains the first maximum-drawdown trough.
- `recovery`: begins below zero and ends materially closer to zero.
- `pressure`: contains one or more bridge events.
- `opening`: otherwise.

### Act III

- `resolution`: always; specialize its summary by terminal reason.

Sentence templates must use only verified facts. Examples:

- “The run opened with {wins} wins in {rounds} rounds, reaching {peakPnl}.”
- “The deepest drop arrived at round {troughRound}: {drawdown} below the prior peak.”
- “{bridgeCount} bridges arrived in {windowRounds} hands.”
- “The session closed at the target after {rounds} rounds.”
- “The stop loss ended the run at {finalPnl}; the configured boundary held.”
- “You chose to end the run at {finalPnl}.”

Use correct singular/plural grammar and the existing currency formatter. Avoid “almost won,” “due for a win,” “lucky,” “unlucky,” “heroic,” “disaster,” or any causal claim unsupported by the event log.

## “Three bridges in eleven hands” fact

Add a pure densest-bridge-window calculation:

- Given sorted bridge events and a fixed maximum window of 11 rounds, find the contiguous 11-round interval containing the most events.
- On a tie, choose the earliest interval.
- Only emit the sentence when at least two bridges occur in the chosen interval.
- Report the actual interval length for short sessions; never claim eleven hands when fewer were observed.

Define whether “bridge” includes both Carry Over and Write Off. Use **all recorded bridging decisions** for narrative density, while typed facts retain counts by event type.

## Storage/versioning choice

Prefer deriving the recap from a stored `SessionResult` on render and caching it by `sessionId + templateVersion`. This allows template fixes without bloating history.

If share cards or the Vault require immutable historical wording, persist a small recap snapshot with the trophy/share artifact, not a duplicate on every session. Keep `templateVersion` explicit either way.

Old sessions may have no `events` but do have bet history and top-touch totals. Generate only facts provable from the available fields and label the recap as limited internally; never synthesize bridge rounds.

## User experience

- Add the recap below the graph and primary result on Summary.
- Present the acts as three compact Art Deco chapters with act number, title, round range, and one or two sentences.
- Allow acts to highlight the matching graph range on hover/focus/tap without making the graph unreadable.
- Add a stored-session detail surface from History rather than expanding every list card to full prose.
- Keep final P&L and stop reason more visually prominent than the narrative.
- Include a copy-ready text formatter, but do not implement image share cards in this task.

## Edge cases

- Zero bets and a user-stopped result.
- One or two bets.
- All P&L values equal (possible with pushes after multi-game support).
- Multiple equal maximum drawdowns.
- Multiple events at the same round.
- Missing/legacy events.
- Corrupt round order.
- Sessions at `maxRounds`.
- Fractional payouts/cents.
- Event counts that disagree with aggregate `topOfLadderTouches`; show only defensible detail and surface a development warning.

## Tests

Use table-driven and snapshot tests for:

- Stable output for identical data and template version.
- Three valid contiguous acts for normal sessions.
- Boundary snapping priority and tie-breaking.
- Earliest occurrence of equal maximum drawdowns.
- Densest 11-round bridge window and pluralization.
- Every terminal reason’s closing template.
- Short, empty, push-only, legacy, and corrupt histories.
- Currency values with cents.
- No banned causal/near-miss terms in the template registry.
- Structured facts matching the rendered sentence values.

Add component tests for summary rendering, history detail, graph-range interaction, and a limited legacy recap.

## Acceptance criteria

- Every valid completed session can produce a deterministic, structured three-act recap.
- Every number and event in the prose is traceable to stored data.
- Short/legacy sessions degrade gracefully without invented detail.
- Summary and history can render the recap accessibly on narrow screens.
- The output is reusable by a later share-card renderer.

## Out of scope

- LLM-generated prose.
- Remote generation or moderation.
- Raster share-card generation and social posting.
- User-editable recap text.
- Trophy selection; see `05-the-vault.md`.
