import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '../../config/env';

// The one-time code that proves a handover happened (ADR-0045). The buyer is
// shown it; the seller must enter it to mark the order DELIVERED.
//
// DERIVED, never stored: HMAC-SHA256 over "orderId:version" with a key that is
// domain-separated from the JWT use of the same secret. So there is no
// plaintext (or even hash) in the database to leak, the buyer can be shown the
// same code again on every visit, and "regenerate" is just version + 1.
//
// Six digits is only ~20 bits, so the safety is the attempt cap, not the
// entropy: after MAX_DELIVERY_CODE_ATTEMPTS wrong guesses on a version the
// order is locked until the BUYER regenerates (the seller cannot).
export const MAX_DELIVERY_CODE_ATTEMPTS = 5;

export function deliveryCodeFor(orderId: string, version: number): string {
  const digest = createHmac('sha256', `delivery-otp:${env.JWT_ACCESS_SECRET}`)
    .update(`${orderId}:${version}`)
    .digest();
  return String(digest.readUInt32BE(0) % 1_000_000).padStart(6, '0');
}

export function deliveryCodesMatch(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
