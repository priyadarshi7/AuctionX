import type { AuctionValuation, Prisma } from '@prisma/client';
import { prisma } from '../../infrastructure/database/prisma';
import { createOutboxEventInTx } from '../../infrastructure/outbox/repository';
import { AI_VALUATION_EVENTS_TOPIC } from '../../infrastructure/kafka/topics';
import type { ValuationResult } from '../../infrastructure/ai/valuationProvider';

export function findValuationByAuctionId(auctionId: string): Promise<AuctionValuation | null> {
  return prisma.auctionValuation.findUnique({ where: { auctionId } });
}

// Upsert + outbox event, together, inside the CALLER's transaction —
// exactly the Outbox pattern's own reasoning (Section 16): the event and
// the row it describes must become durable atomically, or a crash between
// the two could leave a PENDING valuation with no event ever published
// (stuck forever, silently). Takes `tx` rather than opening its own
// transaction so this same helper works both nested inside
// auctions/repository.ts's createAuction transaction (the initial trigger)
// and inside modules/ai/service.ts's own standalone transaction
// (regenerate, and the lazy-backfill case on GET).
//
// Upsert, not a plain create — this is called both when no row exists yet
// (createAuction) AND when a COMPLETE or FAILED row from an earlier attempt
// already exists (regenerate). Every result field is cleared on update so a
// stale COMPLETE result can never be shown alongside a FAILED/PENDING
// status or vice versa.
export async function requestValuationInTx(tx: Prisma.TransactionClient, auctionId: string): Promise<AuctionValuation> {
  const row = await tx.auctionValuation.upsert({
    where: { auctionId },
    create: { auctionId, status: 'PENDING' },
    update: {
      status: 'PENDING',
      estimatedValueCents: null,
      priceRangeLowCents: null,
      priceRangeHighCents: null,
      confidence: null,
      explanation: null,
      model: null,
      errorMessage: null,
    },
  });
  await createOutboxEventInTx(tx, {
    topic: AI_VALUATION_EVENTS_TOPIC,
    key: auctionId,
    payload: { type: 'auction.valuate', auctionId },
  });
  return row;
}

export function markValuationComplete(auctionId: string, result: ValuationResult): Promise<AuctionValuation> {
  return prisma.auctionValuation.update({
    where: { auctionId },
    data: {
      status: 'COMPLETE',
      estimatedValueCents: result.estimatedValueCents,
      priceRangeLowCents: result.priceRangeLowCents,
      priceRangeHighCents: result.priceRangeHighCents,
      confidence: result.confidence,
      explanation: result.explanation,
      model: result.model,
      errorMessage: null,
    },
  });
}

export function markValuationFailed(auctionId: string, errorMessage: string): Promise<AuctionValuation> {
  return prisma.auctionValuation.update({
    where: { auctionId },
    data: { status: 'FAILED', errorMessage },
  });
}
