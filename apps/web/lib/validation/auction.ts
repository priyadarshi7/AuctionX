import { z } from 'zod';
import { AUCTION_CATEGORIES, AUCTION_CONDITIONS } from '@/lib/types/auction';

// Price is deliberately NOT collected here — see app/auctions/new/page.tsx's
// comment: the seller sees the AI valuation (ADR-0032) before setting a
// price, on the auction's own DRAFT page, not on this initial form.
export const createAuctionFormSchema = z.object({
  title: z.string().trim().min(1, 'Title is required').max(200),
  description: z.string().trim().min(1, 'Description is required').max(5000),
  category: z.enum(AUCTION_CATEGORIES),
  condition: z.enum(AUCTION_CONDITIONS),
});

export type CreateAuctionFormValues = z.infer<typeof createAuctionFormSchema>;

// Used on the auction's own DRAFT page (app/auctions/[id]/
// SetPriceAndPublishPanel.tsx), after the seller has had a chance to see
// the AI valuation. Prices stay as strings through validation (form inputs
// are strings; converted to cents only at the API call boundary), same
// convention the old combined create form used. Duration is chosen HERE
// too, not at draft-creation time — "ends in N hours" should count from the
// moment the seller actually commits to publishing.
export const setPriceAndPublishFormSchema = z
  .object({
    startingPrice: z
      .string()
      .trim()
      .min(1, 'Starting price is required')
      .refine((value) => Number(value) > 0, 'Must be greater than 0'),
    reservePrice: z
      .string()
      .trim()
      .refine((value) => value === '' || Number(value) > 0, 'Must be greater than 0')
      .optional(),
    durationHours: z.enum(['1', '6', '24', '72']),
  })
  // Same rule the backend enforces (AUCTION-002/ADR-0007) restated here for
  // fast feedback — duplicated validation is an accepted tradeoff
  // (ADR-0015), not drift, since it's the identical rule in both places.
  .refine(
    (data) =>
      !data.reservePrice ||
      data.reservePrice === '' ||
      Number(data.reservePrice) >= Number(data.startingPrice),
    { message: 'Reserve price cannot be less than the starting price', path: ['reservePrice'] },
  );

export type SetPriceAndPublishFormValues = z.infer<typeof setPriceAndPublishFormSchema>;
