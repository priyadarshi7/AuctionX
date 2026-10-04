import type { Order, Prisma, ShipmentEvent } from '@prisma/client';
import { prisma } from '../../infrastructure/database/prisma';
import { createOutboxEventInTx } from '../../infrastructure/outbox/repository';
import type { ShippingAddress } from './address';
import { deliveryCodeFor, deliveryCodesMatch, MAX_DELIVERY_CODE_ATTEMPTS } from './deliveryOtp';

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

// The buyer's delivery address (ADR-0045). Guarded on the order not having
// shipped yet: an address cannot be rewritten under a parcel already moving.
export async function saveShippingAddress(
  orderId: string,
  buyerId: string,
  address: ShippingAddress,
): Promise<Order | null> {
  const { count } = await prisma.order.updateMany({
    where: { id: orderId, buyerId, status: { in: ['PENDING_PAYMENT', 'PAID'] } },
    data: { shippingAddress: address },
  });
  if (count === 0) return null;
  return findOrderById(orderId);
}

export function listShipmentEvents(orderId: string): Promise<ShipmentEvent[]> {
  return prisma.shipmentEvent.findMany({ where: { orderId }, orderBy: { occurredAt: 'asc' } });
}

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
    await tx.shipmentEvent.create({
      data: { orderId, type: 'LABEL_CREATED', description: 'Shipping label created. Waiting for pickup.' },
    });
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

export type DeliverWithCodeResult =
  | { kind: 'delivered'; order: Order }
  | { kind: 'wrong'; attemptsLeft: number }
  | { kind: 'locked' }
  | { kind: 'invalid_state' };

// Completes delivery for the SELLER, who presents the buyer's one-time code
// (ADR-0045). The attempt is counted FIRST, in a guarded UPDATE that only
// matches while attempts remain, so wrong guesses are durably counted even
// when this function returns normally, and two simultaneous guesses cannot
// both read "4 attempts used". The code check then happens against the
// version read after that increment.
export async function deliverWithCode(
  orderId: string,
  sellerId: string,
  code: string,
): Promise<DeliverWithCodeResult> {
  return prisma.$transaction(async (tx) => {
    const { count } = await tx.order.updateMany({
      where: { id: orderId, sellerId, status: 'SHIPPED', deliveryOtpAttempts: { lt: MAX_DELIVERY_CODE_ATTEMPTS } },
      data: { deliveryOtpAttempts: { increment: 1 } },
    });
    if (count === 0) {
      const current = await tx.order.findUnique({ where: { id: orderId } });
      if (current && current.sellerId === sellerId && current.status === 'SHIPPED') return { kind: 'locked' as const };
      return { kind: 'invalid_state' as const };
    }

    const order = await tx.order.findUniqueOrThrow({ where: { id: orderId } });
    if (!deliveryCodesMatch(code, deliveryCodeFor(order.id, order.deliveryOtpVersion))) {
      return { kind: 'wrong' as const, attemptsLeft: Math.max(0, MAX_DELIVERY_CODE_ATTEMPTS - order.deliveryOtpAttempts) };
    }

    await completeDelivery(tx, order.id, 'OTP');
    return { kind: 'delivered' as const, order: await tx.order.findUniqueOrThrow({ where: { id: orderId } }) };
  });
}

// Shared by the OTP path and the auto-confirm worker. Caller has already
// established, inside the same transaction, that the order is SHIPPED.
async function completeDelivery(tx: Prisma.TransactionClient, orderId: string, via: 'OTP' | 'AUTO'): Promise<boolean> {
  const { count } = await tx.order.updateMany({
    where: { id: orderId, status: 'SHIPPED' },
    data: { status: 'DELIVERED', deliveredAt: new Date(), deliveredVia: via },
  });
  if (count === 0) return false;

  const order = await tx.order.findUniqueOrThrow({ where: { id: orderId } });
  await tx.shipmentEvent.createMany({
    data: [
      {
        orderId,
        type: 'DELIVERED',
        description: via === 'OTP' ? 'Delivered. Handover confirmed with the delivery code.' : 'Delivery automatically confirmed.',
      },
    ],
    skipDuplicates: true,
  });
  await createOutboxEventInTx(tx, {
    topic: ORDER_EVENTS_TOPIC,
    key: order.id,
    payload: {
      type: 'order.delivered',
      orderId: order.id,
      auctionId: order.auctionId,
      buyerId: order.buyerId,
      sellerId: order.sellerId,
      method: via,
    },
  });
  return true;
}

// Only the BUYER can issue a new code (and thereby unlock a locked order).
export async function regenerateDeliveryCode(orderId: string, buyerId: string): Promise<Order | null> {
  const { count } = await prisma.order.updateMany({
    where: { id: orderId, buyerId, status: 'SHIPPED' },
    data: { deliveryOtpVersion: { increment: 1 }, deliveryOtpAttempts: 0 },
  });
  if (count === 0) return null;
  return findOrderById(orderId);
}

const STALE_SCAN_BATCH = 100;

export async function findStaleShippedOrderIds(cutoff: Date): Promise<string[]> {
  const rows = await prisma.order.findMany({
    where: { status: 'SHIPPED', shippedAt: { lte: cutoff } },
    select: { id: true },
    orderBy: { shippedAt: 'asc' },
    take: STALE_SCAN_BATCH,
  });
  return rows.map((r) => r.id);
}

// Fallback so an order never sits in SHIPPED forever because a code was lost
// or nobody bothered. Guarded the same way as everything else: whichever
// worker instance (or OTP entry) gets there first wins, the rest match nothing.
export async function autoConfirmDelivery(orderId: string, cutoff: Date): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const stale = await tx.order.findFirst({ where: { id: orderId, status: 'SHIPPED', shippedAt: { lte: cutoff } } });
    if (!stale) return false;
    return completeDelivery(tx, orderId, 'AUTO');
  });
}

const SIMULATION_BATCH = 200;

// Moves simulated shipments along their timeline (ADR-0045). Idempotent: the
// (orderId, type) unique index plus skipDuplicates means a repeated tick, or
// two worker instances, add each event at most once. It deliberately never
// adds DELIVERED: only the delivery code (or the auto-confirm fallback) can.
export async function progressSimulatedShipments(now: Date, stepMs: number): Promise<number> {
  const orders = await prisma.order.findMany({
    where: { status: 'SHIPPED' },
    select: { id: true, shipmentEvents: { select: { type: true, occurredAt: true } } },
    orderBy: { shippedAt: 'asc' },
    take: SIMULATION_BATCH,
  });

  let added = 0;
  for (const order of orders) {
    const at = (type: string) => order.shipmentEvents.find((e) => e.type === type)?.occurredAt;
    const label = at('LABEL_CREATED');
    const transit = at('IN_TRANSIT');
    const out = at('OUT_FOR_DELIVERY');

    let next: { type: 'IN_TRANSIT' | 'OUT_FOR_DELIVERY'; description: string; location: string } | null = null;
    if (label && !transit && now.getTime() - label.getTime() >= stepMs) {
      next = { type: 'IN_TRANSIT', description: 'Picked up and on its way.', location: 'Regional sorting hub' };
    } else if (transit && !out && now.getTime() - transit.getTime() >= stepMs) {
      next = { type: 'OUT_FOR_DELIVERY', description: 'Out for delivery. Have your delivery code ready.', location: 'Local delivery depot' };
    }
    if (!next) continue;

    const { count } = await prisma.shipmentEvent.createMany({
      data: [{ orderId: order.id, ...next, occurredAt: now }],
      skipDuplicates: true,
    });
    added += count;
  }
  return added;
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
