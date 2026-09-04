"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { CardCountingHUD } from "@/components/card-counting/CardCountingHUD";
import { Button } from "@/components/ui";
import type { CardRank } from "@/engine";
import { useCountingStore, useCardCountingAccessStore } from "@/store";
import type { EventLogEntry } from "@/store/counting-store";

type EventType = EventLogEntry["type"];

const RANK_BUTTONS: ReadonlyArray<{
  readonly rank: CardRank;
  readonly label: string;
}> = [
  { rank: "A", label: "A" },
  { rank: 2, label: "2" },
  { rank: 3, label: "3" },
  { rank: 4, label: "4" },
  { rank: 5, label: "5" },
  { rank: 6, label: "6" },
  { rank: 7, label: "7" },
  { rank: 8, label: "8" },
  { rank: 9, label: "9" },
  { rank: 10, label: "10" },
  { rank: "J", label: "J" },
  { rank: "Q", label: "Q" },
  { rank: "K", label: "K" },
];

const EVENT_STYLES: Record<EventType, string> = {
  card: "border-[var(--gold-dim)] text-champagne",
  burn: "border-[var(--amber)] text-amber-200",
  hand: "border-[var(--emerald)] text-emerald-200",
  reset: "border-[var(--crimson)] text-red-200",
};

function formatRank(rank: CardRank): string {
  return typeof rank === "number" ? String(rank) : rank;
}

