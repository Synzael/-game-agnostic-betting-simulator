# Velvet Stakes feature implementation prompts

This directory contains one implementation-ready prompt per proposed feature. Each prompt is intended to be handed to a coding agent on its own branch. Read this file and the selected feature prompt before changing code.

## Repository baseline

The current checkout contains:

- A Next.js 16 / React 19 static-export PWA in `betting-companion/`.
- Capacitor 7 wrappers, offline-first behavior, Zustand persistence, Vitest, and Tailwind CSS.
- A deterministic TypeScript live-session engine in `betting-companion/src/engine/`.
- Active-session and completed-history stores in `betting-companion/src/store/`.
- A decision screen, summary/history screens, and the SVG `AdventureGraph`.
- A Python Monte Carlo engine and safe-target grid search in `simulator.py`.

The current checkout does **not** contain a TypeScript `simulateOneSession` function, a risk-check worker, or stored forecast snapshots. Prompts that use those capabilities must either extend them if they exist on the implementation branch or add the smallest reusable browser-side simulation layer needed. The shipped app must never shell out to Python or require a server.

## Cross-cutting product constraints

Apply these constraints to every feature:

1. Keep the app offline-first. Core functionality and saved data must work in airplane mode.
2. Keep user data local unless a separate, explicit synchronization feature is approved.
3. Never imply that a betting system changes expected value or beats a house edge.
4. Never turn responsible-gambling features into pressure to continue a session.
5. Preserve the noir / Art Deco direction in `betting-companion/docs/DESIGN_DIRECTION.md`.
6. Keep financial calculations deterministic and define rounding explicitly.
7. Version new persisted schemas and migrate old `betting-session:v1` and `betting-history:v1` data without silently deleting it.
8. Treat React Strict Mode, route remounts, and resumed sessions as normal. All completion-time side effects must be idempotent by session ID.
9. Put pure calculations in `src/engine` or `src/lib`, UI state in Zustand stores, and expensive simulation in Web Workers.
10. Add accessible names, keyboard behavior, reduced-motion behavior, empty/loading/error states, and narrow-screen layouts.
11. Do not add gameplay advantages to cosmetics, XP, badges, trophies, or composure.
12. Do not weaken existing premium, invite, or card-counting gates.

## Recommended delivery order

| Order | Prompt | Why |
| --- | --- | --- |
| 1 | `01-decision-ghosts.md` | Standout decision-screen feature and reusable conditional simulation foundation |
| 2 | `07-live-variance-fan.md` | Reuses the forecast engine and graph work from Decision Ghosts |
| 3 | `03-run-modifiers-challenge-runs.md` | Small, isolated rules layer with strong run variety |
| 4 | `02-discipline-meta-progression.md` | Can consume challenge and compliance events without rewarding results |
| 5 | `04-three-act-session-recaps.md` | Pure deterministic history transformation |
| 6 | `05-the-vault.md` | Reuses recap and session snapshot presentation |
| 7 | `06-composure-meter.md` | Requires carefully versioned behavioral events and UX |
| 8 | `09-true-multi-game-support.md` | Foundational engine migration before broader math work |
| 9 | `08-in-app-ladder-optimizer.md` | Depends on a mature worker simulation API and ideally `GameSpec` |
| 10 | `10-voice-entry.md` | Independent native input enhancement |
| 11 | `11-career-bankroll-mode.md` | Adds durable accounting and campaign simulation |
| 12 | `12-expectation-vs-reality-ledger.md` | Most honest after forecast snapshots and game/config versioning exist |

This is sequencing guidance, not a requirement. `01` + `07`, `02` + `03`, and `04` + `05` are the cleanest adjacent pairs.

## Definition of done for every prompt

Before handing off a feature:

- Run `npm run test -- --run`, `npm run lint`, and `npm run build` from `betting-companion/`.
- Add focused unit tests for pure logic and store migrations.
- Add component tests for the primary loading, success, empty, and error states.
- Manually exercise a fresh install, upgraded persisted data, session resume, and duplicate summary mount.
- Document any native-only verification that cannot run in Vitest.
- Report changed files, behavior delivered, tests run, and any intentionally deferred work.

