"use client";

import { useState, type CSSProperties } from "react";
import { AgentIcon, type AgentIconName } from "./agent-icon";

export interface DeskAgentStat { count: number; cost: number; avg_latency: number; }
export type DeskStats = Record<string, DeskAgentStat>;

interface Agent {
  key: string;
  label: string;
  model: "Haiku" | "Sonnet" | "Code";
  role: string;
  icon: AgentIconName;
  color: string;
  task: string; // ce qu'il fait quand il bosse
}

const AGENTS: Agent[] = [
  { key: "analysis_pass1", label: "Technique", model: "Haiku", role: "Analyste", icon: "chart", color: "#8b5cf6", task: "lit RSI · MACD · ADX" },
  { key: "analysis_pass2", label: "Sentiment", model: "Haiku", role: "Analyste", icon: "news", color: "#a855f7", task: "scanne les news" },
  { key: "analysis_pass3", label: "Fondamentaux", model: "Sonnet", role: "Analyste", icon: "flask", color: "#3b82f6", task: "DCF & qualité" },
  { key: "researcher_bull", label: "Bull", model: "Sonnet", role: "Researcher", icon: "trendUp", color: "#10b981", task: "bâtit la thèse haussière" },
  { key: "researcher_bear", label: "Bear", model: "Sonnet", role: "Researcher", icon: "trendDown", color: "#ef4444", task: "cherche les risques" },
  { key: "decision", label: "Trader", model: "Sonnet", role: "Décision", icon: "cpu", color: "#2563eb", task: "tranche BUY / HOLD" },
  { key: "reviewer", label: "Reviewer", model: "Sonnet", role: "Contrôle", icon: "scale", color: "#f59e0b", task: "vérifie 3 perspectives" },
  { key: "exec", label: "Alpaca", model: "Code", role: "Exécution", icon: "bolt", color: "#0ea5e9", task: "passe l'ordre bracket" },
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

export function TradingDeskScene({ stats, tickers = {} }: { stats: DeskStats; tickers?: Record<string, string> }) {
  const [hover, setHover] = useState<string | null>(null);
  const totalCalls = Object.values(stats).reduce((s, v) => s + v.count, 0);
  const workingNow = AGENTS.filter(a => variantFor(stats[a.key]?.count ?? 0) === "a").length;

  return (
    <div className="room">
      <style>{CSS}</style>

      <div className="room-hud">
        <div className="room-head">
          <div className="room-h1">SALLE DES AGENTS</div>
          <div className="room-sub">{totalCalls.toLocaleString()} décisions traitées · {workingNow} en pleine charge</div>
        </div>
        <div className="room-live"><span className="room-live-dot" /> LIVE</div>
      </div>

      <div className="room-grid">
        {AGENTS.map((a, i) => {
          const st = stats[a.key];
          const v = variantFor(st?.count ?? 0);
          const ticker = tickers[a.key] ?? "—";
          const style = {
            "--accent": a.color,
            "--dur": `${DUR[i]}s`,
            "--delay": `${DELAY[i]}s`,
          } as CSSProperties;
          return (
            <div key={a.key} className={`ag agv-${v}`} style={style}
              onMouseEnter={() => setHover(a.key)} onMouseLeave={() => setHover(null)}>

              {/* En-tête : icône + nom + modèle — bien séparé de la scène en dessous */}
              <div className="ag-top">
                <span className="ag-ic"><AgentIcon name={a.icon} size={18} /></span>
                <span className="ag-txt">
                  <span className="ag-name">{a.label}</span>
                  <span className="ag-model"><i style={{ background: MODEL_DOT[a.model] }} />{a.model} · {a.role}</span>
                </span>
              </div>

              {/* Scène : le PNJ marche entre son bureau (haut) et son lit (bas) */}
              <div className="ag-scene">
                <div className="ag-desk">
                  <span className="ag-mon"><span className="ag-mon-tk">{ticker}</span><span className="ag-bars"><i /><i /><i /></span></span>
                </div>
                <div className="ag-bed"><span className="ag-pillow" /></div>

                <div className="ag-npc">
                  <span className="ag-shadow" />
                  <span className="ag-av"><AgentIcon name={a.icon} size={16} /></span>
                </div>

                <div className="ag-task"><b>{ticker}</b>{a.task}</div>
                <div className="ag-zzz"><span>z</span><span>z</span><span>z</span></div>
                <div className="ag-status ag-status-work">● au bureau</div>
                <div className="ag-status ag-status-sleep">en veille</div>
              </div>

              {hover === a.key && st && (
                <div className="ag-tip">{st.count.toLocaleString()} appels · {(st.avg_latency / 1000).toFixed(1)}s · ${st.cost.toFixed(2)}</div>
              )}
            </div>
          );
        })}
      </div>

      <div className="room-legend">
        <span><i className="lg-work" /> au bureau = travaille</span>
        <span><i className="lg-sleep" /> au lit = en veille</span>
        <span className="lg-flow">flux : analystes → researchers → trader → reviewer → exécution</span>
      </div>
    </div>
  );
}

const CSS = `
.room { position: relative; border-radius: 20px; background: #ffffff; border: 1px solid #e2e8f0;
  box-shadow: 0 20px 50px -28px rgba(15,23,42,.22); padding: 18px; }
@media (min-width: 640px) { .room { padding: 22px; } }

.room-hud { display: flex; flex-direction: column; gap: 10px; margin-bottom: 18px; }
@media (min-width: 640px) { .room-hud { flex-direction: row; align-items: center; justify-content: space-between; } }
.room-h1 { font-family: var(--font-geist-mono, monospace); font-weight: 800; letter-spacing: .2em; font-size: 13px; color: #0f172a; }
.room-sub { font-size: 11px; color: #94a3b8; margin-top: 3px; }
.room-live { display: inline-flex; align-items: center; gap: 6px; align-self: flex-start;
  font-family: monospace; font-size: 11px; font-weight: 700; letter-spacing: .15em; color: #ef4444;
  background: #fef2f2; border: 1px solid #fecaca; border-radius: 999px; padding: 4px 10px; }
.room-live-dot { width: 7px; height: 7px; border-radius: 50%; background: #ef4444; box-shadow: 0 0 8px #ef4444; animation: room-blink 1.4s infinite; }
@keyframes room-blink { 0%,100%{opacity:1} 50%{opacity:.25} }

/* Grille responsive : 2 colonnes sur mobile, 4 sur desktop — espacée */
.room-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 16px; }
@media (min-width: 640px) { .room-grid { gap: 20px; } }
@media (min-width: 1024px) { .room-grid { grid-template-columns: repeat(4, 1fr); gap: 24px; } }

/* ---- Carte agent ---- */
.ag { --walk: 70px; position: relative; border-radius: 16px; background: linear-gradient(180deg, #ffffff, #fbfcfe);
  border: 1px solid #eef2f7; box-shadow: 0 6px 18px -14px rgba(15,23,42,.35); overflow: hidden; }

/* En-tête : nom au-dessus, bien détaché de la scène (aucun chevauchement possible) */
.ag-top { display: flex; align-items: center; gap: 11px; padding: 15px 15px 14px; border-bottom: 1px dashed #eef2f7;
  background: linear-gradient(180deg, color-mix(in srgb, var(--accent) 7%, #fff), #ffffff); }
.ag-ic { flex: 0 0 auto; width: 34px; height: 34px; border-radius: 10px; display: grid; place-items: center;
  color: var(--accent); background: color-mix(in srgb, var(--accent) 14%, #fff); border: 1px solid color-mix(in srgb, var(--accent) 28%, #fff); }
.ag-txt { display: flex; flex-direction: column; min-width: 0; gap: 4px; line-height: 1.15; }
.ag-name { font-size: 14px; font-weight: 700; color: #0f172a; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ag-model { display: inline-flex; align-items: center; gap: 5px; font-size: 9px; font-family: monospace; text-transform: uppercase;
  letter-spacing: .06em; color: #94a3b8; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%; }
.ag-model i { flex: 0 0 auto; width: 5px; height: 5px; border-radius: 50%; }

/* Scène (bloc séparé, hauteur fixe, tout est contenu ici) */
.ag-scene { position: relative; height: 158px; overflow: hidden;
  background: radial-gradient(120% 80% at 50% -10%, color-mix(in srgb, var(--accent) 6%, #fff), #f8fafc 70%); }
.ag-scene::after { content: ""; position: absolute; left: 0; right: 0; bottom: 0; height: 46%;
  background-image: linear-gradient(#eef2f7 1px, transparent 1px); background-size: 100% 13px; opacity: .7; }

/* Bureau (haut) — descendu pour que l'écran noir soit entièrement visible sous l'en-tête */
.ag-desk { position: absolute; top: 32px; left: 50%; transform: translateX(-50%); width: 70px; height: 22px;
  background: #f1f5f9; border: 1px solid #e2e8f0; border-radius: 5px 5px 3px 3px; box-shadow: 0 6px 9px -7px rgba(15,23,42,.35); z-index: 1; }
.ag-mon { position: absolute; top: -21px; left: 50%; transform: translateX(-50%); width: 46px; height: 26px;
  background: #0f172a; border: 2px solid #1e293b; border-radius: 4px; overflow: hidden;
  box-shadow: 0 0 0 0 var(--accent); animation: ag-glow var(--dur) ease-in-out var(--delay) infinite both; }
.ag-mon-tk { position: absolute; top: 3px; left: 0; right: 0; text-align: center; font-family: monospace; font-weight: 800; font-size: 8px; color: #93c5fd; }
.ag-bars { position: absolute; bottom: 3px; left: 6px; right: 6px; height: 8px; display: flex; align-items: flex-end; gap: 2px; }
.ag-bars i { flex: 1; background: var(--accent); border-radius: 1px; height: 30%; animation: ag-bar 1.1s ease-in-out infinite; }
.ag-bars i:nth-child(2) { animation-delay: .2s; } .ag-bars i:nth-child(3) { animation-delay: .4s; }
@keyframes ag-bar { 0%,100%{ height: 25%; } 50%{ height: 90%; } }

/* Lit (bas) */
.ag-bed { position: absolute; bottom: 12px; left: 50%; transform: translateX(-50%); width: 76px; height: 26px;
  background: #f8fafc; border: 1px solid #e6ebf2; border-radius: 7px; box-shadow: inset 0 0 0 3px #fff; z-index: 1; }
.ag-pillow { position: absolute; top: 5px; left: 6px; width: 18px; height: 12px; background: #e2e8f0; border-radius: 3px; }

/* PNJ : avatar avec l'icône de l'agent, marche entre bureau et lit */
.ag-npc { position: absolute; top: 62px; left: 50%; transform: translateX(-50%); z-index: 3;
  animation: ag-walk var(--dur) ease-in-out var(--delay) infinite both; }
.ag-shadow { position: absolute; left: 50%; top: 30px; width: 30px; height: 8px; transform: translateX(-50%);
  background: radial-gradient(ellipse, rgba(15,23,42,.16), transparent 70%); }
.ag-av { position: absolute; left: 50%; top: 0; transform: translate(-50%, -50%); width: 34px; height: 34px; border-radius: 50%;
  display: grid; place-items: center; color: #fff;
  background: linear-gradient(150deg, color-mix(in srgb, var(--accent) 92%, #fff), var(--accent));
  border: 2px solid #fff; box-shadow: 0 5px 12px -3px color-mix(in srgb, var(--accent) 55%, transparent);
  animation: ag-bob .7s ease-in-out infinite; }

/* Légende "ce qu'il fait" — apparaît quand il bosse, sous le bureau */
.ag-task { position: absolute; top: 92px; left: 50%; transform: translateX(-50%); z-index: 4;
  max-width: 90%; text-align: center; font-size: 9px; line-height: 1.25; color: #64748b; opacity: 0;
  animation: ag-sigwork var(--dur) ease-in-out var(--delay) infinite both; }
.ag-task b { display: block; font-size: 10px; font-weight: 800; color: var(--accent); }

.ag-zzz { position: absolute; top: 96px; left: 58%; display: flex; gap: 2px; z-index: 4; opacity: 0;
  animation: ag-sigsleep var(--dur) ease-in-out var(--delay) infinite both; }
.ag-zzz span { font-size: 10px; font-weight: 800; color: #94a3b8; animation: ag-zfloat 1.8s ease-in-out infinite; }
.ag-zzz span:nth-child(2){ font-size: 12px; animation-delay: .25s; } .ag-zzz span:nth-child(3){ font-size: 14px; animation-delay: .5s; }
@keyframes ag-zfloat { 0%,100%{ transform: translateY(0); opacity:.5;} 50%{ transform: translateY(-4px); opacity:1;} }

/* Pastille d'état, coin haut-droit de la scène */
.ag-status { position: absolute; top: 8px; right: 8px; z-index: 5; font-size: 8.5px; font-weight: 700; letter-spacing: .02em;
  padding: 2px 7px; border-radius: 999px; }
.ag-status-work { color: #047857; background: #ecfdf5; border: 1px solid #a7f3d0; animation: ag-sigwork var(--dur) ease-in-out var(--delay) infinite both; }
.ag-status-sleep { color: #64748b; background: #f1f5f9; border: 1px solid #e2e8f0; opacity: 0; animation: ag-sigsleep var(--dur) ease-in-out var(--delay) infinite both; }

.ag-tip { position: absolute; top: 46px; left: 50%; transform: translateX(-50%); white-space: nowrap; z-index: 9;
  background: #0f172a; color: #fff; font-size: 10px; padding: 3px 8px; border-radius: 6px; box-shadow: 0 6px 14px -4px rgba(15,23,42,.5); }

/* ---- Cycles : a = bosse bcp (bureau ~60%), b = moyen (~44%), c = dort bcp (~26%) ---- */
/* variante par défaut = b */
@keyframes ag-walk { 0%,42%{ transform: translate(-50%,0);} 50%,92%{ transform: translate(-50%,var(--walk));} 100%{ transform: translate(-50%,0);} }
@keyframes ag-bob { 0%,100%{ transform: translate(-50%,-50%);} 50%{ transform: translate(-50%,-57%);} }
@keyframes ag-sigwork { 0%,42%{opacity:1;} 50%,100%{opacity:0;} }
@keyframes ag-sigsleep { 0%,52%{opacity:0;} 58%,90%{opacity:1;} 96%,100%{opacity:0;} }
@keyframes ag-glow { 0%,42%{ box-shadow: 0 0 14px -1px var(--accent); border-color: var(--accent);} 50%,100%{ box-shadow: 0 0 0 0 transparent; border-color: #1e293b;} }

.agv-a .ag-npc { animation-name: ag-walk-a; } .agv-a .ag-task, .agv-a .ag-status-work { animation-name: ag-sigwork-a; }
.agv-a .ag-zzz, .agv-a .ag-status-sleep { animation-name: ag-sigsleep-a; } .agv-a .ag-mon { animation-name: ag-glow-a; }
.agv-c .ag-npc { animation-name: ag-walk-c; } .agv-c .ag-task, .agv-c .ag-status-work { animation-name: ag-sigwork-c; }
.agv-c .ag-zzz, .agv-c .ag-status-sleep { animation-name: ag-sigsleep-c; } .agv-c .ag-mon { animation-name: ag-glow-c; }

@keyframes ag-walk-a { 0%,58%{ transform: translate(-50%,0);} 66%,94%{ transform: translate(-50%,var(--walk));} 100%{ transform: translate(-50%,0);} }
@keyframes ag-sigwork-a { 0%,56%{opacity:1;} 64%,100%{opacity:0;} }
@keyframes ag-sigsleep-a { 0%,64%{opacity:0;} 70%,92%{opacity:1;} 98%,100%{opacity:0;} }
@keyframes ag-glow-a { 0%,56%{ box-shadow: 0 0 14px -1px var(--accent); border-color: var(--accent);} 64%,100%{ box-shadow: 0 0 0 0 transparent; border-color: #1e293b;} }
@keyframes ag-walk-c { 0%,24%{ transform: translate(-50%,0);} 33%,92%{ transform: translate(-50%,var(--walk));} 100%{ transform: translate(-50%,0);} }
@keyframes ag-sigwork-c { 0%,24%{opacity:1;} 32%,100%{opacity:0;} }
@keyframes ag-sigsleep-c { 0%,34%{opacity:0;} 40%,90%{opacity:1;} 96%,100%{opacity:0;} }
@keyframes ag-glow-c { 0%,24%{ box-shadow: 0 0 14px -1px var(--accent); border-color: var(--accent);} 32%,100%{ box-shadow: 0 0 0 0 transparent; border-color: #1e293b;} }

.room-legend { display: flex; flex-wrap: wrap; gap: 10px 18px; margin-top: 18px; font-size: 11px; color: #64748b; }
.room-legend span { display: inline-flex; align-items: center; gap: 6px; }
.room-legend i { width: 11px; height: 11px; border-radius: 3px; }
.lg-work { background: #10b981; } .lg-sleep { background: #cbd5e1; }
.lg-flow { color: #94a3b8; }
@media (min-width: 640px) { .lg-flow { margin-left: auto; } }

@media (prefers-reduced-motion: reduce) {
  .ag-npc, .ag-task, .ag-zzz, .ag-status, .ag-mon, .ag-bars i, .room-live-dot { animation: none !important; }
  .ag-npc { transform: translate(-50%, 0); } .ag-task, .ag-status-work { opacity: 1; } .ag-status-sleep, .ag-zzz { opacity: 0; }
}
`;
