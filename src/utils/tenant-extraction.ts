import type { Request } from 'express';
import { z } from 'zod';
import { logger } from './logger.js';

/**
 * Tenant extraction utilities
 *
 * Extracts tenant ID from request headers/JWT for RLS context.
 * For this demo, we use a simple X-Tenant-ID header.
 *
 * In production, you would:
 * 1. Validate JWT token
 * 2. Extract tenant_id from JWT claims
 * 3. Verify user has access to that tenant
 * 4. Cache tenant lookup in Redis (avoid DB hit per request)
 */

// UUID validation schema
const uuidSchema = z.string().uuid();

/**
 * Extracts tenant ID from request
 *
 * For demo: Reads X-Tenant-ID header
 * For production: Would extract from validated JWT claims
 *
 * @param req Express request
 * @returns Tenant ID (UUID) or null if not present/invalid
 */
export function extractTenantId(req: Request): string | null {
  // Demo approach: Read from X-Tenant-ID header
  const tenantIdHeader = req.headers['x-tenant-id'] as string | undefined;

  if (!tenantIdHeader) {
    logger.debug('No X-Tenant-ID header present');
    return null;
  }

  // Validate it's a valid UUID
  const parseResult = uuidSchema.safeParse(tenantIdHeader);

  if (!parseResult.success) {
    logger.warn(
      {
        tenantId: tenantIdHeader,
        error: parseResult.error.flatten(),
      },
      'Invalid tenant ID format (not a UUID)'
    );
    return null;
  }

  return parseResult.data;
}

/**
 * Extracts tenant slug from request (for lookups)
 *
 * For demo: Reads X-Tenant-Slug header
 * For production: Would extract from JWT or subdomain
 *
 * @param req Express request
 * @returns Tenant slug or null if not present
 */
export function extractTenantSlug(req: Request): string | null {
  const slugHeader = req.headers['x-tenant-slug'] as string | undefined;

  if (!slugHeader) {
    return null;
  }

  // Basic slug validation (lowercase alphanumeric and hyphens)
  const slugRegex = /^[a-z0-9][a-z0-9-]{1,62}$/;
  if (!slugRegex.test(slugHeader)) {
    logger.warn(
      {
        slug: slugHeader,
      },
      'Invalid tenant slug format'
    );
    return null;
  }

  return slugHeader;
}

/**
 * Production JWT extraction example (commented out for demo)
 *
 * In a real application, you would:
 *
 * ```typescript
 * import jwt from 'jsonwebtoken';
 *
 * export function extractTenantIdFromJWT(req: Request): string | null {
 *   const authHeader = req.headers.authorization;
 *   if (!authHeader?.startsWith('Bearer ')) {
 *     return null;
 *   }
 *
 *   const token = authHeader.slice(7);
 *
 *   try {
 *     const decoded = jwt.verify(token, env.JWT_SECRET) as {
 *       tenant_id: string;
 *       user_id: string;
 *       role: string;
 *     };
 *
 *     // Validate tenant_id is a UUID
 *     const parseResult = uuidSchema.safeParse(decoded.tenant_id);
 *     if (!parseResult.success) {
 *       return null;
 *     }
 *
 *     return parseResult.data;
 *   } catch (error) {
 *     logger.warn({ error }, 'JWT verification failed');
 *     return null;
 *   }
 * }
 * ```
 */
