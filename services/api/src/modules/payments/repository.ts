import type { Payment, PaymentStatus } from '@prisma/client';
import { prisma } from '../../infrastructure/database/prisma';
import { createNotificationInTx } from '../notifications/repository';
import { pushNotification } from '../../infrastructure/realtime/notificationEvents';

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
  const result = await prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<LockedPaymentRow[]>`
      SELECT id, "orderId", status
      FROM payments
      WHERE provider = ${provider} AND "providerRef" = ${providerRef}
      FOR UPDATE
    `;
    const payment = rows[0];
    if (!payment || payment.status !== 'PENDING') {
      return { applied: false, notification: undefined };
    }

    await tx.payment.update({ where: { id: payment.id }, data: { status: outcome } });

    let notification;
    if (outcome === 'SUCCEEDED') {
      // .update() already returns the full updated row — no extra read
      // needed to get sellerId/amountCents for the notification below.
      const updatedOrder = await tx.order.update({ where: { id: payment.orderId }, data: { status: 'PAID' } });
      notification = await createNotificationInTx(tx, {
        userId: updatedOrder.sellerId,
        type: 'PAYMENT_RECEIVED',
        auctionId: updatedOrder.auctionId,
        orderId: updatedOrder.id,
        data: { amountCents: updatedOrder.amountCents },
      });
    }

    return { applied: true, notification };
  });

  // Pushed only after commit — same reasoning as the other two trigger
  // sites (bids/repository.ts, auctions/repository.ts).
  if (result.notification) {
    pushNotification(result.notification);
  }

  return { applied: result.applied };
}
