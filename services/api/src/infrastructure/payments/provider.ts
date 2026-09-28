// Section 19's payment flow names a real external Payment Provider. This
// interface is the seam between that flow and any specific provider — the
// same pattern as infrastructure/email/sender.ts's EmailSender: business
// logic (modules/payments, modules/orders) depends only on this interface,
// never on a concrete provider, so swapping Mock for a real Stripe/Razorpay
// implementation later touches one file, not every caller.

export type CreatePaymentIntentInput = {
  orderId: string;
  amountCents: number;
  // Ours, not the provider's — generated when we create the Payment row,
  // used to make "create an intent for this order" itself idempotent
  // (Section 11). Real providers (Stripe included) accept an
  // Idempotency-Key precisely so a network retry of this same call can't
  // create two intents for one order.
  idempotencyKey: string;
};

export type CreatePaymentIntentResult = {
  // The provider's id for the object we just created — opaque to us,
  // stored so an incoming webhook can be correlated back to this Payment.
  providerRef: string;
  status: 'PENDING';
};

// Deliberately just {type, providerRef} — NEVER an amount. Section 19: never
// trust a client-or-provider-supplied claim about money against anything
// but our own records. The only thing a webhook is allowed to tell us is
// "this providerRef changed state"; the amount that actually gets marked
// paid always comes from the Payment row we ourselves created, not from
// whatever a webhook payload claims.
export type PaymentWebhookEvent =
  | { type: 'payment.succeeded'; providerRef: string }
  | { type: 'payment.failed'; providerRef: string };

export interface PaymentProvider {
  readonly name: string;
  createPaymentIntent(input: CreatePaymentIntentInput): Promise<CreatePaymentIntentResult>;
  // Throws on a missing/invalid signature or unparseable body — callers
  // never get a PaymentWebhookEvent out of this without it being verified
  // first. rawBody must be the exact bytes the provider signed (Section 28
  // — signature verification breaks if the body is re-serialized from
  // parsed JSON first), which is why the webhook route must NOT run
  // express.json() ahead of this call.
  verifyWebhookEvent(rawBody: Buffer, signatureHeader: string | undefined): PaymentWebhookEvent;
}
