'use client';

import Link from 'next/link';
import { CATEGORY_DISPLAY } from '@/lib/categoryDisplay';
import { formatCents } from '@/lib/format';
import { lotRef } from '@/lib/lot';
import type { Auction } from '@/lib/types/auction';
import { Countdown } from './Countdown';
import { Plate } from './Plate';

// Only the fields this card actually renders — not the full Auction type —
// so the SAME component can render either a real Auction (browse/home) or a
// SearchAuctionResult (lib/search.ts's narrower OpenSearch-backed shape,
// ADR-0029), without an adapter fabricating fields neither source has.
export type AuctionCardData = Pick<
  Auction,
  'id' | 'title' | 'category' | 'status' | 'images' | 'currentPriceCents' | 'endTime'
>;

export const PRICE_LABEL: Record<Auction['status'], string> = {
  DRAFT: 'Price',
  PENDING_REVIEW: 'Price',
  PUBLISHED: 'Opens at',
  ACTIVE: 'Current bid',
  PAUSED: 'Current bid',
  CANCELLED: 'Last price',
  ENDED: 'Closing price',
};

export const STATE_LABEL: Record<Auction['status'], string> = {
  DRAFT: 'Draft',
  PENDING_REVIEW: 'In review',
  PUBLISHED: 'Upcoming',
  ACTIVE: 'Live',
  PAUSED: 'Paused',
  CANCELLED: 'Withdrawn',
  ENDED: 'Closed',
};

// One catalogue entry: mounted plate, lot line, serif title, ruled figures.
export function AuctionCard({ auction }: { auction: AuctionCardData }) {
  const display = CATEGORY_DISPLAY[auction.category];
  const isActive = auction.status === 'ACTIVE';

  return (
    <Link href={`/auctions/${auction.id}`} className="group flex flex-col">
      <Plate
        src={auction.images[0]}
        alt={auction.title}
        ratio={1}
        className="transition-colors group-hover:border-foreground"
        imageClassName="transition-transform duration-700 ease-out group-hover:scale-[1.035]"
      />

      <p className="eyebrow mt-3 flex items-baseline justify-between gap-2">
        <span className="truncate">
          Lot {lotRef(auction.id)} · {display.label}
        </span>
      </p>
      <p className="mt-1.5 line-clamp-2 font-serif text-lg leading-snug underline-offset-4 group-hover:underline">
        {auction.title}
      </p>

      <div className="mt-auto pt-3">
        <div className="flex items-end justify-between gap-3 border-t border-border-strong pt-2">
          <div>
            <p className="text-[11px] text-muted-foreground">{PRICE_LABEL[auction.status]}</p>
            <p className="figures text-xl leading-tight">{formatCents(auction.currentPriceCents)}</p>
          </div>
          <div className="text-right">
            <p className="flex items-center justify-end gap-1.5 text-[11px] text-muted-foreground">
              {isActive && <span aria-hidden className="size-1.5 rounded-full bg-live" />}
              {isActive ? 'Closes in' : 'Status'}
            </p>
            {isActive ? (
              <Countdown endTime={auction.endTime} className="text-base leading-tight" />
            ) : (
              <p className="font-serif text-base italic leading-tight">{STATE_LABEL[auction.status]}</p>
            )}
          </div>
        </div>
      </div>
    </Link>
  );
}
