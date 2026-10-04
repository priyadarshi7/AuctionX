// Section 19's payment flow names a real external Payment Provider. This
// interface is the seam between that flow and any specific provider — the
// same pattern as infrastructure/email/sender.ts's EmailSender: business
// logic (modules/payments, modules/orders) depends only on this interface,
// never on a concrete provider. Two implementations exist: MockPaymentProvider
// (local dev and tests) and StripePaymentProvider (Stripe Checkout, test mode
// only — see stripeProvider.ts and ADR-0044).

export type CreatePaymentIntentInput = {
  orderId: string;
  amountCents: number;
  // Ours, not the provider's — generated when we create the Payment row,
  // used to make "create an intent for this order" itself idempotent
  // (Section 11). Real providers (Stripe included) accept an
  // Idempotency-Key precisely so a network retry of this same call can't
  // create two intents for one order.
  idempotencyKey: string;
  // What the buyer sees on the provider's page.
  description: string;
  // Where the provider sends the buyer back to (the order page).
  returnUrl: string;
};

export type CreatePaymentIntentResult = {
  // The provider's id for the object we just created — opaque to us,
  // stored so an incoming webhook can be correlated back to this Payment.
  providerRef: string;
  status: 'PENDING';
  // Hosted-checkout providers: where to send the buyer to pay. Null for the
  // mock, which "pays" by itself.
  checkoutUrl: string | null;
};

// A webhook may only tell us that a providerRef changed state. The amount
// that gets marked paid always comes from the Payment row we created. An
// event MAY carry the amount the provider actually collected, and if it does
// it is used only as a tripwire: a mismatch with our own record means the
// payment is NOT applied and is logged loudly (Section 19).
export type PaymentWebhookEvent =
  | { type: 'payment.succeeded'; providerRef: string; amountCents?: number }
  | { type: 'payment.failed'; providerRef: string };

// The provider's current view of one payment, asked directly rather than
// waited for. Used to reconcile when a webhook is late or missing.
export type PaymentStatusSnapshot =
  | { state: 'paid'; amountCents: number }
  | { state: 'open'; checkoutUrl: string | null }
  | { state: 'expired' };

export interface PaymentProvider {
  readonly name: string;
  // The HTTP header carrying the webhook signature for this provider.
  readonly signatureHeader: string;
  createPaymentIntent(input: CreatePaymentIntentInput): Promise<CreatePaymentIntentResult>;
  // Throws on a missing/invalid signature or unparseable body — callers
  // never get an event out of this without it being verified first.
  // Returns null for a verified event we deliberately do not act on.
  // rawBody must be the exact bytes the provider signed (Section 28), which is
  // why the webhook route must NOT run express.json() ahead of this call.
  verifyWebhookEvent(rawBody: Buffer, signatureHeader: string | undefined): PaymentWebhookEvent | null;
  fetchStatus(providerRef: string): Promise<PaymentStatusSnapshot>;
  // Returns the provider's id for the refund. Idempotent per idempotencyKey.
  refund(providerRef: string, idempotencyKey: string): Promise<{ refundRef: string }>;
}
