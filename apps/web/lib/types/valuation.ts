// Mirrors services/api/prisma/schema.prisma's AuctionValuation model
// (ADR-0032) — same Date-becomes-ISO-string-over-HTTP note as
// lib/types/auction.ts.

export type ValuationStatus = 'PENDING' | 'COMPLETE' | 'FAILED';

export type Valuation = {
  id: string;
  auctionId: string;
  status: ValuationStatus;
  // Null while PENDING/FAILED — only populated once status is COMPLETE.
  estimatedValueCents: number | null;
  priceRangeLowCents: number | null;
  priceRangeHighCents: number | null;
  confidence: number | null;
  explanation: string | null;
  model: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
};
