import type { Order, ShipmentEvent } from '@prisma/client';
import { shippingProvider } from '../../infrastructure/shipping';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../../middleware/errors';
import { createPaymentIntentForOrder, syncOrderPayment, type PaymentStart } from '../payments/service';
import { shippingAddressSchema, type ShippingAddress } from './address';
import { deliveryCodeFor, MAX_DELIVERY_CODE_ATTEMPTS } from './deliveryOtp';
import {
  deliverWithCode,
  findOrderById,
  listOrdersForUser,
  listShipmentEvents,
  markOrderShipped,
  regenerateDeliveryCode,
  saveShippingAddress,
} from './repository';

// What an order looks like to one particular viewer (ADR-0045). The raw row
// carries things that must not leave the server (the delivery-code counters)
// and one that only some people may see (the address).
export type OrderView = Omit<Order, 'shippingAddress' | 'deliveryOtpVersion' | 'deliveryOtpAttempts'> & {
  shippingAddress: ShippingAddress | null;
  // True once wrong guesses have used up the attempts for the current code.
  deliveryCodeLocked: boolean;
};

export type OrderDetailView = OrderView & {
  shipmentEvents: ShipmentEvent[];
  // Only ever present for the BUYER of a SHIPPED order. Everyone else, and
  // every other state, gets null.
  deliveryCode: string | null;
};

// Who may see the address: the buyer always; the seller only while there is a
// parcel to send (PAID or SHIPPED); nobody else, and not the seller after
// delivery, when it has no further purpose.
function visibleAddress(order: Order, viewerId: string): ShippingAddress | null {
  if (!order.shippingAddress) return null;
  const isBuyer = order.buyerId === viewerId;
  const isSeller = order.sellerId === viewerId && (order.status === 'PAID' || order.status === 'SHIPPED');
  return isBuyer || isSeller ? (order.shippingAddress as ShippingAddress) : null;
}

export function toOrderView(order: Order, viewerId: string): OrderView {
  const { shippingAddress: _address, deliveryOtpVersion: _version, deliveryOtpAttempts: attempts, ...rest } = order;
  return {
    ...rest,
    shippingAddress: visibleAddress(order, viewerId),
    deliveryCodeLocked: order.status === 'SHIPPED' && attempts >= MAX_DELIVERY_CODE_ATTEMPTS,
  };
}

async function toDetailView(order: Order, viewerId: string): Promise<OrderDetailView> {
  const shipmentEvents = await listShipmentEvents(order.id);
  const deliveryCode =
    order.buyerId === viewerId && order.status === 'SHIPPED' ? deliveryCodeFor(order.id, order.deliveryOtpVersion) : null;
  return { ...toOrderView(order, viewerId), shipmentEvents, deliveryCode };
}

export async function listMyOrders(userId: string): Promise<OrderView[]> {
  const orders = await listOrdersForUser(userId);
  return orders.map((order) => toOrderView(order, userId));
}

// Same visibility shape as bids' "buyer or seller only" — an Order is not
// public the way an Auction listing is; only its two parties may see it.
export async function getOrderForViewer(userId: string, orderId: string): Promise<OrderDetailView> {
  return toDetailView(await requireParty(userId, orderId), userId);
}

