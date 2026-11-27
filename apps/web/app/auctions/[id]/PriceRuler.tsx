import { formatCents } from '@/lib/format';

// The AI's range drawn as a rule, with its estimate and (optionally) the
// seller's own opening price marked on it.
export function PriceRuler({
  low,
  high,
  estimate,
  mine,
}: {
  low: number;
  high: number;
  estimate: number;
  mine?: number | null;
}) {
  // Leave room either side of the range, and stretch to include an outlying
  // price so its marker stays on the rule.
  const span = Math.max(high - low, estimate * 0.2, 100);
  const min = Math.max(0, Math.min(low - span * 0.35, mine ?? low));
  const max = Math.max(high + span * 0.35, mine ?? high);
  const at = (cents: number) => `${((cents - min) / (max - min)) * 100}%`;

  return (
    <div>
      <p className="sr-only">
        Estimated range {formatCents(low)} to {formatCents(high)}, estimate {formatCents(estimate)}
        {mine ? `, your opening price ${formatCents(mine)}` : ''}.
      </p>
      <div aria-hidden className="relative mx-1.5 h-14">
        <div className="absolute inset-x-0 top-7 h-px bg-border-strong" />
        <div className="absolute top-5 h-4 border-x-2 border-accent bg-accent-soft" style={{ left: at(low), width: `calc(${at(high)} - ${at(low)})` }} />
        <div className="absolute top-3.5 h-7 w-0.5 -translate-x-1/2 bg-foreground" style={{ left: at(estimate) }} />
        {mine ? (
          <div className="absolute top-0 -translate-x-1/2 text-center transition-[left] duration-300" style={{ left: at(mine) }}>
            <span className="eyebrow block leading-none text-accent!">You</span>
            <span className="mx-auto mt-1 block size-3 rotate-45 bg-accent" />
          </div>
        ) : null}
      </div>
      <div aria-hidden className="flex justify-between gap-3 text-xs text-muted-foreground">
        <span>Low {formatCents(low)}</span>
        <span>High {formatCents(high)}</span>
      </div>
    </div>
  );
}
