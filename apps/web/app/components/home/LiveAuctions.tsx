'use client';

import { IconGavel, IconPlugConnectedX } from '@tabler/icons-react';
import Link from 'next/link';
import { CATEGORY_DISPLAY } from '@/lib/categoryDisplay';
import type { AuctionCategory } from '@/lib/types/auction';
import { CategoryFilter } from '../CategoryFilter';
import { LotLedger } from '../LotLedger';
import { Button, ButtonLink } from '../ui/Button';
import { PageMessage, Skeleton } from '../ui/Page';
import { useHomeSale, type SaleState } from './useHomeSale';

const HEADING: Record<SaleState, { title: string; note: string }> = {
  live: { title: 'Order of sale', note: 'Live lots, soonest to close first. Refreshes by itself.' },
  upcoming: { title: 'Upcoming lots', note: 'Nothing is open for bidding yet. These are next.' },
  closed: { title: 'Past lots', note: 'Nothing is open right now. Here is what closed most recently.' },
  empty: { title: 'Order of sale', note: 'No lots in this department yet.' },
};

export function LiveAuctions({
  category,
  onCategoryChange,
}: {
  category: AuctionCategory | '';
  onCategoryChange: (category: AuctionCategory | '') => void;
}) {
  const sale = useHomeSale(category);
  const { title, note } = HEADING[sale.state];
  const lots =
    sale.state === 'live'
      ? [...sale.lots].sort((a, b) => new Date(a.endTime ?? 0).getTime() - new Date(b.endTime ?? 0).getTime())
      : sale.lots;

  return (
    <section id="live" className="mx-auto w-full max-w-6xl scroll-mt-24 px-4 py-14 sm:px-6">
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-3xl font-medium tracking-tight">{title}</h2>
          <p className="mt-1 text-sm text-muted-foreground" aria-live="polite">
            {sale.isLoading ? 'Checking the saleroom…' : note}
          </p>
        </div>
        <Link href="/auctions" className="eyebrow border-b border-foreground pb-0.5 text-foreground hover:text-accent">
          Full catalogue
        </Link>
      </div>

      <CategoryFilter
        value={category}
        onChange={onCategoryChange}
        label="Filter lots by department"
        className="mb-6"
      />

      {sale.isError && (
        <PageMessage
          icon={IconPlugConnectedX}
          title="Couldn't load the lots"
          body="Check your connection and try again."
          action={
            <Button variant="secondary" size="sm" onClick={sale.refetch}>
              Try again
            </Button>
          }
        />
      )}

      {sale.isLoading && (
        <div className="flex flex-col gap-3" aria-busy="true">
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="h-20 w-full" />
          ))}
        </div>
      )}

      {!sale.isLoading && !sale.isError && lots.length === 0 && (
        <PageMessage
          icon={IconGavel}
          title={category ? `No lots in ${CATEGORY_DISPLAY[category].label}` : 'The catalogue is empty'}
          body="New lots are added all the time. You can also list one yourself."
          action={
            <div className="flex flex-wrap justify-center gap-2">
              {category && (
                <Button variant="secondary" size="sm" onClick={() => onCategoryChange('')}>
                  All departments
                </Button>
              )}
              <ButtonLink href="/auctions/new" size="sm">
                Sell an item
              </ButtonLink>
            </div>
          }
        />
      )}

      {!sale.isError && lots.length > 0 && (
        <LotLedger auctions={lots} className={sale.isStale ? 'opacity-50' : ''} />
      )}
    </section>
  );
}
