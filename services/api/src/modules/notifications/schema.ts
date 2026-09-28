import { z } from 'zod';

// Same reasoning as bids' listBidsQuerySchema (ADR-0011) — a notification
// feed is bounded, recent-first browsing, not Section 46-scale deep paging.
export const listNotificationsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export type ListNotificationsQuery = z.infer<typeof listNotificationsQuerySchema>;
