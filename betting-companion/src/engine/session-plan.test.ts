import { beforeEach, describe, expect, it } from "vitest";
import {
  configFromPresetProvenance,
  findRegisteredGameByFingerprint,
  resolveSessionPlan,
} from "./session-plan";
import { createStrategyFromPreset, DEFAULT_SESSION_CONFIG } from "./presets";
import { DEFAULT_LADDERS } from "./ladder";
import type { SessionConfig } from "./types";
import { useSessionStore } from "@/store/session-store";

import {
  createLabPresetFixture as labPreset,
  LAB_FIXTURE_OBJECTIVE as LAB_OBJECTIVE,
  LAB_FIXTURE_ONE_LADDER as ONE_LADDER,
  LAB_FIXTURE_TWO_LADDERS as TWO_LADDERS,
} from "./optimizer-preset.fixture";

const confirmedConfig: SessionConfig = {
  bankroll: LAB_OBJECTIVE.bankroll,
  profitTarget: LAB_OBJECTIVE.profitTarget,
  stopLossAbs: LAB_OBJECTIVE.stopLossAbs,
  maxRounds: LAB_OBJECTIVE.maxRounds,
  tableMax: LAB_OBJECTIVE.tableMax,
  startingLadder: 0,
};

function resolveOrThrow(
  input: Parameters<typeof resolveSessionPlan>[0]
) {
  const resolution = resolveSessionPlan(input);
  if (!resolution.ok) throw new Error(resolution.error);
  return resolution.plan;
}

