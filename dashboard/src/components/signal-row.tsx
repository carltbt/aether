"use client";

import { useState } from "react";
import { cn, relativeTime } from "@/lib/utils";

interface Signal {
  id: string;
  ticker: string;
  action: "BUY" | "SELL" | "HOLD";
  conviction: number;
  position_size_pct: number | null;
  reviewer_verdict: string | null;
  code_validation: string | null;
  executed: boolean;
  rationale: string | null;
  score_c1_earnings: number | null;
  score_c2_momentum: number | null;
  score_c3_smart_money: number | null;
  score_c4_quality: number | null;
  score_c5_valuation: number | null;
  score_c6_sentiment: number | null;
  created_at: string;
  strategy_used: string | null;
  market_regime: string | null;
}

const CLUSTERS = [
  { key: "score_c1_earnings", short: "C1", label: "Earnings" },
  { key: "score_c2_momentum", short: "C2", label: "Momentum" },
  { key: "score_c3_smart_money", short: "C3", label: "SmartMoney" },
  { key: "score_c4_quality", short: "C4", label: "Quality" },
  { key: "score_c5_valuation", short: "C5", label: "Valuation" },
  { key: "score_c6_sentiment", short: "C6", label: "News" },
] as const;

// Compute effective outcome from full pipeline state (Trader → Reviewer → ValidateOrder → Execute)
type Outcome =
  | { kind: "hold" }
  | { kind: "executed"; action: "BUY" | "SELL" }
  | { kind: "blocked"; action: "BUY" | "SELL"; by: "reviewer" | "code_validation" }
  | { kind: "approved_pending"; action: "BUY" | "SELL" }  // reviewer OK, not yet executed
  | { kind: "in_review"; action: "BUY" | "SELL" };       // reviewer not yet ran

function computeOutcome(s: Signal): Outcome {
  if (s.action === "HOLD") return { kind: "hold" };
  if (s.executed) return { kind: "executed", action: s.action };
  if (s.reviewer_verdict === "REJECT") return { kind: "blocked", action: s.action, by: "reviewer" };
  if (s.code_validation && s.code_validation.startsWith("REJECTED")) return { kind: "blocked", action: s.action, by: "code_validation" };
  if (s.reviewer_verdict === "APPROVE") return { kind: "approved_pending", action: s.action };
  return { kind: "in_review", action: s.action };
}

