import { GenericContainer, StartedTestContainer } from 'testcontainers';
import { Kysely, PostgresDialect, sql } from 'kysely';
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

  // Wait for database to be ready
  let retries = 10;
  while (retries > 0) {
    try {
      await sql.raw('SELECT 1').execute(db);
      break;
    } catch (err) {
      retries--;
      if (retries === 0) throw err;
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }

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

  // CRITICAL: Create non-superuser role for RLS testing
  // The 'test' user created by the container is a superuser which bypasses RLS.
  // We create a new 'app_user' role with minimal privileges for proper RLS testing.
  await sql.raw(`
    CREATE ROLE app_user WITH LOGIN PASSWORD 'app_user' NOSUPERUSER NOCREATEDB NOCREATEROLE;
    GRANT USAGE ON SCHEMA public TO app_user;
    GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE ON ALL TABLES IN SCHEMA public TO app_user;
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_user;
  `).execute(db);

  // Destroy the superuser connection and reconnect as app_user
  await db.destroy();

  const appUserConnectionString = `postgresql://app_user:app_user@${host}:${port}/test_rls`;
  const appUserPool = new Pool({
    connectionString: appUserConnectionString,
    max: 10,
    idleTimeoutMillis: 10000,
    connectionTimeoutMillis: 10000,
    statement_timeout: 10000,
  });

  db = new Kysely<Database>({
    dialect: new PostgresDialect({ pool: appUserPool }),
  });

  return { container, db, connectionString: appUserConnectionString };
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
 *
 * Note: Uses TRUNCATE which bypasses RLS and is more efficient for test cleanup.
 * Also resets any session variables that might have been set.
 */
export async function cleanTestData(database: Kysely<Database>): Promise<void> {
  // TRUNCATE bypasses RLS and is faster for bulk deletion in tests
  // CASCADE automatically handles foreign key constraints
  await sql.raw(`
    TRUNCATE TABLE
      tasks,
      projects,
      users,
      tenants,
      admin_audit_log
    CASCADE;

    -- Reset any session variables
    RESET app.current_tenant_id;
    RESET app.is_superadmin;
  `).execute(database);
}
