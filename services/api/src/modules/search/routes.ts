import { Router } from 'express';
import { validateQuery } from '../../middleware/validate';
import { searchAuctionsHandler } from './controller';
import { searchAuctionsQuerySchema } from './schema';

export const searchRoutes = Router();

searchRoutes.get('/auctions', validateQuery(searchAuctionsQuerySchema), searchAuctionsHandler);
