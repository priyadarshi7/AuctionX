// Mirrors services/api/prisma/schema.prisma's Order/Payment models
// (ADR-0023/0025) — same Date-becomes-ISO-string-over-HTTP note as
// lib/types/auction.ts.

export type OrderStatus = 'PENDING_PAYMENT' | 'PAID' | 'SHIPPED' | 'DELIVERED' | 'CANCELLED';
export type OrderCancelReason = 'PAYMENT_TIMEOUT' | 'ADMIN';

export type ShippingAddress = {
  fullName: string;
  line1: string;
  line2?: string;
  city: string;
  region: string;
  postalCode: string;
  country: string;
  phone: string;
};

export type ShipmentEventType = 'LABEL_CREATED' | 'IN_TRANSIT' | 'OUT_FOR_DELIVERY' | 'DELIVERED';

export type ShipmentEvent = {
  id: string;
  type: ShipmentEventType;
  description: string;
  location: string | null;
  occurredAt: string;
};

export type Order = {
  id: string;
  auctionId: string;
  winningBidId: string;
  sellerId: string;
  buyerId: string;
  amountCents: number;
  status: OrderStatus;
  paymentDueAt: string | null;
  shippedAt: string | null;
  carrier: string | null;
  trackingNumber: string | null;
  deliveredAt: string | null;
  cancelledAt: string | null;
  cancelReason: OrderCancelReason | null;
  // Only the buyer, or the seller while a parcel is to be sent, ever gets this.
  shippingAddress: ShippingAddress | null;
  deliveredVia: 'OTP' | 'AUTO' | null;
  deliveryCodeLocked: boolean;
  // Present on the single-order response only (not the list).
  shipmentEvents?: ShipmentEvent[];
  // Only for the BUYER of a SHIPPED order.
  deliveryCode?: string | null;
  createdAt: string;
  updatedAt: string;
};

export type PaymentStatus = 'PENDING' | 'SUCCEEDED' | 'FAILED';

export type Payment = {
  id: string;
  orderId: string;
  provider: string;
  providerRef: string;
  amountCents: number;
  status: PaymentStatus;
  idempotencyKey: string;
  createdAt: string;
  updatedAt: string;
};
