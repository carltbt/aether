import { cn, formatCurrency, formatNumber } from "@/lib/utils";
import { AgentIcon, type AgentIconName } from "./agent-icon";

export interface NodeStat { count: number; cost: number; avg_latency: number; }
export type PipelineStats = Record<string, NodeStat>;

const MODEL_BADGE: Record<string, string> = {
  Haiku: "bg-violet-50 text-violet-700 border-violet-200",
  Sonnet: "bg-blue-50 text-blue-700 border-blue-200",
  Code: "bg-slate-100 text-slate-500 border-slate-200",
};

function LlmNode({ title, subtitle, model, stat, accent, icon }: {
  title: string; subtitle: string; model: "Haiku" | "Sonnet"; stat?: NodeStat; accent?: boolean; icon: AgentIconName;
}) {
  return (
    <div className={cn(
      "relative bg-white border rounded-xl p-4 shadow-sm hover:shadow-md transition-shadow w-full",
      accent ? "border-slate-300" : "border-slate-200",
    )}>
      <div className="absolute left-0 top-3 bottom-3 w-1 rounded-full bg-brand-gradient" />
      <div className="pl-2">
        <div className="flex items-center justify-between gap-2">
          <span className="flex items-center gap-2 min-w-0">
            <span className="shrink-0 text-slate-400"><AgentIcon name={icon} size={15} /></span>
            <span className="font-semibold text-sm text-slate-900 truncate">{title}</span>
          </span>
          <span className={cn("text-[10px] font-mono font-bold uppercase px-1.5 py-0.5 rounded border shrink-0", MODEL_BADGE[model])}>{model}</span>
        </div>
        <div className="text-[11px] text-slate-400 mt-0.5">{subtitle}</div>
        {stat && (
          <div className="flex items-center gap-3 mt-2 text-[11px] text-slate-500 tabular">
            <span><b className="text-slate-900">{formatNumber(stat.count)}</b> appels</span>
            <span className="text-slate-300">·</span>
            <span>{formatCurrency(stat.cost)}</span>
            <span className="text-slate-300">·</span>
            <span>{(stat.avg_latency / 1000).toFixed(1)}s moy</span>
          </div>
        )}
      </div>
    </div>
  );
}

function CodeNode({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div className="bg-slate-50 border border-slate-200 border-dashed rounded-xl p-4 w-full">
      <div className="flex items-center justify-between gap-2">
        <span className="font-semibold text-sm text-slate-700">{title}</span>
        <span className={cn("text-[10px] font-mono font-bold uppercase px-1.5 py-0.5 rounded border shrink-0", MODEL_BADGE.Code)}>déterministe</span>
      </div>
      <div className="text-[11px] text-slate-400 mt-0.5">{subtitle}</div>
    </div>
  );
}

function StageLabel({ n, label }: { n: number; label: string }) {
  return (
    <div className="flex items-center gap-2 mb-2">
      <span className="flex items-center justify-center w-5 h-5 rounded-full bg-brand-gradient text-white text-[10px] font-bold">{n}</span>
      <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">{label}</span>
    </div>
  );
}

function Connector() {
  return (
    <div className="flex flex-col items-center py-1.5" aria-hidden>
      <div className="w-px h-5 bg-gradient-to-b from-slate-300 to-slate-200" />
      <div className="text-slate-300 text-xs leading-none -mt-1">▼</div>
    </div>
  );
}

export function PipelineMindmap({ stats }: { stats: PipelineStats }) {
  const totalCalls = Object.values(stats).reduce((s, v) => s + v.count, 0);
  const totalCost = Object.values(stats).reduce((s, v) => s + v.cost, 0);

  return (
    <section>
      {/* Summary banner */}
      <div className="bg-brand-gradient text-white rounded-xl px-6 py-5 mb-6">
        <div className="text-xs uppercase tracking-wider text-white/70">Pipeline de décision — 7 appels Claude par action</div>
        <div className="flex flex-wrap items-end gap-x-8 gap-y-2 mt-2">
          <div>
            <div className="text-3xl font-semibold tabular">{formatNumber(totalCalls)}</div>
            <div className="text-xs text-white/60">appels LLM cumulés</div>
          </div>
          <div>
            <div className="text-3xl font-semibold tabular">{formatCurrency(totalCost)}</div>
            <div className="text-xs text-white/60">coût total Anthropic</div>
          </div>
          <div className="text-xs text-white/70 max-w-md leading-relaxed">
            3 analystes (technique · sentiment · fondamentaux) → 2 researchers Bull/Bear isolés → Trader (Guided Mode) → Reviewer 3 perspectives → validation code → exécution Alpaca.
          </div>
        </div>
      </div>

      {/* Flow */}
      <div className="max-w-2xl mx-auto">
        <StageLabel n={1} label="Sélection de l'univers" />
        <CodeNode title="Screener hebdomadaire" subtitle="Univers mid-caps US $2B–$20B · Tech / Healthcare / Industrials / Consumer" />
        <Connector />

        <StageLabel n={2} label="Scoring quantitatif" />
        <CodeNode title="6 clusters pondérés → conviction" subtitle="C1 Earnings 25% · C2 Momentum 20% · C3 Smart Money 20% · C4 Quality 15% · C5 Valuation 10% · C6 News 10%" />
        <Connector />

        <StageLabel n={3} label="Analystes — 3 passes parallèles" />
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <LlmNode icon="chart" title="Technique" subtitle="RSI · MACD · ADX · setups" model="Haiku" stat={stats["analysis_pass1"]} />
          <LlmNode icon="news" title="Sentiment" subtitle="News · catalyseurs" model="Haiku" stat={stats["analysis_pass2"]} />
          <LlmNode icon="flask" title="Fondamentaux" subtitle="DCF · qualité · valorisation" model="Sonnet" stat={stats["analysis_pass3"]} />
        </div>
        <Connector />

        <StageLabel n={4} label="Researchers — débat isolé" />
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <LlmNode icon="trendUp" title="Bull" subtitle="Meilleur argumentaire haussier" model="Sonnet" stat={stats["researcher_bull"]} />
          <LlmNode icon="trendDown" title="Bear" subtitle="Meilleur argumentaire baissier" model="Sonnet" stat={stats["researcher_bear"]} />
        </div>
        <Connector />

        <StageLabel n={5} label="Trader — décision finale" />
        <LlmNode icon="cpu" title="Trader (Guided Mode)" subtitle="Synthèse du débat → BUY / HOLD + sizing, stop, target" model="Sonnet" stat={stats["decision"]} accent />
        <Connector />

        <StageLabel n={6} label="Reviewer — contrôle qualité" />
        <LlmNode icon="scale" title="Reviewer (3 perspectives)" subtitle="Conservateur · Neutre · Agressif → veto si 2/3 REJECT" model="Sonnet" stat={stats["reviewer"]} accent />
        <Connector />

        <StageLabel n={7} label="Garde-fous & exécution" />
        <CodeNode title="Validation Couche 2 (code, sans LLM)" subtitle="Sizing · stop-loss · earnings 5j · concentration secteur · dédup ticker · VIX/cash réels" />
        <Connector />
        <CodeNode title="Exécution Alpaca (paper)" subtitle="Ordre bracket : entrée + stop-loss + take-profit" />
      </div>
    </section>
  );
}
