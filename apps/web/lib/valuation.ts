import { apiFetch } from './apiClient';
import type { Comparable, Valuation } from './types/valuation';

// Optional: an API deployed before ADR-0046 does not send it.
export type ValuationResponse = { valuation: Valuation; comparables?: Comparable[] };

// Seller-only (ADR-0032) — the backend itself enforces ownership; this
// throws ApiError(403/404) via apiFetch for a non-owner, same as every
// other authenticated request in this app.
export function getAuctionValuationRequest(accessToken: string, auctionId: string): Promise<ValuationResponse> {
  return apiFetch<ValuationResponse>(`/auctions/${auctionId}/valuation`, { accessToken });
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
