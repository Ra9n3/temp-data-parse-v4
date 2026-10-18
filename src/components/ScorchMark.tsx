export function ScorchMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 64" className={className} aria-hidden>
      <defs>
        <linearGradient id="scorchFlame" x1="20" y1="58" x2="44" y2="8" gradientUnits="userSpaceOnUse">
          <stop stopColor="#fb7185" />
          <stop offset="0.45" stopColor="#f97316" />
          <stop offset="1" stopColor="#fbbf24" />
        </linearGradient>
      </defs>
      <rect width="64" height="64" rx="14" fill="#12141c" />
      <path
        fill="url(#scorchFlame)"
        d="M33 8c2 10-8 14-7 24 0 3 2 6 5 8-6-1-11 4-11 11 0 8 7 15 16 15 10 0 16-7 16-16 0-14-13-18-11-30-3 5-8 7-8-12z"
      />
      <path fill="#fff7ed" opacity="0.85" d="M34 36c1 4-2 6-1 10 2 0 5-3 5-7 0-3-2-5-4-3z" />
    </svg>
  );
}
