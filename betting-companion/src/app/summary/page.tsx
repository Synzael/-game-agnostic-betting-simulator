"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useSessionStore, useHistoryStore, useVaultStore } from "@/store";
import { Button } from "@/components/ui";
import { formatStake, getStopReasonText, isWinningSession } from "@/engine";
import { TrophyCategory } from "@/engine/types";
import { AdventureGraph } from "@/components/graph";
import { NewVaultRecord } from "@/components/vault";

export default function SummaryPage() {
  const router = useRouter();
  const state = useSessionStore((s) => s.state);
  const config = useSessionStore((s) => s.config);
  const completedResult = useSessionStore((s) => s.completedResult);
  const game = useSessionStore((s) => s.game);
  const endSession = useSessionStore((s) => s.endSession);
  const resetSession = useSessionStore((s) => s.resetSession);
  const historySessions = useHistoryStore((s) => s.sessions);
  const addSession = useHistoryStore((s) => s.addSession);
  const initializeVault = useVaultStore((s) => s.initializeFromHistory);
  const evaluateSession = useVaultStore((s) => s.evaluateSession);
  const consumeReveal = useVaultStore((s) => s.consumeReveal);
  const pendingRevealsBySessionId = useVaultStore(
    (s) => s.pendingRevealsBySessionId
  );
  const vaultPersistenceError = useVaultStore((s) => s.persistenceError);
  const completionHandled = useRef(false);
  const [newVaultRecords, setNewVaultRecords] = useState<
    readonly TrophyCategory[]
  >([]);

  // Complete once across Strict Mode replays and safely deduplicate across
  // remounts with the cached SessionResult ID.
  useEffect(() => {
    if (!state?.stopped || completionHandled.current) return;

    const result = endSession();
    if (!result) return;
    completionHandled.current = true;

    initializeVault(historySessions);
    addSession(result);
    evaluateSession(result);
  }, [
    state?.stopped,
    endSession,
    historySessions,
    initializeVault,
    addSession,
    evaluateSession,
  ]);

  // A forecast can finish after the terminal result is first written. Replace
  // the same history ID with its completed compact snapshot when that happens.
  useEffect(() => {
    if (completedResult?.forecastSnapshot) {
      addSession(completedResult);
    }
  }, [completedResult, addSession]);

  // Copy the persisted pending reveal into page-local state, then consume it.
  // The timer keeps the effect synchronized without a cascading render and
  // remains safe under Strict Mode's setup/cleanup replay.
  useEffect(() => {
    if (!completedResult) return;
    const categories = pendingRevealsBySessionId[completedResult.id];
    if (!categories || categories.length === 0) return;

    const timer = window.setTimeout(() => {
      setNewVaultRecords(categories);
      consumeReveal(completedResult.id);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [completedResult, consumeReveal, pendingRevealsBySessionId]);

  // Redirect if no session
  if (!state || !config) {
    return (
      <div className="min-h-screen bg-noir p-6 flex flex-col items-center justify-center">
        <div className="text-center animate-fadeInUp">
          <div className="w-16 h-16 mx-auto mb-4 rounded-2xl bg-[var(--noir-card)] border border-[var(--noir-border)] flex items-center justify-center">
            <svg className="w-8 h-8 text-muted" fill="currentColor" viewBox="0 0 20 20">
              <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z" clipRule="evenodd" />
            </svg>
          </div>
          <p className="text-secondary mb-6 font-display text-lg">No session data</p>
          <Link href="/">
            <Button variant="gold">Go Home</Button>
          </Link>
        </div>
      </div>
    );
  }

  const isWin = isWinningSession(state);
  const stopReasonText = getStopReasonText(state.stopReason);

  const handleNewSession = () => {
    resetSession();
    router.push("/setup");
  };

  const handleGoHome = () => {
    resetSession();
    router.push("/");
  };

  return (
    <div className="min-h-screen bg-noir p-4 safe-bottom">
      {/* Result Header */}
      <div className="text-center py-8 animate-fadeInUp">
        <div className={`
          w-24 h-24 mx-auto mb-6 rounded-3xl flex items-center justify-center
          ${isWin
            ? "bg-gradient-to-br from-[var(--emerald)] to-[var(--emerald-deep)] shadow-emerald"
            : "bg-gradient-to-br from-[var(--crimson)] to-[var(--crimson-deep)] shadow-crimson"
          }
        `}>
          {isWin ? (
            <svg className="w-12 h-12 text-white" fill="currentColor" viewBox="0 0 20 20">
              <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
            </svg>
          ) : (
            <svg className="w-12 h-12 text-white" fill="currentColor" viewBox="0 0 20 20">
              <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clipRule="evenodd" />
            </svg>
          )}
        </div>

        <h1
          className={`font-display text-3xl mb-2 ${
            isWin ? "text-[var(--emerald)]" : "text-[var(--crimson)]"
          }`}
        >
          {isWin ? "Target Reached!" : stopReasonText}
        </h1>

        <div
          className={`font-display text-6xl font-semibold mt-4 ${
            state.pnl >= 0 ? "pnl-positive" : "pnl-negative"
          }`}
        >
          {state.pnl >= 0 ? "+" : ""}
          {formatStake(state.pnl)}
        </div>
      </div>

      {/* Adventure Graph */}
      <div className="max-w-md mx-auto animate-fadeInUp stagger-1">
        <AdventureGraph height={140} />
      </div>

      {/* Decorative divider */}
      <div className="divider-gold my-8 max-w-md mx-auto" />

      {/* Stats */}
      <div className="max-w-md mx-auto space-y-4">
        <NewVaultRecord categories={newVaultRecords} />

        {vaultPersistenceError && (
          <div
            role="status"
            className="rounded-xl border border-[var(--amber)] bg-[var(--amber-glow)] p-4 text-sm leading-6 text-secondary"
          >
            {vaultPersistenceError}
          </div>
        )}

        <div className="card-noir p-5 animate-fadeInUp stagger-1">
          <h2 className="text-[10px] text-muted uppercase tracking-[0.15em] mb-4">
            Session Summary
          </h2>
          <div className="space-y-3">
            <StatRow label="Rounds Played" value={state.rounds.toString()} />
            {game && (
              <StatRow
                label="Game"
                value={`${game.gameDisplayName} · ${game.betVariant.displayName}`}
              />
            )}
            <StatRow
              label="Win / Loss / Push"
              value={`${state.winCount ?? 0} / ${state.lossCount ?? 0} / ${state.pushCount ?? 0}`}
            />
            <StatRow
              label="Total Wagered"
              value={formatStake(state.totalWagered)}
            />
            <StatRow
              label="Max Stake"
              value={formatStake(state.maxStake)}
            />
            <StatRow
              label="Max Drawdown"
              value={formatStake(state.maxDrawdown)}
              negative
            />
            <StatRow
              label="Ladder Tops Hit"
              value={state.topTouches.toString()}
            />
          </div>
        </div>

        {/* Ladder Touches */}
        <div className="card-noir p-5 animate-fadeInUp stagger-2">
          <h2 className="text-[10px] text-muted uppercase tracking-[0.15em] mb-4">
            Ladder Activity
          </h2>
          <div className="flex gap-2">
            {Object.entries(state.ladderTouches).map(([ladder, touches]) => (
              <div
                key={ladder}
                className="flex-1 bg-[var(--noir-elevated)] rounded-xl p-3 text-center border border-[var(--noir-border)]"
              >
                <div className="text-[10px] text-muted uppercase tracking-wider">L{Number(ladder) + 1}</div>
                <div className="font-display text-2xl text-gold mt-1">{touches}</div>
                <div className="text-[10px] text-muted">bets</div>
              </div>
            ))}
          </div>
        </div>

        {/* Actions */}
        <div className="space-y-3 pt-6 animate-fadeInUp stagger-3">
          <Button
            variant="gold"
            size="lg"
            fullWidth
            onClick={handleNewSession}
          >
            New Session
          </Button>
          <Button
            variant="ghost"
            size="lg"
            fullWidth
            onClick={handleGoHome}
          >
            Go Home
          </Button>
        </div>
      </div>
    </div>
  );
}

function StatRow({
  label,
  value,
  negative = false
}: {
  label: string;
  value: string;
  negative?: boolean;
}) {
  return (
    <div className="flex justify-between items-center">
      <span className="text-secondary text-sm">{label}</span>
      <span className={`font-display text-lg ${negative ? "text-[var(--crimson)]" : "text-champagne"}`}>
        {value}
      </span>
    </div>
  );
}
