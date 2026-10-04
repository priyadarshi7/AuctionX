import { randomUUID, createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '../../config/env';
import { logger } from '../observability/logger';
import type {
  PaymentProvider,
  PaymentStatusSnapshot,
  PaymentWebhookEvent,
  CreatePaymentIntentInput,
  CreatePaymentIntentResult,
} from './provider';

// How long after "creating an intent" the simulated webhook fires. Short
// enough that a live/manual test doesn't feel broken, long enough to be
// unmistakably asynchronous (Section 19 — payment is never resolved inline
// with the request that started it) and to match this codebase's existing
// precedent of testing real async behavior with a short, real wait rather
// than mocking away the passage of time (see auctions/closing.test.ts's
// "closes an auction for real after a short real-time wait" test).
const WEBHOOK_DELAY_MS = 300;

function sign(rawBody: Buffer): string {
  return createHmac('sha256', env.MOCK_PAYMENT_WEBHOOK_SECRET).update(rawBody).digest('hex');
}

export type WebhookHandler = (rawBody: Buffer, signatureHeader: string | undefined) => Promise<void>;

// Simulates a real, async, webhook-driven payment provider with ZERO
// external account required — the same "local dev never needs a live
// third-party account" principle that picked s3mock over
// MinIO/LocalStack (MEDIA-001, ADR-0022) and ConsoleEmailSender over a
// hard Gmail requirement (AUTH-007, ADR-0006). A real StripePaymentProvider
// can be added later behind the same PaymentProvider interface without
// touching modules/orders or modules/payments — see provider.ts.
//
// Deliberate, documented shortcut: the simulated webhook is delivered by
// calling `webhookHandler` (an in-process function) rather than making a
// real HTTP request back into this same server. A real provider genuinely
// crosses the network; this doesn't. What actually matters for learning
// this pattern — raw-body HMAC signature verification and idempotent event
// processing — is fully real either way, because `webhookHandler` is the
// exact same function modules/payments/routes.ts wires up to the real HTTP
// webhook route (see modules/payments/service.ts's `wireUpMockProvider`).
// Only the literal network hop is skipped, deliberately, to avoid coupling
// this class to knowing its own server's port/base URL and to keep tests
// deterministic without binding a second real listener.
export class MockPaymentProvider implements PaymentProvider {
  readonly name = 'mock';
  readonly signatureHeader = 'x-mock-signature';
  private webhookHandler: WebhookHandler | null = null;
  // Real providers (Stripe included) dedupe on an Idempotency-Key you pass
  // THEM, not just on a key you separately store yourself — a retried
  // "create intent" call with the same key gets back the SAME object,
  // rather than creating a second one. This map is what makes that true
  // here: without it, two concurrent createPaymentIntent calls carrying the
  // identical idempotencyKey (the exact race modules/payments/service.ts's
  // DB unique constraint is the ultimate backstop for) would each get a
  // distinct providerRef and each schedule their own simulated webhook —
  // technically harmless (only one would ever find its Payment row still
  // PENDING) but not an accurate simulation of what a real provider does.
  private readonly intentsByIdempotencyKey = new Map<string, CreatePaymentIntentResult>();

  // Runtime injection, not a static import of modules/payments/service.ts —
  // this is an infrastructure-layer class and must not depend on a domain
  // module at the module-graph level (Section 54), even though at runtime
  // it needs to call into one to deliver its simulated webhook.
  setWebhookHandler(handler: WebhookHandler): void {
    this.webhookHandler = handler;
  }

  createPaymentIntent(input: CreatePaymentIntentInput): Promise<CreatePaymentIntentResult> {
    const existing = this.intentsByIdempotencyKey.get(input.idempotencyKey);
    if (existing) {
      return Promise.resolve(existing);
    }

    const providerRef = `mock_pi_${randomUUID()}`;
    const result: CreatePaymentIntentResult = { providerRef, status: 'PENDING', checkoutUrl: null };
    this.intentsByIdempotencyKey.set(input.idempotencyKey, result);

    setTimeout(() => {
      void this.simulateWebhookDelivery({ type: 'payment.succeeded', providerRef }).catch((err: unknown) => {
        logger.error({ err, providerRef }, 'MockPaymentProvider: simulated webhook delivery failed');
      });
    }, WEBHOOK_DELAY_MS);
    return Promise.resolve(result);
  }

  verifyWebhookEvent(rawBody: Buffer, signatureHeader: string | undefined): PaymentWebhookEvent {
    if (!signatureHeader) {
      throw new Error('Missing X-Mock-Signature header');
    }
    const expected = Buffer.from(sign(rawBody), 'hex');
    let given: Buffer;
    try {
      given = Buffer.from(signatureHeader, 'hex');
    } catch {
      throw new Error('Malformed signature');
    }
    // Length check before timingSafeEqual: it throws on mismatched lengths
    // rather than returning false, and a length mismatch isn't itself
    // secret information worth constant-timing.
    if (given.length !== expected.length || !timingSafeEqual(expected, given)) {
      throw new Error('Invalid signature');
    }

    let parsed: { type?: unknown; providerRef?: unknown };
    try {
      parsed = JSON.parse(rawBody.toString('utf8')) as { type?: unknown; providerRef?: unknown };
    } catch {
      throw new Error('Malformed webhook payload');
    }
    if (
      (parsed.type !== 'payment.succeeded' && parsed.type !== 'payment.failed') ||
      typeof parsed.providerRef !== 'string'
    ) {
      throw new Error('Unrecognized webhook payload shape');
    }
    return { type: parsed.type, providerRef: parsed.providerRef };
  }

  // The mock settles by itself via its simulated webhook, so from the
  // outside it is always "open" until that webhook lands.
  fetchStatus(_providerRef: string): Promise<PaymentStatusSnapshot> {
    return Promise.resolve({ state: 'open', checkoutUrl: null });
  }

  refund(_providerRef: string, _idempotencyKey: string): Promise<{ refundRef: string }> {
    return Promise.resolve({ refundRef: `mock_re_${randomUUID()}` });
  }

  private async simulateWebhookDelivery(event: PaymentWebhookEvent): Promise<void> {
    if (!this.webhookHandler) {
      logger.error({ event }, 'MockPaymentProvider: no webhook handler wired, dropping simulated event');
      return;
    }
    const rawBody = Buffer.from(JSON.stringify(event), 'utf8');
    const signatureHeader = sign(rawBody);
    await this.webhookHandler(rawBody, signatureHeader);
  }
}

export const mockPaymentProvider = new MockPaymentProvider();
