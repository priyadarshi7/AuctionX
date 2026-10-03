import type { Auction, AuctionCategory, AuctionCondition, AuctionStatus, Prisma } from '@prisma/client';
import { prisma } from '../../infrastructure/database/prisma';
import { createOutboxEventInTx } from '../../infrastructure/outbox/repository';
import { AI_VALUATION_EVENTS_TOPIC, SEARCH_EVENTS_TOPIC } from '../../infrastructure/kafka/topics';
import { computePaymentDueAt } from '../orders/lifecycle';

// Phase 9 (Section 25/ADR-0029): every function in this file that changes
// a field the search index cares about publishes this SAME lightweight
// signal, in the SAME transaction as the write — the point isn't to carry
// data in the event (it carries only the id), it's to tell
// modules/search/consumer.ts "go re-read this auction and reindex it,"
// which it does from Postgres directly. A dedicated topic, not
// 'auction-events' — see that consumer's own comment for why sharing a
// topic with modules/notifications/consumer.ts would corrupt ITS DLQ
// signal. Test-scoped (SEARCH_EVENTS_TOPIC) so a live dev server can't
// pick up test-published events (ADR-0031).
function publishReindexEvent(tx: Prisma.TransactionClient, auctionId: string): Promise<unknown> {
  return createOutboxEventInTx(tx, {
    topic: SEARCH_EVENTS_TOPIC,
    key: auctionId,
    payload: { type: 'auction.reindex', auctionId },
  });
}

export type NewAuction = {
  sellerId: string;
  title: string;
  description: string;
  category: AuctionCategory;
  condition: AuctionCondition;
  images: string[];
  startingPriceCents: number;
  reservePriceCents?: number;
  currentPriceCents: number;
};

// Wrapped in a transaction (vs. a bare prisma.auction.create) purely to
// publish the reindex event atomically with the row's existence — see the
// comment on publishReindexEvent below for why every mutation in this file
// does the same.
//
// Also creates the auction's AuctionValuation row here directly (PENDING),
// rather than importing anything from modules/ai — same precedent as Order
// being created directly inside closeAuctionIfExpired below (schema.prisma's
// own comment on Order: "not via an event/outbox... a second write inside
// the same transaction is strictly simpler"). modules/ai/consumer.ts is the
// only thing that ever needs to know Ollama exists; this file only needs to
// know "an auction was just created, tell that consumer to go value it,"
// the exact same decoupling publishReindexEvent already uses for search.
export function createAuction(data: NewAuction): Promise<Auction> {
  return prisma.$transaction(async (tx) => {
    const auction = await tx.auction.create({ data });
    await publishReindexEvent(tx, auction.id);
    await tx.auctionValuation.create({ data: { auctionId: auction.id, status: 'PENDING' } });
    await createOutboxEventInTx(tx, {
      topic: AI_VALUATION_EVENTS_TOPIC,
      key: auction.id,
      payload: { type: 'auction.valuate', auctionId: auction.id },
    });
    return auction;
  });
}

export function findAuctionById(id: string): Promise<Auction | null> {
  return prisma.auction.findUnique({ where: { id } });
}

// A listing cancelled before it ever went live (from DRAFT or PENDING_REVIEW)
// is cancelled with startTime cleared, and every path that goes live sets
// startTime. So "CANCELLED with no startTime" means "never public": it must
// not appear in Browse, search or to non-owners.
export function isNeverLive(a: { status: AuctionStatus; startTime: Date | null }): boolean {
  return a.status === 'CANCELLED' && a.startTime === null;
}

export type AuctionListFilters = {
  excludeNeverLive?: boolean;
  status?: AuctionStatus | { not: AuctionStatus } | { notIn: AuctionStatus[] };
  category?: AuctionCategory;
  sellerId?: string;
};

// (createdAt, id) as a composite cursor — createdAt alone isn't a strict
// total order (two rows can share a timestamp, especially under fast
// concurrent inserts), so id breaks the tie deterministically. Ordering by
// id itself carries no meaning (UUIDs are random) — it's there purely to
// make the sort stable.
export type AuctionCursor = { createdAt: Date; id: string };

