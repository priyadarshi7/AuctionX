'use client';

import Link from 'next/link';
import { CATEGORY_DISPLAY } from '@/lib/categoryDisplay';
import { formatCents } from '@/lib/format';
import type { Auction } from '@/lib/types/auction';
import { useTimeRemaining } from '@/lib/useTimeRemaining';
import { Mascot } from './Mascot';

// Only the fields this card actually renders — not the full Auction type —
// so the SAME component can render either a real Auction (browse/home) or a
// SearchAuctionResult (lib/search.ts's narrower OpenSearch-backed shape,
// ADR-0029), without an adapter fabricating fields neither source has.
type AuctionCardData = Pick<Auction, 'id' | 'title' | 'category' | 'status' | 'images' | 'currentPriceCents' | 'endTime'>;

export function AuctionCard({ auction }: { auction: AuctionCardData }) {
  const display = CATEGORY_DISPLAY[auction.category];
  const timeRemaining = useTimeRemaining(auction.status === 'ACTIVE' ? auction.endTime : null);

  return (
    <Link
      href={`/auctions/${auction.id}`}
      className="group flex flex-col overflow-hidden rounded-2xl border-2 border-ink bg-white shadow-hard-sm transition-transform hover:-translate-y-1 hover:shadow-hard"
    >
      <div className="relative aspect-square w-full overflow-hidden border-b-2 border-ink bg-cream-2">
        {auction.images[0] ? (
          // Storage domain isn't fixed yet (local s3mock vs. prod R2), so
          // next/image's remotePatterns can't be configured until
          // deployment (same constraint noted in auctions/new/page.tsx).
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={auction.images[0]}
            alt={auction.title}
            className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center">
            <Mascot className="h-20 w-20 opacity-70" />
          </div>
        )}
        <span className="absolute left-2 top-2 rounded-full border-2 border-ink bg-cream px-2 py-0.5 text-xs font-semibold">
          {display.emoji} {display.label}
        </span>
        {auction.status === 'ACTIVE' && (
          <span className="absolute right-2 top-2 flex items-center gap-1 rounded-full border-2 border-ink bg-green px-2 py-0.5 text-xs font-semibold text-ink">
            <span className="h-1.5 w-1.5 rounded-full bg-ink" />
            {timeRemaining}
          </span>
        )}
      </div>

      <div className="flex flex-1 flex-col gap-2 p-3">
        <p className="line-clamp-2 font-display text-base font-bold leading-tight">{auction.title}</p>
        <div className="mt-auto flex items-end justify-between">
          <div>
            <p className="text-[11px] uppercase tracking-wide text-ink/50">
              {auction.status === 'ACTIVE' ? 'Current bid' : 'Price'}
            </p>
            <p className="font-display text-lg font-extrabold">{formatCents(auction.currentPriceCents)}</p>
          </div>
        </div>
      </div>
    </Link>
  );
}
