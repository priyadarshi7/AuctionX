import Redis from 'ioredis';
import { env } from '../../config/env';
import { logger } from '../observability/logger';

// ioredis retries connecting in the background by default (exponential
// backoff) — we rely on that built-in behavior rather than writing our own
// (Section 41: don't build retry logic you don't need). A connection error
// is logged, never thrown/crashed on: Redis is never load-bearing for
// booting or serving requests (Section 12/40 — rate limiting fails open).
export const redis = new Redis(env.REDIS_URL, {
  maxRetriesPerRequest: 1,
  lazyConnect: false,
});

redis.on('error', (err) => {
  logger.error({ err }, 'Redis connection error');
});
