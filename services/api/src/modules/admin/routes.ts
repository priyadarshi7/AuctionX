import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate';
import { requireRole } from '../../middleware/authorize';
import { validateBody, validateQuery } from '../../middleware/validate';
import {
  listAuctionsHandler,
  listAuditLogHandler,
  listOrdersHandler,
  listUsersHandler,
  moderateAuctionHandler,
  refundOrderHandler,
  setTrustedSellerHandler,
  statsHandler,
  updateUserStatusHandler,
} from './controller';
import {
  listAdminAuctionsQuerySchema,
  listAdminOrdersQuerySchema,
  listAuditLogQuerySchema,
  listUsersQuerySchema,
  moderateAuctionSchema,
  setTrustedSellerSchema,
  updateUserStatusSchema,
} from './schema';

export const adminRoutes = Router();

// One gate for the whole router, applied before any route is matched, so a
// new admin endpoint added below can't forget it. 401 for no/invalid token,
// 403 for a real non-admin (authenticate then requireRole).
adminRoutes.use(authenticate, requireRole('ADMIN'));

adminRoutes.get('/stats', statsHandler);

adminRoutes.get('/users', validateQuery(listUsersQuerySchema), listUsersHandler);
adminRoutes.patch('/users/:userId/status', validateBody(updateUserStatusSchema), updateUserStatusHandler);

adminRoutes.patch('/users/:userId/trusted', validateBody(setTrustedSellerSchema), setTrustedSellerHandler);

adminRoutes.get('/auctions', validateQuery(listAdminAuctionsQuerySchema), listAuctionsHandler);
adminRoutes.post('/auctions/:auctionId/moderate', validateBody(moderateAuctionSchema), moderateAuctionHandler);

adminRoutes.get('/orders', validateQuery(listAdminOrdersQuerySchema), listOrdersHandler);
adminRoutes.post('/orders/:orderId/refund', refundOrderHandler);

adminRoutes.get('/audit-log', validateQuery(listAuditLogQuerySchema), listAuditLogHandler);
