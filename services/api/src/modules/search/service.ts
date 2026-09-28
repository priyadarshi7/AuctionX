import { AppError } from '../../middleware/errors';
import { logger } from '../../infrastructure/observability/logger';
import { listAuctions } from '../auctions/repository';
import { queryAuctions, upsertAuctionDocument, type SearchAuctionsParams, type SearchAuctionsResult } from './repository';

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

// The gap reindex-on-mutation (ADR-0029) always had: it only ever indexes
// an auction the NEXT time something happens to it — a row that already
// existed before this feature shipped, and that nothing has touched
// since, has no reindex event to ever trigger from. Found from live usage
// (ADR-0031): a real pre-existing "Hello" auction was simply never in the
// index at all, confirmed directly against OpenSearch (`found: false`),
// not a query bug. This walks every non-DRAFT auction in Postgres
// (keyset-paginated, same AuctionListFilters/cursor auctions/repository.ts
// already uses for browsing — no reason to invent a second pagination
// scheme) and upserts it, closing that gap once. Called automatically
// when the index is freshly created (repository.ts's ensureAuctionIndex)
// and available as its own script (scripts/reindex-search.ts) for
// whenever a full rebuild is needed on a non-empty index.
export async function reindexAllAuctions(): Promise<{ indexed: number }> {
  let indexed = 0;
  let after: Parameters<typeof listAuctions>[2];
  for (;;) {
    const { rows, hasMore } = await listAuctions({ status: { not: 'DRAFT' } }, 200, after);
    for (const auction of rows) {
      await upsertAuctionDocument(auction);
      indexed += 1;
    }
    const last = rows.at(-1);
    if (!hasMore || !last) break;
    after = { createdAt: last.createdAt, id: last.id };
  }
  logger.info({ indexed }, 'search.reindex_all_complete');
  return { indexed };
}
