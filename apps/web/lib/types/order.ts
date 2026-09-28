// Mirrors services/api/prisma/schema.prisma's Order/Payment models
// (ADR-0023/0025) — same Date-becomes-ISO-string-over-HTTP note as
// lib/types/auction.ts.

export type OrderStatus = 'PENDING_PAYMENT' | 'PAID' | 'CANCELLED';

export type Order = {
  id: string;
  auctionId: string;
  winningBidId: string;
  sellerId: string;
  buyerId: string;
  amountCents: number;
  status: OrderStatus;
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
