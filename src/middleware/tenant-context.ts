import type { Request, Response, NextFunction } from 'express';
import { extractTenantId } from '../utils/tenant-extraction.js';
import { logger } from '../utils/logger.js';

/**
 * Tenant context middleware
 *
 * Extracts tenant ID from request and attaches to req.tenantId.
 * DOES NOT set database context - that's handled per-query with withTenantContext().
 *
 * This middleware:
 * 1. Extracts tenant ID from request (header/JWT)
 * 2. Validates it's a valid UUID
 * 3. Attaches to req.tenantId for easy access
 * 4. Logs tenant context for debugging
 *
 * The actual `SET LOCAL app.current_tenant_id` happens in database client functions:
 * - withTenantContext() for normal tenant-scoped queries
 * - withPrivilegedContext() for admin cross-tenant queries
 */

declare global {
  namespace Express {
    interface Request {
      tenantId?: string;
    }
  }
}

export function tenantContextMiddleware(
  req: Request,
  _res: Response,
  next: NextFunction
): void {
  // Extract tenant ID from request
  const tenantId = extractTenantId(req);

  if (tenantId) {
    // Attach to request for handlers
    req.tenantId = tenantId;

    logger.debug(
      {
        tenantId,
        correlationId: req.correlationId,
        path: req.path,
        method: req.method,
      },
      'Tenant context extracted'
    );
  } else {
    logger.debug(
      {
        correlationId: req.correlationId,
        path: req.path,
        method: req.method,
      },
      'No tenant context in request'
    );
  }

  next();
}

/**
 * Middleware to require tenant context
 *
 * Use this on routes that REQUIRE a tenant (e.g., /api/projects).
 * Returns 401 Unauthorized if tenant context is missing.
 *
 * Example:
 * ```typescript
 * app.get('/api/projects', requireTenantContext, async (req, res) => {
 *   // req.tenantId is guaranteed to exist here
 *   const projects = await withTenantContext(req.tenantId!, async (tx) => {
 *     return await tx.selectFrom('projects').selectAll().execute();
 *   });
 *   res.json(projects);
 * });
 * ```
 */
export function requireTenantContext(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  if (!req.tenantId) {
    logger.warn(
      {
        correlationId: req.correlationId,
        path: req.path,
        method: req.method,
      },
      'Tenant context required but not present'
    );

    res.status(401).json({
      error: 'Unauthorized',
      message: 'Tenant context required',
      correlationId: req.correlationId,
    });
    return;
  }

  next();
}
