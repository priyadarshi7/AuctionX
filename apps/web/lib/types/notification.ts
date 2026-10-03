// Mirrors services/api/prisma/schema.prisma's Notification model.

export type NotificationType =
  | 'OUTBID'
  | 'AUCTION_WON'
  | 'AUCTION_SOLD'
  | 'AUCTION_RESERVE_NOT_MET'
  | 'PAYMENT_RECEIVED'
  | 'ORDER_SHIPPED'
  | 'ORDER_DELIVERED'
  | 'ORDER_CANCELLED'
  | 'AUCTION_MODERATED';

export type Notification = {
  id: string;
  userId: string;
  type: NotificationType;
  auctionId: string | null;
  orderId: string | null;
  data: Record<string, unknown>;
  readAt: string | null;
  createdAt: string;
};
