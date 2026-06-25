"use client";

import { useState, type CSSProperties } from "react";

export interface DeskAgentStat { count: number; cost: number; avg_latency: number; }
export type DeskStats = Record<string, DeskAgentStat>;

interface Station {
  key: string;
  label: string;
  model: "Haiku" | "Sonnet" | "Code";
  emoji: string;
  color: string;       // accent
  left: number;        // % on floor
  top: number;         // % on floor
  lift: number;        // px translateZ (hauteur)
}

// Disposition sur le "sol" : analystes (gauche) → researchers → trader → reviewer → exécution
const STATIONS: Station[] = [
  { key: "analysis_pass1", label: "Technique", model: "Haiku", emoji: "📈", color: "#8b5cf6", left: 13, top: 20, lift: 70 },
  { key: "analysis_pass2", label: "Sentiment", model: "Haiku", emoji: "📰", color: "#8b5cf6", left: 11, top: 50, lift: 70 },
  { key: "analysis_pass3", label: "Fondamentaux", model: "Sonnet", emoji: "🔬", color: "#3b82f6", left: 13, top: 80, lift: 70 },
  { key: "researcher_bull", label: "Bull", model: "Sonnet", emoji: "🐂", color: "#10b981", left: 40, top: 28, lift: 90 },
  { key: "researcher_bear", label: "Bear", model: "Sonnet", emoji: "🐻", color: "#ef4444", left: 40, top: 72, lift: 90 },
  { key: "decision", label: "Trader", model: "Sonnet", emoji: "🧠", color: "#2563eb", left: 64, top: 50, lift: 110 },
  { key: "reviewer", label: "Reviewer", model: "Sonnet", emoji: "⚖️", color: "#f59e0b", left: 83, top: 35, lift: 95 },
  { key: "exec", label: "Alpaca", model: "Code", emoji: "⚡", color: "#0ea5e9", left: 88, top: 72, lift: 80 },
];

// Lanes de flux (packets qui circulent) : [fromLeft,fromTop,toLeft,toTop, delay]
const LANES: Array<[number, number, number, number, number]> = [
  [16, 24, 40, 30, 0], [14, 50, 40, 30, 0.6], [16, 78, 40, 70, 1.2],
  [44, 30, 64, 50, 1.8], [44, 70, 64, 50, 2.2],
  [68, 50, 83, 38, 2.8], [85, 40, 88, 68, 3.4],
];

const MODEL_DOT: Record<string, string> = { Haiku: "#8b5cf6", Sonnet: "#3b82f6", Code: "#64748b" };

