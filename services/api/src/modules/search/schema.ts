import { z } from 'zod';
import { AuctionCategory, AuctionStatus } from '@prisma/client';

// Same MAX_PRICE_CENTS sanity bound as auctions/schema.ts — a range filter
// on the same field deserves the same bound, not a fresh made-up number.
const MAX_PRICE_CENTS = 2_000_000_000;

export const searchAuctionsQuerySchema = z
  .object({
    // Optional — no `q` still returns a valid, filtered, newest-first
    // browse of the index (repository.ts's queryAuctions), not an error.
    q: z.string().trim().min(1).max(200).optional(),
    category: z.nativeEnum(AuctionCategory).optional(),
    status: z.nativeEnum(AuctionStatus).optional(),
    minPriceCents: z.coerce.number().int().nonnegative().max(MAX_PRICE_CENTS).optional(),
    maxPriceCents: z.coerce.number().int().nonnegative().max(MAX_PRICE_CENTS).optional(),
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(50).default(20),
  })
  .refine((data) => data.minPriceCents === undefined || data.maxPriceCents === undefined || data.maxPriceCents >= data.minPriceCents, {
    message: 'maxPriceCents cannot be less than minPriceCents',
    path: ['maxPriceCents'],
  });

export type SearchAuctionsQuery = z.infer<typeof searchAuctionsQuerySchema>;
