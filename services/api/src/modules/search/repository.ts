import type { Auction } from '@prisma/client';
import { searchClient } from '../../infrastructure/search/client';
import { env } from '../../config/env';
import { logger } from '../../infrastructure/observability/logger';

const INDEX = env.OPENSEARCH_AUCTIONS_INDEX;

// `text` fields (title/description) get OpenSearch's default analyzer —
// tokenized, lowercased, so "Vintage Rolex" matches a query for "rolex" —
// that's the entire reason a dedicated search engine is here instead of a
// Postgres `=`/`ILIKE` filter. Everything else is `keyword` (exact-match
// filtering, never tokenized) or a numeric/date type — a category or status
// filter must never accidentally fuzzy-match.
const AUCTION_INDEX_MAPPING = {
  properties: {
    id: { type: 'keyword' },
    sellerId: { type: 'keyword' },
    title: { type: 'text' },
    description: { type: 'text' },
    category: { type: 'keyword' },
    condition: { type: 'keyword' },
    status: { type: 'keyword' },
    images: { type: 'keyword' },
    startingPriceCents: { type: 'long' },
    currentPriceCents: { type: 'long' },
    createdAt: { type: 'date' },
    endTime: { type: 'date' },
  },
} as const;

// Idempotent, same precedent as MEDIA-001's ensureBucketExists — safe to
// call on every boot. Creating an index that already exists is a normal,
// expected no-op here (checked first, not just caught-and-ignored), not an
// error path.
export async function ensureAuctionIndex(): Promise<void> {
  const exists = await searchClient.indices.exists({ index: INDEX });
  if (exists.body) {
    return;
  }
  await searchClient.indices.create({
    index: INDEX,
    body: { mappings: AUCTION_INDEX_MAPPING },
  });
  logger.info({ index: INDEX }, 'search.index_created');
}

export type AuctionDocument = Pick<
  Auction,
  | 'id'
  | 'sellerId'
  | 'title'
  | 'description'
  | 'category'
  | 'condition'
  | 'status'
  | 'images'
  | 'startingPriceCents'
  | 'currentPriceCents'
  | 'createdAt'
  | 'endTime'
>;

// Upsert via `index` (not `update`) — the consumer always has the FULL
// current row (re-fetched fresh from Postgres, modules/search/consumer.ts),
// never a partial patch, so a full document replace is simpler and
// correct: no risk of a stale field lingering from a previous version the
// way a partial `update` could leave behind.
export async function upsertAuctionDocument(auction: AuctionDocument): Promise<void> {
  await searchClient.index({
    index: INDEX,
    id: auction.id,
    body: {
      id: auction.id,
      sellerId: auction.sellerId,
      title: auction.title,
      description: auction.description,
      category: auction.category,
      condition: auction.condition,
      status: auction.status,
      images: auction.images,
      startingPriceCents: auction.startingPriceCents,
      currentPriceCents: auction.currentPriceCents,
      createdAt: auction.createdAt,
      endTime: auction.endTime,
    },
    refresh: false,
  });
}

// DRAFT auctions (not publicly visible, ADR-0008) must never end up
// searchable — and there is no legitimate PUBLISHED-or-later auction that
// should ever be removed from the index while it still exists, so the only
// two reasons to reach this are "the row is gone" (impossible today — no
// delete endpoint exists) or "it's still a DRAFT." Deleting a document that
// was never indexed is a normal no-op (`ignore: [404]`), not an error —
// covers a DRAFT auction that gets edited before ever being published.
export async function deleteAuctionDocument(auctionId: string): Promise<void> {
  await searchClient.delete({ index: INDEX, id: auctionId }, { ignore: [404] });
}

export type SearchAuctionsParams = {
  q?: string;
  category?: string;
  status?: string;
  minPriceCents?: number;
  maxPriceCents?: number;
  page: number;
  limit: number;
};

export type SearchAuctionsResult = {
  total: number;
  results: AuctionDocument[];
};

// Relevance ranking only makes sense with a real `q` — title weighted 2x
// description (a match in the title is a stronger signal than one buried
// in the description). With no `q`, this is a plain filtered browse over
// the same index, sorted newest-first to match the existing /auctions
// endpoint's default ordering rather than an arbitrary relevance score with
// nothing to rank against.
export async function queryAuctions(params: SearchAuctionsParams): Promise<SearchAuctionsResult> {
  const filter: Record<string, unknown>[] = [];
  if (params.category) filter.push({ term: { category: params.category } });
  if (params.status) filter.push({ term: { status: params.status } });
  if (params.minPriceCents !== undefined || params.maxPriceCents !== undefined) {
    filter.push({
      range: {
        currentPriceCents: {
          ...(params.minPriceCents !== undefined ? { gte: params.minPriceCents } : {}),
          ...(params.maxPriceCents !== undefined ? { lte: params.maxPriceCents } : {}),
        },
      },
    });
  }

  const must = params.q ? [{ multi_match: { query: params.q, fields: ['title^2', 'description'] } }] : [];

  const response = await searchClient.search({
    index: INDEX,
    body: {
      query: { bool: { must, filter } },
      // No search_after/scroll — this mirrors the same "not paginating
      // deeply" simplification the rest of this project accepts elsewhere
      // (PROGRESS.md's "Not yet done" list), deferred until real usage
      // shows anyone actually pages this far into search results.
      from: (params.page - 1) * params.limit,
      size: params.limit,
      // Sorted by relevance (OpenSearch's default `_score` order) when a
      // real text query is present; explicit newest-first only for the
      // no-`q` filtered-browse case, where there's no relevance score to
      // rank against. The key is omitted rather than set to `undefined`
      // (exactOptionalPropertyTypes) — spread it in only when needed.
      ...(params.q ? {} : { sort: [{ createdAt: 'desc' as const }] }),
    },
  });

  const hits = response.body.hits.hits as { _source: AuctionDocument }[];
  const total = response.body.hits.total;
  return {
    total: typeof total === 'number' ? total : (total?.value ?? 0),
    results: hits.map((hit) => hit._source),
  };
}
