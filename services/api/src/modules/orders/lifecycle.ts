// How long a winner has to pay before the order is cancelled (ADR-0038).
// 48h: long enough for someone who isn't glued to the site, short enough
// that a seller isn't left waiting on a ghost for days. A constant, not
// env config, until there's a real reason to tune it per deployment.
export const ORDER_PAYMENT_WINDOW_MS = 48 * 60 * 60 * 1000;

export function computePaymentDueAt(now: Date): Date {
  return new Date(now.getTime() + ORDER_PAYMENT_WINDOW_MS);
}

// A payment attempt younger than this is treated as "still in flight": the
// provider's webhook may be about to land, so the deadline worker leaves the
// order alone for now rather than cancelling it out from under a payment
// that is about to succeed. Older than this, a still-PENDING attempt is
// considered abandoned and no longer protects the order.
export const IN_FLIGHT_PAYMENT_GRACE_MS = 60 * 60 * 1000;