export function TradingDeskScene({ stats }: { stats: DeskStats }) {
  const [hover, setHover] = useState<string | null>(null);
  const totalCalls = Object.values(stats).reduce((s, v) => s + v.count, 0);

  return (
    <div className="td-root">
      <style>{CSS}</style>

      {/* Overlay HUD */}
      <div className="td-hud">
        <div className="td-hud-title">AETHER · TRADING FLOOR</div>
        <div className="td-hud-sub">{totalCalls.toLocaleString()} décisions LLM traitées · 8 agents en service</div>
      </div>
      <div className="td-live"><span className="td-live-dot" /> LIVE</div>

      {/* Scène 3D */}
      <div className="td-stage">
        <div className="td-floor">
          {/* grille + halo */}
          <div className="td-grid" />
          <div className="td-glow" />

          {/* connecteurs (au sol) */}
          {LANES.map((l, i) => {
            const dx = l[2] - l[0], dy = l[3] - l[1];
            const len = Math.hypot(dx, dy);
            const ang = (Math.atan2(dy, dx) * 180) / Math.PI;
            return (
              <div key={`c${i}`} className="td-conn" style={{ left: `${l[0]}%`, top: `${l[1]}%`, width: `${len}%`, transform: `rotate(${ang}deg)` }} />
            );
          })}

          {/* packets de données qui circulent */}
          {LANES.map((l, i) => (
            <div key={`p${i}`} className="td-packet" style={{ left: `${l[0]}%`, top: `${l[1]}%`, "--tx": `${l[2] - l[0]}%`, "--ty": `${l[3] - l[1]}%`, animationDelay: `${l[4]}s` } as CSSProperties} />
          ))}

          {/* stations / agents */}
          {STATIONS.map((s) => {
            const st = stats[s.key];
            const calls = st?.count ?? 0;
            const busy = calls > 0;
            return (
              <div
                key={s.key}
                className="td-station"
                style={{ left: `${s.left}%`, top: `${s.top}%`, "--lift": `${s.lift}px`, "--accent": s.color } as CSSProperties}
                onMouseEnter={() => setHover(s.key)}
                onMouseLeave={() => setHover(null)}
              >
                {/* ombre au sol */}
                <div className="td-shadow" />
                {/* poteau */}
                <div className="td-pole" style={{ height: `var(--lift)` }} />
                {/* carte agent */}
                <div className={`td-card ${busy ? "td-busy" : ""}`}>
                  <div className="td-avatar"><span>{s.emoji}</span></div>
                  <div className="td-meta">
                    <div className="td-name">{s.label}</div>
                    <div className="td-badge"><span className="td-mdot" style={{ background: MODEL_DOT[s.model] }} />{s.model}</div>
                  </div>
                  {hover === s.key && st && (
                    <div className="td-tip">{calls.toLocaleString()} appels · {(st.avg_latency / 1000).toFixed(1)}s · ${st.cost.toFixed(2)}</div>
                  )}
                  {busy && <div className="td-work" />}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div className="td-legend">
        <span><i style={{ background: "#8b5cf6" }} /> Haiku</span>
        <span><i style={{ background: "#3b82f6" }} /> Sonnet</span>
        <span><i style={{ background: "#64748b" }} /> Code</span>
        <span className="td-legend-flow">→ flux : analystes · researchers · trader · reviewer · exécution</span>
      </div>
    </div>
  );
}

const CSS = `
.td-root { position: relative; border-radius: 20px; overflow: hidden;
  background: radial-gradient(120% 90% at 50% 0%, #0b1220 0%, #060a14 55%, #03060d 100%);
  border: 1px solid #1e293b; padding: 0; min-height: 560px; }
.td-hud { position: absolute; top: 18px; left: 22px; z-index: 5; }
.td-hud-title { font-family: var(--font-geist-mono, monospace); font-weight: 800; letter-spacing: .22em; font-size: 13px;
  color: #e2e8f0; text-shadow: 0 0 18px rgba(59,130,246,.5); }
.td-hud-sub { font-size: 11px; color: #64748b; margin-top: 3px; }
.td-live { position: absolute; top: 18px; right: 22px; z-index: 5; display: flex; align-items: center; gap: 6px;
  font-family: monospace; font-size: 11px; font-weight: 700; letter-spacing: .15em; color: #f87171; }
.td-live-dot { width: 8px; height: 8px; border-radius: 50%; background: #f87171; box-shadow: 0 0 10px #f87171; animation: td-blink 1.4s infinite; }
@keyframes td-blink { 0%,100%{opacity:1} 50%{opacity:.25} }

.td-stage { perspective: 1300px; perspective-origin: 50% 24%; height: 560px; display: flex; align-items: center; justify-content: center; }
.td-floor { position: relative; width: 78%; height: 360px; transform-style: preserve-3d;
  transform: rotateX(57deg) rotateZ(0deg); animation: td-sway 14s ease-in-out infinite;
  background: linear-gradient(180deg, rgba(37,99,235,.08), rgba(2,6,13,.2));
  border: 1px solid rgba(59,130,246,.25); border-radius: 10px;
  box-shadow: 0 0 80px rgba(37,99,235,.18) inset, 0 40px 80px rgba(0,0,0,.6); }
@keyframes td-sway { 0%,100%{ transform: rotateX(57deg) rotateZ(-3deg);} 50%{ transform: rotateX(57deg) rotateZ(3deg);} }

.td-grid { position: absolute; inset: 0; border-radius: 10px;
  background-image: linear-gradient(rgba(59,130,246,.18) 1px, transparent 1px), linear-gradient(90deg, rgba(59,130,246,.18) 1px, transparent 1px);
  background-size: 7.5% 9%; animation: td-grid 6s linear infinite; }
@keyframes td-grid { from{ background-position: 0 0; } to { background-position: 0 9%; } }
.td-glow { position: absolute; left: 60%; top: 45%; width: 240px; height: 240px; transform: translate(-50%,-50%);
  background: radial-gradient(circle, rgba(37,99,235,.35), transparent 65%); filter: blur(8px); }

.td-conn { position: absolute; height: 3px; transform-origin: left center; border-radius: 3px;
  background: linear-gradient(90deg, rgba(59,130,246,0), rgba(59,130,246,.55), rgba(59,130,246,0));
  background-size: 200% 100%; animation: td-flow 2.2s linear infinite; opacity:.7; }
@keyframes td-flow { from{background-position:200% 0;} to{background-position:-200% 0;} }

.td-packet { position: absolute; width: 9px; height: 9px; margin: -4px 0 0 -4px; border-radius: 50%;
  background: #93c5fd; box-shadow: 0 0 12px 3px rgba(96,165,250,.9); animation: td-move 4s linear infinite; }
@keyframes td-move { 0%{ transform: translate(0,0); opacity:0;} 12%{opacity:1;} 88%{opacity:1;} 100%{ transform: translate(var(--tx), var(--ty)); opacity:0;} }

.td-station { position: absolute; transform-style: preserve-3d; transform-origin: bottom center; }
.td-shadow { position: absolute; left: 50%; top: 0; width: 76px; height: 26px; transform: translate(-50%,-50%);
  background: radial-gradient(ellipse, rgba(0,0,0,.55), transparent 70%); }
.td-pole { position: absolute; left: 50%; bottom: 0; width: 2px; transform: translateX(-50%);
  background: linear-gradient(to top, rgba(59,130,246,.05), var(--accent)); opacity:.5; }
.td-card { position: absolute; left: 50%; bottom: 0; width: 132px; transform: translateX(-50%) rotateX(-57deg) translateZ(var(--lift)); transform-origin: bottom center;
  background: linear-gradient(160deg, rgba(15,23,42,.96), rgba(2,6,13,.96)); border: 1px solid var(--accent);
  border-radius: 12px; padding: 9px 10px; display: flex; align-items: center; gap: 9px;
  box-shadow: 0 0 0 1px rgba(255,255,255,.03), 0 10px 24px rgba(0,0,0,.55), 0 0 22px -6px var(--accent); }
.td-busy { animation: td-pulse 2.6s ease-in-out infinite; }
@keyframes td-pulse { 0%,100%{ box-shadow: 0 10px 24px rgba(0,0,0,.55), 0 0 14px -8px var(--accent);} 50%{ box-shadow: 0 10px 24px rgba(0,0,0,.55), 0 0 30px 0px var(--accent);} }
.td-avatar { width: 34px; height: 34px; border-radius: 9px; display: grid; place-items: center; font-size: 18px; flex-shrink: 0;
  background: radial-gradient(circle at 30% 25%, rgba(255,255,255,.14), rgba(255,255,255,.02)); border: 1px solid rgba(255,255,255,.08);
  animation: td-bob 3s ease-in-out infinite; }
@keyframes td-bob { 0%,100%{ transform: translateY(0);} 50%{ transform: translateY(-2px);} }
.td-meta { min-width: 0; }
.td-name { font-size: 12px; font-weight: 700; color: #f1f5f9; line-height: 1.1; }
.td-badge { display: inline-flex; align-items: center; gap: 4px; margin-top: 3px; font-size: 9px; font-family: monospace; text-transform: uppercase; color: #94a3b8; }
.td-mdot { width: 6px; height: 6px; border-radius: 50%; }
.td-tip { position: absolute; left: 50%; top: -26px; transform: translateX(-50%); white-space: nowrap;
  background: #0f172a; border: 1px solid var(--accent); color: #e2e8f0; font-size: 10px; padding: 3px 7px; border-radius: 6px; }
.td-work { position: absolute; right: 8px; bottom: 7px; width: 6px; height: 6px; border-radius: 50%; background: var(--accent);
  box-shadow: 0 0 8px var(--accent); animation: td-blink 1s infinite; }

.td-legend { position: absolute; bottom: 14px; left: 22px; right: 22px; z-index: 5; display: flex; gap: 16px; flex-wrap: wrap;
  font-size: 11px; color: #94a3b8; }
.td-legend span { display: inline-flex; align-items: center; gap: 6px; }
.td-legend i { width: 9px; height: 9px; border-radius: 50%; display: inline-block; }
.td-legend-flow { margin-left: auto; color: #475569; }
`;
