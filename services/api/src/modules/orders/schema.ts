import { z } from 'zod';

// Client-generated, per Section 11 — the same idempotency pattern as bids'
// body-field `idempotencyKey` (bids/schema.ts), not a header. Scoped to
// this order by the frontend regenerating it per fresh "Pay" attempt (a
// page reload or a retry after a FAILED payment should send a NEW key; a
// double-click within the same attempt should send the SAME one).
export const payOrderSchema = z.object({
  idempotencyKey: z.string().min(1).max(200),
});

export type PayOrderInput = z.infer<typeof payOrderSchema>;

// Free-text on purpose: carriers are too many and too regional to enumerate
// (this is a marketplace, not a shipping-API integration), and the server
// doesn't act on the value. Trimmed and length-bounded so it can't be empty
// or abused as a large-payload channel.
export const shipOrderSchema = z.object({
  carrier: z.string().trim().min(1, 'Enter the carrier').max(100),
  trackingNumber: z.string().trim().min(1, 'Enter the tracking number').max(100),
});

export type ShipOrderInput = z.infer<typeof shipOrderSchema>;
