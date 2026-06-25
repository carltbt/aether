"use client";

import { useState, type CSSProperties } from "react";

export interface DeskAgentStat { count: number; cost: number; avg_latency: number; }
export type DeskStats = Record<string, DeskAgentStat>;

interface Agent {
  key: string;
  label: string;
  model: "Haiku" | "Sonnet" | "Code";
  emoji: string;
  color: string;
}

const AGENTS: Agent[] = [
  { key: "analysis_pass1", label: "Technique", model: "Haiku", emoji: "📈", color: "#8b5cf6" },
  { key: "analysis_pass2", label: "Sentiment", model: "Haiku", emoji: "📰", color: "#a855f7" },
  { key: "analysis_pass3", label: "Fondam.", model: "Sonnet", emoji: "🔬", color: "#3b82f6" },
  { key: "researcher_bull", label: "Bull", model: "Sonnet", emoji: "🐂", color: "#10b981" },
  { key: "researcher_bear", label: "Bear", model: "Sonnet", emoji: "🐻", color: "#ef4444" },
  { key: "decision", label: "Trader", model: "Sonnet", emoji: "🧠", color: "#2563eb" },
  { key: "reviewer", label: "Reviewer", model: "Sonnet", emoji: "⚖️", color: "#f59e0b" },
  { key: "exec", label: "Alpaca", model: "Code", emoji: "⚡", color: "#0ea5e9" },
];

// déphasages pour que la salle soit toujours en mouvement (mix bossent/dorment)
const DUR = [13, 16, 14, 11, 17, 12, 15, 10];
const DELAY = [0, 2.4, 5.1, 1.2, 3.6, 6.2, 0.8, 4.4];

function variantFor(count: number): "a" | "b" | "c" {
  if (count >= 100) return "a"; // bosse beaucoup
  if (count >= 40) return "b";  // moyen
  return "c";                    // dort beaucoup
}

const MODEL_DOT: Record<string, string> = { Haiku: "#8b5cf6", Sonnet: "#3b82f6", Code: "#64748b" };

export function TradingDeskScene({ stats }: { stats: DeskStats }) {
  const [hover, setHover] = useState<string | null>(null);
  const totalCalls = Object.values(stats).reduce((s, v) => s + v.count, 0);
  const workingNow = AGENTS.filter(a => variantFor(stats[a.key]?.count ?? 0) === "a").length;

  return (
    <div className="rm-root">
      <style>{CSS}</style>

      <div className="rm-hud">
        <div className="rm-title">AETHER · SALLE DES AGENTS</div>
        <div className="rm-sub">{totalCalls.toLocaleString()} décisions traitées · {workingNow} agents en pleine charge</div>
      </div>
      <div className="rm-live"><span className="rm-live-dot" /> LIVE</div>

      <div className="rm-room">
        <div className="rm-floor" />
        <div className="rm-zone rm-zone-top">BUREAUX</div>
        <div className="rm-zone rm-zone-bot">DORTOIR</div>

        {AGENTS.map((a, i) => {
          const st = stats[a.key];
          const v = variantFor(st?.count ?? 0);
          const style = {
            left: `${4 + i * 12}%`,
            "--accent": a.color,
            "--dur": `${DUR[i]}s`,
            "--delay": `${DELAY[i]}s`,
          } as CSSProperties;
          return (
            <div key={a.key} className={`rm-cell rm-${v}`} style={style}
              onMouseEnter={() => setHover(a.key)} onMouseLeave={() => setHover(null)}>

              {/* bureau */}
              <div className="rm-desk">
                <div className="rm-screen"><span className="rm-screenglow" /></div>
                <div className="rm-deskglow" />
              </div>

              {/* lit */}
              <div className="rm-bed"><span className="rm-pillow" /></div>

              {/* le PNJ qui marche entre les deux */}
              <div className="rm-npc">
                <div className="rm-shadow" />
                <div className="rm-body"><span className="rm-emoji">{a.emoji}</span></div>
                <div className="rm-badge">● actif</div>
                <div className="rm-zzz"><span>z</span><span>z</span><span>z</span></div>
              </div>

              {/* étiquette */}
              <div className="rm-label">
                <span className="rm-name">{a.label}</span>
                <span className="rm-mbadge"><i style={{ background: MODEL_DOT[a.model] }} />{a.model}</span>
              </div>

              {hover === a.key && st && (
                <div className="rm-tip">{(st.count).toLocaleString()} appels · {(st.avg_latency / 1000).toFixed(1)}s · ${st.cost.toFixed(2)}</div>
              )}
            </div>
          );
        })}
      </div>

      <div className="rm-legend">
        <span><i className="rm-lg-work" /> au bureau = travaille</span>
        <span><i className="rm-lg-sleep" /> au lit = en veille</span>
        <span className="rm-legend-flow">flux : analystes · researchers · trader · reviewer · exécution</span>
      </div>
    </div>
  );
}

