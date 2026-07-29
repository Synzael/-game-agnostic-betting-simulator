"use client";

import { useSessionStore } from "@/store";
import { formatStake } from "@/engine";

export function SessionStats() {
  const state = useSessionStore((s) => s.state);
  const config = useSessionStore((s) => s.config);

  if (!state || !config) {
    return null;
  }

  const currentBankroll = config.bankroll + state.pnl;
  const settledRounds =
    (state.winCount ?? 0) + (state.lossCount ?? 0) + (state.pushCount ?? 0);
  const netReturn =
    state.totalWagered > 0 ? (state.pnl / state.totalWagered) * 100 : 0;

  return (
    <div className="grid grid-cols-2 gap-3">
      <StatCard
        label="Rounds"
        value={state.rounds.toString()}
        subtext={`Max: ${config.maxRounds}`}
      />
      <StatCard
        label="Bankroll"
        value={formatStake(currentBankroll)}
        subtext={`Started: ${formatStake(config.bankroll)}`}
        highlight={currentBankroll > config.bankroll}
      />
      <StatCard
        label="Max Stake"
        value={formatStake(state.maxStake)}
        subtext="This session"
      />
      <StatCard
        label="Max Drawdown"
        value={formatStake(state.maxDrawdown)}
        subtext="Peak to trough"
        negative
      />
      <StatCard
        label="Outcomes"
        value={`${state.winCount ?? 0}W · ${state.lossCount ?? 0}L · ${state.pushCount ?? 0}P`}
        subtext={`${settledRounds} settled rounds`}
      />
      <StatCard
        label="Net Return"
        value={`${netReturn >= 0 ? "+" : ""}${netReturn.toFixed(2)}%`}
        subtext="P&L / total wagered"
        highlight={netReturn > 0}
        negative={netReturn < 0}
      />
    </div>
  );
}

function StatCard({
  label,
  value,
  subtext,
  highlight = false,
  negative = false,
}: {
  label: string;
  value: string;
  subtext: string;
  highlight?: boolean;
  negative?: boolean;
}) {
  return (
    <div className="bg-[var(--noir-elevated)] rounded-xl p-4 border border-[var(--noir-border)]">
      <div className="text-[10px] text-muted uppercase tracking-[0.15em]">
        {label}
      </div>
      <div className={`
        font-display text-xl font-semibold mt-1
        ${highlight ? "text-[var(--emerald)]" : negative ? "text-[var(--crimson)]" : "text-champagne"}
      `}>
        {value}
      </div>
      <div className="text-[10px] text-muted mt-1">
        {subtext}
      </div>
    </div>
  );
}
