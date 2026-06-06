import Link from "next/link";
import { createAdminClient } from "@/lib/supabase-admin";
import { LogoutButton } from "@/components/logout-button";
import { PipelineMindmap, type PipelineStats } from "@/components/pipeline-mindmap";
import { ExchangesFeed, type ExchangeLog } from "@/components/exchanges-feed";

export const dynamic = "force-dynamic";

export default async function PipelinePage() {
  const supabase = createAdminClient();

  const [statsRes, feedRes] = await Promise.all([
    supabase.from("agent_logs").select("log_type, cost_usd, latency_ms").limit(5000),
    supabase.from("agent_logs")
      .select("id, log_type, ticker, input_tokens, output_tokens, latency_ms, cost_usd, raw_output, error, created_at")
      .order("created_at", { ascending: false })
      .limit(80),
  ]);

  // Aggregate per log_type for the mind map nodes
  const acc: Record<string, { count: number; cost: number; lat: number }> = {};
  for (const r of statsRes.data ?? []) {
    const k = r.log_type as string;
    if (!acc[k]) acc[k] = { count: 0, cost: 0, lat: 0 };
    acc[k].count += 1;
    acc[k].cost += Number(r.cost_usd ?? 0);
    acc[k].lat += Number(r.latency_ms ?? 0);
  }
  const stats: PipelineStats = {};
  for (const [k, v] of Object.entries(acc)) {
    stats[k] = { count: v.count, cost: v.cost, avg_latency: v.count ? v.lat / v.count : 0 };
  }

  const logs = (feedRes.data ?? []) as ExchangeLog[];

  return (
    <main className="min-h-screen">
      <header className="border-b border-slate-200">
        <div className="max-w-7xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="bg-brand-gradient text-white font-mono font-bold text-sm px-2.5 py-1 rounded">AETHER</div>
            <span className="text-xs text-slate-400">|</span>
            <span className="text-xs text-slate-500">pipeline LLM</span>
          </div>
          <div className="flex items-center gap-4">
            <Link href="/" className="text-xs text-slate-500 hover:text-slate-900 transition-colors">← Dashboard</Link>
            <LogoutButton />
          </div>
        </div>
      </header>

      <div className="max-w-7xl mx-auto px-6 py-8 space-y-10">
        <PipelineMindmap stats={stats} />
        <ExchangesFeed logs={logs} />
      </div>
    </main>
  );
}
