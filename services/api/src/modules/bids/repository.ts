import type { AuctionStatus, Bid } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { prisma } from '../../infrastructure/database/prisma';
import { SEARCH_EVENTS_TOPIC } from '../../infrastructure/kafka/topics';
import { computeExtendedEndTime } from './antiSniping';

// Reconstructs a full Bid from a raw query's flat, prefixed columns, or
// null when the LEFT JOIN that produced them matched nothing. Used for
// both the idempotency-replay column set and the previous-highest-bid
// column set below — same shape, different prefix, so one helper instead
// of writing this mapping out twice.
function bidFromRawColumns(
  id: string | null,
  auctionId: string | null,
  bidderId: string | null,
  amountCents: number | null,
  idempotencyKey: string | null,
  createdAt: Date | null,
): Bid | null {
  if (!id) return null;
  return {
    id,
    auctionId: auctionId as string,
    bidderId: bidderId as string,
    amountCents: amountCents as number,
    idempotencyKey: idempotencyKey as string,
    createdAt: createdAt as Date,
  };
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

type LockedReadRow = {
  auctionId: string;
  auctionSellerId: string;
  auctionStatus: AuctionStatus;
  auctionCurrentPriceCents: number;
  auctionEndTime: Date | null;
  existingBidId: string | null;
  existingBidAuctionId: string | null;
  existingBidBidderId: string | null;
  existingBidAmountCents: number | null;
  existingBidIdempotencyKey: string | null;
  existingBidCreatedAt: Date | null;
};

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
//
// ADR-0036 latency addendum: the transaction body is exactly two round
// trips — one locked read, one combined write — down from up to seven
// sequential statements. WHAT is locked, read, validated and written is
// unchanged; only how many network hops it takes.
export async function placeBidTransactionally(
  auctionId: string,
  bid: NewBidData,
  validate: (auction: LockedAuctionRow | undefined) => void,
): Promise<PlaceBidResult> {
  return prisma.$transaction(async (tx) => {
    // Round trip 1 of 2: the row lock plus an idempotency pre-check, as one
    // query. `FOR UPDATE OF a` locks only the auctions row.
    //
    // READ COMMITTED subtlety (found by place-bid.test.ts, not assumed): when
    // this statement has to WAIT for the lock, Postgres re-reads the locked
    // auctions row afterwards, but every OTHER table in the statement keeps
    // the snapshot from before the wait. So the `e` join below is only a
    // best-effort replay check: a retry that waited behind its own twin can
    // miss the twin's bid here. That is safe, never a double-accept: the
    // unique (bidderId, idempotencyKey) index rejects the insert, and
    // service.ts turns that (or the spurious validation failure) into a
    // replay with a fresh lookup. The previous-highest-bid lookup, which
    // must be exact, therefore lives in round trip 2, not here.
    const rows = await tx.$queryRaw<LockedReadRow[]>`
      SELECT
        a.id AS "auctionId",
        a."sellerId" AS "auctionSellerId",
        a.status AS "auctionStatus",
        a."currentPriceCents" AS "auctionCurrentPriceCents",
        a."endTime" AS "auctionEndTime",
        e.id AS "existingBidId",
        e."auctionId" AS "existingBidAuctionId",
        e."bidderId" AS "existingBidBidderId",
        e."amountCents" AS "existingBidAmountCents",
        e."idempotencyKey" AS "existingBidIdempotencyKey",
        e."createdAt" AS "existingBidCreatedAt"
      FROM auctions a
      LEFT JOIN bids e
        ON e."bidderId" = ${bid.bidderId} AND e."idempotencyKey" = ${bid.idempotencyKey}
      WHERE a.id = ${auctionId}
      FOR UPDATE OF a
    `;
    const row = rows[0];

    // Scoped to (bidderId, idempotencyKey) only — NOT also to this auction
    // — so `existingBidAuctionId` can legitimately be a DIFFERENT auction's
    // id (the cross-auction key-reuse case service.ts's catch block
    // documents). That's why it's read off the row rather than assumed.
    const existing = row
      ? bidFromRawColumns(
          row.existingBidId,
          row.existingBidAuctionId,
          row.existingBidBidderId,
          row.existingBidAmountCents,
          row.existingBidIdempotencyKey,
          row.existingBidCreatedAt,
        )
      : null;
    if (existing) {
      // A replay describes something that already happened — it never
      // re-triggers a fresh extension of its own, and (same reasoning)
      // never re-publishes an outbid event for it either.
      return { bid: existing, extended: false };
    }

    const lockedAuction: LockedAuctionRow | undefined = row
      ? {
          id: row.auctionId,
          sellerId: row.auctionSellerId,
          status: row.auctionStatus,
          currentPriceCents: row.auctionCurrentPriceCents,
          endTime: row.auctionEndTime,
        }
      : undefined;
    validate(lockedAuction);
    // validate() throws for every invalid case, including a missing row —
    // reaching this line means it's safe to use non-null below.
    const auction = lockedAuction as LockedAuctionRow;

    // Anti-sniping (Section 18): computed from the locked read and written
    // in the same transaction as the bid itself, so there's no window where
    // the bid is accepted but the extension hasn't happened (or vice versa).
    const extendedEndTime = auction.endTime ? computeExtendedEndTime(auction.endTime, new Date()) : null;
    // Always written, even when unchanged — re-writing the same value is a
    // no-op, and one unconditional SET is simpler than a conditional SQL
    // fragment.
    const finalEndTime = extendedEndTime ?? auction.endTime;

    // Raw SQL bypasses Prisma's client-side @default(uuid()) — the id
    // columns have no database default — so ids are generated here.
    const newBidId = randomUUID();
    const reindexEventId = randomUUID();
    const outbidEventId = randomUUID();
    // Phase 9 (ADR-0029): every accepted bid changes currentPriceCents,
    // which the search index must reflect, on its own test-scoped topic
    // (SEARCH_EVENTS_TOPIC, ADR-0031).
    const reindexPayload = JSON.stringify({ type: 'auction.reindex', auctionId });
    // Via the Outbox (ADR-0027), not a direct Notification insert — the
    // notifications consumer does that work asynchronously, off this
    // transaction (Section 64).

    // Round trip 2 of 2: INSERT the bid, UPDATE the auction, INSERT the
    // reindex outbox event, and conditionally INSERT the outbid outbox event
    // — as ONE statement, using Postgres's data-modifying CTEs. Each INSERT
    // reads the previous step's RETURNING output as its FROM source (the
    // same pattern as the Postgres manual's own "move rows between tables"
    // example), and the final SELECT joins every CTE, so every write is in
    // the statement's dependency graph and is guaranteed to execute.
    //
    // new_bid's INSERT ... VALUES always yields exactly one row, and every
    // other CTE yields at most one, so the LEFT JOIN ... ON true chain can
    // neither drop nor multiply the result: exactly one row comes back.
    const rowsWritten = await tx.$queryRaw<Bid[]>`
      WITH prev AS (
        -- Who this bid outbids. Exact, because this statement takes a fresh
        -- snapshot while this transaction already holds the auction lock, so
        -- no other bid on this auction can be committed or missed. Highest
        -- amount, not latest timestamp: price is what defines "leading".
        SELECT "bidderId", "amountCents"
        FROM bids
        WHERE "auctionId" = ${auctionId}
        ORDER BY "amountCents" DESC, "createdAt" DESC
        LIMIT 1
      ),
      new_bid AS (
        -- clock_timestamp(), not now(): now() is the transaction START time,
        -- which can precede a rival transaction's even though this one took
        -- the lock second. Bid history is ordered by createdAt, so it must be
        -- the moment of acceptance.
        INSERT INTO bids (id, "auctionId", "bidderId", "amountCents", "idempotencyKey", "createdAt")
        VALUES (${newBidId}, ${auctionId}, ${bid.bidderId}, ${bid.amountCents}, ${bid.idempotencyKey}, clock_timestamp())
        RETURNING id, "auctionId", "bidderId", "amountCents", "idempotencyKey", "createdAt"
      ),
      updated_auction AS (
        UPDATE auctions
        SET "currentPriceCents" = ${bid.amountCents}, "endTime" = ${finalEndTime}
        WHERE id = ${auctionId}
        RETURNING id
      ),
      reindex_event AS (
        INSERT INTO outbox_events (id, topic, key, payload, "createdAt")
        SELECT ${reindexEventId}, ${SEARCH_EVENTS_TOPIC}, ${auctionId}, ${reindexPayload}::jsonb, now()
        FROM updated_auction
        RETURNING id
      ),
      outbid_event AS (
        INSERT INTO outbox_events (id, topic, key, payload, "createdAt")
        -- No event for an auction's first bid (prev is empty), or for a
        -- bidder re-outbidding themselves. Keyed by auctionId (Section 15).
        SELECT ${outbidEventId}, 'bid-events', ${auctionId},
          jsonb_build_object(
            'type', 'bid.outbid',
            'auctionId', ${auctionId}::text,
            'outbidUserId', prev."bidderId",
            'previousAmountCents', prev."amountCents",
            'newAmountCents', ${bid.amountCents}::int
          ),
          now()
        FROM new_bid, prev
        WHERE prev."bidderId" <> ${bid.bidderId}
        RETURNING id
      )
      SELECT nb.id, nb."auctionId", nb."bidderId", nb."amountCents", nb."idempotencyKey", nb."createdAt"
      FROM new_bid nb
      LEFT JOIN updated_auction ua ON true
      LEFT JOIN reindex_event re ON true
      LEFT JOIN outbid_event oe ON true
    `;

    return { bid: rowsWritten[0] as Bid, extended: extendedEndTime !== null };
  });
}
