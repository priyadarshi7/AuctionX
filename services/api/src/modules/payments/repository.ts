import type { Payment, PaymentStatus } from '@prisma/client';
import { prisma } from '../../infrastructure/database/prisma';
import { createOutboxEventInTx } from '../../infrastructure/outbox/repository';

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

export type ApplyWebhookResult = { applied: boolean };

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
      // .update() already returns the full updated row — no extra read
      // needed to get sellerId/amountCents for the event payload below.
      const updatedOrder = await tx.order.update({ where: { id: payment.orderId }, data: { status: 'PAID' } });
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
