#!/usr/bin/env node
/**
 * Migration runner script
 * Runs database migrations using node-pg-migrate
 */

import { run } from 'node-pg-migrate';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';

async function runMigrations() {
  try {
    logger.info('Starting database migrations...');

    const migrations = await run({
      databaseUrl: env.DATABASE_URL,
      dir: 'src/database/migrations',
      direction: 'up',
      migrationsTable: 'pgmigrations',
      count: Infinity,
      verbose: true,
      log: (msg) => logger.info(msg),
    });

    if (migrations.length === 0) {
      logger.info('No pending migrations');
    } else {
      logger.info(
        {
          count: migrations.length,
          migrations: migrations.map((m) => m.name),
        },
        'Migrations completed successfully'
      );
    }

    process.exit(0);
  } catch (error) {
    logger.error({ error }, 'Migration failed');
    process.exit(1);
  }
}

runMigrations();