describe("resolveSessionPlan", () => {
  beforeEach(() => {
    useSessionStore.getState().resetSession();
  });

  it("previews a built-in preset with its own default ladders", () => {
    const plan = resolveOrThrow({
      presetId: "aggressive",
      customPresets: [],
      config: { ...DEFAULT_SESSION_CONFIG, startingLadder: 1 },
      gameId: "even_money",
      betVariantId: "even_money",
    });
    expect(plan.source.kind).toBe("builtin");
    expect(plan.strategy).toEqual(createStrategyFromPreset("aggressive"));
    expect(plan.strategy.ladders).toBe(DEFAULT_LADDERS);
    expect(plan.config.startingLadder).toBe(1);
    expect(plan.firstStake).toBe(50);
    expect(plan.adjustments).toEqual([]);
    expect(plan.blockers).toEqual([]);
    expect(plan.provenance).toBeNull();
  });

  it("previews a custom preset with its saved ladders, not DEFAULT_LADDERS", () => {
    const preset = labPreset(TWO_LADDERS);
    const plan = resolveOrThrow({
      presetId: preset.id,
      customPresets: [preset],
      config: confirmedConfig,
      gameId: "baccarat_standard_8_deck",
      betVariantId: "banker_5pct_commission",
    });
    expect(plan.source.kind).toBe("custom");
    expect(plan.strategy).toEqual(preset.strategy);
    expect(plan.strategy).not.toBe(preset.strategy);
    expect(plan.strategy.ladders.map((ladder) => ladder.name)).toEqual([
      "Lab 1",
      "Lab 2",
    ]);
    expect(plan.firstStake).toBe(5);
    expect(plan.highestStake).toBe(100);
    expect(plan.provenance?.status).toBe("confirmed_for_these_settings");
    expect(plan.provenance?.mismatches).toEqual([]);
  });

  it("freezes exactly the previewed config, strategy, and game into a new session", () => {
    const preset = labPreset(TWO_LADDERS);
    const plan = resolveOrThrow({
      presetId: preset.id,
      customPresets: [preset],
      config: { ...confirmedConfig, startingLadder: 1 },
      gameId: "baccarat_standard_8_deck",
      betVariantId: "banker_5pct_commission",
    });

    useSessionStore
      .getState()
      .startSession(plan.config, plan.strategy, plan.game);
    const store = useSessionStore.getState();

    expect(store.strategy).toEqual(plan.strategy);
    expect(store.config).toEqual(plan.config);
    expect(store.game?.fingerprint).toBe(plan.game.fingerprint);
    expect(store.state?.currentLadder).toBe(plan.config.startingLadder);
    expect(store.getCurrentStake()).toBe(plan.firstStake);
    expect(store.getCurrentStake()).toBe(25);
  });

  it("reports the engine's starting-ladder clamp instead of hiding it", () => {
    const preset = labPreset(ONE_LADDER);
    const plan = resolveOrThrow({
      presetId: preset.id,
      customPresets: [preset],
      config: { ...confirmedConfig, startingLadder: 2 },
      gameId: "baccarat_standard_8_deck",
      betVariantId: "banker_5pct_commission",
    });
    expect(plan.config.startingLadder).toBe(0);
    expect(plan.adjustments).toHaveLength(1);
    expect(plan.adjustments[0]).toMatchObject({
      field: "startingLadder",
      saved: "ladder 3",
      effective: "Lab 1",
    });

    useSessionStore
      .getState()
      .startSession(plan.config, plan.strategy, plan.game);
    expect(useSessionStore.getState().state?.currentLadder).toBe(0);
    expect(useSessionStore.getState().config?.startingLadder).toBe(0);
  });

  it("does not fall back to another strategy for an unknown preset", () => {
    const resolution = resolveSessionPlan({
      presetId: "custom:deleted",
      customPresets: [],
      config: DEFAULT_SESSION_CONFIG,
      gameId: "even_money",
      betVariantId: "even_money",
    });
    expect(resolution.ok).toBe(false);
    if (!resolution.ok) expect(resolution.error).toMatch(/no longer available/);
  });

  it("lists every setting that differs from the confirmed Lab objective", () => {
    const preset = labPreset(TWO_LADDERS);
    const plan = resolveOrThrow({
      presetId: preset.id,
      customPresets: [preset],
      config: {
        ...confirmedConfig,
        bankroll: 10_000,
        tableMax: undefined,
        startingLadder: 1,
      },
      gameId: "even_money",
      betVariantId: "even_money",
    });
    expect(plan.provenance?.status).toBe("confirmed_for_other_settings");
    const fields = plan.provenance?.mismatches.map((m) => m.field);
    expect(fields).toEqual([
      "Game",
      "Bankroll",
      "Table max",
      "Starting ladder",
    ]);
    expect(plan.provenance?.mismatches.find((m) => m.field === "Table max"))
      .toEqual({ field: "Table max", confirmed: "$500", current: "none" });
  });

  it("flags a saved ladder that no longer matches its confirmed candidate", () => {
    const preset = labPreset(TWO_LADDERS, {
      candidateFingerprint: "fnv1a32:deadbeef",
    });
    const plan = resolveOrThrow({
      presetId: preset.id,
      customPresets: [preset],
      config: confirmedConfig,
      gameId: "baccarat_standard_8_deck",
      betVariantId: "banker_5pct_commission",
    });
    expect(plan.provenance?.mismatches.map((m) => m.field)).toEqual([
      "Ladder fingerprint",
    ]);
  });

  it("aligns settings and game with the confirmed objective without reshaping ladders", () => {
    const preset = labPreset(TWO_LADDERS);
    const aligned = configFromPresetProvenance(preset, {
      ...DEFAULT_SESSION_CONFIG,
      startingLadder: 2,
    });
    expect(aligned).toEqual(confirmedConfig);

    const game = findRegisteredGameByFingerprint(
      preset.provenance.gameFingerprint
    );
    expect(game).toEqual({
      gameId: "baccarat_standard_8_deck",
      betVariantId: "banker_5pct_commission",
    });
    expect(findRegisteredGameByFingerprint("fnv1a32:00000000")).toBeNull();

    const plan = resolveOrThrow({
      presetId: preset.id,
      customPresets: [preset],
      config: aligned,
      gameId: game!.gameId,
      betVariantId: game!.betVariantId,
    });
    expect(plan.provenance?.status).toBe("confirmed_for_these_settings");
    expect(plan.strategy).toEqual(preset.strategy);
  });

  it("explains configurations the engine could not run", () => {
    const preset = labPreset(TWO_LADDERS);
    const plan = resolveOrThrow({
      presetId: preset.id,
      customPresets: [preset],
      config: { ...confirmedConfig, bankroll: 4, stopLossAbs: 4, tableMax: 4 },
      gameId: "baccarat_standard_8_deck",
      betVariantId: "banker_5pct_commission",
    });
    expect(plan.blockers).toHaveLength(2);
    expect(plan.blockers[0]).toMatch(/exceeds the \$4 bankroll/);
    expect(plan.blockers[1]).toMatch(/table max/);
  });

  it("does not touch an active session when Setup re-resolves", () => {
    const preset = labPreset(TWO_LADDERS);
    const first = resolveOrThrow({
      presetId: "default",
      customPresets: [preset],
      config: DEFAULT_SESSION_CONFIG,
      gameId: "even_money",
      betVariantId: "even_money",
    });
    useSessionStore
      .getState()
      .startSession(first.config, first.strategy, first.game);
    const before = useSessionStore.getState();

    resolveOrThrow({
      presetId: preset.id,
      customPresets: [preset],
      config: confirmedConfig,
      gameId: "baccarat_standard_8_deck",
      betVariantId: "banker_5pct_commission",
    });
    const after = useSessionStore.getState();
    expect(after.strategy).toBe(before.strategy);
    expect(after.config).toBe(before.config);
    expect(after.game).toBe(before.game);
  });
});
