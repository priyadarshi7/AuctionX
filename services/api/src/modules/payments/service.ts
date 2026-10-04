import { Prisma, type Payment } from '@prisma/client';
import { env } from '../../config/env';
import { paymentProvider, mockPaymentProvider, type PaymentStatusSnapshot } from '../../infrastructure/payments';
import { logger } from '../../infrastructure/observability/logger';
import { ConflictError, ForbiddenError, NotFoundError, WebhookVerificationError } from '../../middleware/errors';
import { findOrderById } from '../orders/repository';
import {
  applyPaymentWebhookEvent,
  createPaymentAttempt,
  findActivePaymentForOrder,
  findPaymentById,
  findPaymentByOrderAndIdempotencyKey,
  findPaymentByProviderRef,
  findPendingPaymentForOrder,
  markPaymentRefunded,
} from './repository';

// Reads modules/orders/repository.ts directly rather than going through
// orders' service layer — the same pragmatic, documented cross-module
// pattern bids/service.ts already uses to read the locked auction row
// (Section 54). modules/orders/service.ts calls INTO this file the other
// direction (to create a payment intent for an order it owns), so this
// stays a one-way dependency, not a cycle: payments depends on orders'
// repository (data), orders depends on payments' service (business logic).
export type PaymentStart = { payment: Payment; checkoutUrl: string | null };

export async function createPaymentIntentForOrder(
  buyerId: string,
  orderId: string,
  idempotencyKey: string,
): Promise<PaymentStart> {
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
  // A paid order must be shippable (ADR-0045): the seller cannot send a parcel
  // to nowhere, so the buyer says where it goes before any money moves.
  if (!order.shippingAddress) {
    throw new ConflictError('SHIPPING_ADDRESS_REQUIRED', 'Add your delivery address before paying');
  }

  // Business-level idempotency: if an attempt is already in flight (or
  // already succeeded), don't start another — this catches the common case
  // (buyer re-opens the pay page, or double-clicks and the frontend sends a
  // FRESH idempotencyKey each time) without needing the exact same key.
  const active = await findActivePaymentForOrder(orderId);
  if (active) {
    if (active.status !== 'PENDING') {
      return { payment: active, checkoutUrl: null };
    }
    // An attempt is already in flight. Ask the provider where it stands: if
    // the buyer left Stripe's page and comes back within its 30 minutes, send
    // them back to the SAME page; if it was in fact paid or has expired,
    // settle that first so a stale attempt can never wedge the order.
    const status = await paymentProvider.fetchStatus(active.providerRef);
    if (status.state === 'open') {
      return { payment: active, checkoutUrl: status.checkoutUrl };
    }
    await settleFromSnapshot(active, status);
    const refreshed = await findActivePaymentForOrder(orderId);
    if (refreshed) {
      return { payment: refreshed, checkoutUrl: null };
    }
    // The old attempt expired: fall through and start a fresh one.
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
    description: `AuctionX order ${orderId.slice(0, 8)}`,
    returnUrl: `${env.FRONTEND_URL}/orders/${orderId}`,
  });

  try {
    const payment = await createPaymentAttempt({
      orderId,
      provider: paymentProvider.name,
      providerRef: intent.providerRef,
      amountCents: order.amountCents,
      idempotencyKey,
    });
    return { payment, checkoutUrl: intent.checkoutUrl };
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
        return { payment: existing, checkoutUrl: intent.checkoutUrl };
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
  // A verified event we deliberately do not act on (e.g. a Stripe event type
  // we do not subscribe to). Acknowledged so the provider stops retrying.
  if (!event) return;

  await settlePayment(
    event.providerRef,
    event.type === 'payment.succeeded' ? 'SUCCEEDED' : 'FAILED',
    event.type === 'payment.succeeded' ? event.amountCents : undefined,
  );
}

