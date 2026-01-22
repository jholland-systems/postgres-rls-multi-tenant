import express, { type Express } from 'express';
import { logger } from './utils/logger.js';
import { env } from './config/env.js';
import { correlationIdMiddleware } from './middleware/correlation-id.js';
import { tenantContextMiddleware } from './middleware/tenant-context.js';
import { errorHandler } from './middleware/error-handler.js';

/**
 * Creates and configures the Express application
 * with all middleware for tenant isolation, logging, and error handling
 */
export function createApp(): Express {
  const app = express();

  // ============================================================================
  // GLOBAL MIDDLEWARE (Applied to all routes)
  // ============================================================================

  // Parse JSON bodies
  app.use(express.json());

  // Correlation ID (for distributed tracing and log correlation)
  app.use(correlationIdMiddleware);

  // Request logging (with correlation ID and tenant ID)
  app.use((req, res, next) => {
    const start = Date.now();

    // Log response after it finishes
    res.on('finish', () => {
      const duration = Date.now() - start;
      logger.info(
        {
          method: req.method,
          path: req.path,
          status: res.statusCode,
          duration,
          correlationId: req.correlationId,
          tenantId: req.tenantId,
        },
        'HTTP request completed'
      );
    });

    next();
  });

  // Tenant context extraction (attaches req.tenantId if present)
  app.use(tenantContextMiddleware);

  // ============================================================================
  // PUBLIC ROUTES (No tenant context required)
  // ============================================================================

  // Health check endpoint
  app.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      environment: env.NODE_ENV,
    });
  });

  // Root endpoint (API info)
  app.get('/', (req, res) => {
    res.json({
      name: 'Multi-Tenant PostgreSQL RLS',
      description: 'Production-grade multi-tenant data isolation showcase',
      version: '1.0.0',
      documentation: 'https://github.com/[user]/multi-tenant-postgres-rls',
      correlationId: req.correlationId,
    });
  });

  // ============================================================================
  // API ROUTES (To be implemented in Phase 4)
  // ============================================================================

  // Tenant-scoped routes will use requireTenantContext middleware
  // Example:
  // app.get('/api/projects', requireTenantContext, asyncHandler(async (req, res) => {
  //   const projects = await withTenantContext(req.tenantId!, async (tx) => {
  //     return await tx.selectFrom('projects').selectAll().execute();
  //   });
  //   res.json(projects);
  // }));

  // System-level routes (tenant management) use withSystemContext
  // Example:
  // app.post('/api/tenants', asyncHandler(async (req, res) => {
  //   const tenant = await withSystemContext(async (db) => {
  //     return await db.insertInto('tenants').values(req.body).execute();
  //   });
  //   res.json(tenant);
  // }));

  // ============================================================================
  // ERROR HANDLERS (Must be last)
  // ============================================================================

  // 404 handler
  app.use((req, res) => {
    res.status(404).json({
      error: 'Not Found',
      path: req.path,
      correlationId: req.correlationId,
    });
  });

  // Global error handler (catches all errors)
  app.use(errorHandler);

  return app;
}
