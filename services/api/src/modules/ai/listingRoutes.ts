import { Router } from 'express';
import { isGroqConfigured } from '../../infrastructure/ai/groqClient';
import { authenticate } from '../../middleware/authenticate';
import { aiListingGlobalRateLimit, aiListingRateLimit } from '../../middleware/rateLimit';
import { validateBody } from '../../middleware/validate';
import { suggestListing } from './listingAssistant';
import { listingSuggestionRequestSchema, type ListingSuggestionRequest } from './listingSchema';

// Mounted at /api/v1/ai.
export const aiListingRoutes = Router();

// Lets the web app hide the button instead of offering something that cannot
// work.
aiListingRoutes.get('/status', authenticate, (_req, res) => {
  res.status(200).json({ listingAssistant: isGroqConfigured() });
});

// Synchronous on purpose (Section 57): a person is waiting for the answer,
// it takes seconds, and nothing else depends on it.
aiListingRoutes.post(
  '/listing-suggestions',
  authenticate,
  aiListingRateLimit,
  aiListingGlobalRateLimit,
  validateBody(listingSuggestionRequestSchema),
  async (req, res, next) => {
    try {
      const suggestion = await suggestListing(req.body as ListingSuggestionRequest);
      res.status(200).json({ suggestion });
    } catch (err) {
      next(err);
    }
  },
);
