'use client';

import { useQueryClient, useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { listAuctionsRequest } from '@/lib/auctions';
import { useAuthStore } from '@/store/authStore';
import { AuctionRow } from './AuctionRow';

// A plain useQuery, not useInfiniteQuery (contrast with /auctions, WEB-001):
// the backend caps a page at 50 (schema.ts), and a seller's OWN listing
// count is expected to be far smaller than the public pool for the
// foreseeable future — adding pagination now would be solving a problem
// that doesn't exist yet (Section 62). Revisit if a seller with 50+
// listings ever shows up for real.
export default function MyAuctionsPage() {
  const router = useRouter();
  const status = useAuthStore((state) => state.status);
  const user = useAuthStore((state) => state.user);
  const accessToken = useAuthStore((state) => state.accessToken);
  const queryClient = useQueryClient();

  useEffect(() => {
    if (status === 'anonymous') {
      router.replace('/login');
    }
  }, [status, router]);

  const { data, isLoading, isError } = useQuery({
    queryKey: ['auctions', 'mine', user?.id],
    queryFn: () => listAuctionsRequest({ sellerId: user!.id, limit: 50, accessToken }),
    enabled: status === 'authenticated' && !!user,
  });

  if (status !== 'authenticated' || !user || !accessToken) {
    return (
      <main className="flex-1 p-6">
        <p className="text-gray-500">Loading…</p>
      </main>
    );
  }

  const invalidate = () => {
    // Broad, not surgical: an action here can change an auction that's
    // also cached under the public list/detail keys (WEB-001) and
    // CACHE-001's own server-side Redis cache already invalidates itself
    // independently on the backend — this just makes sure THIS browser
    // tab's TanStack Query cache doesn't keep showing a stale status after
    // a pause/cancel/start click. Correctness-cheap: worst case is a few
    // extra refetches, not a few missed ones.
    void queryClient.invalidateQueries({ queryKey: ['auctions'] });
  };

  const auctions = data?.auctions ?? [];

  return (
    <main className="mx-auto w-full max-w-3xl flex-1 p-6">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-semibold">My auctions</h1>
        <Link href="/auctions/new" className="text-sm underline hover:text-gray-600">
          Sell an item
        </Link>
      </div>

      {isLoading && <p className="text-gray-500">Loading…</p>}
      {isError && <p className="text-red-600">Failed to load your auctions.</p>}
      {!isLoading && !isError && auctions.length === 0 && (
        <p className="text-gray-500">
          You haven&apos;t created any auctions yet.{' '}
          <Link href="/auctions/new" className="underline">
            Create one
          </Link>
          .
        </p>
      )}

      <ul className="flex flex-col gap-3">
        {auctions.map((auction) => (
          <AuctionRow key={auction.id} auction={auction} accessToken={accessToken} onChanged={invalidate} />
        ))}
      </ul>
    </main>
  );
}
