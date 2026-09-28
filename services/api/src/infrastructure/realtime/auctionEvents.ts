import { invalidateAuctionCache } from '../redis/auctionCache';
import { broadcastToAuction } from '../websocket/gateway';

export type AuctionChangeReason = 'bid' | 'lifecycle';

// The single place both domain modules (`bids`, `auctions`) call after a
// write commits, instead of each calling `invalidateAuctionCache` and
// `broadcastToAuction` separately. These two operations are conceptually one
// thing — "something about this auction changed, so the cached read is
// stale and any live watcher should refetch" — and keeping them paired here
// means a future new mutation site can't add cache invalidation while
// forgetting to notify watchers (or vice versa).
//
// Invalidate BEFORE broadcasting, not after: a client that reacts to the
// broadcast by immediately refetching over REST must not be able to land on
// the now-stale cache entry in the (very short, 5s TTL) window before
// invalidation would otherwise have run.
//
// The WebSocket payload itself carries no auction data, only a signal to
// refetch — see gateway.ts's module comment and ADR-0021 for why: REST
// remains the single place auction data is serialized and visibility rules
// (ADR-0008) are enforced, so this never has to keep a second payload shape
// in sync with it.
export async function notifyAuctionChanged(auctionId: string, reason: AuctionChangeReason): Promise<void> {
  await invalidateAuctionCache(auctionId);
  broadcastToAuction(auctionId, { type: 'auction.changed', auctionId, reason });
}
