import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate';
import { validateBody, validateQuery } from '../../middleware/validate';
import {
  cancelAuctionHandler,
  createAuctionHandler,
  getAuctionHandler,
  listAuctionsHandler,
  pauseAuctionHandler,
  publishAuctionHandler,
  startAuctionHandler,
  submitAuctionHandler,
  updateAuctionHandler,
  withdrawAuctionHandler,
} from './controller';
import {
  createAuctionSchema,
  listAuctionsQuerySchema,
  publishAuctionSchema,
  submitAuctionSchema,
  updateAuctionSchema,
} from './schema';

export const auctionRoutes = Router();

// No dedicated rate limiter beyond the global apiRateLimit already applied
// to /api/v1/* in app.ts — Section 30 doesn't call out auction creation as
// needing a stricter tier than the general authenticated-user ceiling
// (contrast with login/register, which are pre-auth and IP-keyed for a
// specific reason — see authRateLimit).
auctionRoutes.post('/', authenticate, validateBody(createAuctionSchema), createAuctionHandler);

// No `authenticate` here — browsing/reading is Section 30's "high traffic,
// no login required" case. req.user is already populated best-effort by the
// global optionalAuthenticate (app.ts), which is all these handlers need to
// decide draft visibility.
auctionRoutes.get('/', validateQuery(listAuctionsQuerySchema), listAuctionsHandler);
auctionRoutes.get('/:id', getAuctionHandler);

auctionRoutes.patch('/:id', authenticate, validateBody(updateAuctionSchema), updateAuctionHandler);
auctionRoutes.post(
  '/:id/publish',
  authenticate,
  validateBody(publishAuctionSchema),
  publishAuctionHandler,
);

// The review-aware way to list an auction (ADR-0041): the server decides
// whether it waits for an admin or goes straight live.
auctionRoutes.post('/:id/submit', authenticate, validateBody(submitAuctionSchema), submitAuctionHandler);
auctionRoutes.post('/:id/withdraw', authenticate, withdrawAuctionHandler);

// No body on any of these — the action itself is the entire request.
auctionRoutes.post('/:id/start', authenticate, startAuctionHandler);
auctionRoutes.post('/:id/pause', authenticate, pauseAuctionHandler);
auctionRoutes.post('/:id/cancel', authenticate, cancelAuctionHandler);
