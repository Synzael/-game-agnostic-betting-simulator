# Handoff: Game-Agnostic Betting Simulator / "Velvet Stakes"

Audience: an LLM or engineer picking this repo up cold. Read this file top to bottom before
touching code. It covers what the project is, the math at its core, where that math lives in
two separate implementations, how to run things, and the traps.

---

## 1. What this project is

Two codebases sharing one staking model:

| Part | Path | Role |
| --- | --- | --- |
| Python research simulator | `simulator.py`, `config.py`, `presets.ini`, `tests/` | Offline Monte Carlo. Answers "what profit target can I hit with ≤α ruin risk?" Not shipped to users. |
| TypeScript companion app | `betting-companion/` | Next.js 16 / React 19 static-export PWA + Capacitor 7 native wrappers. A *live* companion: the user enters real table outcomes, the app tracks ladder position and offers decisions. Never shells out to Python. |

The app is branded **Velvet Stakes** (noir / Art Deco direction, see
`betting-companion/docs/DESIGN_DIRECTION.md`).

**Product stance, enforced throughout:** this is educational. No copy anywhere may imply a
staking system changes expected value or beats a house edge. It does not — see §2.1. Every
feature is built to make the negative-EV tail *visible*, not to hide it.

---

## 2. The math at the core

### 2.1 The one invariant that dominates everything

Per round, for stake $s$, win probability $p$, net payout multiplier $b$:

$$\mathbb{E}[\text{round}] = s\,(bp - (1-p))$$

For the baseline even-money game ($b=1$, $p=0.495$) this is $-0.01\,s$. Summing over a session:

$$\mathbb{E}[\text{P\&L}] = -(\text{house edge}) \times (\text{total wagered})$$

No ladder, bridge, or recovery rule appears in that expression. **The staking system only
reshapes the distribution** — it buys a high median and a high hit rate by manufacturing a
rare, very heavy left tail. The Python README's own output shows this: median P&L $100,
mean P&L $22.85, skewness −12.1.

### 2.2 Three intersecting Fibonacci ladders

Stakes are Fibonacci sequences $F = 1,2,3,5,8,13,21,34,55,89$ scaled by a unit that multiplies
by 10 per ladder (verified against `create_default_ladders()` / `DEFAULT_LADDERS`):

| Ladder | Unit | Multipliers | Stakes | Steps |
| --- | --- | --- | --- | --- |
| L1 | ×5 | 1,2,3,5,8,13,21,34,55 | 5 … 275 | 9 |
| L2 | ×50 | 1,2,3,5,8,13,21,**35** | 50 … 1750 | 8 |
| L3 | ×500 | 1,2,3,5,8,13,21,34,55,89 | 500 … 44500 | 10 |

(L2's last rung is 35 units, not 34 — a deliberate rounding to $1750. Do not "fix" it silently;
it is baked into tests and persisted sessions.)

**"Intersecting" means the stake ranges overlap, not that the ladders share rungs.** L1's top
(275) sits inside L2's span (50–1750); L2's top (1750) sits inside L3's span (500–44500). So
when a ladder is exhausted there is always a next ladder whose rungs bracket the stake you were
already betting — the bridge has somewhere continuous to land, at any offset the policy chooses.
Bridging at offset 0 is a large step *down* in stake (275 → 50) that buys a fresh 8 rungs of
escalation headroom; that trade — give up stake size, buy runway — is the whole point of the
multi-ladder structure.

### 2.3 The stepping rule: +1 on loss, −2 on win

Within a ladder, index $i$ moves:

- **loss** → $i + 1$
- **win** → $i - 2$
- clamped to $[0, i_{\max}]$

Down-2 is the correct partner to Fibonacci stakes because $F_n = F_{n-1} + F_{n-2}$: a 1:1 win at
rung $n$ returns exactly the two rungs beneath it, so retreating two rungs keeps the index an
honest proxy for accumulated deficit measured in units.

**Index-space random walk.** The index is a walk with $+1$ w.p. $q = 1-p = 0.505$ and $-2$ w.p.
$p = 0.495$. Drift per round is $q - 2p = -0.485$: strongly negative. The walk spends nearly all
its time reflected at 0, and reaching the top rung is a rare large-deviation event.

