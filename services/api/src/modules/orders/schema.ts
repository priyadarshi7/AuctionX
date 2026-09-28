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
