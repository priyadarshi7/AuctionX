'use client';

import { useQuery } from '@tanstack/react-query';
import { getAuctionValuationRequest } from '@/lib/valuation';

export const valuationKey = (auctionId: string) => ['auctions', 'valuation', auctionId];

// Shared by the appraisal panel and the pricing form: one query key, so one
// request, and both update together.
export function useValuation(auctionId: string, accessToken: string) {
  return useQuery({
    queryKey: valuationKey(auctionId),
    queryFn: () => getAuctionValuationRequest(accessToken, auctionId),
    // Poll while the background worker is still on it; stop at COMPLETE or
    // FAILED.
    refetchInterval: (query) => (query.state.data?.valuation.status === 'PENDING' ? 1500 : false),
  });
}
