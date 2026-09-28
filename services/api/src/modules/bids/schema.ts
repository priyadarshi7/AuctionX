import { z } from 'zod';

// Matches auctions' MAX_PRICE_CENTS (ADR-0007) — same money domain, same
// sanity ceiling, so a bid can never be a value an auction's own price
// fields couldn't hold.
const MAX_BID_CENTS = 2_000_000_000;

export const placeBidSchema = z.object({
  amountCents: z.number().int().positive().max(MAX_BID_CENTS),
  // Required, not optional — unlike registration (which has email as a
  // natural uniqueness key), bid placement has nothing else to deduplicate
  // on (Section 11; ADR-0011). The client must supply one.
  idempotencyKey: z.string().trim().min(1).max(255),
});

export type PlaceBidInput = z.infer<typeof placeBidSchema>;

// No cursor pagination here, unlike auctions' listing (ADR-0008) — this
// endpoint's current purpose is observing/verifying bid history and the
// eventual winner, not the Section 46 hot-auction-scale case. Deep paging
// through thousands of bids isn't a stated requirement yet; the exact same
// keyset pattern from auctions/schema.ts can be applied here later if it
// becomes one.
export const listBidsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export type ListBidsQuery = z.infer<typeof listBidsQuerySchema>;
