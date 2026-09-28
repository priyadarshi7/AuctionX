import type { Notification, NotificationType, Prisma } from '@prisma/client';
import { prisma } from '../../infrastructure/database/prisma';

export type NewNotification = {
  userId: string;
  type: NotificationType;
  auctionId?: string;
  orderId?: string;
  data: Prisma.InputJsonValue;
};

// Takes the CALLER's transaction client, not the module-level `prisma`
// singleton — every trigger site (bids/repository.ts, auctions/repository.ts,
// payments/repository.ts) creates a Notification inside its OWN existing
// transaction, so the notification's existence is atomically consistent
// with the event it reports (see the Notification model's doc comment in
// schema.prisma). Same pragmatic cross-module reach-in already used
// elsewhere (Section 54) — e.g. bids/repository.ts locking the Auction row.
export function createNotificationInTx(tx: Prisma.TransactionClient, data: NewNotification): Promise<Notification> {
  return tx.notification.create({ data });
}

export function listNotificationsForUser(userId: string, limit: number): Promise<Notification[]> {
  return prisma.notification.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    take: limit,
  });
}

export function countUnreadForUser(userId: string): Promise<number> {
  return prisma.notification.count({ where: { userId, readAt: null } });
}

// Returns null for "doesn't exist or isn't yours" (the service layer turns
// that into a 404 — Section 8's usual "don't leak which ids exist" isn't a
// real concern here, but the null makes ownership and not-found symmetric
// without a separate lookup). Marking an already-read notification read
// again is a harmless no-op, not an error — idempotent by construction,
// same instinct as every other mutating endpoint in this codebase.
export async function markNotificationRead(userId: string, notificationId: string): Promise<Notification | null> {
  const notification = await prisma.notification.findUnique({ where: { id: notificationId } });
  if (!notification || notification.userId !== userId) {
    return null;
  }
  if (notification.readAt) {
    return notification;
  }
  return prisma.notification.update({ where: { id: notificationId }, data: { readAt: new Date() } });
}

export async function markAllNotificationsRead(userId: string): Promise<void> {
  await prisma.notification.updateMany({
    where: { userId, readAt: null },
    data: { readAt: new Date() },
  });
}
