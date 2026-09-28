import type { NextFunction, Request, Response } from 'express';
import { searchAuctions } from './service';
import type { SearchAuctionsQuery } from './schema';

// No `authenticate` — same reasoning as auctions/controller.ts's
// listAuctionsHandler: browsing/searching is Section 30's "high traffic, no
// login required" case.
export async function searchAuctionsHandler(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const query = req.validatedQuery as SearchAuctionsQuery;
    // Conditional spreads, not passing `query` straight through — same
    // `exactOptionalPropertyTypes` convention auctions/service.ts's
    // listPublicAuctions already follows: an optional field must be either
    // present with a real value or absent entirely, never present-as-
    // `undefined`.
    const result = await searchAuctions({
      ...(query.q !== undefined ? { q: query.q } : {}),
      ...(query.category !== undefined ? { category: query.category } : {}),
      ...(query.status !== undefined ? { status: query.status } : {}),
      ...(query.minPriceCents !== undefined ? { minPriceCents: query.minPriceCents } : {}),
      ...(query.maxPriceCents !== undefined ? { maxPriceCents: query.maxPriceCents } : {}),
      page: query.page,
      limit: query.limit,
    });
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}
