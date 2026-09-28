import { apiFetch } from './apiClient';
import type { Bid } from './types/auction';

export type PlaceBidResult = { bid: Bid; auctionExtended: boolean };

export function placeBidRequest(
  accessToken: string,
  auctionId: string,
  amountCents: number,
  idempotencyKey: string,
): Promise<PlaceBidResult> {
  return apiFetch<PlaceBidResult>(`/auctions/${auctionId}/bids`, {
    method: 'POST',
    body: { amountCents, idempotencyKey },
    accessToken,
  });
}
