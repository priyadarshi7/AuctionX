import type { Order, Payment } from '@prisma/client';
import { ForbiddenError, NotFoundError } from '../../middleware/errors';
import { createPaymentIntentForOrder } from '../payments/service';
import { findOrderById, listOrdersForUser } from './repository';

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
