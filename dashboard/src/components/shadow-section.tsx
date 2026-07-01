"use client";

import { cn, formatCurrency, formatPct, relativeTime } from "@/lib/utils";

interface ShadowPosition {
  id: string;
  ticker: string;
  status: string;
  opened_at: string;
  closed_at: string | null;
  entry_price: number;
  exit_price: number | null;
  quantity: number;
  position_size_usd: number | null;
  pnl_usd: number | null;
  pnl_pct: number | null;
  exit_reason: string | null;
  was_reviewer_approved: boolean;
  trader_conviction: number | null;
  reviewer_verdict: string | null;
}

export function ShadowSection({ positions }: { positions: ShadowPosition[] }) {
  if (!positions || positions.length === 0) {
    return (
      <section>
        <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-500 mb-3">Shadow Portfolio (what would have happened)</h2>
        <div className="bg-white border border-slate-200 rounded-xl px-6 py-12 text-center text-sm text-slate-400">
          Shadow tracking starts on the next BUY proposed by Trader.
        </div>
      </section>
    );
  }

  const open = positions.filter(p => p.status === "OPEN");
  const closed = positions.filter(p => p.status === "CLOSED");
  const approved = positions.filter(p => p.was_reviewer_approved);
  const rejected = positions.filter(p => !p.was_reviewer_approved);

  const sumPnl = (arr: ShadowPosition[]) => arr.reduce((s, p) => s + Number(p.pnl_usd ?? 0), 0);
  const approvedPnl = sumPnl(approved);
  const rejectedPnl = sumPnl(rejected);

  return (
    <section>
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-500">Shadow Portfolio</h2>
        <span className="text-xs text-slate-400">{open.length} open · {closed.length} closed</span>
      </div>

      {/* Verdict empirique : Reviewer trop strict ou correct ? */}
      <div className="grid grid-cols-2 gap-3 mb-3">
        <div className="bg-emerald-50 border border-emerald-200 rounded-lg px-4 py-3">
          <div className="text-[10px] uppercase tracking-wider text-emerald-700">Reviewer-approved (real)</div>
          <div className="text-lg font-semibold tabular text-emerald-900 mt-0.5">{formatCurrency(approvedPnl)}</div>
          <div className="text-[10px] text-emerald-600 mt-0.5">{approved.length} positions</div>
        </div>
        <div className="bg-slate-50 border border-slate-200 rounded-lg px-4 py-3">
          <div className="text-[10px] uppercase tracking-wider text-slate-600">Reviewer-rejected (shadow)</div>
          <div className={cn("text-lg font-semibold tabular mt-0.5", rejectedPnl >= 0 ? "text-slate-900" : "text-red-700")}>{formatCurrency(rejectedPnl)}</div>
          <div className="text-[10px] text-slate-500 mt-0.5">{rejected.length} positions</div>
        </div>
      </div>
      {rejected.length >= 3 && (
        <div className="text-[10px] text-slate-500 italic mb-3">
          {rejectedPnl < 0
            ? "✓ Reviewer was right — these would have lost money"
            : rejectedPnl > approvedPnl
              ? "Reviewer may be too strict — rejected ones outperforming"
              : "Neutral — not enough signal to conclude yet"}
        </div>
      )}

      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
        <table className="w-full text-sm min-w-[760px]">
          <thead className="bg-slate-50 text-[10px] text-slate-500 uppercase tracking-wider">
            <tr>
              <th className="px-3 py-2 text-left">Ticker</th>
              <th className="px-3 py-2 text-center">Reviewer</th>
              <th className="px-3 py-2 text-right">Conv</th>
              <th className="px-3 py-2 text-right">Entry</th>
              <th className="px-3 py-2 text-right">Exit/Curr</th>
              <th className="px-3 py-2 text-right">P&L %</th>
              <th className="px-3 py-2 text-right">P&L $</th>
              <th className="px-3 py-2 text-center">Status</th>
              <th className="px-3 py-2 text-right">Opened</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {positions.map(p => {
              const pnlClass = (Number(p.pnl_pct ?? 0)) >= 0 ? "text-emerald-700" : "text-red-700";
              return (
                <tr key={p.id} className={cn("hover:bg-slate-50", p.status === "CLOSED" && "opacity-70")}>
                  <td className="px-3 py-2 ticker">{p.ticker}</td>
                  <td className="px-3 py-2 text-center text-[10px]">
                    <span className={cn(
                      "inline-block px-1.5 py-0.5 rounded border font-mono font-bold uppercase",
                      p.was_reviewer_approved
                        ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                        : "bg-slate-50 text-slate-500 border-slate-200",
                    )}>
                      {p.was_reviewer_approved ? "APPR" : p.reviewer_verdict === "REJECT" ? "REJ" : "PEND"}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-right tabular text-xs">{p.trader_conviction ?? "—"}</td>
                  <td className="px-3 py-2 text-right tabular text-xs">{formatCurrency(Number(p.entry_price))}</td>
                  <td className="px-3 py-2 text-right tabular text-xs">{p.exit_price !== null ? formatCurrency(Number(p.exit_price)) : "—"}</td>
                  <td className={cn("px-3 py-2 text-right tabular text-xs font-semibold", pnlClass)}>
                    {p.pnl_pct !== null ? formatPct(Number(p.pnl_pct), { signed: true }) : "—"}
                  </td>
                  <td className={cn("px-3 py-2 text-right tabular text-xs", pnlClass)}>
                    {p.pnl_usd !== null ? formatCurrency(Number(p.pnl_usd)) : "—"}
                  </td>
                  <td className="px-3 py-2 text-center text-[10px] text-slate-500">{p.status}</td>
                  <td className="px-3 py-2 text-right text-[10px] text-slate-400">{relativeTime(p.opened_at)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        </div>
      </div>
    </section>
  );
}
