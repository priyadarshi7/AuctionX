import type { AuctionDocument } from '@prisma/client';
import { prisma } from '../../infrastructure/database/prisma';

// Seller-uploaded supporting paperwork for a listing (ADR-0041). Plain data
// access only; ownership/state rules live in service.ts.

export function countDocumentsForAuction(auctionId: string): Promise<number> {
  return prisma.auctionDocument.count({ where: { auctionId } });
}

// Every stored object key belonging to a seller's auctions, collected BEFORE
// the account's rows are deleted (the cascade removes the rows, after which
// there would be nothing left to say which files to remove).
export async function listObjectKeysForSeller(sellerId: string): Promise<string[]> {
  const rows = await prisma.auctionDocument.findMany({
    where: { auction: { sellerId } },
    select: { objectKey: true },
  });
  return rows.map((r) => r.objectKey);
}

export function listDocumentsForAuction(auctionId: string): Promise<AuctionDocument[]> {
  return prisma.auctionDocument.findMany({ where: { auctionId }, orderBy: { createdAt: 'asc' } });
}

export function findDocument(id: string): Promise<AuctionDocument | null> {
  return prisma.auctionDocument.findUnique({ where: { id } });
}

export type NewDocument = {
  auctionId: string;
  uploaderId: string;
  objectKey: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
};

// Registers a document under the auction row's lock, so the cap and the
// "still a DRAFT" rule are exact under concurrency: two simultaneous
// registrations (or a registration racing the seller's submit, whose guarded
// UPDATE takes the same row lock) serialize, and the second one sees the
// first one's effect.
export function createDocumentWithinLimit(
  data: NewDocument,
  max: number,
): Promise<AuctionDocument | 'FULL' | 'LOCKED'> {
  return prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<{ status: string }[]>`
      SELECT status::text AS status FROM auctions WHERE id = ${data.auctionId} FOR UPDATE
    `;
    if (rows[0]?.status !== 'DRAFT') return 'LOCKED' as const;
    if ((await tx.auctionDocument.count({ where: { auctionId: data.auctionId } })) >= max) return 'FULL' as const;
    return tx.auctionDocument.create({ data });
  });
}

export function deleteDocumentRow(id: string): Promise<AuctionDocument> {
  return prisma.auctionDocument.delete({ where: { id } });
}
