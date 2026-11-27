import { AuctionCategory, AuctionCondition } from '@prisma/client';
import { z } from 'zod';
import { env } from '../../config/env';

// What the seller has typed so far. Everything is optional except that there
// must be something to work from.
export const listingSuggestionRequestSchema = z
  .object({
    title: z.string().trim().max(200).default(''),
    description: z.string().trim().max(5000).default(''),
    category: z.nativeEnum(AuctionCategory),
    condition: z.nativeEnum(AuctionCondition),
    // Only our own uploads (same rule as auctions/schema.ts). It matters more
    // here: the server may download these, so arbitrary URLs would let a
    // caller make it fetch any address (SSRF).
    images: z
      .array(
        z
          .string()
          .url()
          .startsWith(`${env.S3_PUBLIC_URL_BASE}/`, "Image URL must come from this application's uploads"),
      )
      .max(10)
      .default([]),
  })
  .refine((data) => data.title !== '' || data.images.length > 0, {
    message: 'Add a title or at least one photo first',
    path: ['title'],
  });

export type ListingSuggestionRequest = z.infer<typeof listingSuggestionRequestSchema>;

// The model's reply. Lists are trimmed rather than rejected: one item too many
// is not a reason to throw away a good answer.
const text = (max: number) =>
  z
    .string()
    .transform((value) => value.trim().slice(0, max))
    .catch('');
const list = (max: number) =>
  z
    .array(z.unknown())
    .catch([])
    .transform((items) =>
      items
        .filter((item): item is string => typeof item === 'string' && item.trim() !== '')
        .slice(0, max)
        .map((item) => item.trim().slice(0, 240)),
    );

export const listingSuggestionSchema = z.object({
  title: z
    .string()
    .trim()
    .min(1)
    .transform((value) => value.slice(0, 200)),
  description: z
    .string()
    .trim()
    .min(1)
    .transform((value) => value.slice(0, 5000)),
  category: z.nativeEnum(AuctionCategory).nullable().catch(null),
  condition: z.nativeEnum(AuctionCondition).nullable().catch(null),
  conditionReason: text(240),
  missingDetails: z
    .array(z.unknown())
    .catch([])
    .transform((items) =>
      items
        .map((item) => z.object({ label: z.string().min(1).max(60), why: text(240) }).safeParse(item))
        .flatMap((result) => (result.success ? [result.data] : []))
        .slice(0, 6),
    ),
  photoTips: list(5),
  concerns: list(4),
});

export type ListingSuggestion = z.infer<typeof listingSuggestionSchema>;
