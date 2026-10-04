import type { Payment, PaymentStatus } from '@prisma/client';
import { prisma } from '../../infrastructure/database/prisma';
import { createOutboxEventInTx } from '../../infrastructure/outbox/repository';
import { logger } from '../../infrastructure/observability/logger';

// PENDING or SUCCEEDED both count as "active" — if either exists, don't
// start a second payment attempt for this order (PENDING: one's already in
// flight; SUCCEEDED: the order is already paid, a second attempt would be
// a bug in the caller, not something to paper over here).
export function findActivePaymentForOrder(orderId: string): Promise<Payment | null> {
  return prisma.payment.findFirst({
    where: { orderId, status: { in: ['PENDING', 'SUCCEEDED'] } },
    orderBy: { createdAt: 'desc' },
  });
}

export function findPaymentByOrderAndIdempotencyKey(orderId: string, idempotencyKey: string): Promise<Payment | null> {
  return prisma.payment.findUnique({
    where: { orderId_idempotencyKey: { orderId, idempotencyKey } },
  });
}

export function findPaymentById(id: string): Promise<Payment | null> {
  return prisma.payment.findUnique({ where: { id } });
}

export function findPaymentByProviderRef(provider: string, providerRef: string): Promise<Payment | null> {
  return prisma.payment.findUnique({ where: { provider_providerRef: { provider, providerRef } } });
}

// The newest still-undecided attempt for an order, for the buyer-triggered
// reconciliation with the provider.
export function findPendingPaymentForOrder(orderId: string): Promise<Payment | null> {
  return prisma.payment.findFirst({ where: { orderId, status: 'PENDING' }, orderBy: { createdAt: 'desc' } });
}

// Guarded: only a SUCCEEDED payment that has not been refunded yet can be
// marked refunded, so two concurrent refunds (an automatic one and an admin
// retry) cannot both record a result. The provider call itself is idempotent
// per payment (refund-{paymentId}), so the money is returned at most once.
export async function markPaymentRefunded(paymentId: string, refundRef: string): Promise<boolean> {
  const { count } = await prisma.payment.updateMany({
    where: { id: paymentId, status: 'SUCCEEDED', refundedAt: null },
    data: { refundedAt: new Date(), refundRef },
  });
  return count === 1;
}

export type NewPaymentAttempt = {
  orderId: string;
  provider: string;
  providerRef: string;
  amountCents: number;
  idempotencyKey: string;
};

export function createPaymentAttempt(data: NewPaymentAttempt): Promise<Payment> {
  return prisma.payment.create({ data: { ...data, status: 'PENDING' } });
}

type LockedPaymentRow = { id: string; orderId: string; status: PaymentStatus };

// refundPaymentId is set when the provider really took the money but the
// order could no longer be paid (it had been cancelled), so the caller can
// return the money.
export type ApplyWebhookResult = { applied: boolean; refundPaymentId?: string };

// One transaction: lock the Payment row by (provider, providerRef) — the
// exact pair a webhook uses to find its way back here — verify it's still
// PENDING (a terminal Payment means this delivery is a duplicate; real
// providers retry webhooks whose receipt they couldn't confirm, Section 41),
// flip its status, and — only on SUCCEEDED — mark the Order PAID in the
// SAME transaction. A Payment that flipped to SUCCEEDED whose Order never
// became PAID (or vice versa) would be exactly the kind of bug Section 10's
// "everything that must be atomic happens in one transaction" exists to
// prevent.
export async function applyPaymentWebhookEvent(
  provider: string,
  providerRef: string,
  outcome: 'SUCCEEDED' | 'FAILED',
): Promise<ApplyWebhookResult> {
  return prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<LockedPaymentRow[]>`
      SELECT id, "orderId", status
      FROM payments
      WHERE provider = ${provider} AND "providerRef" = ${providerRef}
      FOR UPDATE
    `;
    const payment = rows[0];
    if (!payment || payment.status !== 'PENDING') {
      return { applied: false };
    }

    await tx.payment.update({ where: { id: payment.id }, data: { status: outcome } });

    if (outcome === 'SUCCEEDED') {
      // Guarded: only a PENDING_PAYMENT order may become PAID. The payment
      // deadline worker can cancel an order while a payment attempt is
      // still in flight (ADR-0038); an unguarded update here would silently
      // resurrect that CANCELLED order. The Payment itself stays SUCCEEDED
      // regardless — the provider really did take the money, and hiding
      // that would be worse than the awkward state. What's left is a
      // paid-but-cancelled order that needs a manual refund, logged loudly
      // here and surfaced in the admin orders overview.
      const { count } = await tx.order.updateMany({
        where: { id: payment.orderId, status: 'PENDING_PAYMENT' },
        data: { status: 'PAID' },
      });
      if (count === 0) {
        logger.error(
          { orderId: payment.orderId, paymentId: payment.id },
          'payment.succeeded_for_non_payable_order: money taken for an order that is no longer awaiting payment; refunding',
        );
        return { applied: true, refundPaymentId: payment.id };
      }
      const updatedOrder = await tx.order.findUniqueOrThrow({ where: { id: payment.orderId } });
      // Published via the Outbox (ADR-0027) — a consumer
      // (modules/notifications/consumer.ts) turns this into a
      // PAYMENT_RECEIVED notification for the seller, asynchronously.
      // Keyed by orderId, not auctionId (unlike the other two topics) —
      // ordering matters per-order here, not per-auction (schema.prisma's
      // OutboxEvent doc comment).
      await createOutboxEventInTx(tx, {
        topic: 'payment-events',
        key: updatedOrder.id,
        payload: {
          type: 'payment.succeeded',
          orderId: updatedOrder.id,
          auctionId: updatedOrder.auctionId,
          sellerId: updatedOrder.sellerId,
          amountCents: updatedOrder.amountCents,
        },
      });
    }

    return { applied: true };
  });
}
