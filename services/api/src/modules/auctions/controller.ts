import type { NextFunction, Request, Response } from 'express';
import { UnauthorizedError } from '../../middleware/errors';
import {
  cancelExistingAuction,
  createNewAuction,
  getAuctionForViewer,
  listPublicAuctions,
  pauseExistingAuction,
  publishExistingAuction,
  startExistingAuction,
  updateExistingAuction,
} from './service';
import type {
  CreateAuctionInput,
  ListAuctionsQuery,
  PublishAuctionInput,
  UpdateAuctionInput,
} from './schema';

export async function createAuctionHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.user) {
      // Unreachable in practice — this route is always behind `authenticate`
      // — but narrows the type and fails loudly instead of silently if that
      // ever stops being true (same pattern as auth's `me` handler).
      throw new UnauthorizedError('UNAUTHENTICATED');
    }
    const input = req.body as CreateAuctionInput;
    const auction = await createNewAuction(req.user.id, input);
    res.status(201).json({ auction });
  } catch (err) {
    next(err);
  }
}

// No `authenticate` on this route (see routes.ts) — req.user is populated
// best-effort by the global `optionalAuthenticate` in app.ts, or left
// undefined for an anonymous browser. Both are valid callers here.
export async function listAuctionsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const query = req.validatedQuery as ListAuctionsQuery;
    const result = await listPublicAuctions(req.user, query);
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

export async function getAuctionHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const auction = await getAuctionForViewer(req.user, req.params.id as string);
    res.status(200).json({ auction });
  } catch (err) {
    next(err);
  }
}

export async function updateAuctionHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.user) {
      throw new UnauthorizedError('UNAUTHENTICATED');
    }
    const patch = req.body as UpdateAuctionInput;
    const auction = await updateExistingAuction(req.user.id, req.params.id as string, patch);
    res.status(200).json({ auction });
  } catch (err) {
    next(err);
  }
}

export async function publishAuctionHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.user) {
      throw new UnauthorizedError('UNAUTHENTICATED');
    }
    const input = req.body as PublishAuctionInput;
    const auction = await publishExistingAuction(req.user.id, req.params.id as string, input);
    res.status(200).json({ auction });
  } catch (err) {
    next(err);
  }
}

// start/pause/cancel take no request body — the action is the whole
// request, unlike publish (which can carry an optional schedule override).
export async function startAuctionHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.user) {
      throw new UnauthorizedError('UNAUTHENTICATED');
    }
    const auction = await startExistingAuction(req.user.id, req.params.id as string);
    res.status(200).json({ auction });
  } catch (err) {
    next(err);
  }
}

export async function pauseAuctionHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.user) {
      throw new UnauthorizedError('UNAUTHENTICATED');
    }
    const auction = await pauseExistingAuction(req.user.id, req.params.id as string);
    res.status(200).json({ auction });
  } catch (err) {
    next(err);
  }
}

export async function cancelAuctionHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.user) {
      throw new UnauthorizedError('UNAUTHENTICATED');
    }
    const auction = await cancelExistingAuction(req.user.id, req.params.id as string);
    res.status(200).json({ auction });
  } catch (err) {
    next(err);
  }
}
