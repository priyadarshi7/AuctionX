import type { NextFunction, Request, Response } from 'express';
import { UnauthorizedError } from '../../middleware/errors';
import { confirmOrderDelivered, getOrderForViewer, listMyOrders, payForOrder, shipOrder } from './service';
import type { PayOrderInput, ShipOrderInput } from './schema';

export async function listOrdersHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.user) {
      throw new UnauthorizedError('UNAUTHENTICATED');
    }
    const orders = await listMyOrders(req.user.id);
    res.status(200).json({ orders });
  } catch (err) {
    next(err);
  }
}

export async function getOrderHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.user) {
      throw new UnauthorizedError('UNAUTHENTICATED');
    }
    const order = await getOrderForViewer(req.user.id, req.params.id as string);
    res.status(200).json({ order });
  } catch (err) {
    next(err);
  }
}

export async function payOrderHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.user) {
      throw new UnauthorizedError('UNAUTHENTICATED');
    }
    const { idempotencyKey } = req.body as PayOrderInput;
    const payment = await payForOrder(req.user.id, req.params.id as string, idempotencyKey);
    res.status(200).json({ payment });
  } catch (err) {
    next(err);
  }
}

export async function shipOrderHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.user) {
      throw new UnauthorizedError('UNAUTHENTICATED');
    }
    const { carrier, trackingNumber } = req.body as ShipOrderInput;
    const order = await shipOrder(req.user.id, req.params.id as string, { carrier, trackingNumber });
    res.status(200).json({ order });
  } catch (err) {
    next(err);
  }
}

export async function confirmDeliveryHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.user) {
      throw new UnauthorizedError('UNAUTHENTICATED');
    }
    const order = await confirmOrderDelivered(req.user.id, req.params.id as string);
    res.status(200).json({ order });
  } catch (err) {
    next(err);
  }
}
