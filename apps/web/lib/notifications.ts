import { apiFetch } from './apiClient';
import { formatCents } from './format';
import type { Notification } from './types/notification';

export function listMyNotificationsRequest(
  accessToken: string,
): Promise<{ notifications: Notification[]; unreadCount: number }> {
  return apiFetch<{ notifications: Notification[]; unreadCount: number }>('/notifications', { accessToken });
}

export function markNotificationReadRequest(accessToken: string, notificationId: string): Promise<{ notification: Notification }> {
  return apiFetch<{ notification: Notification }>(`/notifications/${notificationId}/read`, {
    method: 'POST',
    accessToken,
  });
}

export function markAllNotificationsReadRequest(accessToken: string): Promise<void> {
  return apiFetch<void>('/notifications/read-all', { method: 'POST', accessToken });
}

// Kept as one place mapping notification type -> display text and target
// link, rather than a switch statement duplicated inside the dropdown
// component — the type -> {auctionId, orderId, data shape} correspondence
// is defined once here, matching exactly what the five trigger sites in
// services/api create (bids/repository.ts, auctions/repository.ts,
// payments/repository.ts).
export function describeNotification(notification: Notification): { message: string; href: string } {
  const data = notification.data as Record<string, number | string | null | undefined>;
  switch (notification.type) {
    case 'OUTBID':
      return {
        message: `You were outbid — the new highest bid is ${formatCents(Number(data.newAmountCents ?? 0))}.`,
        href: `/auctions/${notification.auctionId}`,
      };
    case 'AUCTION_WON':
      return {
        message: `You won an auction for ${formatCents(Number(data.amountCents ?? 0))}!`,
        href: `/orders/${notification.orderId}`,
      };
    case 'AUCTION_SOLD':
      return {
        message: `Your auction sold for ${formatCents(Number(data.amountCents ?? 0))}.`,
        href: `/orders/${notification.orderId}`,
      };
    case 'AUCTION_RESERVE_NOT_MET':
      return {
        message: 'Your auction ended without meeting its reserve price.',
        href: `/auctions/${notification.auctionId}`,
      };
    case 'PAYMENT_RECEIVED':
      return {
        message: `Payment received: ${formatCents(Number(data.amountCents ?? 0))}. Time to ship it.`,
        href: `/orders/${notification.orderId}`,
      };
    case 'ORDER_SHIPPED':
      return {
        message: 'Your order has shipped. Track it and find your delivery code on the order page.',
        href: `/orders/${notification.orderId}`,
      };
    case 'ORDER_DELIVERED':
      return {
        message: 'Delivery confirmed. This order is complete.',
        href: `/orders/${notification.orderId}`,
      };
    case 'AUCTION_MODERATED': {
      if (data.asBidder) {
        return {
          message: `An auction you bid on was cancelled by a moderator, so your bid no longer applies${data.reason ? `: ${String(data.reason)}` : '.'}`,
          href: `/auctions/${notification.auctionId}`,
        };
      }
      if (data.action === 'approve') {
        return { message: 'Your listing was approved and is now live.', href: `/auctions/${notification.auctionId}` };
      }
      if (data.action === 'reject') {
        return {
          message: `Your listing needs changes before it can go live${data.reason ? `: ${String(data.reason)}` : '.'}`,
          href: `/auctions/${notification.auctionId}`,
        };
      }
      const verb = data.action === 'cancel' ? 'cancelled' : data.action === 'pause' ? 'paused' : 'resumed';
      return {
        message: `A moderator ${verb} your auction${data.reason ? `: ${String(data.reason)}` : '.'}`,
        href: `/auctions/${notification.auctionId}`,
      };
    }
    case 'ORDER_CANCELLED':
      return {
        message: 'An order was cancelled because payment was not received in time.',
        href: `/orders/${notification.orderId}`,
      };
  }
}
