// Aether logo — "A" peak + growth arrow (refonte 25/06).
// 2 tons : A ardoise, flèche dégradé bleu (cohérent avec bg-brand-gradient).

export function Logo({ size = 28, className = "" }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 120 120"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      role="img"
      aria-label="Aether"
    >
      <defs>
        <linearGradient id="aetherArrow" x1="16" y1="96" x2="116" y2="36" gradientUnits="userSpaceOnUse">
          <stop stopColor="#60a5fa" />
          <stop offset="0.55" stopColor="#2563eb" />
          <stop offset="1" stopColor="#1e3a8a" />
        </linearGradient>
      </defs>
      {/* A — pic plein avec contre-forme en V */}
      <path d="M60 17 L99 103 L80 103 L60 62 L40 103 L21 103 Z" fill="#0f172a" />
      {/* Flèche de croissance — swoosh ascendant */}
      <path
        d="M16 97 C 47 88, 85 87, 104 49"
        stroke="url(#aetherArrow)"
        strokeWidth="12"
        strokeLinecap="round"
        fill="none"
      />
      {/* Pointe de flèche */}
      <path d="M110 34 L116 58 L93 49 Z" fill="#1e3a8a" />
    </svg>
  );
}
