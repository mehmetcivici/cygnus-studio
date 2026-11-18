/** Mark: the Northern Cross asterism of the Cygnus constellation. */
export function LogoMark({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden className="cy-logo-mark">
      <defs>
        <linearGradient id="cy-logo-bg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#1b4f86" />
          <stop offset="1" stopColor="#0b2347" />
        </linearGradient>
      </defs>
      <rect x="0.5" y="0.5" width="31" height="31" rx="8" fill="url(#cy-logo-bg)" stroke="#4fc3ea" strokeOpacity="0.45" />
      <g stroke="#4fc3ea" strokeWidth="1.3" strokeLinecap="round" opacity="0.9">
        <path d="M16 5.5 L16 26.5" />
        <path d="M6.5 13.5 L16 15 L25.5 12" />
      </g>
      <g fill="#ffffff">
        <circle cx="16" cy="5.5" r="2.1" />
        <circle cx="16" cy="15" r="1.7" />
        <circle cx="16" cy="26.5" r="1.5" />
        <circle cx="6.5" cy="13.5" r="1.5" />
        <circle cx="25.5" cy="12" r="1.5" />
      </g>
    </svg>
  );
}
