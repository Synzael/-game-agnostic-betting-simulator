#!/usr/bin/env node
/**
 * Real-browser QA for the P0 slices: effective Setup preview, optimizer
 * checkpoint/resume through real Web Workers and IndexedDB, cancellation, and
 * the 2,500-sample / 5,000-round variance forecast timing.
 *
 * Playwright is not a project dependency. Point PLAYWRIGHT_MODULE at an
 * installed `playwright` package directory, e.g. a global install:
 *
 *   npm run build && python3 -m http.server 3100 --directory out &
 *   PLAYWRIGHT_MODULE=/path/to/node_modules/playwright \
 *     node scripts/qa/browser-qa.mjs
 *
 * Environment: BASE_URL (default http://localhost:3100), QA_OUT (screenshot
 * directory, default /tmp/velvet-qa), HEADLESS (default 1).
 */

import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const require = createRequire(import.meta.url);
const playwrightModule = process.env.PLAYWRIGHT_MODULE;
if (!playwrightModule) {
  console.error("Set PLAYWRIGHT_MODULE to an installed playwright package directory.");
  process.exit(2);
}
const { chromium, devices } = require(playwrightModule);

const BASE_URL = process.env.BASE_URL ?? "http://localhost:3100";
const OUT_DIR = process.env.QA_OUT ?? "/tmp/velvet-qa";
const HEADLESS = process.env.HEADLESS !== "0";
mkdirSync(OUT_DIR, { recursive: true });

const report = [];
function log(label, value) {
  const line = value === undefined ? label : `${label}: ${typeof value === "string" ? value : JSON.stringify(value)}`;
  console.log(line);
  report.push(line);
}
function assert(condition, message) {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
  log(`ok - ${message}`);
}
/** Wait until the running view reports at least `minEvaluated` candidates, or explain what is on screen. */
async function waitForEvaluated(page, minEvaluated, timeout = 120_000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const progress = await page.getByTestId("job-progress").innerText().catch(() => null);
    const evaluated = progress ? Number.parseInt(progress, 10) : NaN;
    if (Number.isFinite(evaluated) && evaluated >= minEvaluated) return evaluated;
    if ((await page.getByText("5 · Confirmed frontier").count()) > 0) {
      throw new Error(`job finished before reaching ${minEvaluated} evaluations (last progress: ${progress})`);
    }
    await page.waitForTimeout(50);
  }
  const text = (await page.locator("main").innerText()).replace(/\s+/g, " ").slice(0, 600);
  throw new Error(`timed out waiting for ${minEvaluated} evaluations; screen: ${text}`);
}

async function shot(page, name) {
  const file = path.join(OUT_DIR, `${name}.png`);
  await page.screenshot({ path: file, fullPage: true });
  log("screenshot", file);
}
const readStore = (page, key) =>
  page.evaluate((k) => {
    const raw = localStorage.getItem(k);
    return raw ? JSON.parse(raw) : null;
  }, key);

/**
 * Widen the search so the evolutionary branch (not the 256-cell grid) runs.
 * `heavy` lengthens each simulated path (far target, long horizon) so a run
 * lasts long enough to be paused or reloaded mid-generation.
 */
async function configureEvolutionaryJob(page, heavy = false) {
  await page.getByLabel("Maximum ladders").fill("4");
  await page.getByLabel("Maximum steps").fill("8");
  await page.getByLabel("Worker concurrency").fill("2");
  if (heavy) {
    // Tiny stakes against a huge bankroll and an unreachable target: paths run
    // the full 10,000-round horizon instead of stopping early.
    await page.getByLabel("Bankroll").fill("100000");
    await page.getByLabel("Profit target").fill("50000");
    await page.getByLabel("Stop loss").fill("100000");
    await page.getByLabel("Table max").fill("100000");
    await page.getByLabel("Max rounds").fill("10000");
    await page.getByLabel("Minimum stake").fill("5");
    await page.getByLabel("Maximum stake").fill("20");
  }
  const estimate = await page.getByText(/Estimated .* canonical candidates/).textContent();
  assert(/seeded evolutionary/.test(estimate), `search is evolutionary (${estimate.trim()})`);
}

async function startJob(page) {
  await page.getByRole("button", { name: "Review Job" }).click();
  await page.getByRole("button", { name: "Start Local Search" }).click();
}

