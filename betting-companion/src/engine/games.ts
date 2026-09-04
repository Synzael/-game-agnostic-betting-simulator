import {
  BetRecord,
  BetVariantSpec,
  FrozenGameSnapshot,
  GameOutcomeSpec,
  GameSpec,
  RecordedOutcome,
} from "./types";
import { fromMinorUnits, settleNetPnl } from "./money";

export const GAME_REGISTRY_VERSION = 1;
export const GAME_PROBABILITY_TOLERANCE = 1e-9;

/**
 * Rules sources:
 * - Standard eight-deck Baccarat rules and 0.95:1 Banker payout:
 *   https://www.gra.gov.sg/docs/default-source/game-rules/mbs/baccarat-games/mbs-baccarat-game-rules---ver-8.pdf
 * - Eight-deck Banker/Player/Tie combination counts used for probabilities:
 *   https://wizardofodds.com/games/baccarat/basics/
 * - Craps Pass/Come odds settlement ratios:
 *   https://www.gra.gov.sg/docs/default-source/game-rules/mbs/dice-games/mbs-craps-game-rules-version-3.pdf
 *
 * Craps probabilities are exact conditional probabilities after the point is
 * established: point combinations divided by point + seven combinations.
 */
const BANKER_WIN_PROBABILITY = 2_292_252_566_437_888 / 4_998_398_275_503_360;
const PLAYER_WIN_PROBABILITY = 2_230_518_282_592_256 / 4_998_398_275_503_360;
const BACCARAT_TIE_PROBABILITY = 475_627_426_473_216 / 4_998_398_275_503_360;

const STANDARD_OUTCOME_IDS = {
  win: "win",
  loss: "loss",
} as const;

export const GAME_SPECS: readonly GameSpec[] = Object.freeze([
  {
    id: "even_money",
    version: 1,
    displayName: "Generic Even Money",
    description: "Independent 1:1 outcomes using the simulator's 1% house-edge baseline.",
    assumptions: "Independent rounds; 49.5% win and 50.5% loss.",
    betVariants: [
      {
        id: "even_money",
        displayName: "Even Money (1:1)",
        settlementVersion: 1,
        roundingRule: "nearest_cent_half_away_from_zero",
        outcomes: [
          {
            id: STANDARD_OUTCOME_IDS.win,
            displayName: "Win",
            probability: 0.495,
            netPayoutMultiplier: 1,
            progressionEffect: "win",
          },
          {
            id: STANDARD_OUTCOME_IDS.loss,
            displayName: "Loss",
            probability: 0.505,
            netPayoutMultiplier: -1,
            progressionEffect: "loss",
          },
        ],
      },
    ],
  },
  {
    id: "baccarat_standard_8_deck",
    version: 1,
    displayName: "Baccarat",
    description: "Standard eight-deck Banker wager with 5% commission.",
    assumptions:
      "Standard eight-deck drawing rules; Banker wins pay 0.95:1 and ties push.",
    betVariants: [
      {
        id: "banker_5pct_commission",
        displayName: "Banker (5% commission)",
        settlementVersion: 1,
        roundingRule: "nearest_cent_half_away_from_zero",
        outcomes: [
          {
            id: "banker_win",
            displayName: "Banker Win",
            probability: BANKER_WIN_PROBABILITY,
            netPayoutMultiplier: 0.95,
            progressionEffect: "win",
          },
          {
            id: "banker_loss",
            displayName: "Banker Loss",
            probability: PLAYER_WIN_PROBABILITY,
            netPayoutMultiplier: -1,
            progressionEffect: "loss",
          },
          {
            id: "tie",
            displayName: "Tie / Push",
            probability: BACCARAT_TIE_PROBABILITY,
            netPayoutMultiplier: 0,
            progressionEffect: "neutral",
          },
        ],
      },
    ],
  },
  {
    id: "craps_single_odds",
    version: 1,
    displayName: "Craps Odds",
    description: "A point-specific single odds wager after a point is established.",
    assumptions:
      "Models only the supplemental odds wager resolved by point before seven; the required line wager is outside this module.",
    betVariants: [
      createCrapsVariant("point_4_10", "Point 4 / 10", 3, 2),
      createCrapsVariant("point_5_9", "Point 5 / 9", 4, 1.5),
      createCrapsVariant("point_6_8", "Point 6 / 8", 5, 1.2),
    ],
  },
]);

