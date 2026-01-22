import express, { type Express } from 'express';
import { logger } from './utils/logger.js';
import { env } from './config/env.js';

/**
 * Creates and configures the Express application
 */
export function createApp(): Express {
  const app = express();

  // Middleware: Parse JSON bodies
  app.use(express.json());

  // Middleware: Request logging
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
        },
        'HTTP request completed'
      );
    });

    next();
  });

  // Health check endpoint
  app.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      environment: env.NODE_ENV,
    });
  });

  // Root endpoint
  app.get('/', (_req, res) => {
    res.json({
      name: 'Multi-Tenant PostgreSQL RLS',
      description: 'Production-grade multi-tenant data isolation showcase',
      version: '1.0.0',
      documentation: 'https://github.com/[user]/multi-tenant-postgres-rls',
    });
  });

  // 404 handler
  app.use((req, res) => {
    const { path } = req;
    res.status(404).json({
      error: 'Not Found',
      path,
    });
  });

  // Error handler
  app.use((err: Error, req: express.Request, res: express.Response, _next: express.NextFunction) => {
    logger.error(
      {
        err,
        method: req.method,
        path: req.path,
      },
      'Unhandled error'
    );

    res.status(500).json({
      error: 'Internal Server Error',
      message: env.NODE_ENV === 'development' ? err.message : undefined,
    });
  });

  return app;
}
