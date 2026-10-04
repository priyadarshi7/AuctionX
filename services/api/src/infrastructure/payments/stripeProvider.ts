import Stripe from 'stripe';
import type {
  CreatePaymentIntentInput,
  CreatePaymentIntentResult,
  PaymentProvider,
  PaymentStatusSnapshot,
  PaymentWebhookEvent,
} from './provider';

// Stripe Checkout (the hosted payment page), TEST MODE ONLY. The buyer is
// redirected to Stripe, so card details never touch this server or our
// frontend. Three independent guards keep real money out (ADR-0044):
//   1. config/env.ts refuses to boot with anything but an sk_test_/rk_test_ key;
//   2. every Checkout Session we create must report livemode === false;
//   3. every webhook event must report livemode === false.
// Test-mode keys cannot charge a real card even if the other two failed; they
// exist so a configuration mistake fails loudly instead of quietly working.

export class StripePaymentProvider implements PaymentProvider {
  readonly name = 'stripe';
  readonly signatureHeader = 'stripe-signature';
  private readonly stripe: Stripe;

  constructor(
    secretKey: string,
    private readonly webhookSecret: string | undefined,
    private readonly currency: string,
  ) {
    // Explicit timeout and bounded retries (Section 67): a hung Stripe call
    // must not hang the buyer's request forever. Retries are safe because
    // every mutating call below carries an idempotency key.
    this.stripe = new Stripe(secretKey, { timeout: 15_000, maxNetworkRetries: 2 });
  }

  async createPaymentIntent(input: CreatePaymentIntentInput): Promise<CreatePaymentIntentResult> {
    // No time-based parameters (such as expires_at): Stripe rejects a repeat of
    // an idempotency key whose parameters differ at all, so two concurrent
    // identical pay requests would otherwise fail one of them. The session
    // therefore lives for Stripe's default 24 hours; an unpaid one is settled
    // as expired by fetchStatus / the checkout.session.expired webhook.
    const session = await this.stripe.checkout.sessions.create(
      {
        mode: 'payment',
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: this.currency,
              unit_amount: input.amountCents,
              product_data: { name: input.description },
            },
          },
        ],
        client_reference_id: input.orderId,
        metadata: { orderId: input.orderId },
        success_url: `${input.returnUrl}?payment=success`,
        cancel_url: `${input.returnUrl}?payment=cancelled`,
      },
      { idempotencyKey: `checkout-${input.orderId}-${input.idempotencyKey}` },
    );

    if (session.livemode) {
      throw new Error('Refusing a live-mode Stripe session: this deployment is test-mode only');
    }
    if (!session.url) {
      throw new Error('Stripe did not return a checkout URL');
    }
    return { providerRef: session.id, status: 'PENDING', checkoutUrl: session.url };
  }

  verifyWebhookEvent(rawBody: Buffer, signatureHeader: string | undefined): PaymentWebhookEvent | null {
    if (!this.webhookSecret) {
      throw new Error('Stripe webhooks are not configured (STRIPE_WEBHOOK_SECRET is unset)');
    }
    if (!signatureHeader) {
      throw new Error('Missing Stripe-Signature header');
    }
    // Verifies the HMAC over the exact raw bytes and rejects timestamps older
    // than the SDK's tolerance (replay protection). Throws on any mismatch.
    const event = this.stripe.webhooks.constructEvent(rawBody, signatureHeader, this.webhookSecret);
    if (event.livemode) {
      throw new Error('Refusing a live-mode Stripe event: this deployment is test-mode only');
    }

    switch (event.type) {
      case 'checkout.session.completed':
      case 'checkout.session.async_payment_succeeded': {
        const session = event.data.object;
        // "completed" can arrive before the money has settled for delayed
        // payment methods; only a session reporting paid counts.
        if (session.payment_status !== 'paid') return null;
        if (session.currency !== this.currency) {
          throw new Error(`Unexpected currency on a paid session: ${session.currency ?? 'none'}`);
        }
        return {
          type: 'payment.succeeded',
          providerRef: session.id,
          ...(session.amount_total !== null ? { amountCents: session.amount_total } : {}),
        };
      }
      case 'checkout.session.expired':
      case 'checkout.session.async_payment_failed':
        return { type: 'payment.failed', providerRef: event.data.object.id };
      default:
        return null;
    }
  }

  async fetchStatus(providerRef: string): Promise<PaymentStatusSnapshot> {
    const session = await this.stripe.checkout.sessions.retrieve(providerRef);
    if (session.livemode) {
      throw new Error('Refusing a live-mode Stripe session: this deployment is test-mode only');
    }
    if (session.payment_status === 'paid') {
      return { state: 'paid', amountCents: session.amount_total ?? 0 };
    }
    if (session.status === 'expired') {
      return { state: 'expired' };
    }
    return { state: 'open', checkoutUrl: session.url };
  }

  async refund(providerRef: string, idempotencyKey: string): Promise<{ refundRef: string }> {
    const session = await this.stripe.checkout.sessions.retrieve(providerRef);
    const paymentIntent = typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id;
    if (!paymentIntent) {
      throw new Error('This Checkout Session has no payment to refund');
    }
    const refund = await this.stripe.refunds.create(
      { payment_intent: paymentIntent, reason: 'requested_by_customer', metadata: { checkoutSession: providerRef } },
      { idempotencyKey },
    );
    return { refundRef: refund.id };
  }
}
