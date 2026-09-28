import { apiFetch } from './apiClient';
import type { AuctionCategory, AuctionCondition, AuctionStatus } from './types/auction';

// Mirrors services/api/src/modules/search/repository.ts's AuctionDocument —
// deliberately a NARROWER shape than the full Auction type (types/auction.ts):
// this is exactly what the OpenSearch index actually stores (Section 25's
// derived read model), not a re-fetch of the full row. No
// reservePriceCents/startTime/endedAt/updatedAt — the search endpoint never
// had them to return.
export type SearchAuctionResult = {
  id: string;
  sellerId: string;
  title: string;
  description: string;
  category: AuctionCategory;
  condition: AuctionCondition;
  status: AuctionStatus;
  images: string[];
  startingPriceCents: number;
  currentPriceCents: number;
  createdAt: string;
  endTime: string | null;
};

export type SearchAuctionsResult = { total: number; results: SearchAuctionResult[] };

// page/limit, not a cursor — ADR-0029: the search index is a genuinely
// separate, simpler read path from the cursor-paginated /auctions browse
// endpoint (Section 39's "search may be eventually consistent and doesn't
// need the same rigor" reasoning extends to its pagination style too).
export function searchAuctionsRequest(params: {
  q?: string;
  category?: AuctionCategory;
  status?: AuctionStatus;
  minPriceCents?: number;
  maxPriceCents?: number;
  page?: number;
  limit?: number;
}): Promise<SearchAuctionsResult> {
  return apiFetch<SearchAuctionsResult>('/search/auctions', {
    query: {
      q: params.q || undefined,
      category: params.category,
      status: params.status,
      minPriceCents: params.minPriceCents,
      maxPriceCents: params.maxPriceCents,
      page: params.page,
      limit: params.limit,
    },
  });
}
