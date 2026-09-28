import type { NextFunction, Request, Response } from 'express';
import { UnauthorizedError } from '../../middleware/errors';
import { getValuation, regenerateValuation } from './service';

export async function getValuationHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.user) {
      throw new UnauthorizedError('UNAUTHENTICATED');
    }
    const valuation = await getValuation(req.user.id, req.params.auctionId as string);
    res.status(200).json(valuation);
  } catch (err) {
    next(err);
  }
}

export async function regenerateValuationHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.user) {
      throw new UnauthorizedError('UNAUTHENTICATED');
    }
    const valuation = await regenerateValuation(req.user.id, req.params.auctionId as string);
    res.status(202).json(valuation);
  } catch (err) {
    next(err);
  }
}
