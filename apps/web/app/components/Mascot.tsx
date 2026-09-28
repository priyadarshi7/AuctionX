// A small reusable blob mascot (rounded body, dot eyes, blush cheeks, thin
// stick legs) — purely decorative, echoing the reference design's mascot
// character. Pure SVG (no image asset) so it inherits `color` and never
// needs a network request.
export function Mascot({ className, color = '#f5c94b' }: { className?: string; color?: string }) {
  return (
    <svg viewBox="0 0 120 130" fill="none" xmlns="http://www.w3.org/2000/svg" className={className}>
      {/* legs */}
      <line x1="40" y1="100" x2="34" y2="122" stroke="#14141a" strokeWidth="3" strokeLinecap="round" />
      <line x1="80" y1="100" x2="86" y2="122" stroke="#14141a" strokeWidth="3" strokeLinecap="round" />
      <circle cx="34" cy="122" r="3.5" fill="#14141a" />
      <circle cx="86" cy="122" r="3.5" fill="#14141a" />
      {/* arms */}
      <line x1="22" y1="70" x2="4" y2="80" stroke="#14141a" strokeWidth="3" strokeLinecap="round" />
      <line x1="98" y1="70" x2="116" y2="80" stroke="#14141a" strokeWidth="3" strokeLinecap="round" />
      <circle cx="4" cy="80" r="3.5" fill="#14141a" />
      <circle cx="116" cy="80" r="3.5" fill="#14141a" />
      {/* body */}
      <path
        d="M60 8C86 8 106 30 106 58C106 86 86 104 60 104C34 104 14 86 14 58C14 30 34 8 60 8Z"
        fill={color}
        stroke="#14141a"
        strokeWidth="3"
      />
      {/* blush */}
      <ellipse cx="34" cy="62" rx="7" ry="4" fill="#ff9fb8" opacity="0.8" />
      <ellipse cx="86" cy="62" rx="7" ry="4" fill="#ff9fb8" opacity="0.8" />
      {/* eyes */}
      <circle cx="46" cy="52" r="4" fill="#14141a" />
      <circle cx="74" cy="52" r="4" fill="#14141a" />
      {/* smile */}
      <path d="M50 68C54 73 66 73 70 68" stroke="#14141a" strokeWidth="3" strokeLinecap="round" fill="none" />
    </svg>
  );
}
