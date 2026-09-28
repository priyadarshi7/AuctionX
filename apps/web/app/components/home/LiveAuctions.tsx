'use client';

import Link from 'next/link';
import { CATEGORY_DISPLAY, CATEGORY_ORDER, THEME_CLASSES } from '@/lib/categoryDisplay';
import type { AuctionCategory } from '@/lib/types/auction';
import { AuctionCard } from '../AuctionCard';
import { AuctionCardSkeleton } from '../AuctionCardSkeleton';
import { Mascot } from '../Mascot';
import { useLiveAuctions } from './useLiveAuctions';

export function LiveAuctions({
  category,
  onCategoryChange,
}: {
  category: AuctionCategory | '';
  onCategoryChange: (category: AuctionCategory | '') => void;
}) {
  const query = useLiveAuctions(category);
  const auctions = query.data?.auctions ?? [];
  const label = category ? CATEGORY_DISPLAY[category].label : 'every category';

  return (
    <section id="live" className="scroll-mt-20 border-y-2 border-ink bg-cream-2 py-16">
      <div className="mx-auto max-w-6xl px-6">
        <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="font-display text-3xl font-extrabold sm:text-4xl">Live right now</h2>
            <p className="mt-1 text-ink/60" aria-live="polite">
              {query.isSuccess ? `${auctions.length} live in ${label}, refreshing automatically.` : 'Checking the floor…'}
            </p>
          </div>
          <Link href="/auctions" className="text-sm font-semibold underline underline-offset-4">
            Browse all auctions
          </Link>
        </div>

        <div
          role="group"
          aria-label="Filter live auctions by category"
          className="-mx-6 mb-8 flex gap-2 overflow-x-auto px-6 pb-2"
        >
          <button
            type="button"
            aria-pressed={category === ''}
            onClick={() => onCategoryChange('')}
            className={`shrink-0 rounded-full border-2 border-ink px-4 py-1.5 text-sm font-semibold transition-colors ${
              category === '' ? 'bg-ink text-cream' : 'bg-white hover:bg-cream'
            }`}
          >
            All
          </button>
          {CATEGORY_ORDER.map((c) => {
            const display = CATEGORY_DISPLAY[c];
            const theme = THEME_CLASSES[display.theme];
            const active = category === c;
            return (
              <button
                key={c}
                type="button"
                aria-pressed={active}
                onClick={() => onCategoryChange(active ? '' : c)}
                className={`shrink-0 rounded-full border-2 border-ink px-4 py-1.5 text-sm font-semibold transition-colors ${
                  active ? `${theme.bg} ${theme.text}` : 'bg-white hover:bg-cream'
                }`}
              >
                {display.emoji} {display.label}
              </button>
            );
          })}
        </div>

        {query.isError && (
          <div className="flex flex-col items-center gap-3 rounded-2xl border-2 border-dashed border-ink/30 py-12 text-center">
            <p className="text-ink/70">Couldn&apos;t load live auctions.</p>
            <button
              type="button"
              onClick={() => void query.refetch()}
              className="rounded-full border-2 border-ink bg-white px-5 py-2 text-sm font-semibold shadow-hard-sm transition-transform hover:-translate-y-0.5"
            >
              Try again
            </button>
          </div>
        )}

        {query.isLoading && (
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
            {Array.from({ length: 4 }, (_, i) => (
              <AuctionCardSkeleton key={i} />
            ))}
          </div>
        )}

        {query.isSuccess && auctions.length === 0 && (
          <div className="flex flex-col items-center gap-3 rounded-2xl border-2 border-dashed border-ink/30 py-12 text-center">
            <Mascot className="h-16 w-16" color="#ff5c8a" />
            <p className="text-ink/70">Nothing live in {label} this second.</p>
            <div className="flex gap-4 text-sm font-semibold">
              {category && (
                <button type="button" onClick={() => onCategoryChange('')} className="underline underline-offset-4">
                  Show all categories
                </button>
              )}
              <Link href="/auctions/new" className="underline underline-offset-4">
                Sell an item
              </Link>
            </div>
          </div>
        )}

        {auctions.length > 0 && (
          <div
            className={`grid grid-cols-2 gap-4 transition-opacity sm:grid-cols-3 lg:grid-cols-4 ${
              query.isPlaceholderData ? 'opacity-50' : ''
            }`}
          >
            {auctions.map((auction) => (
              <AuctionCard key={auction.id} auction={auction} />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
