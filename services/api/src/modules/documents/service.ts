import type { AuctionDocument, Role } from '@prisma/client';
import {
  createPresignedDocumentUpload,
  createSignedDocumentUrl,
  deleteDocumentObject,
  documentKeyPrefix,
  headDocumentObject,
  MAX_DOCUMENT_BYTES,
  readDocumentObject,
  type DocumentContentType,
} from '../../infrastructure/storage/documents';
import { AppError, ConflictError, NotFoundError, ValidationError } from '../../middleware/errors';
import { findAuctionById } from '../auctions/repository';
import {
  countDocumentsForAuction,
  createDocumentWithinLimit,
  deleteDocumentRow,
  findDocument,
  listDocumentsForAuction,
} from './repository';
import type { RegisterDocumentInput } from './schema';
import { ClamavUnavailableError } from '../../infrastructure/security/clamav';
import { scanDocument } from '../../infrastructure/storage/documentScan';

// Enforced exactly at registration (createDocumentWithinLimit locks the
// auction row); the earlier checks only fail fast before an upload.
export const MAX_DOCUMENTS_PER_AUCTION = 5;

export type DocumentView = {
  id: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  createdAt: Date;
  // Short-lived signed link. Present on list responses only.
  url?: string;
};

function toView(doc: AuctionDocument): DocumentView {
  return {
    id: doc.id,
    fileName: doc.fileName,
    contentType: doc.contentType,
    sizeBytes: doc.sizeBytes,
    createdAt: doc.createdAt,
  };
}

// Writing is the seller's, and only while the listing is a DRAFT. Once it is
// submitted the paperwork is frozen, so the admin approves exactly what was
// submitted and a seller can't swap documents after approval. A non-owner
// gets 404 (not 403): whether this seller has documents is none of their
// business.
async function requireEditableOwnedAuction(userId: string, auctionId: string) {
  const auction = await findAuctionById(auctionId);
  if (!auction || auction.sellerId !== userId) {
    throw new NotFoundError('Auction not found');
  }
  if (auction.status !== 'DRAFT') {
    throw new ConflictError('DOCUMENTS_LOCKED', 'Documents can only be changed while the auction is a draft');
  }
  return auction;
}

export async function requestDocumentUpload(userId: string, auctionId: string, contentType: DocumentContentType) {
  await requireEditableOwnedAuction(userId, auctionId);
  if ((await countDocumentsForAuction(auctionId)) >= MAX_DOCUMENTS_PER_AUCTION) {
    throw new ConflictError('TOO_MANY_DOCUMENTS', `An auction can have at most ${MAX_DOCUMENTS_PER_AUCTION} documents`);
  }
  return createPresignedDocumentUpload(auctionId, contentType);
}

export async function registerDocument(
  userId: string,
  auctionId: string,
  input: RegisterDocumentInput,
): Promise<DocumentView> {
  await requireEditableOwnedAuction(userId, auctionId);

  // The key must be one we issued for THIS auction. Without this a seller
  // could register someone else's object (or another auction's) as their own.
  if (!input.objectKey.startsWith(documentKeyPrefix(auctionId))) {
    throw new ValidationError({ objectKey: ['Invalid document key'] });
  }
  if ((await countDocumentsForAuction(auctionId)) >= MAX_DOCUMENTS_PER_AUCTION) {
    throw new ConflictError('TOO_MANY_DOCUMENTS', `An auction can have at most ${MAX_DOCUMENTS_PER_AUCTION} documents`);
  }

  // Believe the bucket, not the client.
  const head = await headDocumentObject(input.objectKey);
  if (!head) {
    throw new ValidationError({ objectKey: ['No uploaded file found for this key'] });
  }
  if (head.sizeBytes > MAX_DOCUMENT_BYTES) {
    await deleteDocumentObject(input.objectKey);
    throw new ValidationError({ objectKey: ['File is too large'] });
  }

  // Scan what is really in the bucket before it can ever be shown to an
  // admin. A refused file is deleted. If the scanner itself is down we do NOT
  // delete or accept: the seller retries (fail closed, ADR-0043).
  let verdict;
  try {
    verdict = await scanDocument(await readDocumentObject(input.objectKey), head.contentType ?? input.contentType);
  } catch (err) {
    if (err instanceof ClamavUnavailableError) {
      throw new AppError(503, 'SCAN_UNAVAILABLE', 'We could not scan this file right now. Please try again shortly.');
    }
    throw err;
  }
  if (!verdict.ok) {
    await deleteDocumentObject(input.objectKey);
    throw new ValidationError({ objectKey: [verdict.reason] }, 'This file was rejected');
  }

  try {
    const doc = await createDocumentWithinLimit(
      {
        auctionId,
        uploaderId: userId,
        objectKey: input.objectKey,
        fileName: input.fileName,
        contentType: head.contentType ?? input.contentType,
        sizeBytes: head.sizeBytes,
      },
      MAX_DOCUMENTS_PER_AUCTION,
    );
    if (doc === 'FULL') {
      await deleteDocumentObject(input.objectKey);
      throw new ConflictError('TOO_MANY_DOCUMENTS', `An auction can have at most ${MAX_DOCUMENTS_PER_AUCTION} documents`);
    }
    if (doc === 'LOCKED') {
      await deleteDocumentObject(input.objectKey);
      throw new ConflictError('DOCUMENTS_LOCKED', 'Documents can only be changed while the auction is a draft');
    }
    return toView(doc);
  } catch (err) {
    // objectKey is unique: registering the same upload twice.
    if ((err as { code?: string }).code === 'P2002') {
      throw new ConflictError('DOCUMENT_ALREADY_REGISTERED', 'This upload has already been added');
    }
    throw err;
  }
}

// Seller (the owner) or an admin. Everyone else gets 404, whatever the
// auction's status: documents are never public, even after approval.
export async function listDocuments(
  user: { id: string; role: Role },
  auctionId: string,
): Promise<DocumentView[]> {
  const auction = await findAuctionById(auctionId);
  if (!auction) {
    throw new NotFoundError('Auction not found');
  }
  if (auction.sellerId !== user.id && user.role !== 'ADMIN') {
    throw new NotFoundError('Auction not found');
  }
  const docs = await listDocumentsForAuction(auctionId);
  return Promise.all(
    docs.map(async (doc) => ({ ...toView(doc), url: await createSignedDocumentUrl(doc.objectKey, doc.fileName) })),
  );
}

export async function removeDocument(userId: string, auctionId: string, documentId: string): Promise<void> {
  await requireEditableOwnedAuction(userId, auctionId);
  const doc = await findDocument(documentId);
  // Same 404 for "doesn't exist" and "belongs to a different auction".
  if (!doc || doc.auctionId !== auctionId) {
    throw new NotFoundError('Document not found');
  }
  await deleteDocumentRow(documentId);
  await deleteDocumentObject(doc.objectKey);
}
