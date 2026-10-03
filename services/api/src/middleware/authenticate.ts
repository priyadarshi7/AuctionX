import type { NextFunction, Request, Response } from 'express';
import { TokenExpiredError, JsonWebTokenError } from 'jsonwebtoken';
import { verifyAccessToken } from '../infrastructure/security/tokens';
import { isUserBlocked } from '../infrastructure/security/blockedUsers';
import { UnauthorizedError } from './errors';

export async function authenticate(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const header = req.headers.authorization;

  if (!header?.startsWith('Bearer ')) {
    next(new UnauthorizedError('UNAUTHENTICATED', 'Missing or malformed Authorization header'));
    return;
  }

  const token = header.slice('Bearer '.length);

  try {
    const payload = verifyAccessToken(token);
    // One Redis EXISTS (fails open): a suspended/banned user's still-valid
    // token is refused immediately rather than after it expires.
    if (await isUserBlocked(payload.sub)) {
      next(new UnauthorizedError('ACCOUNT_DISABLED', 'This account is not active'));
      return;
    }
    req.user = { id: payload.sub, role: payload.role };
    next();
  } catch (err) {
    // Distinct code for "expired" so a future client knows to attempt a
    // silent refresh rather than forcing the user back to the login form.
    if (err instanceof TokenExpiredError) {
      next(new UnauthorizedError('TOKEN_EXPIRED', 'Access token has expired'));
      return;
    }
    if (err instanceof JsonWebTokenError) {
      next(new UnauthorizedError('INVALID_TOKEN', 'Access token is invalid'));
      return;
    }
    next(err);
  }
}

// Never rejects — populates req.user best-effort when a valid Bearer token
// is present, otherwise leaves the request as anonymous. For endpoints that
// behave differently for logged-in vs anonymous callers without requiring
// login (Section 30's example: auction browsing), and for the global rate
// limiter's authenticated-vs-anonymous key/quota split.
export function optionalAuthenticate(req: Request, _res: Response, next: NextFunction): void {
  const header = req.headers.authorization;

  if (!header?.startsWith('Bearer ')) {
    next();
    return;
  }

  try {
    const payload = verifyAccessToken(header.slice('Bearer '.length));
    req.user = { id: payload.sub, role: payload.role };
  } catch {
    // Invalid/expired token on a route that doesn't require auth: treat as
    // anonymous rather than erroring — the caller didn't need to be logged
    // in, so a bad token shouldn't block them, only fail to identify them.
  }
  next();
}
