import Redis from 'ioredis';
import { env } from '../../config/env';
import { logger } from '../observability/logger';

// ioredis retries connecting in the background by default (exponential
// backoff) — we rely on that built-in behavior rather than writing our own
// (Section 41: don't build retry logic you don't need). A connection error
// is logged, never thrown/crashed on: Redis is never load-bearing for
// booting or serving requests (Section 12/40 — rate limiting fails open).
//
// commandTimeout matters for a DIFFERENT failure mode than connectTimeout:
// connectTimeout only bounds the TCP handshake, but a socket can finish
// that handshake and then go dead at the protocol level (observed live: a
// stale WSL2 port-forward accepted the TCP connection instantly, then
// never relayed a single byte of the Redis protocol). Without a command
// timeout, every `await redis.eval(...)` in middleware/rateLimit.ts hangs
// forever on a connection ioredis still considers "open" — the fail-open
// try/catch there is correctly written but never runs, because the
// promise never settles. 3s is generous for a healthy call (sub-10ms
// normally) and short enough that a dead connection fails fast instead of
// hanging every /api/v1/auth/* request (including the frontend's
// on-every-page-load silent refresh) indefinitely.
export const redis = new Redis(env.REDIS_URL, {
  maxRetriesPerRequest: 1,
  lazyConnect: false,
  commandTimeout: 3000,
});

redis.on('error', (err) => {
  logger.error({ err }, 'Redis connection error');
});
