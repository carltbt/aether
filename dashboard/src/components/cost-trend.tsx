"use client";

import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine } from "recharts";
import { formatCurrency } from "@/lib/utils";

interface DataPoint {
  date: string;
  cost_usd: number;
}

const BUDGET_DAILY_TARGET = 2.5;  // ~$12-15/week per STRATEGY.md

export function CostTrend({ data }: { data: DataPoint[] }) {
  if (!data || data.length === 0) {
    return (
      <div className="bg-white border border-slate-200 rounded-xl px-5 py-8 text-center text-xs text-slate-400">
        No cost data yet.
      </div>
    );
  }

  const total = data.reduce((s, d) => s + d.cost_usd, 0);
  const avg = total / data.length;

  return (
    <div className="bg-white border border-slate-200 rounded-xl p-5">
      <div className="flex items-center justify-between mb-3">
        <div className="text-xs font-medium uppercase tracking-wider text-slate-500">Anthropic cost — last 7 days</div>
        <div className="text-xs text-slate-500 tabular">
          Total: <span className="font-semibold text-slate-900">{formatCurrency(total)}</span>
          <span className="text-slate-300 mx-2">·</span>
          Avg: <span className="font-semibold text-slate-900">{formatCurrency(avg)}/jour</span>
        </div>
      </div>
      <ResponsiveContainer width="100%" height={120}>
        <BarChart data={data} margin={{ top: 5, right: 5, left: 5, bottom: 5 }}>
          <XAxis
            dataKey="date"
            tick={{ fontSize: 9, fill: "#94a3b8" }}
            axisLine={{ stroke: "#e2e8f0" }}
            tickLine={false}
            tickFormatter={(v) => v.slice(5)}
          />
          <YAxis
            tick={{ fontSize: 9, fill: "#94a3b8" }}
            axisLine={{ stroke: "#e2e8f0" }}
            tickLine={false}
            tickFormatter={(v) => `$${v.toFixed(1)}`}
          />
          <Tooltip
            contentStyle={{ background: "white", border: "1px solid #e2e8f0", borderRadius: 8, fontSize: 11 }}
            formatter={(v: unknown) => formatCurrency(Number(v))}
          />
          <ReferenceLine y={BUDGET_DAILY_TARGET} stroke="#d97706" strokeDasharray="3 3" label={{ value: "budget", fontSize: 9, fill: "#d97706", position: "right" }} />
          <Bar dataKey="cost_usd" fill="#1d4ed8" radius={[2, 2, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
