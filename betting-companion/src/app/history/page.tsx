"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useHistoryStore, useSettingsStore, useVaultStore } from "@/store";
import { Button, Card, CardContent } from "@/components/ui";
import { formatStake } from "@/engine";
import { calculateHistoryStats } from "@/store/history-store";
import { SessionGraph, stopReasonFromResult } from "@/components/graph";
import { useInitializeVault } from "@/components/vault";

export default function HistoryPage() {
  useInitializeVault();
  const sessions = useHistoryStore((s) => s.sessions);
  const clearHistory = useHistoryStore((s) => s.clearHistory);
  const removeSession = useHistoryStore((s) => s.removeSession);
  const showVarianceFan = useSettingsStore((s) => s.showVarianceFan) ?? true;
  const [showConfirmClear, setShowConfirmClear] = useState(false);

  const stats = useMemo(() => calculateHistoryStats(sessions), [sessions]);

  const formatDate = (timestamp: number) => {
    return new Date(timestamp).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  };

  const getStopReasonLabel = (session: (typeof sessions)[0]) => {
    if (session.hitTarget) return "Target";
    if (session.hitStopLoss) return "Stop Loss";
    if (session.hitMaxRounds) return "Max Rounds";
    if (session.hitTableLimit) return "Table Limit";
    if (session.bankrollExhausted) return "Bankrupt";
    if (session.userStopped) return "Stopped";
    return "Unknown";
  };

  const handleClearHistory = () => {
    clearHistory();
    setShowConfirmClear(false);
  };

  return (
    <div className="min-h-screen bg-slate-900 p-4">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <Link
            href="/"
            className="text-slate-400 hover:text-white text-sm mb-1 block"
          >
            &larr; Back
          </Link>
          <h1 className="text-2xl font-bold text-white">Session History</h1>
        </div>
        {sessions.length > 0 && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setShowConfirmClear(true)}
          >
            Clear All
          </Button>
        )}
      </div>

      {/* Clear Confirmation */}
      {showConfirmClear && (
        <Card variant="danger" className="mb-6">
          <CardContent>
            <p className="text-white mb-4">
              Clear all {sessions.length} sessions? This cannot be undone.
              Vault trophies are preserved separately.
            </p>
            <div className="flex gap-2">
              <Button
                variant="danger"
                size="sm"
                onClick={handleClearHistory}
              >
                Yes, Clear All
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setShowConfirmClear(false)}
              >
                Cancel
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Stats Overview */}
      {sessions.length > 0 && (
        <Card className="mb-6">
          <CardContent>
            <h2 className="text-sm text-slate-400 uppercase tracking-wide mb-4">
              Overall Stats
            </h2>
            <div className="grid grid-cols-2 gap-4 mb-4">
              <StatBox
                label="Total P&L"
                value={formatStake(stats.totalPnl)}
                valueColor={stats.totalPnl >= 0 ? "text-green-400" : "text-red-400"}
              />
              <StatBox
                label="Win Rate"
                value={`${stats.winRate.toFixed(1)}%`}
                valueColor={stats.winRate >= 50 ? "text-green-400" : "text-amber-400"}
              />
            </div>
            <div className="grid grid-cols-3 gap-3">
              <StatBox label="Sessions" value={stats.totalSessions.toString()} small />
              <StatBox label="Avg P&L" value={formatStake(stats.avgPnl)} small />
              <StatBox label="Avg Rounds" value={stats.avgRounds.toFixed(0)} small />
            </div>
            <div className="grid grid-cols-2 gap-3 mt-3">
              <StatBox
                label="Best"
                value={formatStake(stats.bestSession)}
                valueColor="text-green-400"
                small
              />
              <StatBox
                label="Worst"
                value={formatStake(stats.worstSession)}
                valueColor="text-red-400"
                small
              />
            </div>
          </CardContent>
        </Card>
      )}

      {/* Session List */}
      {sessions.length === 0 ? (
        <div className="text-center py-16">
          <div className="text-5xl mb-4">📊</div>
          <p className="text-slate-400 mb-2">No sessions yet</p>
          <p className="text-slate-500 text-sm mb-6">
            Complete a betting session to see your history
          </p>
          <Link href="/setup">
            <Button variant="primary">Start Session</Button>
          </Link>
        </div>
      ) : (
        <div className="space-y-3">
          {sessions.map((session) => (
            <Card key={session.id} className="relative">
              <CardContent>
                <div className="flex justify-between items-start">
                  <div>
                    <div className="text-xs text-slate-500 mb-1">
                      {formatDate(session.startTime)}
                    </div>
                    {session.game && (
                      <div className="mb-1 text-[10px] uppercase tracking-wide text-slate-500">
                        {session.game.gameDisplayName} ·{" "}
                        {session.game.betVariant.displayName}
                      </div>
                    )}
                    <div
                      className={`text-xl font-bold ${
                        session.finalPnl >= 0 ? "text-green-400" : "text-red-400"
                      }`}
                    >
                      {session.finalPnl >= 0 ? "+" : ""}
                      {formatStake(session.finalPnl)}
                    </div>
                  </div>
                  <div className="text-right">
                    <div
                      className={`text-xs px-2 py-1 rounded ${
                        session.hitTarget
                          ? "bg-green-900/50 text-green-400"
                          : "bg-red-900/50 text-red-400"
                      }`}
                    >
                      {getStopReasonLabel(session)}
                    </div>
                    <div className="text-xs text-slate-500 mt-2">
                      {session.roundsPlayed} rounds
                    </div>
                  </div>
                </div>
                {session.betHistory && session.betHistory.length > 0 && (
                  <div className="mt-3">
                    <SessionGraph
                      betHistory={session.betHistory}
                      events={session.events}
                      stopReason={stopReasonFromResult(session)}
                      varianceForecast={session.forecastSnapshot}
                      showVarianceFan={showVarianceFan}
                      showBetNumbers={false}
                      height={70}
                    />
                  </div>
                )}
                <button
                  onClick={() => removeSession(session.id)}
                  className="absolute top-2 right-2 text-slate-600 hover:text-slate-400 text-xs p-1"
                  aria-label="Remove session"
                >
                  &times;
                </button>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Footer */}
      <div className="mt-8 text-center">
        <Link href="/vault" className="mr-3">
          <Button variant="gold">Open the Vault</Button>
        </Link>
        <Link href="/">
          <Button variant="ghost">Back Home</Button>
        </Link>
      </div>
    </div>
  );
}

function StatBox({
  label,
  value,
  valueColor = "text-white",
  small = false,
}: {
  label: string;
  value: string;
  valueColor?: string;
  small?: boolean;
}) {
  return (
    <div className="bg-slate-700/50 rounded-lg p-3 text-center">
      <div className="text-xs text-slate-400 mb-1">{label}</div>
      <div className={`${small ? "text-lg" : "text-2xl"} font-bold ${valueColor}`}>
        {value}
      </div>
    </div>
  );
}
