"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui";
import {
  TROPHY_PRESENTATIONS,
  TrophyCard,
  trophyEvidenceCopy,
  trophyMetric,
  useInitializeVault,
} from "@/components/vault";
import { formatStake, TROPHY_CATEGORIES } from "@/engine";
import { SessionResult, TrophyCategory, TrophySlot } from "@/engine/types";
import { useHistoryStore, useVaultStore } from "@/store";

export default function VaultPage() {
  useInitializeVault();
  const historySessions = useHistoryStore((state) => state.sessions);
  const initialized = useVaultStore((state) => state.initialized);
  const slots = useVaultStore((state) => state.slots);
  const sessionsById = useVaultStore((state) => state.sessionsById);
  const clearVault = useVaultStore((state) => state.clearVault);
  const persistenceError = useVaultStore((state) => state.persistenceError);
  const dismissPersistenceError = useVaultStore(
    (state) => state.dismissPersistenceError
  );

  const [selectedCategory, setSelectedCategory] =
    useState<TrophyCategory | null>(null);
  const [showClearConfirmation, setShowClearConfirmation] = useState(false);

  const slotCountsBySession = useMemo(() => {
    const counts: Record<string, number> = {};
    Object.values(slots).forEach((slot) => {
      if (slot) counts[slot.sessionId] = (counts[slot.sessionId] ?? 0) + 1;
    });
    return counts;
  }, [slots]);

  const selectedSlot = selectedCategory ? slots[selectedCategory] : undefined;
  const selectedSnapshot = selectedSlot
    ? sessionsById[selectedSlot.sessionId]
    : undefined;

  const handleClearVault = () => {
    if (clearVault()) {
      setShowClearConfirmation(false);
      setSelectedCategory(null);
    }
  };

  return (
    <main className="min-h-screen bg-noir px-4 pb-12 safe-top safe-bottom">
      <header className="mx-auto max-w-6xl pt-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <Link
              href="/"
              className="text-xs uppercase tracking-[0.16em] text-secondary transition-colors hover:text-champagne"
            >
              &larr; Velvet Stakes
            </Link>
            <div className="mt-7 flex items-center gap-4">
              <div className="vault-emblem" aria-hidden="true">
                <span>V</span>
              </div>
              <div>
                <p className="text-[9px] uppercase tracking-[0.3em] text-gold">
                  Private collection
                </p>
                <h1 className="font-display text-4xl text-champagne sm:text-5xl">
                  The Vault
                </h1>
              </div>
            </div>
          </div>

          {Object.keys(slots).length > 0 && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setShowClearConfirmation(true)}
            >
              Clear Vault
            </Button>
          )}
        </div>

        <div className="mt-7 max-w-2xl">
          <p className="text-sm leading-6 text-secondary">
            Record-setting sessions are preserved automatically on this
            device, even when ordinary history rolls off or is cleared.
          </p>
          <p className="mt-2 text-xs text-muted">
            The Vault is a record of past sessions—not a prompt to extend play
            or increase stakes.
          </p>
        </div>
      </header>

      {persistenceError && (
        <div
          role="status"
          className="mx-auto mt-6 flex max-w-6xl items-start justify-between gap-4 rounded-xl border border-[var(--amber)] bg-[var(--amber-glow)] p-4"
        >
          <p className="text-sm text-secondary">{persistenceError}</p>
          <button
            type="button"
            className="text-xs uppercase tracking-wider text-[var(--amber)]"
            onClick={dismissPersistenceError}
          >
            Dismiss
          </button>
        </div>
      )}

      {showClearConfirmation && (
        <section className="mx-auto mt-6 max-w-6xl rounded-2xl border border-[var(--crimson)] bg-[var(--crimson-glow)] p-5">
          <h2 className="font-display text-xl text-champagne">
            Permanently clear the Vault?
          </h2>
          <p className="mt-2 max-w-xl text-sm leading-6 text-secondary">
            This permanently removes every preserved trophy. It is separate
            from Session History: clearing the Vault will not delete history,
            and clearing history will not delete the Vault.
          </p>
          <div className="mt-4 flex flex-wrap gap-3">
            <Button variant="danger" size="sm" onClick={handleClearVault}>
              Yes, Clear Vault
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setShowClearConfirmation(false)}
            >
              Cancel
            </Button>
          </div>
        </section>
      )}

      <section
        className="mx-auto mt-10 grid max-w-6xl gap-5 md:grid-cols-3"
        aria-label="Vault trophy case"
      >
        {!initialized ? (
          <div className="col-span-full py-16 text-center text-sm text-muted">
            Opening the trophy case…
          </div>
        ) : (
          TROPHY_CATEGORIES.map((category) => {
            const slot = slots[category];
            return (
              <TrophyCard
                key={category}
                category={category}
                slot={slot}
                snapshot={slot ? sessionsById[slot.sessionId] : undefined}
                ownerSlotCount={
                  slot ? slotCountsBySession[slot.sessionId] ?? 1 : 1
                }
                onOpen={setSelectedCategory}
              />
            );
          })
        )}
      </section>

      <footer className="mx-auto mt-10 flex max-w-6xl flex-wrap items-center justify-between gap-3 border-t border-[var(--noir-border)] pt-6">
        <p className="text-[10px] uppercase tracking-[0.16em] text-muted">
          Stored only in this browser or device
        </p>
        <div className="flex gap-4">
          <Link
            href="/history"
            className="text-xs uppercase tracking-[0.14em] text-secondary hover:text-gold"
          >
            Session History
          </Link>
          <Link
            href="/"
            className="text-xs uppercase tracking-[0.14em] text-secondary hover:text-gold"
          >
            Home
          </Link>
        </div>
      </footer>

      {selectedCategory && selectedSlot && selectedSnapshot && (
        <TrophyEvidenceDialog
          category={selectedCategory}
          slot={selectedSlot}
          session={selectedSnapshot.session}
          ownerSlotCount={slotCountsBySession[selectedSlot.sessionId] ?? 1}
          onClose={() => setSelectedCategory(null)}
        />
      )}
    </main>
  );
}

