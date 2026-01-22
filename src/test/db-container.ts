import { GenericContainer, StartedTestContainer } from 'testcontainers';
import { Kysely, PostgresDialect } from 'kysely';
import { Pool } from 'pg';
import run from 'node-pg-migrate';
import type { Database } from '../database/schema.js';

/**
 * Test database container management
 *
 * Spins up a PostgreSQL container using Testcontainers for integration testing.
 * Each test suite gets a fresh database with migrations applied.
 */

let container: StartedTestContainer | null = null;
let db: Kysely<Database> | null = null;

/**
 * Start PostgreSQL container and run migrations
 *
 * Call this in beforeAll() hooks.
 */
export async function startTestDatabase(): Promise<{
  container: StartedTestContainer;
  db: Kysely<Database>;
  connectionString: string;
}> {
  // Start PostgreSQL 15 container
  container = await new GenericContainer('postgres:15-alpine')
    .withExposedPorts(5432)
    .withEnvironment({
      POSTGRES_USER: 'test',
      POSTGRES_PASSWORD: 'test',
      POSTGRES_DB: 'test_rls',
    })
    .start();

  const host = container.getHost();
  const port = container.getMappedPort(5432);
  const connectionString = `postgresql://test:test@${host}:${port}/test_rls`;

  // Create Kysely instance
  const pool = new Pool({
    connectionString,
    max: 10,
    idleTimeoutMillis: 10000,
    connectionTimeoutMillis: 10000,
    statement_timeout: 10000,
  });

  db = new Kysely<Database>({
    dialect: new PostgresDialect({ pool }),
  });

  // Run migrations
  await run({
    databaseUrl: connectionString,
    dir: 'src/database/migrations',
    direction: 'up',
    migrationsTable: 'pgmigrations',
    count: Infinity,
    verbose: false,
    log: () => {}, // Silent during tests
  });

  return { container, db, connectionString };
}

/**
 * Stop container and clean up connections
 *
 * Call this in afterAll() hooks.
 */
export async function stopTestDatabase(): Promise<void> {
  if (db) {
    await db.destroy();
    db = null;
  }

  if (container) {
    await container.stop();
    container = null;
  }
}

/**
 * Clean all data from tenant-scoped tables (for between-test cleanup)
 *
 * Useful in afterEach() to reset state without recreating the container.
 */
export async function cleanTestData(database: Kysely<Database>): Promise<void> {
  await database.transaction().execute(async (tx) => {
    // Delete in reverse dependency order
    await tx.deleteFrom('tasks').execute();
    await tx.deleteFrom('projects').execute();
    await tx.deleteFrom('users').execute();
    await tx.deleteFrom('tenants').execute();
    await tx.deleteFrom('admin_audit_log').execute();
  });
}