const CSS = `
.rm-root { position: relative; border-radius: 22px; overflow: hidden; background: #ffffff;
  border: 1px solid #e2e8f0; box-shadow: 0 20px 50px -24px rgba(15,23,42,.25); min-height: 560px; }
.rm-hud { position: absolute; top: 18px; left: 22px; z-index: 6; }
.rm-title { font-family: var(--font-geist-mono, monospace); font-weight: 800; letter-spacing: .22em; font-size: 13px; color: #0f172a; }
.rm-sub { font-size: 11px; color: #94a3b8; margin-top: 3px; }
.rm-live { position: absolute; top: 18px; right: 22px; z-index: 6; display: flex; align-items: center; gap: 6px;
  font-family: monospace; font-size: 11px; font-weight: 700; letter-spacing: .15em; color: #ef4444; }
.rm-live-dot { width: 8px; height: 8px; border-radius: 50%; background: #ef4444; box-shadow: 0 0 8px #ef4444; animation: rm-blink 1.4s infinite; }
@keyframes rm-blink { 0%,100%{opacity:1} 50%{opacity:.25} }

.rm-room { position: relative; height: 470px; margin: 64px 14px 0; border-radius: 16px; overflow: hidden;
  background: linear-gradient(180deg, #f8fafc 0%, #ffffff 42%, #f1f5f9 100%); border: 1px solid #eef2f7; }
.rm-floor { position: absolute; inset: 42% 0 0 0;
  background-image: linear-gradient(#e2e8f0 1px, transparent 1px), linear-gradient(90deg, #e9eef5 1px, transparent 1px);
  background-size: 46px 30px; transform: perspective(700px) rotateX(40deg); transform-origin: top; opacity: .7; }
.rm-zone { position: absolute; left: 14px; font-size: 9px; font-weight: 700; letter-spacing: .18em; color: #cbd5e1; z-index: 1; }
.rm-zone-top { top: 12px; } .rm-zone-bot { bottom: 12px; }

.rm-cell { position: absolute; top: 0; width: 12%; height: 100%; }

/* bureau (en haut) */
.rm-desk { position: absolute; top: 30px; left: 50%; transform: translateX(-50%); width: 84px; height: 30px;
  background: #f1f5f9; border: 1px solid #e2e8f0; border-radius: 6px 6px 3px 3px; box-shadow: 0 6px 10px -6px rgba(15,23,42,.25); }
.rm-screen { position: absolute; top: -22px; left: 50%; transform: translateX(-50%); width: 40px; height: 26px;
  background: #0f172a; border-radius: 4px; border: 2px solid #1e293b; overflow: hidden; }
.rm-screenglow { position: absolute; inset: 0; background: linear-gradient(135deg, var(--accent), transparent 70%); opacity: 0; }
.rm-deskglow { position: absolute; inset: -8px; border-radius: 10px; box-shadow: 0 0 0 0 var(--accent); opacity: 0; }

/* lit (en bas) */
.rm-bed { position: absolute; top: 360px; left: 50%; transform: translateX(-50%); width: 92px; height: 40px;
  background: #f8fafc; border: 1px solid #e6ebf2; border-radius: 8px; box-shadow: inset 0 0 0 4px #fff, 0 6px 10px -6px rgba(15,23,42,.2); }
.rm-pillow { position: absolute; top: 6px; left: 7px; width: 22px; height: 16px; background: #e2e8f0; border-radius: 4px; }

/* PNJ */
.rm-npc { position: absolute; top: 78px; left: 50%; width: 0; height: 0;
  animation-name: rm-walk; animation-duration: var(--dur); animation-delay: var(--delay);
  animation-timing-function: ease-in-out; animation-iteration-count: infinite; }
.rm-shadow { position: absolute; left: 50%; top: 30px; width: 34px; height: 10px; transform: translateX(-50%);
  background: radial-gradient(ellipse, rgba(15,23,42,.18), transparent 70%); }
.rm-body { position: absolute; left: 50%; top: 0; transform: translate(-50%,-50%); width: 38px; height: 38px; border-radius: 12px;
  background: radial-gradient(circle at 32% 28%, color-mix(in srgb, var(--accent) 30%, #fff), color-mix(in srgb, var(--accent) 14%, #fff));
  border: 1.5px solid var(--accent); display: grid; place-items: center; box-shadow: 0 4px 10px -3px rgba(15,23,42,.3);
  animation-name: rm-pose; animation-duration: var(--dur); animation-delay: var(--delay);
  animation-timing-function: ease-in-out; animation-iteration-count: infinite; }
.rm-emoji { font-size: 19px; line-height: 1; }
.rm-badge { position: absolute; left: 50%; top: -34px; transform: translateX(-50%); white-space: nowrap;
  font-size: 8.5px; font-weight: 800; letter-spacing: .04em; color: #fff; background: #10b981; padding: 2px 6px; border-radius: 999px;
  box-shadow: 0 2px 6px -1px rgba(16,185,129,.6); opacity: 0;
  animation-name: rm-sigwork; animation-duration: var(--dur); animation-delay: var(--delay); animation-timing-function: ease-in-out; animation-iteration-count: infinite; }
.rm-zzz { position: absolute; left: 50%; top: -30px; transform: translateX(-50%); display: flex; gap: 2px; opacity: 0;
  animation-name: rm-sigsleep; animation-duration: var(--dur); animation-delay: var(--delay); animation-timing-function: ease-in-out; animation-iteration-count: infinite; }
.rm-zzz span { font-size: 11px; font-weight: 800; color: #94a3b8; animation: rm-zfloat 1.8s ease-in-out infinite; }
.rm-zzz span:nth-child(2){ font-size: 13px; animation-delay: .25s; } .rm-zzz span:nth-child(3){ font-size: 15px; animation-delay: .5s; }
@keyframes rm-zfloat { 0%,100%{ transform: translateY(0); opacity:.5;} 50%{ transform: translateY(-4px); opacity:1;} }

.rm-label { position: absolute; top: 4px; left: 50%; transform: translateX(-50%); text-align: center; white-space: nowrap; }
.rm-name { display: block; font-size: 11px; font-weight: 700; color: #0f172a; }
.rm-mbadge { display: inline-flex; align-items: center; gap: 3px; font-size: 8px; font-family: monospace; text-transform: uppercase; color: #94a3b8; margin-top: 1px; }
.rm-mbadge i { width: 5px; height: 5px; border-radius: 50%; }
.rm-tip { position: absolute; top: 40px; left: 50%; transform: translateX(-50%); white-space: nowrap; z-index: 8;
  background: #0f172a; color: #fff; font-size: 10px; padding: 3px 8px; border-radius: 6px; box-shadow: 0 6px 14px -4px rgba(15,23,42,.5); }

/* ---- cycles : a = bosse bcp, b = moyen, c = dort bcp ---- */
/* walk : top du PNJ (78px) → lit (78+280=358px) */
@keyframes rm-walk { 0%,42%{ transform: translateY(0);} 50%,92%{ transform: translateY(280px);} 100%{ transform: translateY(0);} }
@keyframes rm-pose { 0%,46%{ transform: translate(-50%,-50%) rotate(0);} 54%,90%{ transform: translate(-50%,-50%) rotate(76deg) scale(.92);} 100%{ transform: translate(-50%,-50%) rotate(0);} }
@keyframes rm-sigwork { 0%,42%{opacity:1;} 50%,100%{opacity:0;} }
@keyframes rm-sigsleep { 0%,52%{opacity:0;} 58%,90%{opacity:1;} 96%,100%{opacity:0;} }

.rm-a .rm-npc { animation-name: rm-walk-a; } .rm-a .rm-body { animation-name: rm-pose-a; } .rm-a .rm-badge { animation-name: rm-sigwork-a; } .rm-a .rm-zzz { animation-name: rm-sigsleep-a; } .rm-a .rm-screenglow, .rm-a .rm-deskglow { animation: rm-glow-a var(--dur) ease-in-out var(--delay) infinite; }
.rm-b .rm-npc { animation-name: rm-walk-b; } .rm-b .rm-body { animation-name: rm-pose-b; } .rm-b .rm-badge { animation-name: rm-sigwork-b; } .rm-b .rm-zzz { animation-name: rm-sigsleep-b; } .rm-b .rm-screenglow, .rm-b .rm-deskglow { animation: rm-glow-b var(--dur) ease-in-out var(--delay) infinite; }
.rm-c .rm-npc { animation-name: rm-walk-c; } .rm-c .rm-body { animation-name: rm-pose-c; } .rm-c .rm-badge { animation-name: rm-sigwork-c; } .rm-c .rm-zzz { animation-name: rm-sigsleep-c; } .rm-c .rm-screenglow, .rm-c .rm-deskglow { animation: rm-glow-c var(--dur) ease-in-out var(--delay) infinite; }

/* a : bureau 0-60% */
@keyframes rm-walk-a { 0%,58%{ transform: translateY(0);} 66%,94%{ transform: translateY(280px);} 100%{ transform: translateY(0);} }
@keyframes rm-pose-a { 0%,60%{ transform: translate(-50%,-50%) rotate(0);} 68%,92%{ transform: translate(-50%,-50%) rotate(76deg) scale(.92);} 100%{ transform: translate(-50%,-50%) rotate(0);} }
@keyframes rm-sigwork-a { 0%,56%{opacity:1;} 64%,100%{opacity:0;} }
@keyframes rm-sigsleep-a { 0%,64%{opacity:0;} 70%,92%{opacity:1;} 98%,100%{opacity:0;} }
@keyframes rm-glow-a { 0%,56%{opacity:1;} 64%,100%{opacity:0;} }
/* b : bureau 0-44% */
@keyframes rm-walk-b { 0%,42%{ transform: translateY(0);} 50%,92%{ transform: translateY(280px);} 100%{ transform: translateY(0);} }
@keyframes rm-pose-b { 0%,46%{ transform: translate(-50%,-50%) rotate(0);} 54%,90%{ transform: translate(-50%,-50%) rotate(76deg) scale(.92);} 100%{ transform: translate(-50%,-50%) rotate(0);} }
@keyframes rm-sigwork-b { 0%,42%{opacity:1;} 50%,100%{opacity:0;} }
@keyframes rm-sigsleep-b { 0%,52%{opacity:0;} 58%,90%{opacity:1;} 96%,100%{opacity:0;} }
@keyframes rm-glow-b { 0%,42%{opacity:1;} 50%,100%{opacity:0;} }
/* c : bureau 0-26% */
@keyframes rm-walk-c { 0%,24%{ transform: translateY(0);} 33%,92%{ transform: translateY(280px);} 100%{ transform: translateY(0);} }
@keyframes rm-pose-c { 0%,28%{ transform: translate(-50%,-50%) rotate(0);} 36%,90%{ transform: translate(-50%,-50%) rotate(76deg) scale(.92);} 100%{ transform: translate(-50%,-50%) rotate(0);} }
@keyframes rm-sigwork-c { 0%,24%{opacity:1;} 32%,100%{opacity:0;} }
@keyframes rm-sigsleep-c { 0%,34%{opacity:0;} 40%,90%{opacity:1;} 96%,100%{opacity:0;} }
@keyframes rm-glow-c { 0%,24%{opacity:1;} 32%,100%{opacity:0;} }

.rm-legend { position: absolute; bottom: 14px; left: 22px; right: 22px; z-index: 6; display: flex; gap: 18px; flex-wrap: wrap; font-size: 11px; color: #64748b; }
.rm-legend span { display: inline-flex; align-items: center; gap: 6px; }
.rm-legend i { width: 11px; height: 11px; border-radius: 3px; display: inline-block; }
.rm-lg-work { background: #10b981; } .rm-lg-sleep { background: #cbd5e1; }
.rm-legend-flow { margin-left: auto; color: #94a3b8; }
`;
