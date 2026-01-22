import type { Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';

/**
 * Correlation ID middleware
 * Generates a unique request ID for distributed tracing and log correlation
 *
 * - Checks for existing X-Correlation-ID header (from upstream services)
 * - Generates new UUID v4 if not present
 * - Attaches to req.correlationId for easy access
 * - Returns in X-Correlation-ID response header
 *
 * Professional polish: Enables distributed tracing, log aggregation, and debugging
 */

declare global {
  namespace Express {
    interface Request {
      correlationId: string;
    }
  }
}

export function correlationIdMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  // Check if correlation ID already exists (from upstream service or previous middleware)
  const existingId = req.headers['x-correlation-id'] as string | undefined;

  // Use existing ID or generate new one
  const correlationId = existingId || uuidv4();

  // Attach to request for access in handlers
  req.correlationId = correlationId;

  // Return in response header for client/debugging
  res.setHeader('X-Correlation-ID', correlationId);

  next();
}
