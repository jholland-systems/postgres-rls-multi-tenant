import type { Request, Response, NextFunction } from 'express';
import { DatabaseError } from 'pg';
import { logger } from '../utils/logger.js';
import { env } from '../config/env.js';

/**
 * Error types and handlers
 */

export class AppError extends Error {
  constructor(
    public statusCode: number,
    message: string,
    public isOperational = true
  ) {
    super(message);
    Object.setPrototypeOf(this, AppError.prototype);
    Error.captureStackTrace(this, this.constructor);
  }
}

export class NotFoundError extends AppError {
  constructor(resource: string) {
    super(404, `${resource} not found`);
  }
}

export class ValidationError extends AppError {
  constructor(message: string) {
    super(400, message);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Unauthorized') {
    super(401, message);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'Forbidden') {
    super(403, message);
  }
}

/**
 * Global error handler middleware
 *
 * Handles all errors thrown in the application:
 * - AppError: Known application errors (return structured JSON)
 * - DatabaseError: PostgreSQL errors (sanitize for security)
 * - Unknown errors: Log and return generic 500
 *
 * Includes correlation ID in all error responses for debugging.
 */
export function errorHandler(
  err: Error,
  req: Request,
  res: Response,
  _next: NextFunction
): void {
  // Get correlation ID for error tracking
  const correlationId = req.correlationId || 'unknown';

  // Handle known application errors
  if (err instanceof AppError) {
    logger.warn(
      {
        err,
        statusCode: err.statusCode,
        correlationId,
        path: req.path,
        method: req.method,
      },
      'Application error'
    );

    res.status(err.statusCode).json({
      error: err.message,
      correlationId,
      ...(env.NODE_ENV === 'development' && { stack: err.stack }),
    });
    return;
  }

  // Handle PostgreSQL database errors
  if (err instanceof DatabaseError) {
    logger.error(
      {
        err,
        code: err.code,
        detail: err.detail,
        correlationId,
        path: req.path,
        method: req.method,
      },
      'Database error'
    );

    // Sanitize database errors for security
    // Don't expose internal database details to clients
    const message =
      env.NODE_ENV === 'development'
        ? `Database error: ${err.message}`
        : 'A database error occurred';

    res.status(500).json({
      error: 'Internal Server Error',
      message,
      correlationId,
      ...(env.NODE_ENV === 'development' && {
        code: err.code,
        detail: err.detail,
      }),
    });
    return;
  }

  // Handle unknown errors
  logger.error(
    {
      err,
      correlationId,
      path: req.path,
      method: req.method,
    },
    'Unhandled error'
  );

  res.status(500).json({
    error: 'Internal Server Error',
    message: env.NODE_ENV === 'development' ? err.message : undefined,
    correlationId,
    ...(env.NODE_ENV === 'development' && { stack: err.stack }),
  });
}

/**
 * Async handler wrapper
 *
 * Wraps async route handlers to catch promise rejections.
 * Without this, rejected promises in async handlers don't get caught by error middleware.
 *
 * Usage:
 * ```typescript
 * app.get('/api/projects', asyncHandler(async (req, res) => {
 *   const projects = await getProjects(); // If this throws, it's caught
 *   res.json(projects);
 * }));
 * ```
 */
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<void>
) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}
