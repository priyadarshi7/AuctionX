import type { Notification } from '@prisma/client';
import { prisma } from '../../infrastructure/database/prisma';

// Notification creation itself lives in modules/notifications/consumer.ts
// now, not here (ADR-0027) — it's triggered by a Kafka message, not a
// caller's own open transaction, so there's no `tx` to join and no reason
// for a wrapper function here. This file stays the read/mark-read side of
// the module's public surface.

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
