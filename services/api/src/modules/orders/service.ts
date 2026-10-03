import type { Order, Payment } from '@prisma/client';
import { ConflictError, ForbiddenError, NotFoundError } from '../../middleware/errors';
import { createPaymentIntentForOrder } from '../payments/service';
import {
  findOrderById,
  listOrdersForUser,
  markOrderDelivered,
  markOrderShipped,
  type ShipmentDetails,
} from './repository';

export function listMyOrders(userId: string): Promise<Order[]> {
  return listOrdersForUser(userId);
}

// Same visibility shape as bids' "buyer or seller only" — an Order is not
// public the way an Auction listing is; only its two parties may see it.
export async function getOrderForViewer(userId: string, orderId: string): Promise<Order> {
  const order = await findOrderById(orderId);
  if (!order) {
    throw new NotFoundError('Order not found');
  }
  if (order.buyerId !== userId && order.sellerId !== userId) {
    throw new ForbiddenError('You do not have access to this order');
  }
  return order;
}

// Thin pass-through into the Payment domain — kept as its own function
// (rather than the controller calling payments/service.ts directly) purely
// so the orders module's public surface stays "everything about an order
// goes through here," matching every other module's layering (Section 54).
// The buyer-ownership and order-state checks live in
// createPaymentIntentForOrder itself, since payments/service.ts already
// has to load the Order row to do its own work.
export function payForOrder(buyerId: string, orderId: string, idempotencyKey: string): Promise<Payment> {
  return createPaymentIntentForOrder(buyerId, orderId, idempotencyKey);
}

// Seller marks a PAID order as shipped. Idempotent for the exact same
// request (Section 11): a retry or double-click with the same carrier and
// tracking number on an already-SHIPPED order returns it unchanged instead
// of a 409, since "it's shipped, as you asked" is the truthful answer. A
// DIFFERENT carrier/tracking on an already-shipped order is a real
// conflict and is rejected — correcting a typo'd tracking number is a
// separate feature, not something a repeated request should silently do.
export async function shipOrder(sellerId: string, orderId: string, shipment: ShipmentDetails): Promise<Order> {
  const order = await findOrderById(orderId);
  if (!order) {
    throw new NotFoundError('Order not found');
  }
  if (order.sellerId !== sellerId) {
    throw new ForbiddenError('You are not the seller on this order');
  }

  const sameShipment = (o: Order) => o.carrier === shipment.carrier && o.trackingNumber === shipment.trackingNumber;
  if (order.status === 'SHIPPED' && sameShipment(order)) {
    return order;
  }
  if (order.status !== 'PAID') {
    throw new ConflictError('ORDER_NOT_SHIPPABLE', `This order is ${order.status}; only a paid order can be shipped`);
  }

  const shipped = await markOrderShipped(orderId, sellerId, shipment);
  if (shipped) {
    return shipped;
  }
  // The guarded update matched nothing: the order changed between the read
  // above and the write. Re-read to tell an identical concurrent request
  // (replay) apart from a genuine conflict.
  const latest = await findOrderById(orderId);
  if (latest && latest.status === 'SHIPPED' && sameShipment(latest)) {
    return latest;
  }
  throw new ConflictError('ORDER_NOT_SHIPPABLE', 'This order can no longer be shipped');
}

// Buyer confirms receipt of a SHIPPED order. A repeated confirmation on an
// already-DELIVERED order is a no-op success, for the same reason as above.
export async function confirmOrderDelivered(buyerId: string, orderId: string): Promise<Order> {
  const order = await findOrderById(orderId);
  if (!order) {
    throw new NotFoundError('Order not found');
  }
  if (order.buyerId !== buyerId) {
    throw new ForbiddenError('You are not the buyer on this order');
  }
  if (order.status === 'DELIVERED') {
    return order;
  }
  if (order.status !== 'SHIPPED') {
    throw new ConflictError(
      'ORDER_NOT_DELIVERABLE',
      `This order is ${order.status}; only a shipped order can be confirmed as delivered`,
    );
  }

  const delivered = await markOrderDelivered(orderId, buyerId);
  if (delivered) {
    return delivered;
  }
  const latest = await findOrderById(orderId);
  if (latest && latest.status === 'DELIVERED') {
    return latest;
  }
  throw new ConflictError('ORDER_NOT_DELIVERABLE', 'This order can no longer be confirmed as delivered');
}
