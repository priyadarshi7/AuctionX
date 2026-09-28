import type { AuctionStatus, Bid, Prisma } from '@prisma/client';
import { prisma } from '../../infrastructure/database/prisma';
import { createOutboxEventInTx } from '../../infrastructure/outbox/repository';
import { SEARCH_EVENTS_TOPIC } from '../../infrastructure/kafka/topics';
import { computeExtendedEndTime } from './antiSniping';

// Phase 9 (ADR-0029): every accepted bid changes currentPriceCents, which
// the search index needs to reflect — unlike 'bid.outbid' below, this must
// fire for EVERY genuine new bid, including the very first one on an
// auction (which has no previous bidder to outbid, so that event is
// skipped entirely) and a bidder re-outbidding themselves (also skipped
// below). Dedicated, test-scoped topic (SEARCH_EVENTS_TOPIC, ADR-0031) —
// see modules/search/consumer.ts's comment for why this can't share
// 'bid-events'/'auction-events' with modules/notifications/consumer.ts.
function publishReindexEvent(tx: Prisma.TransactionClient, auctionId: string): Promise<unknown> {
  return createOutboxEventInTx(tx, {
    topic: SEARCH_EVENTS_TOPIC,
    key: auctionId,
    payload: { type: 'auction.reindex', auctionId },
  });
}

export function findBidByIdempotencyKey(bidderId: string, idempotencyKey: string): Promise<Bid | null> {
  return prisma.bid.findUnique({
    where: { bidderId_idempotencyKey: { bidderId, idempotencyKey } },
  });
}

// Newest-first is also highest-first (ADR-0011: every accepted bid exceeds
// the previous one by construction), so this same query answers both "bid
// history" and "who's currently winning" — the top row either way.
export function listBidsForAuction(auctionId: string, limit: number): Promise<Bid[]> {
  return prisma.bid.findMany({
    where: { auctionId },
    orderBy: { createdAt: 'desc' },
    take: limit,
  });
}

// Only the columns bid validation actually needs — never the full Auction
// row, to keep the locked read (and therefore the lock's hold time) as
// small as possible.
export type LockedAuctionRow = {
  id: string;
  sellerId: string;
  status: AuctionStatus;
  currentPriceCents: number;
  endTime: Date | null;
};

export type NewBidData = { bidderId: string; amountCents: number; idempotencyKey: string };

export type PlaceBidResult = { bid: Bid; extended: boolean };

// This is Section 10's bid pipeline made real, as ONE Postgres transaction:
// lock the auction row, validate against what the lock guarantees is
// current, persist the bid, update the auction (price, and — Section 18 —
// possibly its schedule), commit. See ADR-0012 for why SELECT ... FOR
// UPDATE (pessimistic locking) over optimistic versioning.
//
// `validate` is injected rather than hardcoded here so the actual business
// rules (ownership, auction status, price) stay in service.ts, matching
// every other module's layering — but it MUST run inside this function,
// after the lock is acquired, or it would be checking against data another
// transaction could still change before this one commits, reopening the
// exact race this function exists to close. It receives `undefined` when
// the auction doesn't exist and is expected to throw in that case too.
export async function placeBidTransactionally(
  auctionId: string,
  bid: NewBidData,
  validate: (auction: LockedAuctionRow | undefined) => void,
): Promise<PlaceBidResult> {
  return prisma.$transaction(async (tx) => {
    // Prisma's query builder has no row-locking API, so this step is
    // necessarily raw SQL. Every other concurrent bid attempt on THIS SAME
    // auction row blocks here until this transaction commits or rolls
    // back; concurrent attempts on OTHER auctions are entirely unaffected
    // (a row lock, not a table lock).
    const rows = await tx.$queryRaw<LockedAuctionRow[]>`
      SELECT id, "sellerId", status, "currentPriceCents", "endTime"
      FROM auctions
      WHERE id = ${auctionId}
      FOR UPDATE
    `;

    // Re-check idempotency AFTER acquiring the lock, not just before
    // entering this transaction. Without this second check, a request that
    // loses the race for the lock would validate its bid against the
    // auction's price AFTER its own twin request (same idempotency key)
    // already raised that price — rejecting a legitimate retry as "too low"
    // instead of replaying the original result. This is what actually
    // closes that race: every bid placement on this auction serializes
    // behind this same row lock, so whichever request acquires it second is
    // GUARANTEED to see any sibling's already-committed insert here, before
    // running price validation against now-stale expectations.
    const existing = await tx.bid.findUnique({
      where: {
        bidderId_idempotencyKey: { bidderId: bid.bidderId, idempotencyKey: bid.idempotencyKey },
      },
    });
    if (existing) {
      // A replay describes something that already happened — it never
      // re-triggers a fresh extension of its own, and (same reasoning)
      // never re-publishes an outbid event for it either.
      return { bid: existing, extended: false };
    }

    validate(rows[0]);
    // validate() throws for every invalid case, including a missing row —
    // reaching this line means it's safe to use non-null below.
    const auction = rows[0] as LockedAuctionRow;

    // Read BEFORE inserting the new bid, under the same lock — this is who
    // this specific bid is about to outbid. Doing this after insert (or
    // after commit) would be a real race: another bid could land in
    // between and make "the 2nd-highest bid" answer a different question
    // than "who did THIS bid just beat."
    const previousHighestBid = await tx.bid.findFirst({
      where: { auctionId },
      orderBy: { createdAt: 'desc' },
    });

    const created = await tx.bid.create({
      data: {
        auctionId,
        bidderId: bid.bidderId,
        amountCents: bid.amountCents,
        idempotencyKey: bid.idempotencyKey,
      },
    });

    // Anti-sniping (Section 18): computed and applied in the SAME
    // transaction, under the SAME lock, as accepting the bid itself — "this
    // must be handled atomically" means there must be no window where the
    // bid is accepted but the extension hasn't happened yet (or vice
    // versa), and there isn't one, because both writes commit together.
    const extendedEndTime = auction.endTime ? computeExtendedEndTime(auction.endTime, new Date()) : null;

    await tx.auction.update({
      where: { id: auctionId },
      data: {
        currentPriceCents: bid.amountCents,
        ...(extendedEndTime ? { endTime: extendedEndTime } : {}),
      },
    });
    await publishReindexEvent(tx, auctionId);

    // No event for the auction's own seller placing the first bid against
    // themselves (impossible anyway — assertBidIsAcceptable blocks shill
    // bidding) or for a bidder immediately re-outbidding themselves
    // (bidderId === previousHighestBid.bidderId — nothing useful to tell
    // them).
    //
    // Published via the Outbox (ADR-0027), not a direct Notification
    // insert — this keeps the bid-placement transaction (Section 64's
    // "critical path must stay fast") from doing the notification's own
    // work; a consumer (modules/notifications/consumer.ts) does that
    // asynchronously, off this transaction entirely. Keyed by auctionId,
    // not bidderId — ordering matters per-auction (Section 15), since two
    // outbid events for the same auction must be processed in the order
    // they happened.
    if (previousHighestBid && previousHighestBid.bidderId !== bid.bidderId) {
      await createOutboxEventInTx(tx, {
        topic: 'bid-events',
        key: auctionId,
        payload: {
          type: 'bid.outbid',
          auctionId,
          outbidUserId: previousHighestBid.bidderId,
          previousAmountCents: previousHighestBid.amountCents,
          newAmountCents: bid.amountCents,
        },
      });
    }

    return { bid: created, extended: extendedEndTime !== null };
  });
}