async function requireParty(userId: string, orderId: string): Promise<Order> {
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
export function payForOrder(buyerId: string, orderId: string, idempotencyKey: string): Promise<PaymentStart> {
  return createPaymentIntentForOrder(buyerId, orderId, idempotencyKey);
}

// The buyer asks us to check with the payment provider rather than wait for
// its webhook (ADR-0044). Idempotent and safe to call repeatedly.
export function syncPayment(buyerId: string, orderId: string): Promise<void> {
  return syncOrderPayment(buyerId, orderId);
}

// The buyer says where to deliver. Allowed until the parcel has shipped.
export async function setShippingAddress(buyerId: string, orderId: string, input: unknown): Promise<OrderDetailView> {
  const order = await findOrderById(orderId);
  if (!order) throw new NotFoundError('Order not found');
  if (order.buyerId !== buyerId) throw new ForbiddenError('You are not the buyer on this order');

  const parsed = shippingAddressSchema.safeParse(input);
  if (!parsed.success) throw new ValidationError(parsed.error.flatten().fieldErrors);

  const updated = await saveShippingAddress(orderId, buyerId, parsed.data);
  if (!updated) {
    throw new ConflictError('ORDER_ADDRESS_LOCKED', `This order is ${order.status}; the address can no longer be changed`);
  }
  return toDetailView(updated, buyerId);
}

// Seller marks a PAID order as shipped. The carrier and tracking number are
// assigned by the shipping provider, not typed in (ADR-0045), and are
// deterministic per order, so a retry or double-click returns the already
// shipped order instead of a 409: "it's shipped, as you asked" is the
// truthful answer (Section 11).
export async function shipOrder(sellerId: string, orderId: string): Promise<OrderDetailView> {
  const order = await findOrderById(orderId);
  if (!order) {
    throw new NotFoundError('Order not found');
  }
  if (order.sellerId !== sellerId) {
    throw new ForbiddenError('You are not the seller on this order');
  }
  if (order.status === 'SHIPPED') {
    return toDetailView(order, sellerId);
  }
  if (order.status !== 'PAID') {
    throw new ConflictError('ORDER_NOT_SHIPPABLE', `This order is ${order.status}; only a paid order can be shipped`);
  }
  if (!order.shippingAddress) {
    throw new ConflictError('SHIPPING_ADDRESS_REQUIRED', 'The buyer has not given a delivery address yet');
  }

  const shipment = await shippingProvider.createShipment({ orderId });
  const shipped = await markOrderShipped(orderId, sellerId, shipment);
  if (shipped) {
    return toDetailView(shipped, sellerId);
  }
  // The guarded update matched nothing: the order changed between the read
  // above and the write. A concurrent identical request is a replay; anything
  // else is a real conflict.
  const latest = await findOrderById(orderId);
  if (latest && latest.status === 'SHIPPED') {
    return toDetailView(latest, sellerId);
  }
  throw new ConflictError('ORDER_NOT_SHIPPABLE', 'This order can no longer be shipped');
}

// The seller completes delivery by entering the code the buyer was shown
// (ADR-0045). A repeat on an already-DELIVERED order is a no-op success.
export async function confirmDeliveryWithCode(
  sellerId: string,
  orderId: string,
  code: string,
): Promise<OrderDetailView> {
  const order = await findOrderById(orderId);
  if (!order) throw new NotFoundError('Order not found');
  if (order.sellerId !== sellerId) throw new ForbiddenError('You are not the seller on this order');
  if (order.status === 'DELIVERED') return toDetailView(order, sellerId);
  if (order.status !== 'SHIPPED') {
    throw new ConflictError(
      'ORDER_NOT_DELIVERABLE',
      `This order is ${order.status}; only a shipped order can be marked as delivered`,
    );
  }

  const result = await deliverWithCode(orderId, sellerId, code);
  switch (result.kind) {
    case 'delivered':
      return toDetailView(result.order, sellerId);
    case 'wrong':
      throw new ValidationError(
        { code: [`That code is not correct. ${result.attemptsLeft} ${result.attemptsLeft === 1 ? 'try' : 'tries'} left.`] },
        'Incorrect delivery code',
      );
    case 'locked':
      throw new ConflictError(
        'DELIVERY_CODE_LOCKED',
        'Too many incorrect codes. The buyer must generate a new code before you can try again.',
      );
    case 'invalid_state': {
      const latest = await findOrderById(orderId);
      if (latest?.status === 'DELIVERED') return toDetailView(latest, sellerId);
      throw new ConflictError('ORDER_NOT_DELIVERABLE', 'This order can no longer be marked as delivered');
    }
  }
}

// The buyer asks for a fresh code (lost it, or the seller locked the old one
// with wrong guesses). Resets the attempt counter.
export async function regenerateCode(buyerId: string, orderId: string): Promise<OrderDetailView> {
  const order = await findOrderById(orderId);
  if (!order) throw new NotFoundError('Order not found');
  if (order.buyerId !== buyerId) throw new ForbiddenError('You are not the buyer on this order');

  const updated = await regenerateDeliveryCode(orderId, buyerId);
  if (!updated) {
    throw new ConflictError('ORDER_NOT_SHIPPED', 'A delivery code can only be generated for a shipped order');
  }
  return toDetailView(updated, buyerId);
}
