// pino-http assigns a request id to req.id for correlating logs to a single
// request (Section 34/75: every log line should be traceable to a request).
// Express's own types don't know about this field, so we extend them here.
import 'express';
import type { Role } from '@prisma/client';

declare module 'express-serve-static-core' {
  interface Request {
    id: string;
    // Populated by the `authenticate` middleware after verifying the
    // access token. Deliberately minimal — role is here for cheap RBAC
    // checks without a DB hit; anything richer means re-fetching the user.
    user?: { id: string; role: Role };
    // Populated by `validateQuery` (middleware/validate.ts). Not `req.query`
    // itself — Express 5 doesn't allow overwriting that — so handlers that
    // validated their query params read this instead. Typed `unknown` here
    // and narrowed at each call site via the schema's inferred type.
    validatedQuery?: unknown;
  }
}
