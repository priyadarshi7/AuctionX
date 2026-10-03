import { apiFetch } from './apiClient';
import type { Bid } from './types/auction';

export type PlaceBidResult = { bid: Bid; auctionExtended: boolean };

// A bid shown in the history the instant the user clicks, before the server
// has accepted it (ADR-0037). The id can never collide with a real bid's
// (those are UUIDs), and is replaced wholesale when the server's real list
// arrives.
const OPTIMISTIC_BID_ID_PREFIX = 'optimistic-';

export function makeOptimisticBid(
  auctionId: string,
  bidderId: string,
  amountCents: number,
  idempotencyKey: string,
): Bid {
  return {
    id: `${OPTIMISTIC_BID_ID_PREFIX}${idempotencyKey}`,
    auctionId,
    bidderId,
    amountCents,
    idempotencyKey,
    createdAt: new Date().toISOString(),
  };
}

export function isOptimisticBid(bid: Bid): boolean {
  return bid.id.startsWith(OPTIMISTIC_BID_ID_PREFIX);
}

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
