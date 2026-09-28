import type { NextFunction, Request, Response } from 'express';
import type { ZodType } from 'zod';
import { ValidationError } from './errors';

// Validates and REPLACES req.body with the parsed/transformed value (e.g.
// email lowercased, whitespace trimmed) so every downstream handler works
// with normalized data instead of re-normalizing itself.
export function validateBody<T>(schema: ZodType<T>) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req.body);

    if (!result.success) {
      next(new ValidationError(result.error.flatten().fieldErrors));
      return;
    }

    req.body = result.data;
    next();
  };
}

// Same idea as validateBody, but for query strings — with one difference:
// Express 5's req.query has no setter, so `req.query = result.data` silently
// does nothing (verified empirically, not assumed) rather than throwing.
// The parsed/coerced result (e.g. `limit` turned into a number) is stashed
// on req.validatedQuery instead; see types/express.d.ts.
export function validateQuery<T>(schema: ZodType<T>) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req.query);

    if (!result.success) {
      next(new ValidationError(result.error.flatten().fieldErrors));
      return;
    }

    req.validatedQuery = result.data;
    next();
  };
}
