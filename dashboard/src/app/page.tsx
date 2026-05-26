import { createAdminClient } from "@/lib/supabase-admin";
import { formatCurrency, formatNumber, relativeTime, cn } from "@/lib/utils";
import { LogoutButton } from "@/components/logout-button";
import { SignalRow } from "@/components/signal-row";

export const dynamic = "force-dynamic";

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

interface DailyCtx {
  market_regime: string;
  vix: number | null;
  spy_vs_sma50: string | null;
  treasury_10y: number | null;
  context_date: string;
}

interface Heartbeat {
  recorded_at: string;
  status: string;
  cycles_completed: number;
  trades_executed: number;
  stocks_analyzed: number;
  notes: string | null;
}

export default async function DashboardPage() {
  const supabase = createAdminClient();

  // Auth is gated by middleware (proxy) — if we're here, user is authenticated via access code
  const [signalsRes, dailyCtxRes, heartbeatRes, openPosRes, costRes, watchlistCountRes] = await Promise.all([
    supabase.from("signals").select("*").order("created_at", { ascending: false }).limit(20),
    supabase.from("daily_context").select("*").order("context_date", { ascending: false }).limit(1).maybeSingle(),
    supabase.from("system_heartbeats").select("*").order("recorded_at", { ascending: false }).limit(1).maybeSingle(),
    supabase.from("positions").select("id, ticker, entry_price, quantity, position_size_usd, stop_loss_price, take_profit_price, status, opened_at").eq("status", "OPEN"),
    supabase.from("agent_logs").select("cost_usd").gte("created_at", new Date(Date.now() - 24 * 3600 * 1000).toISOString()),
    supabase.from("watchlist").select("symbol", { count: "exact", head: true }).eq("is_active", true),
  ]);

  const signals = (signalsRes.data ?? []) as Signal[];
  const dailyCtx = dailyCtxRes.data as DailyCtx | null;
  const heartbeat = heartbeatRes.data as Heartbeat | null;
  const openPositions = openPosRes.data ?? [];
  const cost24h = (costRes.data ?? []).reduce((sum, l) => sum + Number(l.cost_usd ?? 0), 0);
  const watchlistCount = watchlistCountRes.count ?? 0;

  const signalsToday = signals.filter(s => {
    const sigDate = new Date(s.created_at);
    return Date.now() - sigDate.getTime() < 24 * 3600 * 1000;
  });
  const buysToday = signalsToday.filter(s => s.action === "BUY").length;

  return (
    <main className="min-h-screen">
      {/* Header */}
      <header className="border-b border-slate-200">
        <div className="max-w-7xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="bg-brand-gradient text-white font-mono font-bold text-sm px-2.5 py-1 rounded">
              AETHER
            </div>
            <span className="text-xs text-slate-400">|</span>
            <span className="text-xs text-slate-500">admin dashboard</span>
          </div>
          <div className="flex items-center gap-4">
            {heartbeat && (
              <span className="flex items-center gap-1.5 text-xs text-slate-500">
                <span
                  className={cn(
                    "w-1.5 h-1.5 rounded-full",
                    heartbeat.status === "ok" ? "bg-emerald-500" : "bg-amber-500",
                  )}
                />
                last beat {relativeTime(heartbeat.recorded_at)}
              </span>
            )}
            <LogoutButton />
          </div>
        </div>
      </header>

      <div className="max-w-7xl mx-auto px-6 py-8 space-y-8">
        {/* Hero — regime + counts */}
        <section className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <StatCard
            label="Regime"
            value={dailyCtx?.market_regime ?? "—"}
            sub={dailyCtx ? `VIX ${dailyCtx.vix?.toFixed(2)} · SPY ${dailyCtx.spy_vs_sma50}` : "no context yet"}
            accent={dailyCtx?.market_regime === "FREE" ? "success" : dailyCtx?.market_regime === "STRICT" ? "warning" : dailyCtx?.market_regime === "PAUSE" ? "danger" : "default"}
          />
          <StatCard label="Watchlist" value={formatNumber(watchlistCount)} sub="active mid-caps" />
          <StatCard
            label="Signals 24h"
            value={formatNumber(signalsToday.length)}
            sub={`${buysToday} BUY · ${signalsToday.length - buysToday} HOLD`}
            accent={buysToday > 0 ? "success" : "default"}
          />
          <StatCard
            label="Cost 24h"
            value={formatCurrency(cost24h)}
            sub="Anthropic spend"
            accent={cost24h > 5 ? "warning" : "default"}
          />
        </section>

        {/* Open positions */}
        <section>
          <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-500 mb-3">Open Positions</h2>
          <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
            {openPositions.length === 0 ? (
              <div className="px-6 py-12 text-center text-sm text-slate-400">
                No open positions yet.
                <br />
                <span className="text-xs">Système en DRY_RUN — aucun ordre Alpaca exécuté pour l&apos;instant.</span>
              </div>
            ) : (
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-xs text-slate-500 uppercase tracking-wider">
                  <tr>
                    <th className="px-4 py-3 text-left">Ticker</th>
                    <th className="px-4 py-3 text-right">Entry</th>
                    <th className="px-4 py-3 text-right">Size</th>
                    <th className="px-4 py-3 text-right">Stop</th>
                    <th className="px-4 py-3 text-right">Target</th>
                    <th className="px-4 py-3 text-right">Opened</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {openPositions.map((p) => (
                    <tr key={p.id} className="hover:bg-slate-50">
                      <td className="px-4 py-3 ticker">{p.ticker}</td>
                      <td className="px-4 py-3 text-right tabular">{formatCurrency(Number(p.entry_price))}</td>
                      <td className="px-4 py-3 text-right tabular">{formatCurrency(Number(p.position_size_usd), { compact: true })}</td>
                      <td className="px-4 py-3 text-right tabular text-red-600">{formatCurrency(Number(p.stop_loss_price))}</td>
                      <td className="px-4 py-3 text-right tabular text-emerald-600">{formatCurrency(Number(p.take_profit_price))}</td>
                      <td className="px-4 py-3 text-right text-xs text-slate-500">{relativeTime(p.opened_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </section>

        {/* Recent signals */}
        <section>
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-500">Recent Signals</h2>
            <span className="text-xs text-slate-400">last 20</span>
          </div>
          <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
            {signals.length === 0 ? (
              <div className="px-6 py-12 text-center text-sm text-slate-400">No signals yet.</div>
            ) : (
              <div className="divide-y divide-slate-100">
                {signals.map((s) => (
                  <SignalRow key={s.id} signal={s} />
                ))}
              </div>
            )}
          </div>
        </section>

        {/* Footer */}
        <footer className="text-center text-xs text-slate-400 py-6 border-t border-slate-100">
          {heartbeat && (
            <span>
              Last heartbeat · {heartbeat.status} · {heartbeat.stocks_analyzed} stocks · {heartbeat.trades_executed} trades · {relativeTime(heartbeat.recorded_at)}
            </span>
          )}
        </footer>
      </div>
    </main>
  );
}

function StatCard({ label, value, sub, accent = "default" }: { label: string; value: string; sub?: string; accent?: "default" | "success" | "warning" | "danger" }) {
  const accentMap = {
    default: "text-slate-900",
    success: "text-emerald-700",
    warning: "text-amber-700",
    danger: "text-red-700",
  };
  return (
    <div className="bg-white border border-slate-200 rounded-xl px-5 py-4">
      <div className="text-xs font-medium uppercase tracking-wider text-slate-500">{label}</div>
      <div className={cn("text-2xl font-semibold mt-1 tabular", accentMap[accent])}>{value}</div>
      {sub && <div className="text-xs text-slate-400 mt-0.5 tabular">{sub}</div>}
    </div>
  );
}
