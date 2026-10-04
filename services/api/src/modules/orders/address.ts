import { z } from 'zod';

// The delivery address a buyer gives for an order (ADR-0045). Stored as a
// validated JSON object on the order. Bounded and character-restricted so it
// cannot be used as a free-form payload channel; everything is trimmed.
const text = (min: number, max: number, label: string) =>
  z
    .string()
    .trim()
    .min(min, `Enter ${label}`)
    .max(max)
    // No control characters (newlines, NULs): this ends up on a label. The
    // control-character range is the whole point of this pattern.
    // eslint-disable-next-line no-control-regex
    .regex(/^[^\u0000-\u001f\u007f]*$/, `${label} contains invalid characters`);

export const shippingAddressSchema = z.object({
  fullName: text(2, 100, 'the recipient’s full name'),
  line1: text(3, 120, 'the street address'),
  line2: text(0, 120, 'the address line').optional().default(''),
  city: text(1, 80, 'the city'),
  region: text(1, 80, 'the state or region'),
  postalCode: z
    .string()
    .trim()
    .min(3, 'Enter the postal code')
    .max(12)
    .regex(/^[A-Za-z0-9][A-Za-z0-9 -]*$/, 'Enter a valid postal code'),
  // ISO 3166-1 alpha-2, e.g. "IN", "US".
  country: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{2}$/, 'Use the 2-letter country code, for example IN or US'),
  phone: z
    .string()
    .trim()
    .regex(/^\+?[0-9][0-9 ()-]{6,18}$/, 'Enter a valid phone number'),
});

export type ShippingAddress = z.infer<typeof shippingAddressSchema>;
