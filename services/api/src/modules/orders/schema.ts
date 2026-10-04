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

// The 6-digit delivery code the buyer was shown (ADR-0045).
export const confirmDeliverySchema = z.object({
  code: z
    .string()
    .trim()
    .regex(/^[0-9]{6}$/, 'Enter the 6-digit delivery code'),
});

export type ConfirmDeliveryInput = z.infer<typeof confirmDeliverySchema>;

// The shipping address is validated in the service against
// shippingAddressSchema (address.ts); the route only needs an object.
export const shippingAddressBodySchema = z.record(z.string(), z.unknown());
