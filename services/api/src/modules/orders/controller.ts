import type { NextFunction, Request, Response } from 'express';
import { UnauthorizedError } from '../../middleware/errors';
import {
  confirmDeliveryWithCode,
  getOrderForViewer,
  listMyOrders,
  payForOrder,
  regenerateCode,
  setShippingAddress,
  shipOrder,
  syncPayment,
} from './service';
import type { ConfirmDeliveryInput, PayOrderInput } from './schema';

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
    const { payment, checkoutUrl } = await payForOrder(req.user.id, req.params.id as string, idempotencyKey);
    res.status(200).json({ payment, checkoutUrl });
  } catch (err) {
    next(err);
  }
}

export async function syncPaymentHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.user) {
      throw new UnauthorizedError('UNAUTHENTICATED');
    }
    await syncPayment(req.user.id, req.params.id as string);
    res.status(200).json({ synced: true });
  } catch (err) {
    next(err);
  }
}

export async function setShippingAddressHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.user) {
      throw new UnauthorizedError('UNAUTHENTICATED');
    }
    const order = await setShippingAddress(req.user.id, req.params.id as string, req.body);
    res.status(200).json({ order });
  } catch (err) {
    next(err);
  }
}

export async function shipOrderHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.user) {
      throw new UnauthorizedError('UNAUTHENTICATED');
    }
    const order = await shipOrder(req.user.id, req.params.id as string);
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
    const { code } = req.body as ConfirmDeliveryInput;
    const order = await confirmDeliveryWithCode(req.user.id, req.params.id as string, code);
    res.status(200).json({ order });
  } catch (err) {
    next(err);
  }
}

export async function regenerateCodeHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.user) {
      throw new UnauthorizedError('UNAUTHENTICATED');
    }
    const order = await regenerateCode(req.user.id, req.params.id as string);
    res.status(200).json({ order });
  } catch (err) {
    next(err);
  }
}
