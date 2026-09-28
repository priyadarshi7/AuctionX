import type { AuctionValuation } from '@prisma/client';
import { prisma } from '../../infrastructure/database/prisma';
import { ForbiddenError, NotFoundError } from '../../middleware/errors';
import { findAuctionById } from '../auctions/repository';
import { findValuationByAuctionId, requestValuationInTx } from './repository';

// Mirrors modules/auctions/service.ts's own requireOwnedAuction exactly
// (404 for a DRAFT auction owned by someone else — an invisible listing's
// existence must not leak via a 403; 403 for anything else not owned, since
// that auction's existence is already public via GET /auctions/:id). Not
// imported from there — it isn't exported, and duplicating five lines here
// is simpler than widening that module's public surface for one caller.
async function requireOwnedAuction(userId: string, auctionId: string) {
  const auction = await findAuctionById(auctionId);
  if (!auction || (auction.status === 'DRAFT' && auction.sellerId !== userId)) {
    throw new NotFoundError('Auction not found');
  }
  if (auction.sellerId !== userId) {
    throw new ForbiddenError('You do not own this auction');
  }
  return auction;
}

// Seller-only, unlike GET /auctions/:id — an AI valuation is a private
// pricing signal for the seller deciding how to list, not something a
// bidder should see (Section 20's stated use case is the seller, and
// showing a bidder "the AI thinks this is worth less than the asking
// price" would actively work against the seller for no product reason).
export async function getValuation(userId: string, auctionId: string): Promise<AuctionValuation> {
  await requireOwnedAuction(userId, auctionId);

  const existing = await findValuationByAuctionId(auctionId);
  if (existing) {
    return existing;
  }

  // Lazy backfill: an auction created before this feature existed (or
  // before the AuctionValuation write in createAuction shipped) has no row
  // yet. ADR-0031 found the hard way that a derived-data feature which only
  // ever triggers on a NEW mutation leaves every pre-existing row stranded
  // forever unless something explicitly backfills it. Rather than repeating
  // that mistake and needing a second reindex-style script, the first GET
  // for a row-less auction creates one PENDING and triggers it right here.
  return prisma.$transaction((tx) => requestValuationInTx(tx, auctionId));
}

// Re-triggers valuation from scratch — for a FAILED row (Ollama was down,
// or the model produced garbage), or simply because the seller wants a
// fresh opinion. Allowed regardless of auction status: modules/auctions/
// service.ts already restricts editing (title/description/images) to
// DRAFT only, so the INPUT to valuation can't have changed after that —
// this is purely "ask the model again," never "value new content."
export async function regenerateValuation(userId: string, auctionId: string): Promise<AuctionValuation> {
  await requireOwnedAuction(userId, auctionId);
  return prisma.$transaction((tx) => requestValuationInTx(tx, auctionId));
}
