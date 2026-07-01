import type { ReactNode } from "react";
import { Logo } from "./logo";
import { NavPill } from "./nav-pill";
import { LogoutButton } from "./logout-button";

const NAV = [
  { href: "/", label: "Dashboard" },
  { href: "/desk", label: "Trading Floor" },
  { href: "/pipeline", label: "Pipeline" },
];

// En-tête partagé, responsive (nav qui ne déborde pas sur mobile), collant en haut.
export function SiteHeader({ active, subtitle, beat }: { active: string; subtitle: string; beat?: ReactNode }) {
  return (
    <header className="sticky top-0 z-30 border-b border-slate-200 bg-white/80 backdrop-blur supports-[backdrop-filter]:bg-white/65">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-2.5">
        <div className="flex items-center gap-2 min-w-0">
          <Logo size={26} />
          <span className="font-mono font-bold text-sm tracking-tight text-slate-900">AETHER</span>
          <span className="hidden sm:inline text-xs text-slate-300">|</span>
          <span className="hidden sm:inline text-xs text-slate-500 truncate">{subtitle}</span>
        </div>

        <div className="flex items-center gap-2 sm:gap-3 ml-auto">
          {beat}
          <nav className="flex items-center gap-1.5 -mx-1 px-1 overflow-x-auto no-scrollbar">
            {NAV.map((n) => (
              <NavPill key={n.href} href={n.href} active={active === n.href}>{n.label}</NavPill>
            ))}
          </nav>
          <LogoutButton />
        </div>
      </div>
    </header>
  );
}
