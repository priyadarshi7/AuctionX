import { apiFetch } from './apiClient';
import type { Auction, AuctionCategory, AuctionStatus, Bid } from './types/auction';

export type ListAuctionsResult = { auctions: Auction[]; nextCursor: string | null };

// accessToken is optional: public browsing (WEB-001) never passes one —
// there's nothing to see as an anonymous visitor that DRAFT-hiding would
// even affect (ADR-0008). my-auctions (WEB-003) DOES pass one, alongside
// `sellerId` set to the caller's own id, specifically so the backend's
// `canSeeDraftsFor` check recognizes the caller as the owner and includes
// their own DRAFT auctions — the one case where hiding DRAFT would hide the
// seller's own data from themselves.
export function listAuctionsRequest(params: {
  category?: AuctionCategory;
  status?: AuctionStatus;
  sellerId?: string;
  cursor?: string;
  limit?: number;
  accessToken?: string | null;
}): Promise<ListAuctionsResult> {
  return apiFetch<ListAuctionsResult>('/auctions', {
    query: {
      category: params.category,
      status: params.status,
      sellerId: params.sellerId,
      cursor: params.cursor,
      limit: params.limit,
    },
    accessToken: params.accessToken,
  });
}

export function getAuctionRequest(id: string): Promise<{ auction: Auction }> {
  return apiFetch<{ auction: Auction }>(`/auctions/${id}`);
}

export function listBidsRequest(auctionId: string, limit = 20): Promise<{ bids: Bid[] }> {
  return apiFetch<{ bids: Bid[] }>(`/auctions/${auctionId}/bids`, { query: { limit } });
}

export type CreateAuctionPayload = {
  title: string;
  description: string;
  category: AuctionCategory;
  condition: Auction['condition'];
  startingPriceCents: number;
  reservePriceCents?: number;
  images?: string[];
};

export function createAuctionRequest(
  accessToken: string,
  payload: CreateAuctionPayload,
): Promise<{ auction: Auction }> {
  return apiFetch<{ auction: Auction }>('/auctions', { method: 'POST', body: payload, accessToken });
}

export type UpdateAuctionPayload = Partial<{
  startingPriceCents: number;
  reservePriceCents: number | null;
}>;

// Only DRAFT auctions are editable (modules/auctions/service.ts) — used
// here to set the real price after the seller has seen the AI valuation
// (app/auctions/[id]/SetPriceAndPublishPanel.tsx), since the create form no
// longer collects price up front.
export function updateAuctionRequest(
  accessToken: string,
  auctionId: string,
  payload: UpdateAuctionPayload,
): Promise<{ auction: Auction }> {
  return apiFetch<{ auction: Auction }>(`/auctions/${auctionId}`, { method: 'PATCH', body: payload, accessToken });
}

export function publishAuctionRequest(
  accessToken: string,
  auctionId: string,
  endTime: string,
): Promise<{ auction: Auction }> {
  return apiFetch<{ auction: Auction }>(`/auctions/${auctionId}/publish`, {
    method: 'POST',
    body: { endTime },
    accessToken,
  });
}

export function startAuctionRequest(accessToken: string, auctionId: string): Promise<{ auction: Auction }> {
  return apiFetch<{ auction: Auction }>(`/auctions/${auctionId}/start`, { method: 'POST', accessToken });
}

export function pauseAuctionRequest(accessToken: string, auctionId: string): Promise<{ auction: Auction }> {
  return apiFetch<{ auction: Auction }>(`/auctions/${auctionId}/pause`, { method: 'POST', accessToken });
}

export function cancelAuctionRequest(accessToken: string, auctionId: string): Promise<{ auction: Auction }> {
  return apiFetch<{ auction: Auction }>(`/auctions/${auctionId}/cancel`, { method: 'POST', accessToken });
}
