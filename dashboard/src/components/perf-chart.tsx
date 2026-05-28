"use client";

import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine } from "recharts";
import { formatPct } from "@/lib/utils";

interface DataPoint {
  date: string;
  shadow_pnl_pct: number;
  reviewer_approved_pnl_pct: number;
}

export function PerfChart({ data, title = "Shadow vs Reviewer-Approved P&L (cumulative)" }: { data: DataPoint[]; title?: string }) {
  if (!data || data.length === 0) {
    return (
      <div className="bg-white border border-slate-200 rounded-xl px-5 py-12 text-center text-sm text-slate-400">
        No shadow portfolio data yet. First trades will appear within 24-48h.
      </div>
    );
  }

  return (
    <div className="bg-white border border-slate-200 rounded-xl p-5">
      <div className="text-xs font-medium uppercase tracking-wider text-slate-500 mb-3">{title}</div>
      <ResponsiveContainer width="100%" height={220}>
        <LineChart data={data} margin={{ top: 5, right: 5, left: 5, bottom: 5 }}>
          <XAxis
            dataKey="date"
            tick={{ fontSize: 10, fill: "#94a3b8" }}
            axisLine={{ stroke: "#e2e8f0" }}
            tickLine={false}
          />
          <YAxis
            tick={{ fontSize: 10, fill: "#94a3b8" }}
            axisLine={{ stroke: "#e2e8f0" }}
            tickLine={false}
            tickFormatter={(v) => `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`}
          />
          <Tooltip
            contentStyle={{ background: "white", border: "1px solid #e2e8f0", borderRadius: 8, fontSize: 12 }}
            formatter={(v: unknown) => formatPct(Number(v), { signed: true })}
          />
          <ReferenceLine y={0} stroke="#cbd5e1" strokeDasharray="3 3" />
          <Line
            type="monotone"
            dataKey="shadow_pnl_pct"
            name="All BUYs (shadow)"
            stroke="#1d4ed8"
            strokeWidth={2}
            dot={false}
          />
          <Line
            type="monotone"
            dataKey="reviewer_approved_pnl_pct"
            name="Reviewer-approved only"
            stroke="#059669"
            strokeWidth={2}
            dot={false}
          />
        </LineChart>
      </ResponsiveContainer>
      <div className="flex items-center gap-4 mt-2 text-[10px] text-slate-500">
        <span className="flex items-center gap-1"><span className="inline-block w-3 h-0.5 bg-blue-700"></span>All BUYs (shadow)</span>
        <span className="flex items-center gap-1"><span className="inline-block w-3 h-0.5 bg-emerald-600"></span>Reviewer-approved only</span>
      </div>
    </div>
  );
}
