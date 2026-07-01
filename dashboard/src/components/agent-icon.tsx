// Icônes ligne (SVG, pas d'emoji) pour chaque agent. stroke = currentColor.
export type AgentIconName = "chart" | "news" | "flask" | "trendUp" | "trendDown" | "cpu" | "scale" | "bolt" | "warn";

export function AgentIcon({ name, size = 18, className = "" }: { name: AgentIconName; size?: number; className?: string }) {
  const common = {
    width: size, height: size, viewBox: "0 0 24 24", fill: "none",
    stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round" as const, strokeLinejoin: "round" as const,
    className, "aria-hidden": true,
  };
  switch (name) {
    case "chart": // barres (analyse technique)
      return (<svg {...common}><path d="M5 20V11" /><path d="M10 20V5" /><path d="M15 20V14" /><path d="M20 20V8" /></svg>);
    case "news": // journal (sentiment)
      return (<svg {...common}><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M7 9h7" /><path d="M7 13h10" /><path d="M7 16h6" /></svg>);
    case "flask": // bécher (fondamentaux)
      return (<svg {...common}><path d="M9 3h6" /><path d="M10 3v6l-5 8a2 2 0 0 0 1.7 3h10.6a2 2 0 0 0 1.7-3l-5-8V3" /><path d="M7 15h10" /></svg>);
    case "trendUp": // tendance haussière (bull)
      return (<svg {...common}><path d="M3 17l6-6 4 4 8-8" /><path d="M15 7h6v6" /></svg>);
    case "trendDown": // tendance baissière (bear)
      return (<svg {...common}><path d="M3 7l6 6 4-4 8 8" /><path d="M15 17h6v-6" /></svg>);
    case "cpu": // processeur (trader)
      return (<svg {...common}><rect x="6" y="6" width="12" height="12" rx="1.5" /><rect x="9.5" y="9.5" width="5" height="5" rx="1" /><path d="M9 3v3M15 3v3M9 18v3M15 18v3M3 9h3M3 15h3M18 9h3M18 15h3" /></svg>);
    case "scale": // balance (reviewer)
      return (<svg {...common}><path d="M12 4v16" /><path d="M6 8h12" /><path d="M6 8l-3 6a3 3 0 0 0 6 0z" /><path d="M18 8l-3 6a3 3 0 0 0 6 0z" /><path d="M8 20h8" /></svg>);
    case "bolt": // éclair (exécution Alpaca)
      return (<svg {...common} fill="currentColor" stroke="none"><path d="M13 2 4 14h6l-1 8 9-12h-6z" /></svg>);
    case "warn": // triangle d'alerte (erreurs)
      return (<svg {...common}><path d="M10.3 4 2.2 18a2 2 0 0 0 1.7 3h16.2a2 2 0 0 0 1.7-3L13.7 4a2 2 0 0 0-3.4 0z" /><path d="M12 9v4" /><path d="M12 17h.01" /></svg>);
    default: { // garde d'exhaustivité : tout nouveau membre d'AgentIconName casse la compil ici
      const _exhaustive: never = name;
      return _exhaustive ?? null;
    }
  }
}
