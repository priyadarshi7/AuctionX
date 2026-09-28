import type { NextFunction, Request, Response } from 'express';
import { logger } from '../infrastructure/observability/logger';

/**
 * Base class for errors that are safe to translate into a structured HTTP
 * response. Anything thrown that is NOT an AppError is treated as an
 * unexpected bug and never has its message/stack leaked to the client.
 */
export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Resource not found') {
    super(404, 'NOT_FOUND', message);
  }
}

export class ValidationError extends AppError {
  constructor(details: unknown, message = 'Request validation failed') {
    super(400, 'VALIDATION_ERROR', message, details);
  }
}

export class ConflictError extends AppError {
  constructor(code: string, message: string) {
    super(409, code, message);
  }
}

export class UnauthorizedError extends AppError {
  constructor(code: string, message = 'Authentication required') {
    super(401, code, message);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'You do not have permission to perform this action') {
    super(403, 'FORBIDDEN', message);
  }
}

// A payment provider webhook that failed signature verification or was
// unparseable (Section 28 — never process an unverified request claiming to
// be from a payment provider). 400, not 401: this isn't a caller identity
// problem the way UnauthorizedError is, it's a malformed/unverifiable
// request.
export class WebhookVerificationError extends AppError {
  constructor(message: string) {
    super(400, 'INVALID_WEBHOOK', message);
  }
}

export function notFoundHandler(req: Request, _res: Response, next: NextFunction): void {
  next(new NotFoundError(`No route for ${req.method} ${req.path}`));
}

// Express recognizes this as an error-handling middleware purely by arity (4 params).
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  const requestId = req.id;

  if (err instanceof AppError) {
    res.status(err.statusCode).json({
      error: {
        code: err.code,
        message: err.message,
        requestId,
        ...(err.details !== undefined ? { details: err.details } : {}),
      },
    });
    return;
  }

  logger.error({ err, requestId }, 'Unhandled error');

  // Errors in {code, message, requestId} format
  res.status(500).json({
    error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred', requestId },
  });
}
