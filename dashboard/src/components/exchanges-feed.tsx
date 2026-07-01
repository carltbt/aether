"use client";

import { useMemo, useState } from "react";
import { cn, formatCurrency, formatNumber, relativeTime } from "@/lib/utils";
import { AgentIcon } from "./agent-icon";

export interface ExchangeLog {
  id: string;
  log_type: string;
  ticker: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  latency_ms: number | null;
  cost_usd: number | null;
  raw_output: Record<string, unknown> | null;
  error: string | null;
  created_at: string;
}

const META: Record<string, { label: string; model: "Haiku" | "Sonnet"; cls: string; group: string }> = {
  analysis_pass1: { label: "Analyste · Technique", model: "Haiku", cls: "bg-violet-50 text-violet-700 border-violet-200", group: "analyst" },
  analysis_pass2: { label: "Analyste · Sentiment", model: "Haiku", cls: "bg-violet-50 text-violet-700 border-violet-200", group: "analyst" },
  analysis_pass3: { label: "Analyste · Fondamentaux", model: "Sonnet", cls: "bg-blue-50 text-blue-700 border-blue-200", group: "analyst" },
  researcher_bull: { label: "Researcher · Bull", model: "Sonnet", cls: "bg-emerald-50 text-emerald-700 border-emerald-200", group: "researcher" },
  researcher_bear: { label: "Researcher · Bear", model: "Sonnet", cls: "bg-red-50 text-red-700 border-red-200", group: "researcher" },
  decision: { label: "Trader", model: "Sonnet", cls: "bg-slate-900 text-white border-slate-900", group: "trader" },
  reviewer: { label: "Reviewer", model: "Sonnet", cls: "bg-amber-50 text-amber-700 border-amber-200", group: "reviewer" },
};

const FILTERS: Array<{ key: string; label: string; groups: string[] }> = [
  { key: "all", label: "Tous", groups: [] },
  { key: "analyst", label: "Analystes", groups: ["analyst"] },
  { key: "researcher", label: "Researchers", groups: ["researcher"] },
  { key: "trader", label: "Trader", groups: ["trader"] },
  { key: "reviewer", label: "Reviewer", groups: ["reviewer"] },
];

function headline(raw: Record<string, unknown> | null): string {
  if (!raw) return "";
  const keys = ["rationale", "bull_report", "bear_report", "synthesis", "report", "thesis", "summary", "raw_text"];
  for (const k of keys) {
    const v = raw[k];
    if (typeof v === "string" && v.trim()) return v;
  }
  return "";
}

function chip(raw: Record<string, unknown> | null): string | null {
  if (!raw) return null;
  for (const k of ["action", "verdict", "setup_detected", "recommendation", "stance"]) {
    const v = raw[k];
    if (typeof v === "string" && v.trim() && v.toLowerCase() !== "none") return v;
  }
  return null;
}

export function ExchangesFeed({ logs }: { logs: ExchangeLog[] }) {
  const [filter, setFilter] = useState("all");
  const [expanded, setExpanded] = useState<string | null>(null);

  const filtered = useMemo(() => {
    if (filter === "all") return logs;
    const groups = FILTERS.find(f => f.key === filter)?.groups ?? [];
    return logs.filter(l => groups.includes(META[l.log_type]?.group ?? ""));
  }, [logs, filter]);

  return (
    <section>
      <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-500">Tous les échanges LLM</h2>
        <div className="flex items-center gap-1.5">
          {FILTERS.map(f => (
            <button
              key={f.key}
              onClick={() => setFilter(f.key)}
              className={cn(
                "text-[11px] px-2.5 py-1 rounded-full border transition-colors",
                filter === f.key ? "bg-slate-900 text-white border-slate-900" : "bg-white text-slate-500 border-slate-200 hover:border-slate-300",
              )}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      <div className="space-y-2">
        {filtered.length === 0 ? (
          <div className="bg-white border border-slate-200 rounded-xl px-6 py-10 text-center text-sm text-slate-400">Aucun échange.</div>
        ) : filtered.map(l => {
          const m = META[l.log_type] ?? { label: l.log_type, model: "Sonnet" as const, cls: "bg-slate-100 text-slate-600 border-slate-200", group: "" };
          const isOpen = expanded === l.id;
          const hl = headline(l.raw_output);
          const c = chip(l.raw_output);
          return (
            <div key={l.id} className="bg-white border border-slate-200 rounded-xl overflow-hidden">
              <button
                onClick={() => setExpanded(isOpen ? null : l.id)}
                className="w-full text-left px-4 py-3 hover:bg-slate-50 transition-colors"
              >
                <div className="flex items-center gap-2 flex-wrap">
                  <span className={cn("text-[10px] font-medium uppercase tracking-wide px-2 py-0.5 rounded border", m.cls)}>{m.label}</span>
                  {l.ticker && <span className="ticker text-sm font-semibold text-slate-900">{l.ticker}</span>}
                  {c && <span className="text-[10px] font-mono font-bold uppercase px-1.5 py-0.5 rounded bg-slate-100 text-slate-600 border border-slate-200">{c}</span>}
                  <span className="ml-auto flex items-center gap-2 sm:gap-3 text-[11px] text-slate-400 tabular">
                    <span className="hidden sm:inline">{formatNumber(l.input_tokens)}→{formatNumber(l.output_tokens)} tok</span>
                    <span>{formatCurrency(l.cost_usd)}</span>
                    <span>{l.latency_ms != null ? `${(l.latency_ms / 1000).toFixed(1)}s` : "—"}</span>
                    <span>{relativeTime(l.created_at)}</span>
                    <span className="text-slate-300">{isOpen ? "▲" : "▼"}</span>
                  </span>
                </div>
                {hl && !isOpen && (
                  <p className="text-xs text-slate-500 mt-1.5 line-clamp-2">{hl}</p>
                )}
              </button>
              {isOpen && (
                <div className="px-4 pb-4 border-t border-slate-100 pt-3">
                  {l.error && <div className="text-xs text-red-600 mb-2 flex items-center gap-1.5"><AgentIcon name="warn" size={13} className="shrink-0" />{l.error}</div>}
                  <pre className="text-[11px] leading-relaxed text-slate-700 bg-slate-50 border border-slate-100 rounded-lg p-3 overflow-x-auto whitespace-pre-wrap break-words">
                    {l.raw_output ? JSON.stringify(l.raw_output, null, 2) : "(pas de sortie structurée)"}
                  </pre>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
