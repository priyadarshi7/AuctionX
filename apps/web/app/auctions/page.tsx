'use client';

import { useInfiniteQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { listAuctionsRequest } from '@/lib/auctions';
import { formatCategory, formatCents } from '@/lib/format';
import { AUCTION_CATEGORIES, type AuctionCategory } from '@/lib/types/auction';

export default function AuctionsPage() {
  const [category, setCategory] = useState<AuctionCategory | ''>('');

  // Maps directly onto the backend's keyset pagination (ADR-0008): each
  // page's nextCursor becomes the next page's cursor param. No offset math
  // anywhere on this side either — the same correctness reason applies to
  // a live "newest first" feed on the frontend as it did on the backend.
  const { data, fetchNextPage, hasNextPage, isFetchingNextPage, isLoading, isError } = useInfiniteQuery({
    queryKey: ['auctions', 'list', category],
    queryFn: ({ pageParam }: { pageParam: string | undefined }) =>
      listAuctionsRequest({ category: category || undefined, cursor: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  });

  const auctions = data?.pages.flatMap((page) => page.auctions) ?? [];

  return (
    <main className="mx-auto w-full max-w-4xl flex-1 p-6">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Auctions</h1>
        <select
          value={category}
          onChange={(event) => setCategory(event.target.value as AuctionCategory | '')}
          className="rounded border border-gray-300 px-3 py-2 text-sm"
        >
          <option value="">All categories</option>
          {AUCTION_CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {formatCategory(c)}
            </option>
          ))}
        </select>
      </div>

      {isLoading && <p className="text-gray-500">Loading…</p>}
      {isError && <p className="text-red-600">Failed to load auctions.</p>}
      {!isLoading && !isError && auctions.length === 0 && (
        <p className="text-gray-500">No auctions found.</p>
      )}

      <ul className="flex flex-col gap-3">
        {auctions.map((auction) => (
          <li key={auction.id}>
            <Link
              href={`/auctions/${auction.id}`}
              className="flex items-center justify-between gap-4 rounded border border-gray-200 px-4 py-3 hover:border-gray-400"
            >
              <div className="flex items-center gap-3">
                {auction.images[0] && (
                  // Storage domain isn't fixed yet (local s3mock vs. prod
                  // R2), so next/image's remotePatterns can't be configured
                  // until deployment — see app/auctions/new/page.tsx's comment.
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={auction.images[0]}
                    alt=""
                    className="h-14 w-14 shrink-0 rounded border border-gray-200 object-cover"
                  />
                )}
                <div>
                  <p className="font-medium">{auction.title}</p>
                  <p className="text-sm text-gray-500">
                    {formatCategory(auction.category)} · {auction.status}
                  </p>
                </div>
              </div>
              <p className="font-semibold">{formatCents(auction.currentPriceCents)}</p>
            </Link>
          </li>
        ))}
      </ul>

      {hasNextPage && (
        <button
          type="button"
          onClick={() => fetchNextPage()}
          disabled={isFetchingNextPage}
          className="mt-4 rounded border border-gray-300 px-4 py-2 text-sm disabled:opacity-50"
        >
          {isFetchingNextPage ? 'Loading…' : 'Load more'}
        </button>
      )}
    </main>
  );
}