export default function CardCountingPage() {
  const router = useRouter();
  const approvedEmailHash = useCardCountingAccessStore(
    (s) => s.approvedEmailHash
  );
  const unlocked = useCardCountingAccessStore((s) => s.unlocked);
  const hasAccess = approvedEmailHash !== null && unlocked;

  const snapshot = useCountingStore((s) => s.snapshot);
  const cardSeen = useCountingStore((s) => s.cardSeen);
  const completeHand = useCountingStore((s) => s.completeHand);
  const resetShoe = useCountingStore((s) => s.resetShoe);
  const setBetSize = useCountingStore((s) => s.setBetSize);
  const getBurnCount = useCountingStore((s) => s.getBurnCount);
  const pushEvent = useCountingStore((s) => s.pushEvent);
  const eventLog = useCountingStore((s) => s.eventLog);

  // Persist rehydration is async on a hard load; the gate must not act on
  // the pre-hydration default state or unlocked users get bounced home.
  const [accessReady, setAccessReady] = useState(false);
  useEffect(() => {
    if (useCardCountingAccessStore.persist.hasHydrated()) {
      queueMicrotask(() => setAccessReady(true));
      return;
    }
    return useCardCountingAccessStore.persist.onFinishHydration(() =>
      setAccessReady(true)
    );
  }, []);

  // Whitelist + paywall gate: locked visitors are sent home (static export
  // has no middleware, so the guard lives client-side).
  useEffect(() => {
    if (accessReady && !hasAccess) {
      router.replace("/");
    }
  }, [accessReady, hasAccess, router]);

  function handleCardSeen(rank: CardRank): void {
    cardSeen(rank);
    pushEvent(`Card seen: ${formatRank(rank)}`, "card");
  }

  function handleExposeBurn(rank: CardRank): void {
    cardSeen(rank);
    pushEvent(
      `Burn card exposed: ${formatRank(rank)}. Burn ${getBurnCount(rank)} additional cards by house rule.`,
      "burn"
    );
  }

  function handleCompleteHand(): void {
    completeHand();
    pushEvent("Hand completed. Recommendations re-evaluated.", "hand");
  }

  function handleResetShoe(): void {
    resetShoe();
    pushEvent("Shoe reset.", "reset");
  }

  if (!hasAccess) {
    return null;
  }

  return (
    <div className="min-h-screen bg-noir p-4 safe-bottom">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-6">
        <div className="flex flex-col gap-4 rounded-[28px] border border-[var(--gold-dim)] bg-[linear-gradient(145deg,rgba(212,175,55,0.10),rgba(5,5,8,0.9))] p-6 shadow-[0_12px_40px_rgba(0,0,0,0.35)]">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <Link
                href="/"
                className="text-sm uppercase tracking-[0.2em] text-secondary transition-colors hover:text-champagne"
              >
                &larr; Back Home
              </Link>
              <h1 className="mt-3 font-display text-4xl text-champagne">
                EZ Baccarat Card Counting
              </h1>
              <p className="mt-2 max-w-3xl text-sm text-secondary">
                Drive the counting engine with live shoe events. Record every exposed
                card, mark each completed hand, and watch Dragon 7 and Panda 8 update
                in real time.
              </p>
            </div>
            <div className="rounded-full border border-[var(--gold-dim)] px-4 py-2 text-xs uppercase tracking-[0.18em] text-gold">
              8-deck shoe &bull; 14-card cut &bull; 1 hand after cut
            </div>
          </div>
        </div>

        <div className="grid gap-6 xl:grid-cols-[minmax(0,2fr)_380px]">
          <CardCountingHUD
            state={snapshot}
            onBetSizeChange={setBetSize}
            onResetShoe={handleResetShoe}
          />

          <div className="space-y-6">
            <section className="card-noir p-5">
              <div className="mb-4">
                <h2 className="font-display text-2xl text-champagne">Live Shoe Events</h2>
                <p className="mt-1 text-sm text-secondary">
                  Use these controls to feed the engine as cards appear at the table.
                </p>
              </div>

              <div>
                <p className="mb-3 text-xs uppercase tracking-[0.2em] text-secondary">
                  Record Exposed Card
                </p>
                <div className="grid grid-cols-4 gap-2">
                  {RANK_BUTTONS.map(({ rank, label }) => (
                    <Button
                      key={`card-${label}`}
                      variant="secondary"
                      size="sm"
                      onClick={() => handleCardSeen(rank)}
                      className="justify-center"
                    >
                      {label}
                    </Button>
                  ))}
                </div>
              </div>

              <div className="mt-5">
                <p className="mb-3 text-xs uppercase tracking-[0.2em] text-secondary">
                  Burn Card Shortcut
                </p>
                <div className="grid grid-cols-4 gap-2">
                  {RANK_BUTTONS.map(({ rank, label }) => (
                    <Button
                      key={`burn-${label}`}
                      variant="ghost"
                      size="sm"
                      onClick={() => handleExposeBurn(rank)}
                      className="justify-center"
                    >
                      {label}
                    </Button>
                  ))}
                </div>
                <p className="mt-3 text-xs text-secondary">
                  This records the exposed burn card and logs the additional burn count
                  implied by the house rule.
                </p>
              </div>

              <div className="mt-5 grid gap-3 sm:grid-cols-2">
                <Button variant="success" onClick={handleCompleteHand}>
                  Complete Hand
                </Button>
                <Button variant="danger" onClick={handleResetShoe}>
                  Reset Shoe
                </Button>
              </div>
            </section>

            <section className="card-noir p-5">
              <div className="mb-4 flex items-center justify-between gap-3">
                <div>
                  <h2 className="font-display text-2xl text-champagne">Event Log</h2>
                  <p className="mt-1 text-sm text-secondary">
                    Most recent shoe actions are shown first.
                  </p>
                </div>
                <div className="rounded-full border border-[var(--noir-border)] px-3 py-1 text-xs uppercase tracking-[0.18em] text-secondary">
                  {eventLog.length} entries
                </div>
              </div>

              {eventLog.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-[var(--noir-border)] p-4 text-sm text-secondary">
                  No events yet. Start with the first exposed card of the shoe.
                </div>
              ) : (
                <div className="space-y-2">
                  {eventLog.map((entry) => (
                    <div
                      key={entry.id}
                      className={`rounded-xl border px-3 py-2 text-sm ${EVENT_STYLES[entry.type]}`}
                    >
                      {entry.label}
                    </div>
                  ))}
                </div>
              )}
            </section>
          </div>
        </div>
      </div>
    </div>
  );
}