function TrophyEvidenceDialog({
  category,
  slot,
  session,
  ownerSlotCount,
  onClose,
}: {
  readonly category: TrophyCategory;
  readonly slot: TrophySlot;
  readonly session: SessionResult;
  readonly ownerSlotCount: number;
  readonly onClose: () => void;
}) {
  const presentation = TROPHY_PRESENTATIONS[category];
  const date = new Date(session.endTime).toLocaleString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/80 p-3 backdrop-blur-sm sm:items-center"
      role="dialog"
      aria-modal="true"
      aria-labelledby="trophy-detail-title"
    >
      <div className="card-gold relative max-h-[88vh] w-full max-w-lg overflow-y-auto p-6 sm:p-8">
        <button
          type="button"
          onClick={onClose}
          className="absolute right-4 top-4 h-9 w-9 rounded-full border border-[var(--noir-border)] text-secondary hover:text-champagne"
          aria-label="Close trophy evidence"
        >
          &times;
        </button>

        <p className="text-[9px] uppercase tracking-[0.24em] text-gold">
          Auditable evidence · Rules v{slot.evidence.rulesVersion}
        </p>
        <h2
          id="trophy-detail-title"
          className="mt-2 pr-10 font-display text-3xl text-champagne"
        >
          {presentation.title}
        </h2>
        <p className="mt-1 font-display text-2xl text-gold">
          {trophyMetric(category, slot)}
        </p>

        <div className="divider-gold my-6" />

        <p className="font-display text-xl leading-8 text-champagne">
          {trophyEvidenceCopy(category, slot, session)}
        </p>

        <dl className="mt-6 space-y-3">
          <EvidenceRow label="Recorded" value={date} />
          <EvidenceRow
            label="Ending P&L"
            value={`${session.finalPnl >= 0 ? "+" : ""}${formatStake(
              session.finalPnl
            )}`}
          />
          <EvidenceRow
            label="Rounds"
            value={session.roundsPlayed.toString()}
          />
          <EvidenceRow
            label="Starting bankroll"
            value={formatStake(session.config.bankroll)}
          />
          <EvidenceRow
            label="Session ID"
            value={session.id}
            compact
          />
        </dl>

        {ownerSlotCount > 1 && (
          <p className="mt-6 rounded-xl border border-[var(--gold-dim)] bg-[var(--gold-glow)] p-3 text-sm text-secondary">
            This preserved session holds {ownerSlotCount} trophy slots. The
            session snapshot is stored only once.
          </p>
        )}

        <Button
          variant="ghost"
          fullWidth
          className="mt-7"
          onClick={onClose}
        >
          Close Evidence
        </Button>
      </div>
    </div>
  );
}

function EvidenceRow({
  label,
  value,
  compact = false,
}: {
  readonly label: string;
  readonly value: string;
  readonly compact?: boolean;
}) {
  return (
    <div className="flex items-start justify-between gap-5 border-b border-[var(--noir-border)] pb-3">
      <dt className="text-xs text-muted">{label}</dt>
      <dd
        className={`text-right text-sm text-secondary ${
          compact ? "max-w-[60%] break-all font-mono text-[10px]" : ""
        }`}
      >
        {value}
      </dd>
    </div>
  );
}
