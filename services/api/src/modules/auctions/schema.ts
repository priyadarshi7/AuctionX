import { z } from 'zod';
import { AuctionCategory, AuctionCondition, AuctionStatus } from '@prisma/client';
import { env } from '../../config/env';

// Upper bound comfortably under Postgres Int32's ~2.147B ceiling (ADR-0007's
// accepted ~$21M-per-field limit) — this is a sanity bound on input, not a
// business rule, so it's generous rather than tight.
const MAX_PRICE_CENTS = 2_000_000_000;

// MEDIA-001: every image URL must point at OUR object storage bucket, never
// an arbitrary external URL — a seller's only legitimate way to get a URL
// into this array is the presigned-upload flow (modules/uploads), which
// only ever returns URLs under this exact base. This isn't primarily a
// security boundary (nothing server-side ever fetches these URLs), it's
// data-integrity: without it, a client could submit any URL string at all,
// including a broken or unrelated one, and Section 28 says never trust
// client-controlled values further than necessary.
const imagesSchema = z
  .array(z.string().url().startsWith(env.S3_PUBLIC_URL_BASE, 'Image URL must come from this application\'s uploads'))
  .max(10);

export const createAuctionSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    description: z.string().trim().min(1).max(5000),
    category: z.nativeEnum(AuctionCategory),
    condition: z.nativeEnum(AuctionCondition),
    images: imagesSchema.default([]),
    startingPriceCents: z.number().int().positive().max(MAX_PRICE_CENTS),
    reservePriceCents: z.number().int().positive().max(MAX_PRICE_CENTS).optional(),
  })
  // A reserve below the starting price is meaningless: it would mean the
  // seller accepts less than the price bidding is even allowed to start at.
  .refine(
    (data) => data.reservePriceCents === undefined || data.reservePriceCents >= data.startingPriceCents,
    {
      message: 'reservePriceCents cannot be less than startingPriceCents',
      path: ['reservePriceCents'],
    },
  );

export type CreateAuctionInput = z.infer<typeof createAuctionSchema>;

export const listAuctionsQuerySchema = z.object({
  status: z.nativeEnum(AuctionStatus).optional(),
  category: z.nativeEnum(AuctionCategory).optional(),
  sellerId: z.string().uuid().optional(),
  // z.coerce because query-string values always arrive as strings.
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: z.string().optional(),
});

export type ListAuctionsQuery = z.infer<typeof listAuctionsQuerySchema>;

// Every field optional (a PATCH), but reservePriceCents is also nullable —
// distinct from "omitted" (don't touch it) vs explicit null (clear an
// existing reserve). Verified Zod's .partial() preserves that distinction
// (an omitted key is genuinely absent from the parsed object; an explicit
// null stays present) rather than assuming it.
export const updateAuctionSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    description: z.string().trim().min(1).max(5000),
    category: z.nativeEnum(AuctionCategory),
    condition: z.nativeEnum(AuctionCondition),
    images: imagesSchema,
    startingPriceCents: z.number().int().positive().max(MAX_PRICE_CENTS),
    reservePriceCents: z.number().int().positive().max(MAX_PRICE_CENTS).nullable(),
    startTime: z.coerce.date(),
    endTime: z.coerce.date(),
  })
  .partial()
  // Cheap, early rejection for the common case where both sides of a rule
  // are in the SAME request. This can't be the authoritative check — one
  // side might be omitted here and only exist in the already-stored row —
  // so service.ts re-validates the merged (patch + existing row) values
  // before writing.
  .refine(
    (data) =>
      data.reservePriceCents === undefined ||
      data.reservePriceCents === null ||
      data.startingPriceCents === undefined ||
      data.reservePriceCents >= data.startingPriceCents,
    { message: 'reservePriceCents cannot be less than startingPriceCents', path: ['reservePriceCents'] },
  )
  .refine(
    (data) => data.startTime === undefined || data.endTime === undefined || data.endTime > data.startTime,
    { message: 'endTime must be after startTime', path: ['endTime'] },
  );

export type UpdateAuctionInput = z.infer<typeof updateAuctionSchema>;

// Publishing can set the schedule in the same call rather than forcing a
// separate PATCH first — but it's still optional here because a seller may
// have already set startTime/endTime via update.
export const publishAuctionSchema = z
  .object({
    startTime: z.coerce.date(),
    endTime: z.coerce.date(),
  })
  .partial()
  .refine(
    (data) => data.startTime === undefined || data.endTime === undefined || data.endTime > data.startTime,
    { message: 'endTime must be after startTime', path: ['endTime'] },
  );

export type PublishAuctionInput = z.infer<typeof publishAuctionSchema>;

// A duration, not an end time (ADR-0041): the clock starts when the auction
// goes live, which for a reviewed listing is later than this request. 30s is
// the floor so the whole flow can be exercised quickly in testing.
export const submitAuctionSchema = z.object({
  durationSeconds: z
    .number()
    .int()
    .min(30)
    .max(30 * 24 * 60 * 60),
});

export type SubmitAuctionInput = z.infer<typeof submitAuctionSchema>;
