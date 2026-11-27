'use client';

import { formatCents } from '@/lib/format';
import { PriceRuler } from './PriceRuler';
import { useValuation } from './useValuation';

// Round to a price a person would type.
function tidy(cents: number): number {
  const step = cents >= 20_000 ? 500 : 100;
  return Math.max(100, Math.round(cents / step) * step);
}

export type Strategy = { id: string; name: string; note: string; startCents: number; reserveCents: number | null };

// Rules of thumb computed here from the AI's range — not model output, and
// only ever a pre-fill the seller can overwrite.
export function strategiesFor(lowCents: number): Strategy[] {
  return [
    { id: 'open', name: 'Open low', note: 'Draws early bids', startCents: tidy(lowCents * 0.6), reserveCents: null },
    { id: 'fair', name: 'Balanced', note: "At the AI's low figure", startCents: tidy(lowCents), reserveCents: null },
    {
      id: 'safe',
      name: 'Protected',
      note: 'Opens low with a floor',
      startCents: tidy(lowCents * 0.7),
      reserveCents: tidy(lowCents),
    },
  ];
}

export function PriceGuide({
  auctionId,
  accessToken,
  startingCents,
  reserveCents,
  onPick,
}: {
  auctionId: string;
  accessToken: string;
  startingCents: number | null;
  reserveCents: number | null;
  onPick: (strategy: Strategy) => void;
}) {
  const { data } = useValuation(auctionId, accessToken);
  const valuation = data?.valuation;
  if (
    !valuation ||
    valuation.status !== 'COMPLETE' ||
    valuation.priceRangeLowCents === null ||
    valuation.priceRangeHighCents === null ||
    valuation.estimatedValueCents === null
  ) {
    return null;
  }
  const { priceRangeLowCents: low, priceRangeHighCents: high, estimatedValueCents: estimate } = valuation;

  const verdict = !startingCents
    ? 'Pick a starting point, or type your own price.'
    : startingCents > high
      ? `${Math.round((startingCents / high - 1) * 100)}% above the AI's high figure. Bids may not come.`
      : startingCents >= low
        ? "Inside the AI's range. Expect fewer, more serious bids."
        : `${Math.round((1 - startingCents / low) * 100)}% below the AI's low figure. Likely to attract early bids.`;

  return (
    <div className="mt-4 border-y border-border py-4">
      <p className="eyebrow">Price guide</p>
      <div role="group" aria-label="Suggested pricing" className="mt-2 grid gap-2 sm:grid-cols-3">
        {strategiesFor(low).map((strategy) => {
          const active = startingCents === strategy.startCents && reserveCents === strategy.reserveCents;
          return (
            <button
              key={strategy.id}
              type="button"
              aria-pressed={active}
              onClick={() => onPick(strategy)}
              className={`border p-3 text-left transition-colors ${
                active ? 'border-accent bg-accent-soft' : 'border-border-strong hover:border-accent'
              }`}
            >
              <span className="block text-xs font-medium">{strategy.name}</span>
              <span className="figures mt-1 block text-2xl leading-none">{formatCents(strategy.startCents)}</span>
              <span className="mt-1.5 block text-xs text-muted-foreground">
                {strategy.reserveCents ? `Reserve ${formatCents(strategy.reserveCents)}` : strategy.note}
              </span>
            </button>
          );
        })}
      </div>
      <div className="mt-4">
        <PriceRuler low={low} high={high} estimate={estimate} mine={startingCents} />
      </div>
      <p aria-live="polite" className="mt-2 font-serif text-base italic">
        {verdict}
      </p>
    </div>
  );
}
