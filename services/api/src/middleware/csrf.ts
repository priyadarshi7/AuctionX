import type { NextFunction, Request, Response } from 'express';
import { ForbiddenError } from './errors';

// Pure, independently testable — deliberately takes nodeEnv as a parameter
// rather than reading env.NODE_ENV directly, since Jest's process only ever
// runs with NODE_ENV=test (set once at process start by jest config), so a
// test can never exercise the 'production' branch through the real env
// singleton. controller.ts calls this with the real env.NODE_ENV; tests
// call it directly with whichever value they want to assert on.
//
// 'lax' (local dev, and this process's own test run): frontend and backend
// share a top-level domain (both localhost), so SameSite=Lax alone blocks
// cross-site POSTs — the standard CSRF defense, no extra work needed.
// 'none' (production, ADR-0003's anticipated cross-origin deployment,
// ADR-0036 addendum): frontend (Vercel) and backend (Render) are genuinely
// different origins. SameSite=Lax would silently never send the refresh
// cookie on any fetch() call at all (not a security block, a browser
// behavior) — found live, the hard way, as "every reload logs the user
// out." SameSite=None restores cross-site delivery, but on its own reopens
// the exact CSRF gap Lax was closing — requireTrustedOrigin below is what
// replaces that protection.
export function cookieSameSitePolicy(nodeEnv: string): 'lax' | 'none' {
  return nodeEnv === 'production' ? 'none' : 'lax';
}

// Also pure/testable for the same reason. An exact string match, not a
// prefix/substring check — e.g. "https://auctionx-app.vercel.app.evil.com"
// must NOT pass just because it starts with the right string.
export function isTrustedOrigin(origin: string | undefined, frontendUrl: string): boolean {
  return origin === frontendUrl;
}

// Applied only to the cookie-only-credentialed endpoints (/refresh,
// /logout) — not /login, where the credential is the request BODY
// (email/password), not an ambient cookie, so a cross-site POST can't do
// anything a victim didn't type themselves (the classic "login CSRF" is a
// different, lower-severity category this app isn't attempting to solve
// here). `enforce` is false whenever cookieSameSitePolicy would return
// 'lax' — SameSite=Lax is already a complete CSRF defense on its own in
// that case, so this would be redundant extra surface for no benefit (and
// would break every existing supertest call that doesn't set an Origin
// header, local dev included).
export function createRequireTrustedOrigin(frontendUrl: string, enforce: boolean) {
  return function requireTrustedOrigin(req: Request, _res: Response, next: NextFunction): void {
    if (!enforce) {
      next();
      return;
    }
    if (!isTrustedOrigin(req.headers.origin, frontendUrl)) {
      next(new ForbiddenError('Request origin not trusted', 'UNTRUSTED_ORIGIN'));
      return;
    }
    next();
  };
}
