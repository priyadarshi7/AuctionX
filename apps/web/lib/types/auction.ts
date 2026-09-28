// Mirrors services/api/prisma/schema.prisma's Auction/Bid models
// (ADR-0007/0011) and their JSON serialization over the wire — Date
// columns become ISO strings once they cross HTTP.
//
// `as const` tuples, not plain string-union types, so the SAME array can
// back both the TypeScript type (via `typeof X[number]`) and a runtime
// `z.enum()` in lib/validation/auction.ts — one definition, not two that
// could drift apart.
export const AUCTION_CATEGORIES = [
  'ART',
  'COLLECTIBLES',
  'JEWELRY',
  'WATCHES',
  'COINS_AND_CURRENCY',
  'MEMORABILIA',
  'BOOKS_AND_MANUSCRIPTS',
  'OTHER',
] as const;
export type AuctionCategory = (typeof AUCTION_CATEGORIES)[number];

export const AUCTION_CONDITIONS = ['NEW', 'LIKE_NEW', 'GOOD', 'FAIR', 'POOR'] as const;
export type AuctionCondition = (typeof AUCTION_CONDITIONS)[number];

export type AuctionStatus = 'DRAFT' | 'PUBLISHED' | 'ACTIVE' | 'PAUSED' | 'CANCELLED' | 'ENDED';

export type Auction = {
  id: string;
  sellerId: string;
  title: string;
  description: string;
  category: AuctionCategory;
  condition: AuctionCondition;
  images: string[];
  startingPriceCents: number;
  reservePriceCents: number | null;
  currentPriceCents: number;
  status: AuctionStatus;
  startTime: string | null;
  endTime: string | null;
  endedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type Bid = {
  id: string;
  auctionId: string;
  bidderId: string;
  amountCents: number;
  idempotencyKey: string;
  createdAt: string;
};

