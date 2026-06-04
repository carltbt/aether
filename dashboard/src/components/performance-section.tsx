import { cn, formatCurrency, formatPct } from "@/lib/utils";
import { EquityCurve } from "@/components/equity-curve";

export interface Snapshot {
  ok: boolean;
  account: {
    alpaca_ok: boolean;
    equity: number | null;
    cash: number | null;
    buying_power: number | null;
    baseline: number;
    total_pnl_usd: number | null;
    total_pnl_pct: number | null;
    today_pnl_usd: number | null;
    today_pnl_pct: number | null;
  };
  open_positions: Array<{
    ticker: string;
    qty: number;
    avg_entry: number;
    current_price: number;
    market_value: number;
    unrealized_pl: number;
    unrealized_plpc: number;
  }>;
  open_count: number;
  equity_curve: Array<{ date: string; equity: number; pnl: number }>;
  realized: {
    closed_count: number;
    realized_pnl_usd: number;
    wins: number;
    losses: number;
    win_rate: number | null;
    avg_win: number | null;
    avg_loss: number | null;
    profit_factor: number | null;
  };
  reviewer_value: {
    approved_closed_count: number;
    approved_closed_pnl: number;
    rejected_closed_count: number;
    rejected_closed_pnl: number;
    pending_orphan_count: number;
    pending_orphan_pnl: number;
  };
}

function Kpi({ label, value, sub, accent = "default", big = false }: {
  label: string; value: string; sub?: string; accent?: "default" | "up" | "down" | "muted"; big?: boolean;
}) {
  const color = {
    default: "text-slate-900",
    up: "text-emerald-700",
    down: "text-red-700",
    muted: "text-slate-400",
  }[accent];
  return (
    <div className="bg-white border border-slate-200 rounded-xl px-5 py-4">
      <div className="text-[11px] font-medium uppercase tracking-wider text-slate-500">{label}</div>
      <div className={cn("font-semibold tabular mt-1", big ? "text-3xl" : "text-2xl", color)}>{value}</div>
      {sub && <div className="text-xs text-slate-400 mt-0.5 tabular">{sub}</div>}
    </div>
  );
}

