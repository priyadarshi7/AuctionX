import express from 'express';
import request from 'supertest';
import { errorHandler } from '../src/middleware/errors';
import { cookieSameSitePolicy, createRequireTrustedOrigin, isTrustedOrigin } from '../src/middleware/csrf';

const FRONTEND_URL = 'https://auctionx-app.vercel.app';

function buildTestApp(enforce: boolean) {
  const app = express();
  app.post('/probe', createRequireTrustedOrigin(FRONTEND_URL, enforce), (_req, res) => {
    res.status(200).json({ ok: true });
  });
  app.use(errorHandler);
  return app;
}

describe('cookieSameSitePolicy', () => {
  // Pure function tested directly — NODE_ENV is fixed to 'test' for this
  // whole process (jest config), so the real env.NODE_ENV singleton can
  // never actually be 'production' in a test; this is why the function
  // takes nodeEnv as a parameter instead of reading env directly.
  it('is "none" in production (so the cookie survives a cross-origin fetch)', () => {
    expect(cookieSameSitePolicy('production')).toBe('none');
  });

  it('is "lax" in development (same-origin, Lax alone is a complete CSRF defense)', () => {
    expect(cookieSameSitePolicy('development')).toBe('lax');
  });

  it('is "lax" in test', () => {
    expect(cookieSameSitePolicy('test')).toBe('lax');
  });
});

describe('isTrustedOrigin', () => {
  it('matches the exact frontend URL', () => {
    expect(isTrustedOrigin(FRONTEND_URL, FRONTEND_URL)).toBe(true);
  });

  it('rejects a missing Origin header', () => {
    expect(isTrustedOrigin(undefined, FRONTEND_URL)).toBe(false);
  });

  it('rejects a different origin entirely', () => {
    expect(isTrustedOrigin('https://evil.example.com', FRONTEND_URL)).toBe(false);
  });

  it('rejects a lookalike origin that merely starts with the trusted one', () => {
    // Guards against a naive .startsWith()/substring check — this domain
    // is NOT auctionx-app.vercel.app, an attacker who registers it should
    // never pass.
    expect(isTrustedOrigin(`${FRONTEND_URL}.evil.com`, FRONTEND_URL)).toBe(false);
  });
});

describe('requireTrustedOrigin middleware', () => {
  it('is a complete no-op when enforce is false (dev/test — SameSite=Lax already protects)', async () => {
    const app = buildTestApp(false);

    const res = await request(app).post('/probe'); // deliberately no Origin header at all

    expect(res.status).toBe(200);
  });

  it('allows a request from the trusted origin when enforcing', async () => {
    const app = buildTestApp(true);

    const res = await request(app).post('/probe').set('Origin', FRONTEND_URL);

    expect(res.status).toBe(200);
  });

  it('rejects a request with no Origin header when enforcing', async () => {
    const app = buildTestApp(true);

    const res = await request(app).post('/probe');

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('UNTRUSTED_ORIGIN');
  });

  it('rejects a request from a different origin when enforcing', async () => {
    const app = buildTestApp(true);

    const res = await request(app).post('/probe').set('Origin', 'https://evil.example.com');

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('UNTRUSTED_ORIGIN');
  });
});
