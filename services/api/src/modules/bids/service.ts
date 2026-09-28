import type { Bid } from '@prisma/client';
import { Prisma } from '@prisma/client';
import { notifyAuctionChanged } from '../../infrastructure/realtime/auctionEvents';
import { logger } from '../../infrastructure/observability/logger';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../../middleware/errors';
import { getAuctionForViewer, type RequestingUser } from '../auctions/service';
import {
  findBidByIdempotencyKey,
  listBidsForAuction,
  placeBidTransactionally,
  type LockedAuctionRow,
  type PlaceBidResult,
} from './repository';
import type { PlaceBidInput } from './schema';

// Runs INSIDE placeBidTransactionally's transaction, after the row lock —
// see repository.ts's comment on why. Every branch here is a real business
// rule, in the order Section 10's pipeline lists them: does the resource
// exist, is the caller allowed to act on it, is it in a state that accepts
// this action, is the specific value acceptable.
function assertBidIsAcceptable(
  auction: LockedAuctionRow | undefined,
  bidderId: string,
  amountCents: number,
): void {
  if (!auction) {
    throw new NotFoundError('Auction not found');
  }

  // Shill bidding: a seller must not be able to inflate their own price.
  if (auction.sellerId === bidderId) {
    throw new ForbiddenError('You cannot bid on your own auction');
  }

  if (auction.status !== 'ACTIVE') {
    throw new ConflictError(
      'AUCTION_NOT_ACTIVE',
      `This auction is ${auction.status}, not accepting bids`,
    );
  }

  // Belt-and-suspenders alongside the closing worker (ADR-0014): the worker
  // scans every SCAN_INTERVAL_MS, so a request landing in the gap between
  // "endTime passed" and "the worker's next tick" would otherwise be
  // accepted on a technically-expired auction. Reusing
  // AUCTION_SCHEDULE_EXPIRED (established for the `start` action, ADR-0010)
  // for the same underlying situation here, rather than inventing a
  // parallel code.
  if (auction.endTime && auction.endTime <= new Date()) {
    throw new ConflictError(
      'AUCTION_SCHEDULE_EXPIRED',
      "This auction's scheduled end time has already passed",
    );
  }

  if (amountCents <= auction.currentPriceCents) {
    throw new ValidationError({
      amountCents: [`Bid must exceed the current price of ${auction.currentPriceCents} cents`],
    });
  }
}

export async function placeBid(
  bidderId: string,
  auctionId: string,
  input: PlaceBidInput,
): Promise<PlaceBidResult> {
  // Fast path: a genuine retry of an already-succeeded request. No lock
  // needed here — nothing is being decided, only returned — which keeps a
  // stream of retries from adding to contention on a hot auction's row. A
  // replay never re-triggers a fresh anti-sniping extension of its own —
  // it's the SAME original acceptance, not a new event — and by the same
  // logic never re-sends the outbid notification either.
  const existing = await findBidByIdempotencyKey(bidderId, input.idempotencyKey);
  if (existing) {
    return { bid: existing, extended: false };
  }

  try {
    const result = await placeBidTransactionally(
      auctionId,
      { bidderId, amountCents: input.amountCents, idempotencyKey: input.idempotencyKey },
      (auction) => assertBidIsAcceptable(auction, bidderId, input.amountCents),
    );
    // Runs unconditionally on every call, including the in-transaction
    // idempotent-replay branch (repository.ts) where nothing actually
    // changed — a redundant cache invalidation + WS signal is harmless
    // (Section 10: only react after commit; there's no "was this a real
    // mutation" signal worth threading back out here just to skip a cheap
    // no-op) — a subscribed watcher just refetches and gets identical data.
    await notifyAuctionChanged(auctionId, 'bid');
    // An outbid event (if this bid outbid someone) was already published
    // to the Outbox inside placeBidTransactionally's transaction —
    // nothing further to do here. A consumer (modules/notifications/
    // consumer.ts) picks it up via Kafka and creates/pushes the
    // Notification asynchronously (ADR-0027) — deliberately off this
    // request's critical path (Section 64).
    return result;
  } catch (err) {
    // Two concurrent requests with the SAME (bidderId, idempotencyKey)
    // targeting the SAME auction can't reach here — repository.ts's
    // in-transaction re-check (after the row lock) already catches that
    // case, because both requests necessarily serialize behind that one
    // auction row. What CAN still reach here: the same idempotencyKey
    // reused across two DIFFERENT auctions, fired concurrently (ADR-0011's
    // documented tradeoff — the key is scoped to the bidder only, not also
    // the auction) — those two requests lock different rows, so neither's
    // in-transaction check sees the other's insert before both attempt one.
    // The DB's unique constraint is still the actual source of truth here,
    // same pattern as registration's email race (AUTH-002): treat the
    // loser's P2002 as a successful idempotent replay, not an error.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      const bid = await findBidByIdempotencyKey(bidderId, input.idempotencyKey);
      if (bid) {
        logger.warn(
          { bidderId, auctionId },
          'bid.idempotent_replay_after_cross_auction_key_reuse_race',
        );
        return { bid, extended: false };
      }
    }
    throw err;
  }
}

// Reuses auctions' own visibility rule (ADR-0008) rather than inventing a
// separate one for bid history: a DRAFT auction has no bids anyway (bidding
// requires ACTIVE, see assertBidIsAcceptable), but a nonexistent or hidden
// auction id should 404 here exactly like GET /auctions/:id does — bid
// history is not itself sensitive, but which auction ids exist is still
// governed by the one rule already established for that.
export async function listBidsForAuctionAsViewer(
  user: RequestingUser,
  auctionId: string,
  limit: number,
): Promise<Bid[]> {
  await getAuctionForViewer(user, auctionId);
  return listBidsForAuction(auctionId, limit);
}
