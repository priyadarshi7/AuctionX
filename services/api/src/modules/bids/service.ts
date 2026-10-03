import type { Bid } from '@prisma/client';
import { Prisma } from '@prisma/client';
import { notifyAuctionChanged } from '../../infrastructure/realtime/auctionEvents';
import { getCachedAuction } from '../../infrastructure/redis/auctionCache';
import { logger } from '../../infrastructure/observability/logger';
import { AppError, ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../../middleware/errors';
import { findUserById } from '../auth/repository';
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

// Prisma reports the same database event — a unique-constraint violation —
// differently depending on which API hit it: the structured Client API
// (e.g. tx.bid.create()) maps it to P2002, while a raw query (repository.ts's
// combined write statement) gets the generic "raw query failed" P2010 with
// the real Postgres SQLSTATE (23505 = unique_violation) in meta.code.
function isUniqueViolation(err: Prisma.PrismaClientKnownRequestError): boolean {
  return (
    err.code === 'P2002' || (err.code === 'P2010' && (err.meta as { code?: string } | undefined)?.code === '23505')
  );
}

export async function placeBid(
  bidderId: string,
  auctionId: string,
  input: PlaceBidInput,
): Promise<PlaceBidResult> {
  // Three independent lookups (none needs another's result), run
  // concurrently: one round trip's worth of latency instead of three.
  // Measured live (ADR-0036 addendum): with the DB a cross-region hop away,
  // every saved round trip on this path is worth it. Real tradeoff, not
  // hidden: the idempotent-replay fast path below now also pays for the user
  // and cache lookups it didn't strictly need — accepted because replays
  // are rare and the common (non-replay) case is what users feel.
  const [existing, bidder, cachedAuction] = await Promise.all([
    findBidByIdempotencyKey(bidderId, input.idempotencyKey),
    findUserById(bidderId),
    getCachedAuction(auctionId),
  ]);

  // Fast path: a genuine retry of an already-succeeded request. No lock
  // needed here — nothing is being decided, only returned — which keeps a
  // stream of retries from adding to contention on a hot auction's row. A
  // replay never re-triggers a fresh anti-sniping extension of its own —
  // it's the SAME original acceptance, not a new event — and by the same
  // logic never re-sends the outbid notification either.
  if (existing) {
    return { bid: existing, extended: false };
  }

  // Soft email-verification gate (same reasoning/precedent as
  // auctions/service.ts's createNewAuction check) — checked here, BEFORE
  // placeBidTransactionally acquires the auction row's lock, not inside
  // assertBidIsAcceptable: this has nothing to do with the auction's state,
  // so there's no reason to pay for contention on a hot row just to reject
  // for a reason that was already knowable up front (Section 64).
  if (!bidder || !bidder.emailVerifiedAt) {
    throw new ForbiddenError('Verify your email before placing a bid', 'EMAIL_NOT_VERIFIED');
  }
  // A suspended/banned user's access token stays valid until it expires
  // (authenticate is stateless and never reads the DB), so account status is
  // re-checked here against the row already loaded above — free, and it
  // closes the up-to-15-minute window in which a banned user could keep
  // bidding on a token issued before the ban (ADR-0039).
  if (bidder.status !== 'ACTIVE') {
    throw new ForbiddenError('Your account is not active', 'ACCOUNT_DISABLED');
  }

  // Fast-reject precheck — an optimization, not a correctness gate. The
  // 5s auction cache (ADR-0017) is invalidated synchronously after every
  // commit, so on a cache HIT, running the SAME validator against it can
  // reject an obviously-doomed bid (too low, ended, not active, shill) for
  // free, instead of opening the Postgres transaction just to learn the
  // same thing. On a miss or Redis error, cachedAuction is null and this
  // does nothing. A bid that passes here is still fully re-validated under
  // the real row lock below, so this can only cause an early REJECT, never
  // an early ACCEPT.
  //
  // Real tradeoff, not hidden: the cache can only be wrong (not just
  // absent) if a previous commit's invalidation never ran — a crash or
  // Redis outage between that commit and notifyAuctionChanged — and then
  // for at most the 5s TTL. Price and status only move one way, so the one
  // check that could then wrongly reject a valid bid is endTime, right after
  // an anti-sniping extension. That's the same staleness bound ADR-0017
  // already accepts for GET /auctions/:id. If it's ever judged too risky
  // for bidding specifically, delete this block — not the cache.
  if (cachedAuction) {
    try {
      assertBidIsAcceptable(cachedAuction, bidderId, input.amountCents);
    } catch (err) {
      // The idempotency lookup above ran BEFORE this check. If this is a
      // retry whose first attempt committed in between, the cache now shows
      // that attempt's own price and the retry looks "too low". It must be
      // replayed, not rejected, so look the key up again before giving up.
      // Costs one read, and only on the rejection path.
      const replay = await findBidByIdempotencyKey(bidderId, input.idempotencyKey);
      if (replay) {
        return { bid: replay, extended: false };
      }
      throw err;
    }
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
    // loser's unique violation as a successful idempotent replay, not an
    // error. isUniqueViolation() covers both shapes Prisma reports it in —
    // the raw-SQL insert reports P2010, not P2002; checking only P2002 turned
    // this exact race into a 500 (caught by place-bid.test.ts).
    if (err instanceof Prisma.PrismaClientKnownRequestError && isUniqueViolation(err)) {
      const bid = await findBidByIdempotencyKey(bidderId, input.idempotencyKey);
      if (bid) {
        logger.warn(
          { bidderId, auctionId },
          'bid.idempotent_replay_after_cross_auction_key_reuse_race',
        );
        return { bid, extended: false };
      }
    }
    // A retry that waited on the row lock behind its OWN first attempt. In
    // READ COMMITTED the locked row is re-read after the wait (so the price is
    // the first attempt's), but the idempotency-key join in the locked read
    // keeps the statement's original snapshot and misses that bid. The retry
    // therefore fails validation against its own earlier success. Look the
    // key up once more (fresh snapshot) and replay instead of rejecting.
    if (err instanceof AppError) {
      const replay = await findBidByIdempotencyKey(bidderId, input.idempotencyKey);
      if (replay) {
        return { bid: replay, extended: false };
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
