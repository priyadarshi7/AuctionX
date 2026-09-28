import { CATEGORY_DISPLAY, CATEGORY_ORDER } from '@/lib/categoryDisplay';

// Decorative ticker of the real category list. The second copy is
// aria-hidden so screen readers hear each category once; the animation
// pauses on hover and is disabled under prefers-reduced-motion.
export function Marquee() {
  const items = CATEGORY_ORDER.map((c) => CATEGORY_DISPLAY[c]);
  const row = (hidden: boolean) => (
    <ul aria-hidden={hidden || undefined} className="flex shrink-0 items-center gap-8 pr-8">
      {items.map((item) => (
        <li key={item.label} className="flex items-center gap-3 font-display text-lg font-extrabold uppercase tracking-tight">
          <span aria-hidden>{item.emoji}</span>
          {item.label}
          <span aria-hidden className="text-yellow">
            &#9733;
          </span>
        </li>
      ))}
    </ul>
  );

  return (
    <div className="marquee overflow-hidden border-b-2 border-ink bg-ink py-3 text-cream">
      <div className="marquee-track flex w-max">
        {row(false)}
        {row(true)}
      </div>
    </div>
  );
}
