import express, { type Express } from 'express';
import { logger } from './utils/logger.js';
import { env } from './config/env.js';
import { correlationIdMiddleware } from './middleware/correlation-id.js';
import { tenantContextMiddleware } from './middleware/tenant-context.js';
import { errorHandler } from './middleware/error-handler.js';
import tenantsRouter from './routes/tenants.js';
import projectsRouter from './routes/projects.js';
import tasksRouter from './routes/tasks.js';
import usersRouter from './routes/users.js';

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
  // API ROUTES
  // ============================================================================

  // System-level routes (no tenant context required)
  app.use('/api/tenants', tenantsRouter);

  // Tenant-scoped routes (require tenant context)
  app.use('/api/projects', projectsRouter);
  app.use('/api/tasks', tasksRouter);
  app.use('/api/users', usersRouter);

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
