import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate';
import { bidRateLimit } from '../../middleware/rateLimit';
import { validateBody, validateQuery } from '../../middleware/validate';
import { listBidsHandler, placeBidHandler } from './controller';
import { listBidsQuerySchema, placeBidSchema } from './schema';

// mergeParams: true is required for this router (mounted at
// /api/v1/auctions/:auctionId/bids in app.ts) to see :auctionId at all —
// Express routers do NOT inherit a parent mount's params by default.
// Verified empirically before relying on it (Express 5 changed enough
// req.query/req.body behavior elsewhere this session that assuming felt
// unwise here too).
export const bidRoutes = Router({ mergeParams: true });

// bidRateLimit runs after authenticate (needs req.user) and stacks on top
// of the already-global apiRateLimit, same pattern as authRateLimit
// stacking with apiRateLimit elsewhere — see middleware/rateLimit.ts for
// why bidding specifically needs a stricter, (user, auction)-keyed ceiling
// beyond the generic per-user one (Section 30 / CACHE-001's sibling task).
bidRoutes.post('/', authenticate, bidRateLimit, validateBody(placeBidSchema), placeBidHandler);
bidRoutes.get('/', validateQuery(listBidsQuerySchema), listBidsHandler);
