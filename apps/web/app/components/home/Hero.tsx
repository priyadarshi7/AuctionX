'use client';

import { IconArrowRight } from '@tabler/icons-react';
import Link from 'next/link';
import { TextScribble } from '@/components/wensity/text-scribble';
import { CATEGORY_DISPLAY } from '@/lib/categoryDisplay';
import { CONDITION_LABEL, lotRef } from '@/lib/lot';
import type { Auction } from '@/lib/types/auction';
import { PRICE_LABEL } from '../AuctionCard';
import { SaleClock } from '../Countdown';
import { Plate } from '../Plate';
import { PriceTicker } from '../PriceTicker';
import { ButtonLink } from '../ui/Button';
import { Skeleton } from '../ui/Page';
import { EmptySale } from './EmptySale';
import type { SaleState } from './useHomeSale';

const SALE_LINE: Record<SaleState, string> = {
  live: 'now open',
  upcoming: 'opening soon',
  closed: 'between sales',
  empty: 'being prepared',
};

const KICKER: Record<SaleState, string> = {
  live: 'Closing next',
  upcoming: 'Coming up',
  closed: 'Recently closed',
  empty: '',
};

// Live: the lot ending soonest. Otherwise the first photographed lot.
function pickFeature(lots: Auction[], state: SaleState): Auction | undefined {
  if (state === 'live') {
    return [...lots].sort((a, b) => new Date(a.endTime ?? 0).getTime() - new Date(b.endTime ?? 0).getTime())[0];
  }
  return lots.find((lot) => lot.images.length > 0) ?? lots[0];
}

function Spread({ lot, state }: { lot: Auction; state: SaleState }) {
  // Without a photograph the spread is set as type alone; an empty frame the
  // size of the page would say nothing.
  const photo = lot.images[0];
  return (
    <article
      className={`grid items-center gap-8 py-10 lg:gap-14 lg:py-14 ${photo ? 'lg:grid-cols-[1fr_0.85fr]' : ''}`}
    >
      <div className="order-2 min-w-0 lg:order-1">
        <p className="eyebrow">
          <span className="text-accent">{KICKER[state]}</span> · Lot {lotRef(lot.id)}
        </p>
        <h2 className="mt-4 text-4xl font-medium leading-[1.04] tracking-tight sm:text-6xl">
          <Link href={`/auctions/${lot.id}`} className="underline-offset-8 hover:underline">
            {lot.title}
          </Link>
        </h2>
        <p className="mt-4 font-serif text-lg italic text-muted-foreground">
          {CATEGORY_DISPLAY[lot.category].label} · Condition: {CONDITION_LABEL[lot.condition].toLowerCase()}
        </p>

        <div className="mt-8 flex flex-wrap items-end gap-x-12 gap-y-6 border-t border-border-strong pt-6">
          <div>
            <p className="eyebrow mb-2">{PRICE_LABEL[lot.status]}</p>
            <PriceTicker key={lot.id} cents={lot.currentPriceCents} className="text-5xl leading-none" />
          </div>
          {state === 'live' && (
            <div>
              <p className="eyebrow mb-2">Closes in</p>
              <SaleClock endTime={lot.endTime} />
            </div>
          )}
        </div>

        <div className="mt-8 flex flex-wrap gap-3">
          <ButtonLink href={`/auctions/${lot.id}`} className={state === 'live' ? 'btn-accent' : ''}>
            {state === 'live' ? 'Bid on this lot' : 'View this lot'}
            <IconArrowRight aria-hidden className="size-4" stroke={1.6} />
          </ButtonLink>
          <ButtonLink href="/auctions" variant="secondary">
            Open the catalogue
          </ButtonLink>
        </div>
      </div>

      {photo && (
        <Link href={`/auctions/${lot.id}`} tabIndex={-1} aria-hidden className="order-1 block lg:order-2">
          <Plate
            src={photo}
            alt=""
            eager
            ratio={1}
            className="mx-auto w-full max-w-md rotate-1 shadow-2xl transition-transform duration-500 hover:rotate-0"
          />
        </Link>
      )}
    </article>
  );
}

export function Hero({
  lots,
  state,
  loading,
  failed,
  signedIn,
  onHowSelling,
}: {
  lots: Auction[];
  state: SaleState;
  loading: boolean;
  failed: boolean;
  signedIn: boolean;
  onHowSelling: () => void;
}) {
  const feature = pickFeature(lots, state);

  return (
    <section className="mx-auto w-full max-w-6xl px-4 pt-10 sm:px-6">
      {/* Sale heading, set like the front of a catalogue. */}
      <header className="flex flex-wrap items-end justify-between gap-x-8 gap-y-3 border-b-2 border-foreground pb-5">
        <h1 className="text-3xl font-medium tracking-tight sm:text-4xl">
          The sale is{' '}
          {loading ? (
            <span className="italic text-muted-foreground">opening…</span>
          ) : (
            <TextScribble
              key={failed ? 'failed' : state}
              type="underline"
              color="var(--accent)"
              strokeWidth={2.5}
              className="italic"
            >
              {failed ? 'out of reach' : SALE_LINE[state]}
            </TextScribble>
          )}
        </h1>
        <p className="max-w-sm text-sm leading-6 text-muted-foreground">
          Rare things, sold by open bidding. Every bid is checked by the server, and a late bid extends the clock.
        </p>
      </header>

      {loading && (
        <div className="grid gap-10 py-14 lg:grid-cols-[1fr_0.85fr]" aria-busy="true">
          <div className="flex flex-col gap-5">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-32 w-full" />
            <Skeleton className="h-24 w-3/4" />
          </div>
          <Skeleton className="mx-auto aspect-square w-full max-w-md" />
        </div>
      )}

      {!loading && feature && <Spread lot={feature} state={state} />}

      {/* A failed request is not an empty saleroom: the list below shows the
          error and a retry button, so nothing is claimed here. */}
      {!loading && !failed && !feature && <EmptySale signedIn={signedIn} onHowSelling={onHowSelling} />}
    </section>
  );
}