// Keyset ("cursor") pagination, not OFFSET/LIMIT — see service.ts's
// encode/decodeCursor for why: OFFSET pagination silently skips or repeats
// rows when items are inserted/deleted between page requests, which is the
// normal case for a live "newest listings first" feed, not an edge case.
//
// Fetches one row beyond `limit` to learn whether a next page exists
// without a separate COUNT query — a second query would double the read
// cost of every single list request just to answer a boolean.
export async function listAuctions(
  filters: AuctionListFilters,
  limit: number,
  after?: AuctionCursor,
): Promise<{ rows: Auction[]; hasMore: boolean }> {
  const where: Prisma.AuctionWhereInput = {
    ...(filters.status !== undefined ? { status: filters.status } : {}),
    ...(filters.excludeNeverLive ? { NOT: { status: 'CANCELLED' as const, startTime: null } } : {}),
    ...(filters.category !== undefined ? { category: filters.category } : {}),
    ...(filters.sellerId !== undefined ? { sellerId: filters.sellerId } : {}),
    ...(after
      ? {
          OR: [
            { createdAt: { lt: after.createdAt } },
            { createdAt: after.createdAt, id: { lt: after.id } },
          ],
        }
      : {}),
  };

  const rows = await prisma.auction.findMany({
    where,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
  });

  const hasMore = rows.length > limit;
  return { rows: hasMore ? rows.slice(0, limit) : rows, hasMore };
}

// Deliberately has no `status` field in its type — status changes only
// ever happen through a dedicated function (publishAuctionRow, and future
// start/pause/cancel/end equivalents), never through the general content
// edit path. This is enforced by the type signature itself, not just by
// what callers happen to pass.
//
// currentPriceCents IS included here, unlike the public updateAuctionSchema
// (modules/auctions/schema.ts), which never accepts it from a client at
// all — Section 82: never trust a client-controlled price. service.ts's
// updateExistingAuction is the only caller that ever sets it, and only
// derived from a genuinely-patched startingPriceCents (see its own
// comment) — a real bug found live (2026-09-29): editing a DRAFT's
// startingPriceCents left currentPriceCents pointing at whatever it was
// created with, which the bid-placement transaction (bids/repository.ts)
// treats as the real floor to beat — publishing straight after an edit
// would have let a bid far below the seller's actual intended price win.
export type AuctionPatch = Partial<{
  title: string;
  description: string;
  category: AuctionCategory;
  condition: AuctionCondition;
  images: string[];
  startingPriceCents: number;
  currentPriceCents: number;
  reservePriceCents: number | null;
  startTime: Date;
  endTime: Date;
}>;

export function updateAuctionRow(id: string, patch: AuctionPatch): Promise<Auction> {
  return prisma.$transaction(async (tx) => {
    const auction = await tx.auction.update({ where: { id }, data: patch });
    await publishReindexEvent(tx, id);
    return auction;
  });
}

export function publishAuctionRow(id: string, schedule: { startTime: Date; endTime: Date }): Promise<Auction> {
  return prisma.$transaction(async (tx) => {
    const auction = await tx.auction.update({
      where: { id },
      data: { status: 'PUBLISHED', startTime: schedule.startTime, endTime: schedule.endTime },
    });
    await publishReindexEvent(tx, id);
    return auction;
  });
}

// The three review-stage transitions (ADR-0041) are GUARDED updates: the
// required source state is part of the UPDATE's WHERE, so a seller
// double-clicking, withdrawing while an admin approves, or the same request
// arriving twice cannot apply a transition twice or from the wrong state.
// They return null when the guard matched nothing; the service turns that
// into the right error.

export function submitAuctionRow(id: string, durationSeconds: number): Promise<Auction | null> {
  return prisma.$transaction(async (tx) => {
    const { count } = await tx.auction.updateMany({
      where: { id, status: 'DRAFT' },
      data: {
        status: 'PENDING_REVIEW',
        requestedDurationSeconds: durationSeconds,
        submittedAt: new Date(),
        // A fresh submission supersedes any earlier rejection note.
        reviewNote: null,
      },
    });
    if (count === 0) return null;
    await publishReindexEvent(tx, id);
    return tx.auction.findUniqueOrThrow({ where: { id } });
  });
}

