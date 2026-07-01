import { createAdminClient } from "@/lib/supabase-admin";
import { SiteHeader } from "@/components/site-header";
import { TradingDeskScene, type DeskStats } from "@/components/trading-desk-scene";

export const dynamic = "force-dynamic";

export default async function DeskPage() {
  const supabase = createAdminClient();
  const { data } = await supabase.from("agent_logs").select("log_type, cost_usd, latency_ms").limit(5000);

  const acc: Record<string, { count: number; cost: number; lat: number }> = {};
  for (const r of data ?? []) {
    const k = r.log_type as string;
    if (!acc[k]) acc[k] = { count: 0, cost: 0, lat: 0 };
    acc[k].count += 1;
    acc[k].cost += Number(r.cost_usd ?? 0);
    acc[k].lat += Number(r.latency_ms ?? 0);
  }
  const stats: DeskStats = {};
  for (const [k, v] of Object.entries(acc)) stats[k] = { count: v.count, cost: v.cost, avg_latency: v.count ? v.lat / v.count : 0 };
  // "exec" station = positions exécutées (proxy : pas un log_type LLM)
  stats["exec"] = stats["exec"] ?? { count: 0, cost: 0, avg_latency: 0 };

  // Dernier ticker traité par chaque agent → "sur quoi ils bossent"
  const { data: recentLogs } = await supabase
    .from("agent_logs").select("log_type, ticker, created_at")
    .not("ticker", "is", null)
    .order("created_at", { ascending: false }).limit(300);
  const tickers: Record<string, string> = {};
  for (const r of recentLogs ?? []) {
    const k = r.log_type as string; const t = r.ticker as string | null;
    if (k && t && !tickers[k]) tickers[k] = t;
  }
  const { data: lastPos } = await supabase.from("positions").select("ticker").order("opened_at", { ascending: false }).limit(1).maybeSingle();
  if (lastPos?.ticker) tickers["exec"] = lastPos.ticker as string;

  return (
    <main className="min-h-screen">
      <SiteHeader active="/desk" subtitle="salle des agents" />

      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6 sm:py-8">
        <TradingDeskScene stats={stats} tickers={tickers} />
        <p className="text-center text-xs text-slate-400 mt-5 max-w-2xl mx-auto leading-relaxed">
          Chaque personnage est un agent du pipeline. Quand il bosse, il rejoint son <strong className="text-slate-500">bureau</strong> (écran allumé, « au bureau »). Quand il est en veille, il va <strong className="text-slate-500">dormir</strong> (« z z z »). Les agents les plus sollicités passent plus de temps au bureau.
        </p>
      </div>
    </main>
  );
}
