"use client";

import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine } from "recharts";
import { formatCurrency } from "@/lib/utils";

interface Point {
  date: string;
  equity: number;
  pnl: number;
}

export function EquityCurve({ data }: { data: Point[] }) {
  if (!data || data.length === 0) {
    return (
      <div className="bg-white border border-slate-200 rounded-xl px-5 py-12 text-center text-sm text-slate-400">
        Pas encore d&apos;historique d&apos;équité. La courbe se remplit dès la 1re séance live.
      </div>
    );
  }

  const last = data[data.length - 1];
  const positive = last.pnl >= 0;
  const stroke = positive ? "#059669" : "#dc2626";
  const fill = positive ? "#05966922" : "#dc262622";

  return (
    <div className="bg-white border border-slate-200 rounded-xl p-5">
      <div className="flex items-center justify-between mb-3">
        <div className="text-xs font-medium uppercase tracking-wider text-slate-500">Courbe d&apos;équité (P&amp;L vs $100k)</div>
        <div className={`text-sm font-semibold tabular ${positive ? "text-emerald-700" : "text-red-700"}`}>
          {positive ? "+" : ""}{formatCurrency(last.pnl)}
        </div>
      </div>
      <ResponsiveContainer width="100%" height={220}>
        <AreaChart data={data} margin={{ top: 5, right: 5, left: 5, bottom: 5 }}>
          <defs>
            <linearGradient id="equityFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={stroke} stopOpacity={0.25} />
              <stop offset="100%" stopColor={stroke} stopOpacity={0} />
            </linearGradient>
          </defs>
          <XAxis dataKey="date" tick={{ fontSize: 10, fill: "#94a3b8" }} axisLine={{ stroke: "#e2e8f0" }} tickLine={false} tickFormatter={(v) => String(v).slice(5)} />
          <YAxis
            tick={{ fontSize: 10, fill: "#94a3b8" }}
            axisLine={{ stroke: "#e2e8f0" }}
            tickLine={false}
            domain={["auto", "auto"]}
            tickFormatter={(v) => `${v >= 0 ? "+" : ""}${(Number(v) / 1000).toFixed(1)}k`}
          />
          <Tooltip
            contentStyle={{ background: "white", border: "1px solid #e2e8f0", borderRadius: 8, fontSize: 12 }}
            formatter={(v: unknown) => [formatCurrency(Number(v)), "P&L"]}
          />
          <ReferenceLine y={0} stroke="#cbd5e1" strokeDasharray="3 3" />
          <Area type="monotone" dataKey="pnl" stroke={stroke} strokeWidth={2} fill="url(#equityFill)" dot={false} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
