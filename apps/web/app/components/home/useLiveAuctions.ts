'use client';

import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { listAuctionsRequest } from '@/lib/auctions';
import type { AuctionCategory } from '@/lib/types/auction';

// One hook for both the hero spotlight (no category) and the filtered live
// grid: the same query key for the unfiltered case means React Query
// dedupes them into a single request. Refetches every 15s so the grid stays
// fresh without a WebSocket on the home page; keepPreviousData avoids a
// blank flash when the category changes.
export function useLiveAuctions(category: AuctionCategory | '') {
  return useQuery({
    queryKey: ['auctions', 'list', 'home-active', category],
    queryFn: () => listAuctionsRequest({ status: 'ACTIVE', limit: 8, category: category || undefined }),
    placeholderData: keepPreviousData,
    refetchInterval: 15_000,
  });
}
