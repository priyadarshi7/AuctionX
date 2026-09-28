import { Prisma, type Payment } from '@prisma/client';
import { paymentProvider, mockPaymentProvider } from '../../infrastructure/payments';
import { logger } from '../../infrastructure/observability/logger';
import { ConflictError, ForbiddenError, NotFoundError, WebhookVerificationError } from '../../middleware/errors';
import { findOrderById } from '../orders/repository';
import {
  applyPaymentWebhookEvent,
  createPaymentAttempt,
  findActivePaymentForOrder,
  findPaymentByOrderAndIdempotencyKey,
} from './repository';

// Reads modules/orders/repository.ts directly rather than going through
// orders' service layer — the same pragmatic, documented cross-module
// pattern bids/service.ts already uses to read the locked auction row
// (Section 54). modules/orders/service.ts calls INTO this file the other
// direction (to create a payment intent for an order it owns), so this
// stays a one-way dependency, not a cycle: payments depends on orders'
// repository (data), orders depends on payments' service (business logic).
export async function createPaymentIntentForOrder(
  buyerId: string,
  orderId: string,
  idempotencyKey: string,
): Promise<Payment> {
  const order = await findOrderById(orderId);
  if (!order) {
    throw new NotFoundError('Order not found');
  }
  if (order.buyerId !== buyerId) {
    throw new ForbiddenError('You are not the buyer on this order');
  }
  if (order.status !== 'PENDING_PAYMENT') {
    throw new ConflictError('ORDER_NOT_PAYABLE', `This order is ${order.status}, not awaiting payment`);
  }

  // Business-level idempotency: if an attempt is already in flight (or
  // already succeeded), don't start another — this catches the common case
  // (buyer re-opens the pay page, or double-clicks and the frontend sends a
  // FRESH idempotencyKey each time) without needing the exact same key.
  const active = await findActivePaymentForOrder(orderId);
  if (active) {
    return active;
  }

  // Deliberately NOT inside a transaction with the checks above: Section 65
  // — never hold a Postgres row lock across a call to an external system
  // (here, in-process for MockPaymentProvider, but a real provider is a
  // genuine network call). The @@unique([orderId, idempotencyKey])
  // constraint below is the actual race-breaker for the rare case where two
  // concurrent requests both pass the check above before either commits.
  const intent = await paymentProvider.createPaymentIntent({
    orderId,
    amountCents: order.amountCents,
    idempotencyKey,
  });

  try {
    return await createPaymentAttempt({
      orderId,
      provider: paymentProvider.name,
      providerRef: intent.providerRef,
      amountCents: order.amountCents,
      idempotencyKey,
    });
  } catch (err) {
    // Same pattern as bids/service.ts's P2002 handling for cross-auction
    // idempotency-key reuse: the DB constraint is the source of truth for
    // this race, not the check above. Both concurrent callers passed the
    // SAME idempotencyKey to paymentProvider.createPaymentIntent, so
    // MockPaymentProvider's own dedup map (see mockProvider.ts) already
    // returned them the SAME providerRef — only one of the two inserts
    // below can win; the loser fetches and returns the winner's row rather
    // than treating this as a real error.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      const existing = await findPaymentByOrderAndIdempotencyKey(orderId, idempotencyKey);
      if (existing) {
        logger.warn({ orderId }, 'payment.idempotent_replay_after_race');
        return existing;
      }
    }
    throw err;
  }
}

// The single entry point for turning a webhook delivery into a state
// change — called both by the real HTTP route (modules/payments/routes.ts,
// via controller.ts) and, in-process, by MockPaymentProvider's simulated
// delivery (mockProvider.ts's `webhookHandler`). Both paths run the exact
// same verify -> look up -> idempotently apply logic; only the transport
// differs.
export async function handlePaymentWebhook(rawBody: Buffer, signatureHeader: string | undefined): Promise<void> {
  let event;
  try {
    event = paymentProvider.verifyWebhookEvent(rawBody, signatureHeader);
  } catch (err) {
    throw new WebhookVerificationError(err instanceof Error ? err.message : 'Invalid webhook payload');
  }

  const outcome = event.type === 'payment.succeeded' ? 'SUCCEEDED' : 'FAILED';
  const result = await applyPaymentWebhookEvent(paymentProvider.name, event.providerRef, outcome);
  if (!result.applied) {
    // Not necessarily a bug: a provider retrying a webhook it couldn't
    // confirm we received is expected and must be a silent no-op (Section
    // 41), and an unrecognized providerRef would mean a stale/foreign
    // event. Logged so a genuinely unexpected case is still visible.
    logger.warn({ provider: paymentProvider.name, providerRef: event.providerRef, outcome }, 'payment.webhook_ignored');
  }
}

// Wired once at module load, not a static import in mockProvider.ts — see
// that file's doc comment on MockPaymentProvider for why (Section 54: an
// infrastructure-layer class must not depend on a domain module at the
// module-graph level).
mockPaymentProvider.setWebhookHandler(handlePaymentWebhook);
