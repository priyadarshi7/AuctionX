import type { NextFunction, Request, Response } from 'express';
import { redis } from '../infrastructure/redis/client';
import { logger } from '../infrastructure/observability/logger';
import { env } from '../config/env';
import { AppError } from './errors';

// Atomic INCR + conditional EXPIRE in one round trip. Without the Lua
// script, a plain "INCR then separately EXPIRE" has a window where a crash
// or race between the two commands could leave a key with no TTL — it
// would then live forever, silently locking that key out permanently.
const FIXED_WINDOW_SCRIPT = `
local current = redis.call('INCR', KEYS[1])
if current == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
end
return current
`;

export class TooManyRequestsError extends AppError {
  constructor(retryAfterSeconds: number) {
    super(429, 'TOO_MANY_REQUESTS', 'Too many requests, please try again later', {
      retryAfterSeconds,
    });
  }
}

export type RateLimitOptions = {
  windowSeconds: number;
  // A function lets the quota itself differ by caller, not just the key —
  // e.g. authenticated callers get a higher ceiling than anonymous ones.
  max: number | ((req: Request) => number);
  keyPrefix: string;
  // Defaults to IP. Pass a custom keyBy to key by something else (e.g. the
  // authenticated user id) — see `apiRateLimit` below for the
  // authenticated-vs-anonymous split.
  keyBy?: (req: Request) => string;
};

/*
 * Cache rules (Section 13):
 * Key:              ratelimit:{keyPrefix}:{ip|user:<id>}
 * TTL:               windowSeconds (fixed window)
 * Value:             integer request counter
 * Source of truth:   N/A — Redis IS the store; this data has no other home
 *                     and doesn't need one (never business-critical)
 * Invalidation:       TTL expiry only (fixed window resets naturally)
 * Consistency:        eventually consistent across a Redis restart —
 *                     counters reset, which just means a transient loss of
 *                     throttling, not a correctness problem
 * Failure behavior:   FAIL OPEN — a Redis error lets the request through
 *                     and logs the error, rather than blocking all traffic
 *                     on a defensive layer's outage (Section 40)
 * Hot-key risk:       one aggressively-retrying attacker IP becomes a hot
 *                     key under sustained brute force; Redis handles this
 *                     volume trivially at our current scale
 */
export function rateLimit(options: RateLimitOptions) {
  const keyBy = options.keyBy ?? ((req: Request) => req.ip ?? 'unknown');

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const key = `ratelimit:${options.keyPrefix}:${keyBy(req)}`;

    const max = typeof options.max === 'function' ? options.max(req) : options.max;

    try {
      const current = (await redis.eval(
        FIXED_WINDOW_SCRIPT,
        1,
        key,
        options.windowSeconds,
      )) as number;

      res.setHeader('X-RateLimit-Limit', max);
      res.setHeader('X-RateLimit-Remaining', Math.max(0, max - current));

      if (current > max) {
        const ttl = await redis.ttl(key);
        next(new TooManyRequestsError(ttl > 0 ? ttl : options.windowSeconds));
        return;
      }

      next();
    } catch (err) {
      logger.error({ err, key }, 'Rate limit check failed; failing open');
      next();
    }
  };
}

const API_RATE_LIMIT_AUTHENTICATED_MAX = 300;
const API_RATE_LIMIT_ANONYMOUS_MAX = 60;

// The whole Jest suite runs many more than 10 register/login/refresh calls
// against the same test-runner "IP" inside one 15-minute Redis window
// (state persists across test FILES, not just within one). A functional
// test asserting "registration succeeds" shouldn't be coupled to — and
// spuriously fail because of — a threshold tuned for production
// brute-force defense. The mechanism itself (does it actually block at N
// requests, headers, fail-open) is tested directly and deterministically in
// tests/rateLimit.test.ts against a small dedicated instance, not through
// these production-configured ones.
const isTestEnv = env.NODE_ENV === 'test';
const TEST_ENV_MAX = 10_000;

// Applied globally as a baseline. Authenticated callers are identified
// (lower abuse risk) and get a materially higher quota; anonymous callers
// are keyed by IP (spoofable/shared) and get a stricter one — this is the
// "different limits for authorized vs unauthorized users" policy applied
// app-wide, not just to auth endpoints. Requires `optionalAuthenticate` to
// have run first so req.user is populated when a valid token is present.
export const apiRateLimit = rateLimit({
  windowSeconds: 60,
  max: (req) => {
    if (isTestEnv) return TEST_ENV_MAX;
    return req.user ? API_RATE_LIMIT_AUTHENTICATED_MAX : API_RATE_LIMIT_ANONYMOUS_MAX;
  },
  keyPrefix: 'api',
  keyBy: (req) => (req.user ? `user:${req.user.id}` : `ip:${req.ip ?? 'unknown'}`),
});

