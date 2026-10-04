import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate';
import { validateBody } from '../../middleware/validate';
import {
  confirmDeliveryHandler,
  getOrderHandler,
  listOrdersHandler,
  payOrderHandler,
  regenerateCodeHandler,
  setShippingAddressHandler,
  shipOrderHandler,
  syncPaymentHandler,
} from './controller';
import { confirmDeliverySchema, payOrderSchema, shippingAddressBodySchema } from './schema';

export const orderRoutes = Router();

// Every order route requires a real identity — unlike auction browsing,
// there is no "anonymous viewer" concept for orders (ADR-0008's visibility
// rule doesn't apply here; an order is never public).
orderRoutes.get('/', authenticate, listOrdersHandler);
orderRoutes.get('/:id', authenticate, getOrderHandler);
orderRoutes.put('/:id/shipping-address', authenticate, validateBody(shippingAddressBodySchema), setShippingAddressHandler);
orderRoutes.post('/:id/pay', authenticate, validateBody(payOrderSchema), payOrderHandler);
orderRoutes.post('/:id/payment/sync', authenticate, syncPaymentHandler);
orderRoutes.post('/:id/ship', authenticate, shipOrderHandler);
// SELLER, with the buyer's one-time code (ADR-0045).
orderRoutes.post('/:id/confirm-delivery', authenticate, validateBody(confirmDeliverySchema), confirmDeliveryHandler);
// BUYER: a fresh code, which also unlocks an order locked by wrong guesses.
orderRoutes.post('/:id/delivery-code/regenerate', authenticate, regenerateCodeHandler);