// The no-review path (a trusted seller, low-risk category, or review off):
// DRAFT goes straight to ACTIVE with the clock starting now — the same end
// state as publish + start, in one guarded step.
export function activateDraftRow(id: string, schedule: { startTime: Date; endTime: Date }): Promise<Auction | null> {
  return prisma.$transaction(async (tx) => {
    const { count } = await tx.auction.updateMany({
      where: { id, status: 'DRAFT' },
      data: { status: 'ACTIVE', startTime: schedule.startTime, endTime: schedule.endTime },
    });
    if (count === 0) return null;
    await publishReindexEvent(tx, id);
    return tx.auction.findUniqueOrThrow({ where: { id } });
  });
}

export function withdrawAuctionRow(id: string): Promise<Auction | null> {
  return prisma.$transaction(async (tx) => {
    const { count } = await tx.auction.updateMany({
      where: { id, status: 'PENDING_REVIEW' },
      data: { status: 'DRAFT', requestedDurationSeconds: null, submittedAt: null },
    });
    if (count === 0) return null;
    await publishReindexEvent(tx, id);
    return tx.auction.findUniqueOrThrow({ where: { id } });
  });
}

export function startAuctionRow(id: string): Promise<Auction> {
  return prisma.$transaction(async (tx) => {
    const auction = await tx.auction.update({ where: { id }, data: { status: 'ACTIVE' } });
    await publishReindexEvent(tx, id);
    return auction;
  });
}

export function pauseAuctionRow(id: string): Promise<Auction> {
  return prisma.$transaction(async (tx) => {
    const auction = await tx.auction.update({ where: { id }, data: { status: 'PAUSED' } });
    await publishReindexEvent(tx, id);
    return auction;
  });
}

// endedAt records the real end moment, distinct from the scheduled endTime
// (ADR-0007) — a cancellation is precisely the case where they diverge.
export function cancelAuctionRow(id: string, wasLive: boolean): Promise<Auction> {
  return prisma.$transaction(async (tx) => {
    const auction = await tx.auction.update({
      where: { id },
      data: { status: 'CANCELLED', endedAt: new Date(), ...(wasLive ? {} : { startTime: null }) },
    });
    await publishReindexEvent(tx, id);
    return auction;
  });
}

// The closing worker's unlocked candidate scan (infrastructure/jobs/
// auctionClosingWorker.ts) — deliberately NOT itself locked. Each candidate
// is re-checked under a real lock in closeAuctionIfExpired below; this
// query only needs to be roughly right, not authoritative, since anything
// it gets wrong (a false positive from a schedule that moved since this
// scan ran) is caught by that per-auction lock anyway.
export async function findExpiredActiveAuctionIds(now: Date): Promise<string[]> {
  const rows = await prisma.auction.findMany({
    where: { status: { in: ['ACTIVE', 'PAUSED'] }, endTime: { lte: now } },
    select: { id: true },
  });
  return rows.map((row) => row.id);
}

type LockedAuctionForClosing = {
  id: string;
  sellerId: string;
  status: AuctionStatus;
  endTime: Date | null;
  reservePriceCents: number | null;
};

// SOLD: a winning bid exists and (no reserve, or it met the reserve) — an
// Order was created. RESERVE_NOT_MET: bids exist, but the highest never
// reached reservePriceCents — the item goes unsold, same as a real auction
// house's hammer never falling. NO_BIDS: nobody bid at all. Both non-SOLD
// outcomes still mark the auction ENDED; only Order creation depends on
// which one it is.
export type CloseAuctionOutcome = 'SOLD' | 'RESERVE_NOT_MET' | 'NO_BIDS';

export type CloseAuctionResult =
  | { closed: false; outcome: null; winningBidId: null; orderId: null }
  | { closed: true; outcome: CloseAuctionOutcome; winningBidId: string | null; orderId: string | null };

