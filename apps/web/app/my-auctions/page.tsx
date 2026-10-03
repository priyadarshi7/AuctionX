'use client';

import { useQueryClient, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { listAuctionsRequest } from '@/lib/auctions';
import type { AuctionStatus } from '@/lib/types/auction';
import { useRequireAuth } from '@/lib/useRequireAuth';
import { ButtonLink } from '../components/ui/Button';
import { PageHeader, PageLoading, PageMessage, Skeleton } from '../components/ui/Page';
import { AuctionRow } from './AuctionRow';

type Filter = 'ALL' | 'LIVE' | 'DRAFTS' | 'DONE';

const FILTERS: { id: Filter; label: string; match: (s: AuctionStatus) => boolean }[] = [
  { id: 'ALL', label: 'All', match: () => true },
  { id: 'LIVE', label: 'Live', match: (s) => s === 'ACTIVE' || s === 'PAUSED' || s === 'PUBLISHED' },
  { id: 'DRAFTS', label: 'Drafts', match: (s) => s === 'DRAFT' },
  { id: 'DONE', label: 'Ended', match: (s) => s === 'ENDED' || s === 'CANCELLED' },
];

// A plain useQuery, not useInfiniteQuery (contrast with /auctions, WEB-001):
// the backend caps a page at 50 (schema.ts), and a seller's OWN listing
// count is expected to be far smaller than the public pool for the
// foreseeable future — adding pagination now would be solving a problem
// that doesn't exist yet (Section 62). Revisit if a seller with 50+
// listings ever shows up for real.
export default function MyAuctionsPage() {
  const auth = useRequireAuth();
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState<Filter>('ALL');

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['auctions', 'mine', auth.user?.id],
    queryFn: () => listAuctionsRequest({ sellerId: auth.user!.id, limit: 50, accessToken: auth.accessToken }),
    enabled: auth.ready,
  });

  if (!auth.ready) {
    return <PageLoading />;
  }

  const invalidate = () => {
    // Broad, not surgical: an action here can change an auction that's
    // also cached under the public list/detail keys (WEB-001) and
    // CACHE-001's own server-side Redis cache already invalidates itself
    // independently on the backend — this just makes sure THIS browser
    // tab's TanStack Query cache doesn't keep showing a stale status after
    // a pause/cancel/start click.
    void queryClient.invalidateQueries({ queryKey: ['auctions'] });
  };

  const all = data?.auctions ?? [];
  const active = FILTERS.find((f) => f.id === filter)!;
  const visible = all.filter((a) => active.match(a.status));

  return (
    <main className="mx-auto w-full max-w-4xl flex-1 px-6 py-10">
      <PageHeader
        title="My auctions"
        subtitle="Everything you're selling, in one place."
        action={<ButtonLink href="/auctions/new">Sell an item</ButtonLink>}
      />

      <div role="tablist" aria-label="Filter my auctions" className="mb-6 flex flex-wrap gap-2">
        {FILTERS.map((f) => {
          const count = all.filter((a) => f.match(a.status)).length;
          const selected = filter === f.id;
          return (
            <button
              key={f.id}
              type="button"
              role="tab"
              aria-selected={selected}
              onClick={() => setFilter(f.id)}
              className={`rounded-full border-2 border-line px-4 py-1.5 text-sm font-semibold transition-colors ${
                selected ? 'bg-ink text-cream' : 'bg-white hover:bg-cream-2'
              }`}
            >
              {f.label}
              {!isLoading && <span className={`ml-1.5 ${selected ? 'text-cream/70' : 'text-ink/60'}`}>{count}</span>}
            </button>
          );
        })}
      </div>

      {isLoading && (
        <ul className="flex flex-col gap-3" aria-busy="true">
          {[0, 1, 2].map((i) => (
            <li key={i}>
              <Skeleton className="h-28 w-full" />
            </li>
          ))}
        </ul>
      )}

      {isError && (
        <PageMessage
          title="Couldn't load your auctions"
          body="Check your connection and try again."
          action={
            <button
              type="button"
              onClick={() => void refetch()}
              className="rounded-full border-2 border-line bg-white px-5 py-2 text-sm font-semibold shadow-hard-sm"
            >
              Try again
            </button>
          }
        />
      )}

      {!isLoading && !isError && visible.length === 0 && (
        <PageMessage
          mascotColor="#f5c94b"
          title={all.length === 0 ? 'You haven’t listed anything yet' : `No ${active.label.toLowerCase()} auctions`}
          body={
            all.length === 0
              ? 'List your first item and it can be live in about a minute.'
              : 'Try a different filter to see the rest.'
          }
          action={all.length === 0 ? <ButtonLink href="/auctions/new">Create an auction</ButtonLink> : undefined}
        />
      )}

      <ul className="flex flex-col gap-3">
        {visible.map((auction) => (
          <AuctionRow key={auction.id} auction={auction} accessToken={auth.accessToken} onChanged={invalidate} />
        ))}
      </ul>
    </main>
  );
}
