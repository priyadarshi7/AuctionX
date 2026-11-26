'use client';

import { IconPhoto } from '@tabler/icons-react';
import Link from 'next/link';
import { CATEGORY_DISPLAY } from '@/lib/categoryDisplay';
import { formatCents } from '@/lib/format';
import { lotRef } from '@/lib/lot';
import { PRICE_LABEL, STATE_LABEL, type AuctionCardData } from './AuctionCard';
import { Countdown } from './Countdown';

function Thumb({ src, className }: { src?: string; className: string }) {
  return src ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={src} alt="" loading="lazy" className={`object-cover ${className}`} />
  ) : (
    <span className={`flex items-center justify-center bg-surface-muted ${className}`}>
      <IconPhoto aria-hidden className="size-4 text-muted-foreground" stroke={1.2} />
    </span>
  );
}

function Row({ auction }: { auction: AuctionCardData }) {
  const isActive = auction.status === 'ACTIVE';
  return (
    <li className="border-b border-border">
      <Link
        href={`/auctions/${auction.id}`}
        className="group relative grid grid-cols-[3.5rem_1fr_auto] items-center gap-x-4 px-1 py-3 transition-colors hover:bg-accent-soft focus-visible:-outline-offset-2 sm:grid-cols-[4.5rem_3.5rem_1fr_9rem_7.5rem]"
      >
        <span className="eyebrow hidden sm:block">{lotRef(auction.id)}</span>
        <Thumb src={auction.images[0]} className="size-14" />

        <span className="min-w-0">
          <span className="line-clamp-2 font-serif text-lg leading-snug underline-offset-4 group-hover:underline sm:line-clamp-1 sm:text-xl">
            {auction.title}
          </span>
          <span className="block truncate text-xs text-muted-foreground">
            {CATEGORY_DISPLAY[auction.category].label}
            <span className="sm:hidden"> · Lot {lotRef(auction.id)}</span>
          </span>
        </span>

        {/* Enlarged plate that surfaces beside the row on hover (wide screens). */}
        {auction.images[0] && (
          <span
            aria-hidden
            className="plate pointer-events-none absolute right-72 top-1/2 z-10 hidden w-44 -translate-y-1/2 -rotate-2 scale-95 opacity-0 shadow-2xl transition-all duration-200 group-hover:scale-100 group-hover:opacity-100 lg:block"
          >
            <Thumb src={auction.images[0]} className="aspect-square w-full" />
          </span>
        )}

        <span className="text-right">
          <span className="block text-[11px] text-muted-foreground">{PRICE_LABEL[auction.status]}</span>
          <span className="figures block text-lg leading-tight sm:text-xl">
            {formatCents(auction.currentPriceCents)}
          </span>
          {/* On narrow screens the clock sits under the price. */}
          <span className="block sm:hidden">
            {isActive ? (
              <Countdown endTime={auction.endTime} className="text-sm" />
            ) : (
              <span className="text-xs italic text-muted-foreground">{STATE_LABEL[auction.status]}</span>
            )}
          </span>
        </span>

        <span className="hidden text-right sm:block">
          <span className="block text-[11px] text-muted-foreground">{isActive ? 'Closes in' : 'Status'}</span>
          {isActive ? (
            <Countdown endTime={auction.endTime} className="text-lg leading-tight" />
          ) : (
            <span className="block font-serif text-lg italic leading-tight">{STATE_LABEL[auction.status]}</span>
          )}
        </span>
      </Link>
    </li>
  );
}

// The ruled sale list: denser than the plates, for comparing price and time.
export function LotLedger({ auctions, className = '' }: { auctions: AuctionCardData[]; className?: string }) {
  return (
    <ul className={`border-t-2 border-foreground ${className}`}>
      {auctions.map((auction) => (
        <Row key={auction.id} auction={auction} />
      ))}
    </ul>
  );
}