// Strict and IP-keyed unconditionally: register/login/refresh are
// inherently pre-authentication, so there is no identity to key by other
// than IP (Section 30: "Login: strict").
export const authRateLimit = rateLimit({
  windowSeconds: 15 * 60,
  max: isTestEnv ? TEST_ENV_MAX : env.AUTH_RATE_LIMIT_MAX,
  keyPrefix: 'auth',
  keyBy: (req) => `ip:${req.ip ?? 'unknown'}`,
});

// forgot-password gets its OWN pair, not authRateLimit reused, because it
// has a distinct abuse shape: someone spamming reset requests at one victim
// email from many different IPs would sail straight through an IP-only
// limit. Two independent limiters close both angles — a normal user only
// ever trips neither.
const FORGOT_PASSWORD_IP_MAX = 5;
const FORGOT_PASSWORD_EMAIL_MAX = 3;

export const forgotPasswordIpRateLimit = rateLimit({
  windowSeconds: 15 * 60,
  max: isTestEnv ? TEST_ENV_MAX : FORGOT_PASSWORD_IP_MAX,
  keyPrefix: 'forgot-password-ip',
  keyBy: (req) => `ip:${req.ip ?? 'unknown'}`,
});

// Keyed by the target email in the request body, not the caller's identity
// — this is deliberately about protecting the VICTIM's inbox from being
// bombed, not about identifying the requester. express.json() has already
// parsed req.body by the time this runs (it's global middleware in app.ts,
// ahead of any route), so this doesn't need validateBody to have run first;
// a malformed body just falls into a shared "unknown" bucket, which
// validateBody will reject with 400 immediately afterward anyway.
export const forgotPasswordEmailRateLimit = rateLimit({
  windowSeconds: 60 * 60,
  max: isTestEnv ? TEST_ENV_MAX : FORGOT_PASSWORD_EMAIL_MAX,
  keyPrefix: 'forgot-password-email',
  keyBy: (req) => {
    const email = (req.body as { email?: unknown } | undefined)?.email;
    return `email:${typeof email === 'string' ? email.trim().toLowerCase() : 'unknown'}`;
  },
});

// Section 30's "special high-performance strategy" for bidding (CACHE-001's
// sibling task, both Phase 5). This is NOT about a hot auction receiving
// many bids from many DIFFERENT bidders — that's Section 46's hot-auction
// case working correctly, and apiRateLimit's generous per-user ceiling
// already permits it. It's about the cost SHAPE of one bid attempt: unlike
// an ordinary read or write, every attempt — including a rejected one —
// takes a real Postgres row lock (ADR-0012)'s SELECT ... FOR UPDATE. A
// script hammering ONE auction with rapid low-ball bids spends real lock
// time that serializes against every genuine bidder competing on that same
// auction, which is a materially different (and worse) cost profile than
// what apiRateLimit was sized for.
//
// Keyed by (user, auction), not user alone: bounds how much lock-
// contention pressure any ONE bidder can put on any ONE specific auction,
// without penalizing someone legitimately watching and bidding across
// several different auctions at once. 10 attempts per 10 seconds is
// generous for a real bidding war (anti-sniping's own 30s extension
// window, ADR-0013, assumes a human re-bidding a few times, not a sustained
// sub-second click rate) while still meaningfully bounding a script.
const BID_RATE_LIMIT_MAX = 10;

// Extracted and exported so its (user, auction) derivation — the one truly
// bespoke piece of this limiter, as opposed to the generic mechanism
// already covered by tests/rateLimit.test.ts — is independently
// unit-testable without spinning up Express or Redis.
export function bidRateLimitKeyBy(req: Request): string {
  const auctionId = (req.params as { auctionId?: string }).auctionId ?? 'unknown';
  return `user:${req.user?.id ?? 'unknown'}:auction:${auctionId}`;
}

export const bidRateLimit = rateLimit({
  windowSeconds: 10,
  max: isTestEnv ? TEST_ENV_MAX : BID_RATE_LIMIT_MAX,
  keyPrefix: 'bid',
  keyBy: bidRateLimitKeyBy,
});

// Phase 10 (ADR-0032): unlike most write endpoints, regenerating a
// valuation costs real, slow CPU time on a single shared, self-hosted
// Ollama instance — closer in shape to bidRateLimit's "this specific action
// has an unusually expensive cost profile" justification than to the
// generic apiRateLimit ceiling. Keyed by user alone (not per-auction like
// bidding, which needs to bound contention on one hot row) — the resource
// being protected here is the shared Ollama container itself, not any one
// auction's data.
const AI_REGENERATE_RATE_LIMIT_MAX = 5;

export const aiRegenerateRateLimit = rateLimit({
  windowSeconds: 10 * 60,
  max: isTestEnv ? TEST_ENV_MAX : AI_REGENERATE_RATE_LIMIT_MAX,
  keyPrefix: 'ai-regenerate',
  keyBy: (req) => `user:${req.user?.id ?? 'unknown'}`,
});