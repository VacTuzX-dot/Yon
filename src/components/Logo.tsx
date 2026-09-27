// The Yon mark: a file in flight on a marigold tile (src-tauri/app-icon.svg).
// Drawn in the 195,30 → 325,160 box; callers set viewBox or place it.
export function LogoShapes() {
  return (
    <>
      <rect x="195" y="30" width="130" height="130" rx="30" fill="#E8A317" />
      <path
        d="M206 114 L222 110M210 128 L226 124"
        stroke="#1E222B"
        strokeWidth="5"
        strokeLinecap="round"
        opacity="0.45"
      />
      <g transform="rotate(-18 262 97)">
        <path
          d="M246 66 H274 L288 80 V122 Q288 128 282 128 H246 Q240 128 240 122 V72 Q240 66 246 66 Z"
          fill="#1E222B"
        />
        <path d="M274 66 V80 H288 Z" fill="#4A5060" />
      </g>
    </>
  );
}