async function captureResults(page) {
  await page.getByText("5 · Confirmed frontier").waitFor({ timeout: 180_000 });
  const cards = page.locator("main > div.space-y-3 > div");
  const count = await cards.count();
  const results = [];
  for (let index = 0; index < count; index += 1) {
    const card = cards.nth(index);
    await card.locator("summary").click();
    results.push((await card.innerText()).replace(/\s+/g, " ").trim());
  }
  return results;
}

async function optimizerScenarios(browser) {
  const context = await browser.newContext();
  const page = await context.newPage();
  page.on("pageerror", (error) => log("PAGE ERROR", error.message));

  // --- Run 1: uninterrupted baseline -------------------------------------
  await page.goto(`${BASE_URL}/optimizer/`);
  await configureEvolutionaryJob(page);
  await startJob(page);
  await page.getByTestId("job-status").waitFor();
  const t0 = Date.now();
  const baseline = await captureResults(page);
  log("optimizer uninterrupted run wall time ms", Date.now() - t0);
  assert(baseline.length > 0, `baseline produced ${baseline.length} confirmed candidates`);
  await shot(page, "optimizer-results-baseline");

  // Save the first feasible candidate as a custom preset for the Setup scenario.
  const saveButtons = page.getByRole("button", { name: "Save as custom preset" });
  const feasibleCount = await saveButtons.count();
  log("feasible candidates offering save", feasibleCount);
  let savedPresetName = null;
  if (feasibleCount > 0) {
    savedPresetName = "QA Lab Preset";
    await page.getByLabel("Custom preset name").first().fill(savedPresetName);
    await saveButtons.first().click();
    await page.getByRole("button", { name: "Saved" }).first().waitFor();
    const presets = await readStore(page, "custom-presets:v1");
    assert(
      presets?.state?.presets?.[0]?.displayName === savedPresetName,
      "custom preset persisted to localStorage with provenance"
    );
  }

  // --- Run 1b: uninterrupted heavy baseline for the interruption runs -------
  await page.getByRole("button", { name: "New Search" }).click();
  await configureEvolutionaryJob(page, true);
  await startJob(page);
  const t1 = Date.now();
  const heavyBaseline = await captureResults(page);
  log("optimizer heavy uninterrupted run wall time ms", Date.now() - t1);

  // Slow the renderer (page and its workers) so interruptions land mid-search.
  const cdp = await context.newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  log("cpu throttling for interruption runs", "4x");

  // --- Run 2: pause, reload (tab kill), resume ----------------------------
  await page.getByRole("button", { name: "New Search" }).click();
  await configureEvolutionaryJob(page, true);
  await startJob(page);
  await page.getByText(/Generation 2 of 6/).waitFor({ timeout: 120_000 });
  await page.getByRole("button", { name: "Pause" }).click();
  await page.getByTestId("job-status").filter({ hasText: "Paused" }).waitFor();
  await page.getByTestId("checkpoint-state").filter({ hasText: /Checkpoint saved/ }).waitFor();
  const pausedState = await page.getByTestId("checkpoint-state").innerText();
  log("checkpoint line while paused", pausedState);
  await shot(page, "optimizer-paused");
  await page.reload();
  const banner = page.getByTestId("saved-job-resumable");
  await banner.waitFor({ timeout: 30_000 });
  const bannerText = (await banner.innerText()).replace(/\s+/g, " ");
  log("resume banner after reload", bannerText);
  assert(/committed evaluation/.test(bannerText), "banner reports committed evaluations from IndexedDB");
  assert(/generation \d of 6/.test(bannerText), "banner reports the saved generation");
  await shot(page, "optimizer-resume-banner");
  await page.getByRole("button", { name: "Resume Saved Job" }).click();
  const resumed = await captureResults(page);
  assert(
    JSON.stringify(resumed) === JSON.stringify(heavyBaseline),
    "pause → reload → resume reproduces the uninterrupted confirmed frontier"
  );

  // --- Run 3: hard reload while running (no pause) -------------------------
  await page.getByRole("button", { name: "New Search" }).click();
  await page.getByTestId("saved-job-resumable").waitFor({ state: "detached", timeout: 10_000 }).catch(() => {});
  await configureEvolutionaryJob(page, true);
  await startJob(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  // Two full generations committed (64) puts the reload inside generation 3.
  const beforeReload = await waitForEvaluated(page, 70);
  const statusBeforeReload = await page.getByTestId("job-status").innerText();
  log("hard reload at", { evaluated: beforeReload, status: statusBeforeReload });
  await page.reload();
  await page.getByTestId("saved-job-resumable").waitFor({ timeout: 30_000 });
  await page.getByRole("button", { name: "Resume Saved Job" }).click();
  const resumedHard = await captureResults(page);
  assert(
    JSON.stringify(resumedHard) === JSON.stringify(heavyBaseline),
    "reload mid-run → resume reproduces the uninterrupted confirmed frontier"
  );

  // --- Run 4: cancel a multi-worker job; late results must not mutate UI ----
  await page.getByRole("button", { name: "New Search" }).click();
  await configureEvolutionaryJob(page, true);
  await startJob(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  await waitForEvaluated(page, 8);
  const cancelAt = Date.now();
  await page.getByRole("button", { name: "Cancel" }).click();
  await page.getByTestId("job-status").filter({ hasText: "Cancelled" }).waitFor();
  log("cancel → Cancelled label latency ms", Date.now() - cancelAt);
  const progressAtCancel = await page.getByTestId("job-progress").innerText();
  await page.waitForTimeout(1500);
  const progressLater = await page.getByTestId("job-progress").innerText();
  assert(progressAtCancel === progressLater, "no progress mutation after cancel");
  await shot(page, "optimizer-cancelled");
  await page.getByRole("button", { name: "Back to Setup" }).click();
  await page.waitForTimeout(500);
  assert(
    (await page.getByTestId("saved-job-resumable").count()) === 0,
    "a cancelled job is not offered for resume"
  );

  // --- Legacy / incompatible checkpoint handling ---------------------------
  await page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const open = indexedDB.open("velvet-stakes-optimizer", 1);
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result;
          const tx = db.transaction("checkpoints", "readwrite");
          const store = tx.objectStore("checkpoints");
          const getAll = store.getAll();
          getAll.onsuccess = () => {
            const latest = getAll.result.sort((a, b) => b.updatedAt - a.updatedAt)[0];
            if (!latest) return reject(new Error("no checkpoint to downgrade"));
            // Simulate a schema-1 evolutionary exploration record.
            const legacy = { ...latest };
            delete legacy.schemaVersion;
            delete legacy.engineVersion;
            delete legacy.evolution;
            delete legacy.explorationSeedBankFingerprint;
            delete legacy.confirmationSeedBankFingerprint;
            legacy.jobId = "legacy-qa";
            legacy.stage = "exploration";
            legacy.status = "interrupted";
            legacy.confirmation = [];
            legacy.updatedAt = Date.now() + 1000;
            store.put(legacy);
          };
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        };
      })
  );
  await page.reload();
  const incompatible = page.getByTestId("saved-job-incompatible");
  await incompatible.waitFor({ timeout: 30_000 });
  const incompatibleText = (await incompatible.innerText()).replace(/\s+/g, " ");
  log("incompatible banner", incompatibleText);
  assert(/cannot be resumed exactly/.test(incompatibleText), "legacy evolutionary checkpoint is explained, not resumed");
  await shot(page, "optimizer-incompatible");
  await page.getByRole("button", { name: "Discard" }).click();
  await incompatible.waitFor({ state: "detached" });

  await context.storageState({ path: path.join(OUT_DIR, "state.json") });
  await context.close();
  return { savedPresetName };
}

