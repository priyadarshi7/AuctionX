'use client';

import { useQuery } from '@tanstack/react-query';
import { listAuctionsRequest } from '@/lib/auctions';
import type { AuctionCategory, AuctionStatus } from '@/lib/types/auction';
import { useLiveAuctions } from './useLiveAuctions';

export type SaleState = 'live' | 'upcoming' | 'closed' | 'empty';

const FALLBACKS: { status: AuctionStatus; state: SaleState }[] = [
  { status: 'PUBLISHED', state: 'upcoming' },
  { status: 'ENDED', state: 'closed' },
];

// What the home page has to show. Live lots first; if there are none, the
// next best true thing (upcoming, then recently closed) rather than a blank
// page. The state travels with the lots so every heading can label them
// honestly. The fallback only runs once we know nothing is live.
export function useHomeSale(category: AuctionCategory | '') {
  const live = useLiveAuctions(category);
  const liveLots = live.data?.auctions ?? [];
  const needsFallback = live.isSuccess && liveLots.length === 0 && !live.isPlaceholderData;

  const fallback = useQuery({
    queryKey: ['auctions', 'list', 'home-fallback', category],
    queryFn: async () => {
      for (const { status, state } of FALLBACKS) {
        const { auctions } = await listAuctionsRequest({ status, limit: 8, category: category || undefined });
        if (auctions.length > 0) return { state, auctions };
      }
      return { state: 'empty' as SaleState, auctions: [] };
    },
    enabled: needsFallback,
    refetchInterval: 60_000,
  });

  const state: SaleState = needsFallback ? (fallback.data?.state ?? 'empty') : 'live';

  return {
    state,
    lots: needsFallback ? (fallback.data?.auctions ?? []) : liveLots,
    isLoading: live.isLoading || (needsFallback && fallback.isLoading),
    isError: live.isError || (needsFallback && fallback.isError),
    isStale: live.isPlaceholderData,
    refetch: () => {
      void live.refetch();
      if (needsFallback) void fallback.refetch();
    },
  };
}
