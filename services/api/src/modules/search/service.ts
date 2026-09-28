import { AppError } from '../../middleware/errors';
import { logger } from '../../infrastructure/observability/logger';
import { queryAuctions, type SearchAuctionsParams, type SearchAuctionsResult } from './repository';

// Distinct from every other 503 in this codebase (readiness, e.g.) — this
// one specifically means "the transactional system is fine, only search
// is degraded," matching Section 25's explicit requirement that a search
// outage must not look like or cause a broader outage. A structured error
// instead of silently returning an empty result set: an empty result set
// would lie to the caller ("nothing matched") when the true answer is
// "unknown, ask again later."
export class SearchUnavailableError extends AppError {
  constructor() {
    super(503, 'SEARCH_UNAVAILABLE', 'Search is temporarily unavailable, please try again shortly');
  }
}

export async function searchAuctions(params: SearchAuctionsParams): Promise<SearchAuctionsResult> {
  try {
    return await queryAuctions(params);
  } catch (err) {
    logger.error({ err }, 'search.query_failed');
    throw new SearchUnavailableError();
  }
}
