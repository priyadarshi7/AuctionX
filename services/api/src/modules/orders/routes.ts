import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate';
import { validateBody } from '../../middleware/validate';
import {
  confirmDeliveryHandler,
  getOrderHandler,
  listOrdersHandler,
  payOrderHandler,
  shipOrderHandler,
} from './controller';
import { payOrderSchema, shipOrderSchema } from './schema';

export const orderRoutes = Router();

// Every order route requires a real identity — unlike auction browsing,
// there is no "anonymous viewer" concept for orders (ADR-0008's visibility
// rule doesn't apply here; an order is never public).
orderRoutes.get('/', authenticate, listOrdersHandler);
orderRoutes.get('/:id', authenticate, getOrderHandler);
orderRoutes.post('/:id/pay', authenticate, validateBody(payOrderSchema), payOrderHandler);
orderRoutes.post('/:id/ship', authenticate, validateBody(shipOrderSchema), shipOrderHandler);
orderRoutes.post('/:id/confirm-delivery', authenticate, confirmDeliveryHandler);
