import type { Auction } from '@prisma/client';
import { redis } from './client';
import { logger } from '../observability/logger';

// See ADR-0017 for the full cache-rules writeup (Section 13 format). 5s
// matches the frontend's own poll interval (WEB-002) — even in the worst
// case (a missed invalidation call), staleness never exceeds what the
// polling loop already tolerates.
const AUCTION_CACHE_TTL_SECONDS = 5;

function cacheKey(auctionId: string): string {
  return `auction:${auctionId}`;
}

// Date fields survive a JSON.stringify as ISO strings but don't come back
// as Date objects from JSON.parse — revived here so a cache hit is
// genuinely indistinguishable from a fresh Prisma read to every caller,
// not just to whatever happens to only read/re-serialize these fields today.
const DATE_FIELDS = ['createdAt', 'updatedAt', 'startTime', 'endTime', 'endedAt'] as const;

function reviveDates(raw: Record<string, unknown>): Auction {
  for (const field of DATE_FIELDS) {
    const value = raw[field];
    if (typeof value === 'string') {
      raw[field] = new Date(value);
    }
  }
  return raw as unknown as Auction;
}

// Every function here is best-effort and fails open: Redis is never the
// source of truth (Section 12/40), so a Redis error is logged and treated
// as "no cache," never surfaced to the caller. Callers always get a
// correct answer from Postgres either way — just without the speedup.
export async function getCachedAuction(auctionId: string): Promise<Auction | null> {
  try {
    const raw = await redis.get(cacheKey(auctionId));
    if (!raw) return null;
    return reviveDates(JSON.parse(raw) as Record<string, unknown>);
  } catch (err) {
    logger.warn({ err, auctionId }, 'auction_cache.read_failed');
    return null;
  }
}

export async function setCachedAuction(auction: Auction): Promise<void> {
  try {
    await redis.set(cacheKey(auction.id), JSON.stringify(auction), 'EX', AUCTION_CACHE_TTL_SECONDS);
  } catch (err) {
    logger.warn({ err, auctionId: auction.id }, 'auction_cache.write_failed');
  }
}

// Called after a write commits, never before and never from inside the
// transaction itself — see ADR-0017's "why" section for the two failure
// directions that ordering avoids.
export async function invalidateAuctionCache(auctionId: string): Promise<void> {
  try {
    await redis.del(cacheKey(auctionId));
  } catch (err) {
    logger.warn({ err, auctionId }, 'auction_cache.invalidate_failed');
  }
}
