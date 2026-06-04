import { cn, formatCurrency, formatPct, relativeTime } from "@/lib/utils";

export interface ClosedPosition {
  id: string;
  ticker: string;
  entry_price: number | null;
  exit_price: number | null;
  quantity: number | null;
  pnl_usd: number | null;
  pnl_pct: number | null;
  exit_reason: string | null;
  hold_days: number | null;
  opened_at: string | null;
  closed_at: string | null;
}

const REASON_LABEL: Record<string, { label: string; cls: string }> = {
  take_profit: { label: "Take-profit", cls: "bg-emerald-50 text-emerald-700 border-emerald-200" },
  stop_loss_hit: { label: "Stop-loss", cls: "bg-red-50 text-red-700 border-red-200" },
  gap_overnight: { label: "Gap overnight", cls: "bg-red-50 text-red-700 border-red-200" },
  earnings_profit_lock: { label: "Lock earnings", cls: "bg-blue-50 text-blue-700 border-blue-200" },
  timeout_21d: { label: "Timeout 21j", cls: "bg-slate-50 text-slate-600 border-slate-200" },
};

function ReasonBadge({ reason }: { reason: string | null }) {
  if (!reason) return <span className="text-slate-400">—</span>;
  const m = REASON_LABEL[reason] ?? { label: reason, cls: "bg-slate-50 text-slate-600 border-slate-200" };
  return <span className={cn("inline-block px-1.5 py-0.5 rounded border text-[10px] font-medium", m.cls)}>{m.label}</span>;
}

export function ClosedPositionsSection({ positions }: { positions: ClosedPosition[] }) {
  const total = positions.reduce((s, p) => s + Number(p.pnl_usd ?? 0), 0);
  const wins = positions.filter(p => Number(p.pnl_usd ?? 0) > 0).length;

  return (
    <section>
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-500">Historique des positions</h2>
        {positions.length > 0 && (
          <span className="text-xs text-slate-400">
            {positions.length} clôturées · {wins}W/{positions.length - wins}L ·{" "}
            <span className={total >= 0 ? "text-emerald-600" : "text-red-600"}>
              {total >= 0 ? "+" : ""}{formatCurrency(total)}
            </span>
          </span>
        )}
      </div>
      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        {positions.length === 0 ? (
          <div className="px-6 py-12 text-center text-sm text-slate-400">
            Aucune vente encore.
            <br />
            <span className="text-xs">L&apos;historique se remplit à la première clôture (stop, target, ou sortie temporelle).</span>
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-[10px] text-slate-500 uppercase tracking-wider">
              <tr>
                <th className="px-4 py-2 text-left">Ticker</th>
                <th className="px-4 py-2 text-right">Entrée</th>
                <th className="px-4 py-2 text-right">Sortie</th>
                <th className="px-4 py-2 text-right">P&L $</th>
                <th className="px-4 py-2 text-right">P&L %</th>
                <th className="px-4 py-2 text-center">Motif</th>
                <th className="px-4 py-2 text-right">Durée</th>
                <th className="px-4 py-2 text-right">Clôturé</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {positions.map((p) => {
                const up = Number(p.pnl_usd ?? 0) >= 0;
                return (
                  <tr key={p.id} className="hover:bg-slate-50">
                    <td className="px-4 py-2.5 ticker font-medium">{p.ticker}</td>
                    <td className="px-4 py-2.5 text-right tabular">{formatCurrency(Number(p.entry_price))}</td>
                    <td className="px-4 py-2.5 text-right tabular">{formatCurrency(Number(p.exit_price))}</td>
                    <td className={cn("px-4 py-2.5 text-right tabular font-semibold", up ? "text-emerald-700" : "text-red-700")}>
                      {up ? "+" : ""}{formatCurrency(Number(p.pnl_usd))}
                    </td>
                    <td className={cn("px-4 py-2.5 text-right tabular", up ? "text-emerald-700" : "text-red-700")}>
                      {formatPct(Number(p.pnl_pct), { signed: true })}
                    </td>
                    <td className="px-4 py-2.5 text-center"><ReasonBadge reason={p.exit_reason} /></td>
                    <td className="px-4 py-2.5 text-right tabular text-xs text-slate-500">{p.hold_days != null ? `${p.hold_days}j` : "—"}</td>
                    <td className="px-4 py-2.5 text-right text-[10px] text-slate-400">{relativeTime(p.closed_at)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}
