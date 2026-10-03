import type { Order } from '@prisma/client';
import { prisma } from '../../infrastructure/database/prisma';
import { createOutboxEventInTx } from '../../infrastructure/outbox/repository';

export function findOrderById(id: string): Promise<Order | null> {
  return prisma.order.findUnique({ where: { id } });
}

// A buyer and a seller are both legitimate viewers of the same order, from
// opposite sides — one query, OR'd, rather than two separate endpoints.
export function listOrdersForUser(userId: string): Promise<Order[]> {
  return prisma.order.findMany({
    where: { OR: [{ buyerId: userId }, { sellerId: userId }] },
    orderBy: { createdAt: 'desc' },
  });
}

export type ShipmentDetails = { carrier: string; trackingNumber: string };

// Order lifecycle events ride the existing 'payment-events' topic, keyed by
// orderId (ordering matters per order: shipped must be seen before
// delivered). Not a new 'order-events' topic: Aiven's free tier caps us at
// 5 topics and all 5 are in use (ADR-0036/0038). The topic name is a
// slight misnomer for non-payment events; that's the accepted cost.
const ORDER_EVENTS_TOPIC = 'payment-events';

// The state guard IS the concurrency control: `UPDATE ... WHERE status =
// 'PAID'` is atomic in Postgres, and under READ COMMITTED a second
// concurrent transition blocks on the row, then re-evaluates the WHERE
// against the committed result and matches nothing. So two simultaneous
// "ship" requests can never both succeed, with no explicit lock needed.
// Returns the updated order, or null if the guard didn't match (the caller
// decides whether that's an idempotent replay or a real conflict).
export async function markOrderShipped(
  orderId: string,
  sellerId: string,
  shipment: ShipmentDetails,
): Promise<Order | null> {
  return prisma.$transaction(async (tx) => {
    const { count } = await tx.order.updateMany({
      where: { id: orderId, sellerId, status: 'PAID' },
      data: { status: 'SHIPPED', shippedAt: new Date(), ...shipment },
    });
    if (count === 0) return null;

    const order = await tx.order.findUniqueOrThrow({ where: { id: orderId } });
    await createOutboxEventInTx(tx, {
      topic: ORDER_EVENTS_TOPIC,
      key: order.id,
      payload: {
        type: 'order.shipped',
        orderId: order.id,
        auctionId: order.auctionId,
        buyerId: order.buyerId,
        sellerId: order.sellerId,
        carrier: shipment.carrier,
        trackingNumber: shipment.trackingNumber,
      },
    });
    return order;
  });
}

export async function markOrderDelivered(orderId: string, buyerId: string): Promise<Order | null> {
  return prisma.$transaction(async (tx) => {
    const { count } = await tx.order.updateMany({
      where: { id: orderId, buyerId, status: 'SHIPPED' },
      data: { status: 'DELIVERED', deliveredAt: new Date() },
    });
    if (count === 0) return null;

    const order = await tx.order.findUniqueOrThrow({ where: { id: orderId } });
    await createOutboxEventInTx(tx, {
      topic: ORDER_EVENTS_TOPIC,
      key: order.id,
      payload: {
        type: 'order.delivered',
        orderId: order.id,
        auctionId: order.auctionId,
        buyerId: order.buyerId,
        sellerId: order.sellerId,
      },
    });
    return order;
  });
}

const OVERDUE_SCAN_BATCH = 100;

export async function findOverdueUnpaidOrderIds(now: Date): Promise<string[]> {
  const rows = await prisma.order.findMany({
    where: { status: 'PENDING_PAYMENT', paymentDueAt: { lte: now } },
    select: { id: true },
    orderBy: { paymentDueAt: 'asc' },
    take: OVERDUE_SCAN_BATCH,
  });
  return rows.map((r) => r.id);
}

// Cancels one overdue, unpaid order. Same atomic-guard idea as shipping:
// every condition lives in the UPDATE's WHERE, evaluated against the
// committed row at write time, so it can't act on a stale read — an order
// paid a millisecond ago, or already cancelled by an earlier tick or a
// second worker instance, simply matches nothing. Returns whether THIS call
// cancelled it (so only one caller ever emits the event).
//
// The `payments: none PENDING-and-recent` condition is what protects a
// payment that is mid-flight (see IN_FLIGHT_PAYMENT_GRACE_MS). Known narrow
// gap: a payment attempt created in the instant between this UPDATE
// committing and the buyer's pay request finishing can still end up
// attached to a cancelled order; applyPaymentWebhookEvent refuses to
// resurrect the order in that case and logs it for a manual refund.
export async function cancelOverdueUnpaidOrder(
  orderId: string,
  now: Date,
  inFlightCutoff: Date,
): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const { count } = await tx.order.updateMany({
      where: {
        id: orderId,
        status: 'PENDING_PAYMENT',
        paymentDueAt: { lte: now },
        payments: { none: { status: 'PENDING', createdAt: { gt: inFlightCutoff } } },
      },
      data: { status: 'CANCELLED', cancelledAt: now, cancelReason: 'PAYMENT_TIMEOUT' },
    });
    if (count === 0) return false;

    const order = await tx.order.findUniqueOrThrow({ where: { id: orderId } });
    await createOutboxEventInTx(tx, {
      topic: ORDER_EVENTS_TOPIC,
      key: order.id,
      payload: {
        type: 'order.cancelled',
        orderId: order.id,
        auctionId: order.auctionId,
        buyerId: order.buyerId,
        sellerId: order.sellerId,
        amountCents: order.amountCents,
        reason: 'PAYMENT_TIMEOUT',
      },
    });
    return true;
  });
}
