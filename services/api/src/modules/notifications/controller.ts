import type { NextFunction, Request, Response } from 'express';
import { UnauthorizedError } from '../../middleware/errors';
import { getUnreadCount, listMyNotifications, markAllRead, markRead } from './service';
import type { ListNotificationsQuery } from './schema';

export async function listNotificationsHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.user) {
      throw new UnauthorizedError('UNAUTHENTICATED');
    }
    const { limit } = req.validatedQuery as ListNotificationsQuery;
    const [notifications, unreadCount] = await Promise.all([
      listMyNotifications(req.user.id, limit),
      getUnreadCount(req.user.id),
    ]);
    res.status(200).json({ notifications, unreadCount });
  } catch (err) {
    next(err);
  }
}

export async function markNotificationReadHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.user) {
      throw new UnauthorizedError('UNAUTHENTICATED');
    }
    const notification = await markRead(req.user.id, req.params.id as string);
    res.status(200).json({ notification });
  } catch (err) {
    next(err);
  }
}

export async function markAllNotificationsReadHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.user) {
      throw new UnauthorizedError('UNAUTHENTICATED');
    }
    await markAllRead(req.user.id);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
}
