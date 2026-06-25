import Link from "next/link";
import { createAdminClient } from "@/lib/supabase-admin";
import { LogoutButton } from "@/components/logout-button";
import { Logo } from "@/components/logo";
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

  return (
    <main className="min-h-screen">
      <header className="border-b border-slate-200">
        <div className="max-w-7xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <Logo size={26} />
            <span className="font-mono font-bold text-sm tracking-tight text-slate-900">AETHER</span>
            <span className="text-xs text-slate-400">|</span>
            <span className="text-xs text-slate-500">trading floor 3D</span>
          </div>
          <div className="flex items-center gap-4">
            <Link href="/" className="text-xs text-slate-500 hover:text-slate-900 transition-colors">← Dashboard</Link>
            <Link href="/pipeline" className="text-xs text-slate-500 hover:text-slate-900 transition-colors">Pipeline</Link>
            <LogoutButton />
          </div>
        </div>
      </header>

      <div className="max-w-7xl mx-auto px-6 py-8">
        <TradingDeskScene stats={stats} />
        <p className="text-center text-xs text-slate-400 mt-4">
          Chaque station = un agent du pipeline. Halo pulsé = agent actif. Les points bleus sont les décisions qui circulent : analystes → researchers Bull/Bear → Trader → Reviewer → exécution Alpaca.
        </p>
      </div>
    </main>
  );
}