// The ONE place a provider outcome becomes a state change, whether it arrived
// by webhook or was fetched by reconciliation. Idempotent: the underlying
// update only acts on a PENDING payment.
async function settlePayment(providerRef: string, outcome: 'SUCCEEDED' | 'FAILED', claimedAmountCents?: number): Promise<void> {
  if (outcome === 'SUCCEEDED' && claimedAmountCents !== undefined) {
    // Tripwire (Section 19): if the provider says it collected a different
    // amount than OUR record of this payment, do not mark it paid. Never
    // happens with a correct integration, so it is logged as an error.
    const payment = await findPaymentByProviderRef(paymentProvider.name, providerRef);
    if (payment && payment.amountCents !== claimedAmountCents) {
      logger.error(
        { providerRef, expected: payment.amountCents, collected: claimedAmountCents },
        'payment.amount_mismatch: provider collected a different amount than the order; NOT applied',
      );
      return;
    }
  }

  const result = await applyPaymentWebhookEvent(paymentProvider.name, providerRef, outcome);
  if (!result.applied) {
    // Not necessarily a bug: a provider retrying a webhook it couldn't
    // confirm we received is expected and must be a silent no-op (Section
    // 41), and an unrecognized providerRef would mean a stale/foreign
    // event. Logged so a genuinely unexpected case is still visible.
    logger.warn({ provider: paymentProvider.name, providerRef, outcome }, 'payment.webhook_ignored');
    return;
  }
  if (result.refundPaymentId) {
    // Outside the transaction (Section 65: no row lock across a network call).
    // A failure here is not fatal: the order stays flagged "needs refund" and
    // an admin can retry from the dashboard.
    await refundPayment(result.refundPaymentId).catch((err: unknown) => {
      logger.error({ err, paymentId: result.refundPaymentId }, 'payment.auto_refund_failed');
    });
  }
}

async function settleFromSnapshot(payment: Payment, status: PaymentStatusSnapshot): Promise<void> {
  if (status.state === 'paid') {
    await settlePayment(payment.providerRef, 'SUCCEEDED', status.amountCents);
  } else if (status.state === 'expired') {
    await settlePayment(payment.providerRef, 'FAILED');
  }
}

// Buyer-triggered reconciliation: ask the provider about this order's pending
// payment instead of waiting for a webhook. Makes payment robust to a late,
// dropped or not-yet-configured webhook. Safe to call repeatedly.
export async function syncOrderPayment(buyerId: string, orderId: string): Promise<void> {
  const order = await findOrderById(orderId);
  if (!order) throw new NotFoundError('Order not found');
  if (order.buyerId !== buyerId) throw new ForbiddenError('You are not the buyer on this order');

  const pending = await findPendingPaymentForOrder(orderId);
  if (!pending) return;
  await settleFromSnapshot(pending, await paymentProvider.fetchStatus(pending.providerRef));
}

// Returns a SUCCEEDED payment's money to the buyer. Idempotent end to end: the
// provider call carries refund-{paymentId} as its idempotency key (so a retry
// can never refund twice), and the database record is a guarded update.
export async function refundPayment(paymentId: string): Promise<void> {
  const payment = await findPaymentById(paymentId);
  if (!payment) throw new NotFoundError('Payment not found');
  if (payment.status !== 'SUCCEEDED') {
    throw new ConflictError('PAYMENT_NOT_REFUNDABLE', 'Only a successful payment can be refunded');
  }
  if (payment.refundedAt) return;

  const { refundRef } = await paymentProvider.refund(payment.providerRef, `refund-${payment.id}`);
  await markPaymentRefunded(payment.id, refundRef);
  logger.info({ paymentId: payment.id, refundRef }, 'payment.refunded');
}

// Wired once at module load, not a static import in mockProvider.ts — see
// that file's doc comment on MockPaymentProvider for why (Section 54: an
// infrastructure-layer class must not depend on a domain module at the
// module-graph level).
mockPaymentProvider.setWebhookHandler(handlePaymentWebhook);
