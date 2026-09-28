import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate';
import { validateQuery } from '../../middleware/validate';
import {
  listNotificationsHandler,
  markAllNotificationsReadHandler,
  markNotificationReadHandler,
} from './controller';
import { listNotificationsQuerySchema } from './schema';

export const notificationRoutes = Router();

// Every route requires a real identity — there is no "anonymous viewer"
// concept for notifications, same reasoning as orders/routes.ts.
notificationRoutes.get('/', authenticate, validateQuery(listNotificationsQuerySchema), listNotificationsHandler);
notificationRoutes.post('/read-all', authenticate, markAllNotificationsReadHandler);
notificationRoutes.post('/:id/read', authenticate, markNotificationReadHandler);
