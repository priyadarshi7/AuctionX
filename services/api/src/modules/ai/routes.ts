import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate';
import { aiRegenerateRateLimit } from '../../middleware/rateLimit';
import { getValuationHandler, regenerateValuationHandler } from './controller';

// mergeParams: true — mounted at /api/v1/auctions/:auctionId/valuation in
// app.ts, same reasoning as modules/bids/routes.ts.
export const aiValuationRoutes = Router({ mergeParams: true });

// authenticate on both — this is seller-only data, never public (see
// service.ts's comment on why a bidder shouldn't see it).
aiValuationRoutes.get('/', authenticate, getValuationHandler);
aiValuationRoutes.post('/regenerate', authenticate, aiRegenerateRateLimit, regenerateValuationHandler);