function createCrapsVariant(
  id: string,
  displayName: string,
  pointCombinations: number,
  payout: number
): BetVariantSpec {
  const sevenCombinations = 6;
  const total = pointCombinations + sevenCombinations;

  return {
    id,
    displayName,
    settlementVersion: 1,
    roundingRule: "nearest_cent_half_away_from_zero",
    outcomes: [
      {
        id: "point_win",
        displayName: "Point Wins",
        probability: pointCombinations / total,
        netPayoutMultiplier: payout,
        progressionEffect: "win",
      },
      {
        id: "seven_loss",
        displayName: "Seven Out",
        probability: sevenCombinations / total,
        netPayoutMultiplier: -1,
        progressionEffect: "loss",
      },
    ],
  };
}

export function validateGameRegistry(games: readonly GameSpec[]): void {
  const gameIds = new Set<string>();

  for (const game of games) {
    if (!game.id || gameIds.has(game.id)) {
      throw new Error(`Duplicate or empty game id: ${game.id}`);
    }
    gameIds.add(game.id);
    if (!Number.isInteger(game.version) || game.version <= 0) {
      throw new Error(`Invalid version for game ${game.id}`);
    }
    if (game.betVariants.length === 0) {
      throw new Error(`Game ${game.id} has no bet variants`);
    }

    const variantIds = new Set<string>();
    for (const variant of game.betVariants) {
      if (!variant.id || variantIds.has(variant.id)) {
        throw new Error(`Duplicate or empty variant id in ${game.id}: ${variant.id}`);
      }
      variantIds.add(variant.id);
      validateVariant(game.id, variant);
    }
  }
}

function validateVariant(gameId: string, variant: BetVariantSpec): void {
  if (variant.outcomes.length < 2) {
    throw new Error(`${gameId}/${variant.id} must have at least two outcomes`);
  }

  const outcomeIds = new Set<string>();
  let probabilitySum = 0;
  for (const outcome of variant.outcomes) {
    if (!outcome.id || outcomeIds.has(outcome.id)) {
      throw new Error(
        `Duplicate or empty outcome id in ${gameId}/${variant.id}: ${outcome.id}`
      );
    }
    outcomeIds.add(outcome.id);
    if (
      !Number.isFinite(outcome.probability) ||
      outcome.probability < 0 ||
      outcome.probability > 1
    ) {
      throw new Error(`Invalid probability for ${gameId}/${variant.id}/${outcome.id}`);
    }
    if (!Number.isFinite(outcome.netPayoutMultiplier)) {
      throw new Error(`Invalid payout for ${gameId}/${variant.id}/${outcome.id}`);
    }
    probabilitySum += outcome.probability;
  }

  if (Math.abs(probabilitySum - 1) > GAME_PROBABILITY_TOLERANCE) {
    throw new Error(
      `Probabilities for ${gameId}/${variant.id} sum to ${probabilitySum}`
    );
  }
}

validateGameRegistry(GAME_SPECS);

export function getAllGames(): readonly GameSpec[] {
  return GAME_SPECS;
}

export function getGame(gameId: string, version?: number): GameSpec | undefined {
  return GAME_SPECS.find(
    (game) => game.id === gameId && (version === undefined || game.version === version)
  );
}

export function getBetVariant(
  game: GameSpec,
  variantId: string
): BetVariantSpec | undefined {
  return game.betVariants.find((variant) => variant.id === variantId);
}

export function createGameSnapshot(
  gameId: string,
  betVariantId: string
): FrozenGameSnapshot {
  const game = getGame(gameId);
  if (!game) throw new Error(`Unknown game: ${gameId}`);
  const variant = getBetVariant(game, betVariantId);
  if (!variant) {
    throw new Error(`Unknown bet variant: ${gameId}/${betVariantId}`);
  }

  const snapshotData = {
    gameId: game.id,
    gameVersion: game.version,
    gameDisplayName: game.displayName,
    gameDescription: game.description,
    assumptions: game.assumptions,
    betVariant: structuredCloneSafe(variant),
  };

  return {
    ...snapshotData,
    fingerprint: fingerprintValue(snapshotData),
  };
}

