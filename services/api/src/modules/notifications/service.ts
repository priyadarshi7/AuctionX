import type { Notification } from '@prisma/client';
import { NotFoundError } from '../../middleware/errors';
import {
  countUnreadForUser,
  listNotificationsForUser,
  markAllNotificationsRead,
  markNotificationRead,
} from './repository';

export function listMyNotifications(userId: string, limit: number): Promise<Notification[]> {
  return listNotificationsForUser(userId, limit);
}

export function getUnreadCount(userId: string): Promise<number> {
  return countUnreadForUser(userId);
}

export async function markRead(userId: string, notificationId: string): Promise<Notification> {
  const notification = await markNotificationRead(userId, notificationId);
  if (!notification) {
    throw new NotFoundError('Notification not found');
  }
  return notification;
}

export function markAllRead(userId: string): Promise<void> {
  return markAllNotificationsRead(userId);
}
