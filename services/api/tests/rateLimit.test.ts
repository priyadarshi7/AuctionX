import type { Request } from 'express';
import express from 'express';
import request from 'supertest';
import { errorHandler } from '../src/middleware/errors';
import { bidRateLimitKeyBy, rateLimit, type RateLimitOptions } from '../src/middleware/rateLimit';
import { redis } from '../src/infrastructure/redis/client';

const runId = Date.now();

function buildTestApp(options: RateLimitOptions) {
  const app = express();
  app.use(rateLimit(options));
  app.get('/probe', (_req, res) => {
    res.status(200).json({ ok: true });
  });
  app.use(errorHandler);
  return app;
}

describe('rateLimit middleware', () => {
  it('allows up to max requests in the window, then blocks with 429', async () => {
    const app = buildTestApp({ windowSeconds: 60, max: 3, keyPrefix: `block-${runId}` });

    for (let i = 0; i < 3; i++) {
      const res = await request(app).get('/probe');
      expect(res.status).toBe(200);
    }

    const blocked = await request(app).get('/probe');
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('TOO_MANY_REQUESTS');
    expect(blocked.body.error.details.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('reports remaining budget via X-RateLimit headers', async () => {
    const app = buildTestApp({ windowSeconds: 60, max: 5, keyPrefix: `headers-${runId}` });

    const res = await request(app).get('/probe');

    expect(res.headers['x-ratelimit-limit']).toBe('5');
    expect(res.headers['x-ratelimit-remaining']).toBe('4');
  });

  it('tracks each key independently — one caller being blocked does not affect another', async () => {
    const app = buildTestApp({
      windowSeconds: 60,
      max: 1,
      keyPrefix: `keys-${runId}`,
      keyBy: (req) => (req.headers['x-test-caller'] as string) ?? 'default',
    });

    const aliceFirst = await request(app).get('/probe').set('x-test-caller', 'alice');
    expect(aliceFirst.status).toBe(200);
    const aliceSecond = await request(app).get('/probe').set('x-test-caller', 'alice');
    expect(aliceSecond.status).toBe(429);

    const bobFirst = await request(app).get('/probe').set('x-test-caller', 'bob');
    expect(bobFirst.status).toBe(200);
  });

  it('supports a per-request quota (e.g. authenticated vs anonymous)', async () => {
    const app = buildTestApp({
      windowSeconds: 60,
      max: (req) => (req.headers['x-authenticated'] ? 5 : 1),
      keyPrefix: `variable-max-${runId}`,
      keyBy: (req) => (req.headers['x-test-caller'] as string) ?? 'default',
    });

    // Anonymous: max 1 — second request is blocked.
    const anon1 = await request(app).get('/probe').set('x-test-caller', 'anon-caller');
    expect(anon1.status).toBe(200);
    const anon2 = await request(app).get('/probe').set('x-test-caller', 'anon-caller');
    expect(anon2.status).toBe(429);

    // "Authenticated" (different key, higher max): several requests succeed.
    for (let i = 0; i < 5; i++) {
      const res = await request(app)
        .get('/probe')
        .set('x-test-caller', 'auth-caller')
        .set('x-authenticated', '1');
      expect(res.status).toBe(200);
    }
  });

  it('fails open when Redis is unreachable', async () => {
    const evalSpy = jest.spyOn(redis, 'eval').mockRejectedValueOnce(new Error('simulated outage'));
    const app = buildTestApp({ windowSeconds: 60, max: 1, keyPrefix: `failopen-${runId}` });

    const res = await request(app).get('/probe');

    expect(res.status).toBe(200);
    evalSpy.mockRestore();
  });
});

// bidRateLimit (Section 30, CACHE-001's sibling task) reuses the generic
// mechanism already fully covered above — only its (user, auction) key
// derivation is bespoke, so that's the one piece worth testing directly.
// The real 10-per-10s threshold itself is verified live against the
// running dev server (see PROGRESS.md), not here — coupling a Jest test to
// a production threshold is exactly what tests/rateLimit.test.ts's own
// comments (and AUTH-006's rate limiter before it) already argue against.
describe('bidRateLimitKeyBy', () => {
  function fakeRequest(userId: string | undefined, auctionId: string | undefined): Request {
    return {
      user: userId ? { id: userId, role: 'USER' } : undefined,
      params: auctionId ? { auctionId } : {},
    } as unknown as Request;
  }

  it('derives a key from both the user id and the auction id', () => {
    expect(bidRateLimitKeyBy(fakeRequest('user-1', 'auction-a'))).toBe('user:user-1:auction:auction-a');
  });

  it('gives the same user a different bucket per auction', () => {
    const keyA = bidRateLimitKeyBy(fakeRequest('user-1', 'auction-a'));
    const keyB = bidRateLimitKeyBy(fakeRequest('user-1', 'auction-b'));
    expect(keyA).not.toBe(keyB);
  });

  it('gives different users a different bucket on the same auction', () => {
    const keyAlice = bidRateLimitKeyBy(fakeRequest('alice', 'auction-a'));
    const keyBob = bidRateLimitKeyBy(fakeRequest('bob', 'auction-a'));
    expect(keyAlice).not.toBe(keyBob);
  });

  it('falls back to "unknown" rather than throwing if user or params are missing', () => {
    expect(bidRateLimitKeyBy(fakeRequest(undefined, 'auction-a'))).toBe('user:unknown:auction:auction-a');
    expect(bidRateLimitKeyBy(fakeRequest('user-1', undefined))).toBe('user:user-1:auction:unknown');
  });
});