export function PerformanceSection({ snapshot }: { snapshot: Snapshot | null }) {
  if (!snapshot || !snapshot.ok || !snapshot.account.alpaca_ok) {
    return (
      <section>
        <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-500 mb-3">Performance</h2>
        <div className="bg-white border border-slate-200 rounded-xl px-6 py-10 text-center text-sm text-slate-400">
          Snapshot Alpaca indisponible. Réessaie dans un instant.
        </div>
      </section>
    );
  }

  const a = snapshot.account;
  const rv = snapshot.reviewer_value;
  const r = snapshot.realized;
  const totalUp = (a.total_pnl_usd ?? 0) >= 0;
  const todayUp = (a.today_pnl_usd ?? 0) >= 0;
  const unrealized = snapshot.open_positions.reduce((s, p) => s + p.unrealized_pl, 0);

  return (
    <section>
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-500">Performance — Alpaca Paper</h2>
        <span className="text-[11px] text-slate-400">baseline {formatCurrency(a.baseline)}</span>
      </div>

      {/* KPI grid */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4">
        <Kpi
          label="Équité totale"
          value={formatCurrency(a.equity)}
          sub={`cash ${formatCurrency(a.cash, { compact: true })}`}
          big
        />
        <Kpi
          label="P&L total"
          value={`${totalUp ? "+" : ""}${formatCurrency(a.total_pnl_usd)}`}
          sub={formatPct(a.total_pnl_pct, { signed: true })}
          accent={totalUp ? "up" : "down"}
        />
        <Kpi
          label="P&L du jour"
          value={`${todayUp ? "+" : ""}${formatCurrency(a.today_pnl_usd)}`}
          sub={formatPct(a.today_pnl_pct, { signed: true })}
          accent={todayUp ? "up" : "down"}
        />
        <Kpi
          label="Positions ouvertes"
          value={String(snapshot.open_count)}
          sub={`${unrealized >= 0 ? "+" : ""}${formatCurrency(unrealized)} latent`}
          accent={unrealized >= 0 ? "up" : "down"}
        />
      </div>

      {/* Second row : realized + reviewer edge */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4">
        <Kpi
          label="Trades clôturés"
          value={String(r.closed_count)}
          sub={r.closed_count ? `${r.wins}W · ${r.losses}L` : "aucun encore"}
          accent={r.closed_count ? "default" : "muted"}
        />
        <Kpi
          label="Win rate"
          value={r.win_rate !== null ? formatPct(r.win_rate) : "—"}
          sub={r.profit_factor !== null ? `PF ${r.profit_factor.toFixed(2)}` : "PF —"}
          accent={r.win_rate !== null ? (r.win_rate >= 50 ? "up" : "down") : "muted"}
        />
        <Kpi
          label="P&L réalisé"
          value={r.closed_count ? `${r.realized_pnl_usd >= 0 ? "+" : ""}${formatCurrency(r.realized_pnl_usd)}` : "—"}
          sub={r.avg_win !== null ? `moy gain ${formatCurrency(r.avg_win, { compact: true })}` : "—"}
          accent={r.closed_count ? (r.realized_pnl_usd >= 0 ? "up" : "down") : "muted"}
        />
        <Kpi
          label="Edge Reviewer"
          value={rv.rejected_closed_count ? `${rv.rejected_closed_pnl <= 0 ? "" : "+"}${formatCurrency(rv.rejected_closed_pnl)}` : "—"}
          sub={rv.rejected_closed_count ? `${rv.rejected_closed_count} rejets ${rv.rejected_closed_pnl <= 0 ? "évités ✓" : "manqués"}` : "pas de rejet clôturé"}
          accent={rv.rejected_closed_count ? (rv.rejected_closed_pnl <= 0 ? "up" : "down") : "muted"}
        />
      </div>

      {/* Equity curve */}
      <div className="mb-4">
        <EquityCurve data={snapshot.equity_curve} />
      </div>

      {/* Live open positions */}
      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="px-4 py-2.5 border-b border-slate-100 text-[11px] font-medium uppercase tracking-wider text-slate-500">
          Positions ouvertes — unrealized live
        </div>
        {snapshot.open_positions.length === 0 ? (
          <div className="px-6 py-10 text-center text-sm text-slate-400">Aucune position ouverte.</div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-[10px] text-slate-500 uppercase tracking-wider">
              <tr>
                <th className="px-4 py-2 text-left">Ticker</th>
                <th className="px-4 py-2 text-right">Qty</th>
                <th className="px-4 py-2 text-right">Entrée moy.</th>
                <th className="px-4 py-2 text-right">Prix actuel</th>
                <th className="px-4 py-2 text-right">Valeur</th>
                <th className="px-4 py-2 text-right">P&L latent</th>
                <th className="px-4 py-2 text-right">%</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {snapshot.open_positions.map((p) => {
                const up = p.unrealized_pl >= 0;
                return (
                  <tr key={p.ticker} className="hover:bg-slate-50">
                    <td className="px-4 py-2.5 ticker font-medium">{p.ticker}</td>
                    <td className="px-4 py-2.5 text-right tabular">{p.qty}</td>
                    <td className="px-4 py-2.5 text-right tabular">{formatCurrency(p.avg_entry)}</td>
                    <td className="px-4 py-2.5 text-right tabular">{formatCurrency(p.current_price)}</td>
                    <td className="px-4 py-2.5 text-right tabular">{formatCurrency(p.market_value, { compact: true })}</td>
                    <td className={cn("px-4 py-2.5 text-right tabular font-semibold", up ? "text-emerald-700" : "text-red-700")}>
                      {up ? "+" : ""}{formatCurrency(p.unrealized_pl)}
                    </td>
                    <td className={cn("px-4 py-2.5 text-right tabular", up ? "text-emerald-700" : "text-red-700")}>
                      {formatPct(p.unrealized_plpc, { signed: true })}
                    </td>
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
