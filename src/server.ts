import { createApp } from './app.js';
import { logger } from './utils/logger.js';
import { env } from './config/env.js';
import { closeDatabase } from './database/client.js';

// Create Express application
const app = createApp();

// Start server
const server = app.listen(env.PORT, () => {
  logger.info(
    {
      port: env.PORT,
      environment: env.NODE_ENV,
      nodeVersion: process.version,
    },
    'Server started successfully'
  );

  logger.info(
    {
      database: env.DATABASE_URL.replace(/:[^:@]+@/, ':****@'), // Hide password
      poolMax: env.DB_POOL_MAX,
      statementTimeout: env.DB_STATEMENT_TIMEOUT,
    },
    'Database configuration'
  );
});

// Graceful shutdown handler
async function gracefulShutdown(signal: string) {
  logger.info({ signal }, 'Received shutdown signal, starting graceful shutdown');

  // Stop accepting new connections
  server.close(() => {
    logger.info('HTTP server closed');
  });

  try {
    // Close database connections
    await closeDatabase();

    logger.info('Graceful shutdown completed');
    process.exit(0);
  } catch (error) {
    logger.error({ error }, 'Error during graceful shutdown');
    process.exit(1);
  }
}

// Handle shutdown signals
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Handle uncaught errors
process.on('uncaughtException', (error) => {
  logger.fatal({ error }, 'Uncaught exception, shutting down');
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  logger.fatal({ reason, promise }, 'Unhandled promise rejection, shutting down');
  process.exit(1);
});