**Why that rarity does not save you.** The walk is skip-free upward, so $P(\text{ever reach } +n) = w^n$
where $w$ solves $w = q + p\,w^3$ (step up and you're done; step down 2 and you must climb 3).
Numerically (verified):

- Fair game ($p=q=0.5$): $w = 1/\varphi = 0.61803$, and $w\varphi = 1.00000$ exactly.
- House edge 1% ($q=0.505$): $w = 0.62703$, and $w\varphi = 1.01456$.

Since stakes grow like $\varphi^n$ ($\varphi = 1.618$), the expected contribution of rung $n$ to
your P&L scales as $w^n \varphi^n$. **In a fair game the Fibonacci growth exactly cancels the
hitting-probability decay** — every rung contributes equally, which is the elegant property the
system is built on. **A house edge tips that product above 1**, so deeper rungs contribute *more*
expected loss, not less. That single number, $w\varphi > 1$, is the mathematical reason the
left tail is unbounded-feeling and the mean is negative. (Heuristic scaling: infinite ladder, no
reflection at 0, no bridging. It explains the shape; the Monte Carlo produces the real numbers.)

### 2.4 Bridging policies — what happens when you lose at the top rung

This is the only genuinely designed part of the system. Three policies (`BridgingPolicy`):

**`advance_to_next_ladder_start`** — move to ladder $k+1$, index 0. At the top of the *last*
ladder, stop with `table_limit`. Conservative default in the Python CLI.

**`carry_over_index_delta`** — the interesting one. On the *first* bridge, latch a recovery mark:

$$R = \text{pnl} + |\text{pnl}| \cdot \rho = \text{pnl}\,(1-\rho) \quad\text{for pnl} < 0$$

with $\rho = $ `recovery_target_pct`. Example: pnl $=-500$, $\rho=0.5$ → $R = -250$; the player is
now playing to claw back half the hole, not to reach the session target. Then advance to ladder
$k+1$ at index `crossover_offset`. Recovery clears the moment pnl $\ge R$ after any ordinary
(non-bridging) step, and clearing resets hard to **L1, index 0** — the escalation is unwound in
one move. Two subtleties that matter:

- $R$ is latched only on the *first* bridge (`if not in_recovery`). Later bridges deepen the hole
  but do **not** re-latch, so the target becomes progressively easier relative to current pnl.
- If pnl $\ge 0$ at bridge time (possible), $R = \text{pnl}$, so recovery clears on the next step.

**`stop_at_table_limit`** — stop immediately on any top-of-ladder loss. Safest, caps upside.

The presets (`presets.ini`, mirrored in `src/engine/presets.ts`) are all just $(\rho,$ offset$)$
pairs over `carry_over_index_delta`: conservative (0.25, 0), default (0.5, 0), moderate (0.5, 1),
aggressive (0.75, 2), high_offset (0.5, 3), full_recovery (1.0, 0), quick_reset (0.1, 0).

### 2.5 Ruin and the safe-target search (Python only)

A session ends on: `profit_target`, `stop_loss`, `max_rounds`, `table_limit` (top of last ladder,
or stake > table max), `bankroll_exhausted`. **Ruin** is defined as
`stop_loss + table_limit + bankroll_exhausted` — note `max_rounds` is *censored, not counted as
ruin*, which flatters long grinding sessions.

`SafeTargetFinder.search_grid` sweeps profit targets, runs a full Monte Carlo per target, and
reports the **largest** target with $P(\text{ruin}) \le \alpha$. It does this by overwriting the
answer on every passing target as it walks the grid upward, which silently assumes ruin is
monotone increasing in target. It is *usually* monotone; it is not guaranteed to be at small
sample counts. Treat a non-monotone curve as a bug signal, not a discovery. The full curve is
always written to `trade_off_curve_*.csv` — read it, don't trust the single scalar.

---

## 3. Where the math lives

### Python (`simulator.py`, ~1000 lines, single file)

- `GameSpec` — payout ratio, win probability, `resolve_bet`.
- `LadderSpec` — stakes, `get_stake` (clamps on read).
- `StrategyConfig` — ladders + policy + $\rho$ + offset.
- `SessionSimulator.step_index` (`simulator.py:226`) — **the stepping and bridging core.**
- `SessionSimulator.play_round` (`simulator.py:349`) — affordability → table max → resolve →
  stop checks → `step_index`. Order matters; stop checks precede the ladder step.
- `MonteCarloEngine` — loops sessions, aggregates, CIs via `scipy.stats.t`.
- `SafeTargetFinder` — the grid search of §2.5.
- `verify_bridging.py` — hand-driven trace of `carry_over_index_delta`; a useful oracle.

### TypeScript (`betting-companion/src/engine/`)

| File | Role |
| --- | --- |
| `types.ts` | All shared shapes. Read first. |
| `ladder.ts` | `DEFAULT_LADDERS`, stake lookup/clamping. |
| `session.ts` | Port of `SessionSimulator`, **but pausing for user decisions**. `stepIndex`, `handleBridging`, `executeCarryOver`, `processBridgingDecision`, `processAutomatedBridge`. |
| `games.ts` | Multi-game registry: even-money, 8-deck Baccarat Banker (0.95:1, tie pushes), Craps odds by point. Probabilities cited to sources in-file. Sessions freeze a `FrozenGameSnapshot` with a fingerprint so registry edits can never re-settle old money. |
| `money.ts` | All settlement in **integer cents**, half-away-from-zero. Never do raw float arithmetic on money. |
| `monte-carlo.ts` | Mulberry32 seeded PRNG + `simulateOneSession` driving the *same* live engine. Runs in workers and tests. |
| `decision-ghosts.ts` | At a bridge, forecasts both branches on a **shared seed stream** so the comparison isn't noise. 1k preview / 10k full samples. |
| `variance-forecast.ts` | P5–P95 / P25–P75 fan over a round-anchor schedule; R7 quantiles. |
| `optimizer.ts` + `optimizer-coordinator.ts` | Searches ladder *shapes*. Grid below 256 candidates, evolutionary above. Scores by Wilson-interval **lower** bound on hit-target, tie-broken by Wilson **upper** bound on ruin, then median max stake, then drawdown, then fewer total rungs. Feasibility = ruin upper bound ≤ tolerance. Conservative by construction — it ranks on interval bounds, not point estimates. |
| `vault.ts` | Trophy records (biggest comeback, longest survival, perfect run), versioned evidence. |
| `countingEngine.ts` | EZ Baccarat Dragon 7 / Panda 8 side-bet counting (Jacobson 2011 constants). Gated feature. |

UI: `src/app/` routes (setup → session → decision → summary → history/vault/optimizer/
card-counting/premium/unlock), `src/store/` Zustand slices, `src/workers/` for the three
simulation workers.

---

## 4. Python vs TypeScript divergences — read before assuming parity

The TS engine is described in comments as a port. It is not identical. Known real differences:

1. **Decisions are human, not policy.** Python resolves a bridge automatically from
   `bridging_policy`. TS sets `awaitingDecision` and waits for `carry_over` / `write_off` /
   `stop_session`. `processAutomatedBridge` reproduces the Python behavior for simulation paths.
2. **`write_off` is TS-only** — reset to L1/index 0, clear recovery, eat the loss. No Python equivalent.
3. **Offset clamping.** TS clamps `crossoverOffset` to the next ladder's max index. Python does
   not; it stores the raw offset. Python's `get_stake` clamps on read so nothing crashes, but
   Python tests top-of-ladder with `index == max_index` while TS uses `index >= maxIndex`. An
   out-of-range Python index therefore never compares equal and **can never bridge again**. No
   shipped preset triggers this (max offset 3, min next-ladder size 8), but any new preset or
   optimizer-generated ladder must respect it.
4. **Pushes.** TS games have `progressionEffect: "neutral"` (Baccarat ties). A push holds the
   ladder position but still releases an already-met recovery target — otherwise a run of ties
   strands the player on an escalated ladder. Python is binary win/loss and has no such path.
5. **Money.** TS is integer-cents throughout. Python is float. Expect last-cent disagreements on
   fractional payouts (0.95:1 Banker).
6. **Starting ladder.** TS `SessionConfig.startingLadder` lets a session begin on L2/L3. Python
   always starts at L1.
7. **RNG.** Python shares one `np.random.Generator` across all sessions in a run. TS derives a
   per-sample seed (`deriveSampleSeed`) into mulberry32 — reproducible per sample, which the
   ghosts and optimizer depend on.

If you change staking behavior, change it in **both** or explicitly document that you did not.

---

## 5. State of the repo (as of 2026-07-28)

- Branch `ci/cd`; main branch is `main`. Latest commit `f2fe5cb` (decision ghosts, vault, optimizer).
- Working tree clean except untracked `.claude/`.
- `.github/workflows/deploy.yml` builds `betting-companion` and deploys the static export to
  **Cloudflare Pages on push to `main`** (needs `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`,
  `CLOUDFLARE_PAGES_PROJECT`). Given the branch name, CI/CD work is likely the open thread here.

**Verification run for this handoff:**

- `npm test -- --run` → **25 files, 333 tests, all passing** (~5.5s).
- Python tests **could not run**: `numpy`, `scipy`, and `pytest` are not installed in this
  environment. `pip install -r requirements.txt` first; then `python3 -m pytest tests -q`.
  Treat the Python suite as unverified until you do.

### Commands

```bash
# TypeScript app (from betting-companion/)
npm install
npm run dev                 # localhost:3000
npm test -- --run
npx tsc --noEmit
npm run lint -- --quiet     # non-quiet reports warnings in generated PWA service-worker files
npm run build               # static export -> out/
npm run build:native        # Capacitor bundle
npm run cap:sync:ios | cap:sync:android

# Python simulator (from repo root)
pip install -r requirements.txt
python simulator.py --run-tests
python simulator.py --bankroll 100000 --n-sessions 10000 --alpha 0.01 \
  --policy advance_to_next_ladder_start
python verify_bridging.py
python3 -m pytest tests -q
```

---

## 6. Constraints and traps

**Non-negotiable product constraints** (from `Gameplay & roguelike feel/00-README.md`, and they
are enforced in review):

1. Offline-first. Everything core must work in airplane mode; no server dependency, ever.
2. User data stays local absent an explicit, separately approved sync feature.
3. Never imply the system changes EV or beats the house edge.
4. Never turn responsible-gambling features into pressure to keep playing.
5. Deterministic financial math with explicitly defined rounding.
6. Version every persisted schema and migrate old data — never silently drop it. Current keys:
   `betting-session:v1`, `betting-history:v1`, `app-settings:v1`, `custom-presets:v1`,
   `premium-entitlement:v1`, `card-counting:v1`, `card-counting-access:v1`.
7. Completion-time side effects must be **idempotent by session ID** — React Strict Mode, route
   remounts, and resumed sessions all re-fire them.
8. Pure math in `src/engine` or `src/lib`; UI state in Zustand; expensive simulation in workers.
9. Do not weaken the premium / invite / card-counting gates. Native builds require an entitlement;
   card counting additionally requires an email-hash whitelist match
   (`public/card-counting-whitelist.json`, re-validated online with cached-access fallback).

**Engineering traps:**

- Editing `GAME_SPECS` does not and must not change settled history — sessions carry a frozen,
  fingerprinted snapshot. Migration of pre-game-module records is handled by
  `migrateLegacyBetRecords`, which reconstructs settlement from the recorded `pnlAfter` chain
  rather than from today's registry. Preserve that property.
- The safe-target scalar assumes monotone ruin (§2.5). Read the CSV curve.
- `max_rounds` is not ruin. Any risk claim built on the ruin number inherits that assumption.
- The optimizer can return ladder shapes unlike the defaults; validate them against divergence
  #3 above before porting anything back to Python.

---

## 7. Roadmap

`Gameplay & roguelike feel/` holds 13 implementation-ready feature prompts with a recommended
delivery order. Shipped so far: decision ghosts (01), live variance fan (07), the vault (05),
in-app ladder optimizer (08), true multi-game support (09), card counting. Not yet started:
run modifiers / challenge runs (03), discipline meta-progression (02), three-act recaps (04),
composure meter (06), voice entry (10), career bankroll mode (11), expectation-vs-reality
ledger (12). Each prompt file is self-contained and intended to be handed to an agent on its
own branch; read `00-README.md` first for the shared constraints and definition of done.

Prior handoffs with per-feature detail live in `betting-companion/docs/`:
`DECISION_GHOSTS_HANDOFF.md`, `THE_VAULT_HANDOFF.md`, `FEATURES_7_8_9_HANDOFF.md`,
`IOS_OFFLINE_PREMIUM.md`, `ANDROID_OFFLINE_PREMIUM.md`, `DESIGN_DIRECTION.md`.
