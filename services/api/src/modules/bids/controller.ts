import type { NextFunction, Request, Response } from 'express';
import { UnauthorizedError } from '../../middleware/errors';
import { listBidsForAuctionAsViewer, placeBid } from './service';
import type { ListBidsQuery, PlaceBidInput } from './schema';

export async function placeBidHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.user) {
      throw new UnauthorizedError('UNAUTHENTICATED');
    }
    const input = req.body as PlaceBidInput;
    const { bid, extended } = await placeBid(req.user.id, req.params.auctionId as string, input);
    // auctionExtended lets a client show "auction extended!" feedback
    // immediately, without a second round trip to re-fetch the auction.
    res.status(201).json({ bid, auctionExtended: extended });
  } catch (err) {
    next(err);
  }
}

// No `authenticate` — same reasoning as auctions' own GET routes (ADR-0008):
// req.user is populated best-effort by the global optionalAuthenticate.
export async function listBidsHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { limit } = req.validatedQuery as ListBidsQuery;
    const bids = await listBidsForAuctionAsViewer(req.user, req.params.auctionId as string, limit);
    res.status(200).json({ bids });
  } catch (err) {
    next(err);
  }
}
