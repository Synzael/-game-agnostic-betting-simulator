"use client";

import {
  SessionResult,
  TrophyCategory,
  TrophySlot,
  VaultSessionSnapshot,
} from "@/engine/types";
import { formatStake } from "@/engine";
import { SessionGraph, stopReasonFromResult } from "@/components/graph";

export interface TrophyPresentation {
  readonly title: string;
  readonly number: string;
  readonly emptyDescription: string;
}

export const TROPHY_PRESENTATIONS: Record<
  TrophyCategory,
  TrophyPresentation
> = {
  biggest_comeback: {
    title: "Biggest Comeback",
    number: "I",
    emptyDescription:
      "A completed session can qualify when it rises from an observed low point.",
  },
  longest_survival: {
    title: "Longest Survival",
    number: "II",
    emptyDescription:
      "Any completed, recorded run of one round or more can occupy this slot.",
  },
  perfect_run: {
    title: "Perfect Run",
    number: "III",
    emptyDescription:
      "Hit the target with no ladder-top touches, Carry Over, or Write Off events.",
  },
};

export function trophyMetric(
  category: TrophyCategory,
  slot: TrophySlot
): string {
  if (category === "biggest_comeback") {
    return formatStake(Number(slot.evidence.metric));
  }
  if (category === "longest_survival") {
    return `${Number(slot.evidence.metric)} rounds`;
  }
  return "Target · No bridges";
}

export function trophyEvidenceCopy(
  category: TrophyCategory,
  slot: TrophySlot,
  session: SessionResult
): string {
  if (category === "biggest_comeback") {
    const trough = Number(slot.evidence.facts.minimumPnlObserved);
    const finalPnl = Number(slot.evidence.facts.finalPnl);
    const amount = Number(slot.evidence.facts.comebackAmount);
    return `Rose from ${formatStake(trough)} to ${formatStake(
      finalPnl
    )}: a ${formatStake(amount)} comeback.`;
  }
  if (category === "longest_survival") {
    return `${session.roundsPlayed} rounds — the longest recorded run in this Vault.`;
  }
  return "Hit the session target with zero ladder-top touches and no Carry Over or Write Off events.";
}

interface TrophyCardProps {
  readonly category: TrophyCategory;
  readonly slot?: TrophySlot;
  readonly snapshot?: VaultSessionSnapshot;
  readonly ownerSlotCount?: number;
  readonly onOpen: (category: TrophyCategory) => void;
}

function formatDate(timestamp: number): string {
  return new Date(timestamp).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function TrophyCard({
  category,
  slot,
  snapshot,
  ownerSlotCount = 1,
  onOpen,
}: TrophyCardProps) {
  const presentation = TROPHY_PRESENTATIONS[category];
  const session = snapshot?.session;
  const isFilled = Boolean(slot && session);

  return (
    <button
      type="button"
      className={`vault-trophy vault-trophy-${category} ${
        isFilled ? "vault-trophy-filled" : "vault-trophy-empty"
      }`}
      onClick={() => onOpen(category)}
      disabled={!isFilled}
      aria-label={
        isFilled
          ? `Open ${presentation.title} evidence`
          : `${presentation.title}, empty`
      }
    >
      <span className="vault-corner vault-corner-left" aria-hidden="true" />
      <span className="vault-corner vault-corner-right" aria-hidden="true" />

      <span className="relative z-10 flex min-h-full flex-col text-left">
        <span className="flex items-center justify-between">
          <span className="text-[9px] uppercase tracking-[0.24em] text-muted">
            Vault Record
          </span>
          <span className="font-display text-sm text-gold">
            {presentation.number}
          </span>
        </span>

        <span className="my-4 flex items-center gap-3" aria-hidden="true">
          <span className="h-px flex-1 bg-[var(--gold-dim)] opacity-50" />
          <TrophyMark category={category} />
          <span className="h-px flex-1 bg-[var(--gold-dim)] opacity-50" />
        </span>

        <span className="font-display text-2xl text-champagne">
          {presentation.title}
        </span>

        {!slot || !session ? (
          <>
            <span className="mt-2 text-[10px] uppercase tracking-[0.18em] text-muted">
              Awaiting a record
            </span>
            <span className="mt-5 text-sm leading-6 text-secondary">
              {presentation.emptyDescription}
            </span>
          </>
        ) : (
          <>
            <span className="mt-2 font-display text-3xl text-gold">
              {trophyMetric(category, slot)}
            </span>
            <span className="mt-1 text-xs text-secondary">
              {category === "perfect_run"
                ? `First achieved · ${formatDate(session.endTime)}`
                : formatDate(session.endTime)}
            </span>

            {session.betHistory && session.betHistory.length > 0 && (
              <span className="mt-5 block border-y border-[var(--noir-border)] py-2">
                <SessionGraph
                  betHistory={session.betHistory}
                  events={session.events}
                  stopReason={stopReasonFromResult(session)}
                  showBetNumbers={false}
                  height={76}
                />
              </span>
            )}

            <span className="mt-4 flex items-end justify-between gap-3">
              <span>
                <span className="block text-[9px] uppercase tracking-[0.18em] text-muted">
                  Ending P&amp;L
                </span>
                <span
                  className={`font-display text-xl ${
                    session.finalPnl >= 0 ? "pnl-positive" : "pnl-negative"
                  }`}
                >
                  {session.finalPnl >= 0 ? "+" : ""}
                  {formatStake(session.finalPnl)}
                </span>
              </span>
              <span className="text-right text-[10px] uppercase tracking-[0.12em] text-gold">
                View evidence
              </span>
            </span>

            {ownerSlotCount > 1 && (
              <span className="mt-4 rounded-full border border-[var(--gold-dim)] bg-[var(--gold-glow)] px-3 py-1 text-center text-[10px] text-secondary">
                This session holds {ownerSlotCount} Vault records
              </span>
            )}
          </>
        )}
      </span>
    </button>
  );
}

function TrophyMark({ category }: { readonly category: TrophyCategory }) {
  if (category === "biggest_comeback") {
    return (
      <svg className="h-8 w-8 text-gold" viewBox="0 0 32 32" fill="none">
        <path d="M7 23 16 8l9 15" stroke="currentColor" strokeWidth="1.5" />
        <path d="M10 19h12M13 14h6" stroke="currentColor" />
        <circle cx="16" cy="25" r="2" fill="currentColor" />
      </svg>
    );
  }
  if (category === "longest_survival") {
    return (
      <svg className="h-8 w-8 text-gold" viewBox="0 0 32 32" fill="none">
        <circle cx="16" cy="16" r="10" stroke="currentColor" strokeWidth="1.5" />
        <path d="M16 10v7l5 3M12 4h8" stroke="currentColor" />
      </svg>
    );
  }
  return (
    <svg className="h-8 w-8 text-gold" viewBox="0 0 32 32" fill="none">
      <path
        d="m16 5 3.1 6.3 6.9 1-5 4.9 1.2 6.8-6.2-3.2L9.8 24l1.2-6.8-5-4.9 6.9-1L16 5Z"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      <circle cx="16" cy="15" r="2.5" fill="currentColor" />
    </svg>
  );
}