// Section 17's closing workflow as one transaction: lock the auction (same
// mechanism and same row bid placement locks — see ADR-0012 — so a bid
// arriving at the same instant serializes against this automatically),
// re-verify it's actually still expired (anti-sniping, ADR-0013, may have
// pushed endTime out since the unlocked scan found this candidate),
// determine the winner (respecting reservePriceCents — see
// CloseAuctionOutcome), mark it ENDED, and — only when there IS a winner —
// create the Order in the SAME transaction. Idempotent and retry-safe by
// construction (Section 17): calling this again on an already-ENDED
// auction just re-fails the status check and no-ops — no separate
// "already closed?" flag needed, and Order.auctionId's @unique constraint
// means a second attempt could never create a duplicate Order even if this
// guard were somehow bypassed.
export async function closeAuctionIfExpired(auctionId: string, now: Date): Promise<CloseAuctionResult> {
  return prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<LockedAuctionForClosing[]>`
      SELECT id, "sellerId", status, "endTime", "reservePriceCents"
      FROM auctions
      WHERE id = ${auctionId}
      FOR UPDATE
    `;
    const auction = rows[0];

    if (!auction || (auction.status !== 'ACTIVE' && auction.status !== 'PAUSED')) {
      return { closed: false, outcome: null, winningBidId: null, orderId: null };
    }
    if (!auction.endTime || auction.endTime > now) {
      return { closed: false, outcome: null, winningBidId: null, orderId: null };
    }

    // Reading Bid from within the Auctions module mirrors the same
    // pragmatic cross-module access bids/repository.ts already does in the
    // other direction (locking Auction to place a bid) — determining the
    // winner is fundamentally part of closing, and must happen under THIS
    // SAME lock so no bid can be inserted between "who's winning" and
    // "mark this ended" (any such bid needs this identical lock first).
    const highestBid = await tx.bid.findFirst({
      where: { auctionId },
      orderBy: { createdAt: 'desc' },
    });

    const reserveMet = auction.reservePriceCents == null || (highestBid?.amountCents ?? 0) >= auction.reservePriceCents;
    const outcome: CloseAuctionOutcome = !highestBid ? 'NO_BIDS' : reserveMet ? 'SOLD' : 'RESERVE_NOT_MET';

    await tx.auction.update({
      where: { id: auctionId },
      data: { status: 'ENDED', endedAt: now },
    });
    // Unconditional across all three outcomes (SOLD/RESERVE_NOT_MET/
    // NO_BIDS) — status just changed to ENDED either way, which the search
    // index needs to reflect regardless of which outcome this was.
    await publishReindexEvent(tx, auctionId);

    let orderId: string | null = null;

    if (outcome === 'SOLD' && highestBid) {
      const order = await tx.order.create({
        data: {
          auctionId,
          winningBidId: highestBid.id,
          sellerId: auction.sellerId,
          buyerId: highestBid.bidderId,
          amountCents: highestBid.amountCents,
          paymentDueAt: computePaymentDueAt(now),
        },
      });
      orderId = order.id;

      // Published via the Outbox (ADR-0027) — a consumer
      // (modules/notifications/consumer.ts) turns this ONE event into TWO
      // notifications (AUCTION_WON for the buyer, AUCTION_SOLD for the
      // seller), asynchronously, off this transaction.
      await createOutboxEventInTx(tx, {
        topic: 'auction-events',
        key: auctionId,
        payload: {
          type: 'auction.sold',
          auctionId,
          orderId: order.id,
          buyerId: highestBid.bidderId,
          sellerId: auction.sellerId,
          amountCents: highestBid.amountCents,
        },
      });
    } else if (outcome === 'RESERVE_NOT_MET') {
      await createOutboxEventInTx(tx, {
        topic: 'auction-events',
        key: auctionId,
        payload: {
          type: 'auction.reserve_not_met',
          auctionId,
          sellerId: auction.sellerId,
          highestBidCents: highestBid?.amountCents ?? null,
          reservePriceCents: auction.reservePriceCents,
        },
      });
    }
    // NO_BIDS: deliberately no event — "nobody bid on your auction" isn't
    // actionable the way the other outcomes are.

    return { closed: true, outcome, winningBidId: highestBid?.id ?? null, orderId };
  });
}
