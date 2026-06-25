import Link from "next/link";
import { createAdminClient } from "@/lib/supabase-admin";
import { formatCurrency, formatNumber, relativeTime, cn } from "@/lib/utils";
import { LogoutButton } from "@/components/logout-button";
import { SignalRow } from "@/components/signal-row";
import { CostTrend } from "@/components/cost-trend";
import { ShadowSection } from "@/components/shadow-section";
import { PerfChart } from "@/components/perf-chart";
import { PerformanceSection, type Snapshot } from "@/components/performance-section";
import { ClosedPositionsSection, type ClosedPosition } from "@/components/closed-positions-section";
import { Logo } from "@/components/logo";

export const dynamic = "force-dynamic";

async function getSnapshot(): Promise<Snapshot | null> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!url) return null;
  try {
    const r = await fetch(`${url}/functions/v1/portfolio-snapshot`, { method: "POST", cache: "no-store" });
    if (!r.ok) return null;
    return (await r.json()) as Snapshot;
  } catch {
    return null;
  }
}

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
  const [signalsRes, dailyCtxRes, heartbeatRes, costRes, watchlistCountRes, snapshot] = await Promise.all([
    supabase.from("signals").select("*").order("created_at", { ascending: false }).limit(500),
    supabase.from("daily_context").select("*").order("context_date", { ascending: false }).limit(1).maybeSingle(),
    supabase.from("system_heartbeats").select("*").order("recorded_at", { ascending: false }).limit(1).maybeSingle(),
    supabase.from("agent_logs").select("cost_usd").gte("created_at", new Date(Date.now() - 24 * 3600 * 1000).toISOString()),
    supabase.from("watchlist").select("symbol", { count: "exact", head: true }).eq("is_active", true),
    getSnapshot(),
  ]);

  // β — additional v2 queries
  const [shadowRes, cost7dRes, closedPosRes] = await Promise.all([
    supabase.from("shadow_positions").select("*").order("opened_at", { ascending: false }).limit(30),
    supabase.from("agent_logs").select("created_at, cost_usd").gte("created_at", new Date(Date.now() - 7 * 86400 * 1000).toISOString()),
    supabase.from("positions").select("id, ticker, entry_price, exit_price, quantity, pnl_usd, pnl_pct, exit_reason, hold_days, opened_at, closed_at").eq("status", "CLOSED").order("closed_at", { ascending: false }),
  ]);

  const signals = (signalsRes.data ?? []) as Signal[];
  const closedPositions = (closedPosRes.data ?? []) as ClosedPosition[];
  const dailyCtx = dailyCtxRes.data as DailyCtx | null;
  const heartbeat = heartbeatRes.data as Heartbeat | null;
  const cost24h = (costRes.data ?? []).reduce((sum, l) => sum + Number(l.cost_usd ?? 0), 0);
  const watchlistCount = watchlistCountRes.count ?? 0;
  const shadowPositions = shadowRes.data ?? [];

  // β — cost trend 7 days, grouped by date
  const costByDay = new Map<string, number>();
  for (let i = 6; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400 * 1000).toISOString().slice(0, 10);
    costByDay.set(d, 0);
  }
  for (const log of cost7dRes.data ?? []) {
    const dayKey = (log.created_at as string).slice(0, 10);
    if (costByDay.has(dayKey)) costByDay.set(dayKey, (costByDay.get(dayKey) ?? 0) + Number(log.cost_usd ?? 0));
  }
  const costTrend = Array.from(costByDay.entries()).map(([date, cost_usd]) => ({ date, cost_usd }));

  // β — shadow P&L cumul timeline
  const shadowSorted = [...shadowPositions].sort((a, b) =>
    Date.parse(a.opened_at) - Date.parse(b.opened_at)
  );
  let cumShadow = 0;
  let cumApproved = 0;
  const perfData = shadowSorted.map(p => {
    const pnl = Number(p.pnl_pct ?? 0);
    cumShadow += pnl;
    if (p.was_reviewer_approved) cumApproved += pnl;
    return {
      date: (p.opened_at as string).slice(0, 10),
      shadow_pnl_pct: cumShadow,
      reviewer_approved_pnl_pct: cumApproved,
    };
  });

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
          <div className="flex items-center gap-2.5">
            <Logo size={26} />
            <span className="font-mono font-bold text-sm tracking-tight text-slate-900">AETHER</span>
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
            <Link href="/desk" className="text-xs text-slate-500 hover:text-slate-900 transition-colors">Trading Floor 3D →</Link>
            <Link href="/pipeline" className="text-xs text-slate-500 hover:text-slate-900 transition-colors">Pipeline LLM →</Link>
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

        {/* Performance — live Alpaca paper (équité, P&L, courbe, positions) */}
        <PerformanceSection snapshot={snapshot} />

        {/* Historique des positions clôturées (ventes) */}
        <ClosedPositionsSection positions={closedPositions} />

        {/* β — Performance + cost charts side by side */}
        <section className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <PerfChart data={perfData} />
          <CostTrend data={costTrend} />
        </section>

        {/* β — Shadow portfolio (empirical Reviewer validation) */}
        <ShadowSection positions={shadowPositions} />

        {/* Toutes les analyses (scrollable, pas seulement les dernières) */}
        <section>
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-500">Toutes les analyses</h2>
            <span className="text-xs text-slate-400">{formatNumber(signals.length)} signaux</span>
          </div>
          <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
            {signals.length === 0 ? (
              <div className="px-6 py-12 text-center text-sm text-slate-400">No signals yet.</div>
            ) : (
              <div className="divide-y divide-slate-100 max-h-[640px] overflow-y-auto">
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
