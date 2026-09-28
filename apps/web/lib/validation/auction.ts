import { z } from 'zod';
import { AUCTION_CATEGORIES, AUCTION_CONDITIONS } from '@/lib/types/auction';

// Prices stay as strings through validation (form inputs are strings, and
// an empty optional field is '' — fighting z.coerce.number() over that is
// more friction than it saves). Converted to cents only at the API call
// boundary (app/auctions/new/page.tsx), mirroring the backend's own
// integer-cents convention (ADR-0007) without asking the user to think in
// cents themselves.
export const createAuctionFormSchema = z
  .object({
    title: z.string().trim().min(1, 'Title is required').max(200),
    description: z.string().trim().min(1, 'Description is required').max(5000),
    category: z.enum(AUCTION_CATEGORIES),
    condition: z.enum(AUCTION_CONDITIONS),
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
    // Duration, not a raw endTime — publishing computes endTime as
    // now + duration at submit time (mirroring the backend's own
    // "startTime defaults to now" reasoning, AUCTION-004) rather than
    // asking a seller using this simple form to pick an absolute
    // date/time.
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

export type CreateAuctionFormValues = z.infer<typeof createAuctionFormSchema>;