export function SignalRow({ signal }: { signal: Signal }) {
  const [expanded, setExpanded] = useState(false);
  const outcome = computeOutcome(signal);

  return (
    <div>
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full px-4 py-3 hover:bg-slate-50 transition-colors text-left"
      >
        <div className="flex items-center gap-4">
          {/* Ticker */}
          <div className="ticker w-16 text-sm">{signal.ticker}</div>

          {/* Outcome badge — état EFFECTIF du signal, pas juste la décision Trader */}
          <OutcomeBadge outcome={outcome} />

          {/* Conviction */}
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-slate-400">conv</span>
            <ConvictionBar value={signal.conviction} />
            <span className="text-sm font-semibold tabular w-8">{signal.conviction}</span>
          </div>

          {/* Cluster scores compact */}
          <div className="hidden md:flex items-center gap-1 flex-1">
            {CLUSTERS.map((c) => {
              const score = signal[c.key as keyof Signal] as number | null;
              return (
                <ClusterChip key={c.short} short={c.short} score={score} />
              );
            })}
          </div>

          {/* Pipeline trace — décision Trader + verdict Reviewer (compact) */}
          <PipelineTrace signal={signal} outcome={outcome} />

          {/* Time */}
          <div className="text-xs text-slate-400 tabular w-20 text-right">
            {relativeTime(signal.created_at)}
          </div>

          {/* Expand chevron */}
          <svg
            className={cn(
              "w-3 h-3 text-slate-400 transition-transform",
              expanded && "rotate-180",
            )}
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        </div>
      </button>

      {expanded && (
        <div className="px-4 pb-4 pt-2 bg-slate-50 border-t border-slate-100 space-y-3">
          {/* Cluster scores detail */}
          <div className="grid grid-cols-6 gap-3 pt-2">
            {CLUSTERS.map((c) => {
              const score = signal[c.key as keyof Signal] as number | null;
              return (
                <div key={c.short} className="bg-white border border-slate-200 rounded-md px-3 py-2">
                  <div className="text-[10px] text-slate-400 uppercase tracking-wider">{c.label}</div>
                  <div className={cn("text-base font-semibold tabular", scoreColor(score))}>
                    {score ?? "—"}
                  </div>
                </div>
              );
            })}
          </div>

          {/* Meta */}
          <div className="flex items-center gap-4 text-xs text-slate-500">
            {signal.strategy_used && (
              <span>
                Strategy <span className="font-mono font-semibold text-slate-700">{signal.strategy_used}</span>
              </span>
            )}
            {signal.position_size_pct !== null && signal.position_size_pct > 0 && (
              <span>
                Size <span className="font-semibold text-slate-700 tabular">{Number(signal.position_size_pct).toFixed(2)}%</span>
              </span>
            )}
            {signal.market_regime && (
              <span>
                Regime <span className="font-mono font-semibold text-slate-700">{signal.market_regime}</span>
              </span>
            )}
          </div>

          {/* Rationale */}
          {signal.rationale && (
            <div className="bg-white border border-slate-200 rounded-md px-3 py-2.5 text-xs text-slate-700 leading-relaxed">
              <div className="text-[10px] text-slate-400 uppercase tracking-wider mb-1">Rationale</div>
              {signal.rationale}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function OutcomeBadge({ outcome }: { outcome: Outcome }) {
  // Style le badge selon l'état EFFECTIF du signal après toute la pipeline
  const config = (() => {
    switch (outcome.kind) {
      case "hold":
        return { label: "HOLD", style: "bg-slate-50 text-slate-500 border-slate-200" };
      case "executed":
        return { label: `${outcome.action} ✓`, style: "bg-emerald-50 text-emerald-700 border-emerald-200" };
      case "blocked":
        return { label: `${outcome.action} ⊘`, style: "bg-red-50 text-red-700 border-red-200" };
      case "approved_pending":
        return { label: `${outcome.action} →`, style: "bg-amber-50 text-amber-700 border-amber-200" };
      case "in_review":
        return { label: `${outcome.action} ⋯`, style: "bg-slate-50 text-slate-600 border-slate-200" };
    }
  })();

  return (
    <span
      className={cn(
        "inline-block w-16 text-center text-[10px] font-mono font-bold uppercase tracking-wider px-1.5 py-0.5 rounded border",
        config.style,
      )}
    >
      {config.label}
    </span>
  );
}

function PipelineTrace({ signal, outcome }: { signal: Signal; outcome: Outcome }) {
  // Affiche succinctement la chaîne de décision (Trader → Reviewer)
  if (outcome.kind === "hold") {
    return <div className="text-xs text-slate-400 w-32 text-right">trader: HOLD</div>;
  }

  if (outcome.kind === "blocked") {
    return (
      <div className="text-xs w-32 text-right">
        <span className="text-slate-400">trader: {signal.action}</span>
        <span className="mx-1 text-slate-300">→</span>
        <span className="text-red-700 font-medium">{outcome.by === "reviewer" ? "REJECT" : "code REJECT"}</span>
      </div>
    );
  }

  if (outcome.kind === "executed") {
    return <div className="text-xs text-emerald-700 font-medium w-32 text-right">EXECUTED ✓</div>;
  }

  if (outcome.kind === "approved_pending") {
    return <div className="text-xs text-amber-700 w-32 text-right">approved · waiting exec</div>;
  }

  return <div className="text-xs text-slate-400 w-32 text-right">in review</div>;
}

function ConvictionBar({ value }: { value: number }) {
  const pct = Math.min(100, Math.max(0, value));
  return (
    <div className="w-16 h-1.5 bg-slate-100 rounded-full overflow-hidden">
      <div
        className="h-full bg-brand-gradient"
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

function ClusterChip({ short, score }: { short: string; score: number | null }) {
  return (
    <div className="flex items-center gap-0.5 text-[10px]">
      <span className="text-slate-400 font-mono">{short}</span>
      <span className={cn("font-semibold tabular w-3 text-center", scoreColor(score))}>
        {score ?? "—"}
      </span>
    </div>
  );
}

function scoreColor(s: number | null): string {
  if (s === null) return "text-slate-400";
  if (s >= 7) return "text-emerald-700";
  if (s >= 5) return "text-slate-700";
  if (s >= 3) return "text-amber-700";
  return "text-red-700";
}
