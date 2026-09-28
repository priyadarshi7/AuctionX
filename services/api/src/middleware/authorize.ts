import type { NextFunction, Request, Response } from 'express';
import type { Role } from '@prisma/client';
import { ForbiddenError, UnauthorizedError } from './errors';

// Must run after `authenticate` — reads req.user, doesn't populate it.
export function requireRole(...allowedRoles: Role[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.user) {
      // Only reachable if this middleware is wired without `authenticate`
      // in front of it — a wiring bug, not a client-triggerable state.
      next(new UnauthorizedError('UNAUTHENTICATED'));
      return;
    }
    if (!allowedRoles.includes(req.user.role)) {
      next(new ForbiddenError());
      return;
    }
    next();
  };
}
