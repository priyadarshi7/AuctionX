import type { AuctionDocument } from '@prisma/client';
import { prisma } from '../../infrastructure/database/prisma';

// Seller-uploaded supporting paperwork for a listing (ADR-0041). Plain data
// access only; ownership/state rules live in service.ts.

export function countDocumentsForAuction(auctionId: string): Promise<number> {
  return prisma.auctionDocument.count({ where: { auctionId } });
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

export function createDocument(data: NewDocument): Promise<AuctionDocument> {
  return prisma.auctionDocument.create({ data });
}

export function deleteDocumentRow(id: string): Promise<AuctionDocument> {
  return prisma.auctionDocument.delete({ where: { id } });
}