async function setupScenario(browser, savedPresetName) {
  const context = await browser.newContext({
    storageState: path.join(OUT_DIR, "state.json"),
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => log("PAGE ERROR", error.message));
  await page.goto(`${BASE_URL}/setup/`);

  assert((await page.getByText("L1", { exact: true }).count()) === 1, "built-in preview shows L1");
  if (!savedPresetName) {
    log("skip - no feasible preset saved; custom preview path not exercised in browser");
    await context.close();
    return;
  }
  await page.getByText(savedPresetName, { exact: true }).click();
  assert((await page.getByText("L1", { exact: true }).count()) === 0, "custom preset hides DEFAULT_LADDERS");
  assert((await page.getByText("Lab 1", { exact: true }).count()) >= 1, "custom preset previews its Lab ladders");
  const plan = page.getByTestId("effective-plan");
  const planText = (await plan.innerText()).replace(/\s+/g, " ");
  log("effective plan (before align)", planText);
  assert(/Confirmed for other settings/.test(planText), "mismatch against default Setup settings is reported");
  await shot(page, "setup-custom-mismatch");
  await page.getByRole("button", { name: "Use confirmed settings" }).click();
  await page.getByText("Confirmed for these settings").waitFor();
  const alignedText = (await plan.innerText()).replace(/\s+/g, " ");
  log("effective plan (aligned)", alignedText);
  await shot(page, "setup-custom-aligned");

  await page.getByRole("button", { name: "Start Session" }).click();
  await page.getByRole("button", { name: "I Understand" }).click();
  await page.waitForURL(/\/session\/?$/);
  const session = await readStore(page, "betting-session:v1");
  const ladders = session.state.strategy.ladders.map((ladder) => ladder.name);
  log("frozen session strategy ladders", ladders);
  log("frozen session config", session.state.config);
  assert(ladders[0] === "Lab 1", "session froze the custom ladders");
  assert(session.state.config.tableMax === 500 && session.state.config.maxRounds === 300, "session froze the aligned objective settings");
  await shot(page, "session-from-custom-preset");
  await context.close();
}

async function forecastBenchmark(browser) {
  const context = await browser.newContext();
  const page = await context.newPage();
  page.on("pageerror", (error) => log("PAGE ERROR", error.message));
  await page.goto(`${BASE_URL}/setup/`);
  // Default preset, even money, 5,000 rounds: the 2,500-sample full forecast.
  await page.getByRole("button", { name: "Start Session" }).click();
  await page.getByRole("button", { name: "I Understand" }).click();
  await page.waitForURL(/\/session\/?$/);
  const started = Date.now();
  let previewAt = null;
  let readyAt = null;
  const frameLatencies = [];
  while (Date.now() - started < 180_000) {
    const status = (await readStore(page, "betting-session:v1"))?.state?.forecastStatus;
    const now = Date.now();
    if (status === "modeling" && previewAt === null) previewAt = now - started;
    if (status === "ready") {
      readyAt = now - started;
      break;
    }
    // Main-thread responsiveness while the worker is busy.
    const latency = await page.evaluate(
      () =>
        new Promise((resolve) => {
          const t = performance.now();
          requestAnimationFrame(() => resolve(performance.now() - t));
        })
    );
    frameLatencies.push(latency);
    await page.waitForTimeout(100);
  }
  log("forecast preview (400 samples) visible after ms", previewAt);
  log("forecast full (2,500 samples × 5,000 rounds) ready after ms", readyAt);
  log("main-thread rAF latency while modeling ms (max / median)", {
    max: Math.max(...frameLatencies).toFixed(1),
    median: frameLatencies.sort((a, b) => a - b)[Math.floor(frameLatencies.length / 2)]?.toFixed(1),
    samples: frameLatencies.length,
  });
  const heap = await page.evaluate(() => performance.memory?.usedJSHeapSize ?? null);
  log("page JS heap after forecast bytes (workers excluded)", heap);
  assert(readyAt !== null, "full forecast completed within 180 s");
  await shot(page, "session-forecast-ready");
  await context.close();
}

async function layoutScenarios(browser) {
  const phone = devices["iPhone SE"] ?? {
    viewport: { width: 375, height: 667 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  };
  const context = await browser.newContext({
    ...phone,
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  await page.goto(`${BASE_URL}/setup/`);
  await shot(page, "iphone-se-setup-reduced-motion");
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth
  );
  log("setup horizontal overflow px (iPhone SE)", overflow);
  assert(overflow <= 0, "no horizontal overflow on iPhone SE Setup");
  await page.goto(`${BASE_URL}/optimizer/`);
  await shot(page, "iphone-se-optimizer");
  await context.close();
}

const browser = await chromium.launch({ headless: HEADLESS });
try {
  log("browser", `${browser.browserType().name()} ${browser.version()}`);
  const { savedPresetName } = await optimizerScenarios(browser);
  await setupScenario(browser, savedPresetName);
  await forecastBenchmark(browser);
  await layoutScenarios(browser);
  log("RESULT", "all browser checks passed");
} catch (error) {
  log("RESULT", `FAILED: ${error.message}`);
  for (const context of browser.contexts()) {
    for (const [index, page] of context.pages().entries()) {
      const text = await page.locator("body").innerText().catch(() => "");
      log(`open page ${index} text`, text.replace(/\s+/g, " ").slice(0, 800));
      await shot(page, `failure-page-${index}`).catch(() => {});
    }
  }
  process.exitCode = 1;
} finally {
  await browser.close();
  writeFileSync(path.join(OUT_DIR, "report.txt"), report.join("\n"));
  console.log(`report written to ${path.join(OUT_DIR, "report.txt")}`);
}
