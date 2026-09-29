import { apiFetch } from './apiClient';
import type { Valuation } from './types/valuation';

// Seller-only (ADR-0032) — the backend itself enforces ownership; this
// throws ApiError(403/404) via apiFetch for a non-owner, same as every
// other authenticated request in this app.
export function getAuctionValuationRequest(accessToken: string, auctionId: string): Promise<{ valuation: Valuation }> {
  return apiFetch<{ valuation: Valuation }>(`/auctions/${auctionId}/valuation`, { accessToken });
}

export function regenerateAuctionValuationRequest(
  accessToken: string,
  auctionId: string,
): Promise<{ valuation: Valuation }> {
  return apiFetch<{ valuation: Valuation }>(`/auctions/${auctionId}/valuation/regenerate`, {
    method: 'POST',
    accessToken,
  });
}