export function createDefaultGameSnapshot(): FrozenGameSnapshot {
  return createGameSnapshot("even_money", "even_money");
}

export function createLegacyGameSnapshot(): FrozenGameSnapshot {
  const current = createDefaultGameSnapshot();
  const legacy = {
    ...current,
    gameId: "legacy_even_money",
    gameVersion: 1,
    gameDisplayName: "Legacy Even Money",
    gameDescription:
      "Migrated win/loss settlement preserved from a pre-game-module session.",
    assumptions:
      "Actual recorded P&L is preserved exactly; probabilities were not part of the original session record.",
  };
  return {
    ...legacy,
    fingerprint: fingerprintValue({
      ...legacy,
      migrationVersion: 1,
    }),
  };
}

export function resolveOutcomeSpec(
  snapshot: FrozenGameSnapshot,
  recorded: RecordedOutcome | string
): GameOutcomeSpec {
  const outcomeId = typeof recorded === "string" ? recorded : recorded.outcomeId;
  if (typeof recorded !== "string") {
    if (
      recorded.gameId !== snapshot.gameId ||
      recorded.gameVersion !== snapshot.gameVersion ||
      recorded.betVariantId !== snapshot.betVariant.id
    ) {
      throw new Error("Recorded outcome does not belong to the frozen game variant");
    }
  }

  const outcome = snapshot.betVariant.outcomes.find(
    (candidate) => candidate.id === outcomeId
  );
  if (!outcome) {
    throw new Error(
      `Unknown outcome ${outcomeId} for ${snapshot.gameId}/${snapshot.betVariant.id}`
    );
  }
  return outcome;
}

/**
 * Backfills typed outcomes onto bets recorded before the game module existed.
 *
 * Settlement is reconstructed from the recorded `pnlAfter` chain rather than
 * from the current registry, so historical money is never re-derived from
 * today's game definitions. Shared by the session and history store migrations
 * so the two can never interpret the same legacy record differently.
 */
export function migrateLegacyBetRecords(
  bets: readonly BetRecord[],
  game: FrozenGameSnapshot
): BetRecord[] {
  let previousPnl = 0;
  return bets.map((bet) => {
    if (bet.outcome && bet.progressionEffect && bet.settledPnl !== undefined) {
      previousPnl = bet.pnlAfter;
      return bet;
    }

    const won = bet.won === true;
    const settledPnl = bet.pnlAfter - previousPnl;
    previousPnl = bet.pnlAfter;
    return {
      ...bet,
      outcome: createRecordedOutcome(game, won ? "win" : "loss"),
      outcomeDisplayName: won ? "Win" : "Loss",
      progressionEffect: won ? ("win" as const) : ("loss" as const),
      settledPnl,
    };
  });
}

export function createRecordedOutcome(
  snapshot: FrozenGameSnapshot,
  outcomeId: string
): RecordedOutcome {
  resolveOutcomeSpec(snapshot, outcomeId);
  return {
    gameId: snapshot.gameId,
    gameVersion: snapshot.gameVersion,
    betVariantId: snapshot.betVariant.id,
    outcomeId,
  };
}

export function settleOutcome(
  stake: number,
  snapshot: FrozenGameSnapshot,
  recorded: RecordedOutcome | string
): number {
  const outcome = resolveOutcomeSpec(snapshot, recorded);
  return fromMinorUnits(settleNetPnl(stake, outcome.netPayoutMultiplier));
}

export function expectedReturnPerUnit(snapshot: FrozenGameSnapshot): number {
  return snapshot.betVariant.outcomes.reduce(
    (sum, outcome) =>
      sum + outcome.probability * outcome.netPayoutMultiplier,
    0
  );
}

export function fingerprintValue(value: unknown): string {
  const json = stableStringify(value);
  let hash = 0x811c9dc5;
  for (let index = 0; index < json.length; index += 1) {
    hash ^= json.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `fnv1a32:${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}

function structuredCloneSafe<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
