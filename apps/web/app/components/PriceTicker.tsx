'use client';

import { useState } from 'react';
import { NumberTicker } from '@/components/wensity/count-up-animation';

// A price that rolls to its new value, with a wash of accent behind it, when
// a bid lands. It starts AT the current value (no count-up from zero on first
// paint, which would briefly show a price that was never true); only later
// changes animate.
export function PriceTicker({ cents, className = '' }: { cents: number; className?: string }) {
  const [initialCents] = useState(cents);
  return (
    <span className={`figures relative inline-block ${className}`}>
      {/* Re-keyed per price so the flash replays on every change. */}
      {cents !== initialCents && <span key={cents} aria-hidden className="price-flash" />}
      <NumberTicker
        value={cents / 100}
        from={initialCents / 100}
        trigger="mount"
        duration={0.7}
        locales="en-US"
        format={{ style: 'currency', currency: 'USD' }}
        className="relative"
      />
    </span>
  );
}
